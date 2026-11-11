import http from 'node:http'
import { createHmac, randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createClientIp, createLimiter } from './rate-limit.mjs'
import { PortalError, queryUpstream } from './proxy.mjs'

const allowedQuery = new Set(['start', 'end', 'tz', 'bucket', 'limit', 'cursor'])
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export function createPortalServer({
  upstream = 'http://vm2api.vm2api.svc.cluster.local:8787',
  staticDir,
  fetchImpl = fetch,
  timeoutMs = 10000,
  maxResponseBytes = 1024 * 1024,
  keyLimit = 20,
  ipLimit = 60,
  trustedProxyCidrs = [],
  publicOrigin = null,
  maxConcurrent = 4,
  basePath = '',
} = {}) {
  const base = new URL(upstream)
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error('Invalid upstream configuration')
  const mount = basePath === '/' ? '' : basePath.replace(/\/$/, '')
  if (mount && !/^\/[a-zA-Z0-9_-]+$/.test(mount)) throw new Error('Invalid base path configuration')
  const staticRoot = path.resolve(staticDir || new URL('../web/dist/', import.meta.url).pathname)
  const getIp = createClientIp(trustedProxyCidrs)
  const allowIp = createLimiter({ limit: ipLimit })
  const allowKey = createLimiter({ limit: keyLimit })
  const hashSecret = randomBytes(32)
  let active = 0

  function send(res, status, body) {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  function fail(res, status, code, message) {
    if ([429, 503].includes(status)) res.setHeader('retry-after', '5')
    send(res, status, { error: { code, message } })
  }

  return http.createServer(
    { maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000 },
    async (req, res) => {
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader('x-frame-options', 'DENY')
      res.setHeader(
        'content-security-policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      )
      try {
        const url = new URL(req.url, 'http://portal.internal')
        if (!['GET', 'HEAD'].includes(req.method)) return fail(res, 405, 'method_not_allowed', '不支持的请求方式。')
        if (url.pathname === '/healthz') return send(res, 200, { status: 'ok' })
        if (mount) {
          if (url.pathname === mount) {
            res.writeHead(308, { location: `${mount}/` })
            return res.end()
          }
          if (!url.pathname.startsWith(`${mount}/`)) return fail(res, 404, 'not_found', '页面不存在。')
          url.pathname = url.pathname.slice(mount.length)
        }
        if (url.pathname.startsWith('/api/')) {
          if (!['/api/usage', '/api/quota'].includes(url.pathname)) return fail(res, 404, 'not_found', '接口不存在。')
          if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', '不支持的请求方式。')
          const origin = req.headers.origin
          if (origin) {
            let same = false
            try {
              same = publicOrigin
                ? origin === publicOrigin
                : new URL(origin).host === req.headers.host && ['https:', 'http:'].includes(new URL(origin).protocol)
            } catch {}
            if (!same) return fail(res, 403, 'origin_not_allowed', '仅允许从查询网页发起请求。')
          }
          if (!allowIp(getIp(req))) return fail(res, 429, 'rate_limited', '查询过于频繁，请稍后再试。')
          const auth = req.headers.authorization || ''
          if (!/^Bearer [^\s\x00-\x1f\x7f]{8,512}$/.test(auth))
            return fail(res, 401, 'invalid_key', '请输入有效的 API Key。')
          const seen = new Set()
          for (const [name, value] of url.searchParams) {
            if (url.pathname === '/api/quota' || !allowedQuery.has(name) || seen.has(name) || value.length > 2048)
              return fail(res, 400, 'invalid_query', '查询参数无效。')
            seen.add(name)
          }
          const keyHash = createHmac('sha256', hashSecret).update(auth).digest('hex')
          if (!allowKey(keyHash)) return fail(res, 429, 'rate_limited', '查询过于频繁，请稍后再试。')
          if (active >= maxConcurrent) return fail(res, 503, 'query_unavailable', '查询服务繁忙，请稍后重试。')
          const disconnect = new AbortController()
          res.once('close', () => disconnect.abort())
          active += 1
          try {
            const data = await queryUpstream({
              upstream: base,
              kind: url.pathname === '/api/quota' ? 'quota' : 'usage',
              search: url.search,
              authorization: auth,
              fetchImpl,
              timeoutMs,
              maxResponseBytes,
              signal: disconnect.signal,
            })
            return send(res, 200, data)
          } finally {
            active -= 1
          }
        }
        let file
        if (url.pathname === '/' || url.pathname === '/index.html') file = path.join(staticRoot, 'index.html')
        else if (/^\/assets\/[a-zA-Z0-9_./-]+$/.test(url.pathname) && !url.pathname.includes('..'))
          file = path.join(staticRoot, url.pathname.slice(1))
        else if (url.pathname === '/favicon.svg') file = path.join(staticRoot, 'favicon.svg')
        else return fail(res, 404, 'not_found', '页面不存在。')
        const info = await stat(file).catch(() => null)
        if (!info?.isFile()) return fail(res, 404, 'not_found', '页面不存在。')
        const type = contentTypes[path.extname(file)]
        if (!type) return fail(res, 404, 'not_found', '页面不存在。')
        res.writeHead(200, { 'content-type': type, 'content-length': info.size })
        res.end(req.method === 'HEAD' ? undefined : await readFile(file))
      } catch (error) {
        // Never reflect/log upstream errors, URLs or credential-bearing request objects.
        if (error instanceof PortalError) fail(res, error.status, error.code, error.message)
        else fail(res, 500, 'server_error', '查询暂时不可用，请稍后再试。')
      }
    },
  )
}
