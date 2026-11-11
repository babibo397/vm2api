import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPortalServer } from '../server/app.mjs'
import { queryUpstream } from '../server/proxy.mjs'

const key = 'sk-vm-fixture-not-a-real-secret'
const headers = { authorization: `Bearer ${key}` }
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-portal-'))
  await writeFile(path.join(dir, 'index.html'), '<html><title>Key 用量</title></html>')
  const calls = []
  const server = createPortalServer({
    staticDir: dir,
    upstream: 'http://127.0.0.1:8787',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(
        JSON.stringify({
          object: 'api_key_usage_range',
          range: { start: 's', end: 'e', timezone: 'Asia/Shanghai', bucket: 'day' },
          summary: { requests: 1 },
          series: [],
          models: { items: [], truncated: false, other: null },
          recent: { items: [], has_more: false, next_cursor: null },
          internal_secret: 'must-not-leak',
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    },
    ...options,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    await rm(dir, { recursive: true, force: true })
  })
  return { url: `http://127.0.0.1:${server.address().port}`, calls }
}

test('only forwards own Bearer and whitelisted range query, strips other headers and fields', async (t) => {
  const f = await fixture(t)
  const response = await fetch(`${f.url}/api/usage?start=2026-11-01T00:00:00Z&end=2026-11-02T00:00:00Z`, {
    headers: { ...headers, cookie: 'kin-panel=secret', 'x-panel-token': 'admin', 'x-api-key': 'someone-else' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.internal_secret, undefined)
  assert.equal(f.calls.length, 1)
  assert.match(f.calls[0].url, /\/v1\/me\/usage\/range\?/)
  assert.deepEqual(f.calls[0].init.headers, { authorization: headers.authorization, accept: 'application/json' })
  assert.equal(f.calls[0].init.redirect, 'error')
})

test('rejects auth, routes and extra query without contacting upstream', async (t) => {
  const f = await fixture(t)
  for (const [url, opts, status] of [
    ['/api/usage', {}, 401],
    ['/api/usage?key_id=other', { headers }, 400],
    ['/api/usage?start=x&start=y', { headers }, 400],
    ['/api/panel/api-keys', { headers }, 404],
    ['/api/usage', { headers, method: 'POST' }, 405],
  ])
    assert.equal((await fetch(f.url + url, opts)).status, status)
  assert.equal(f.calls.length, 0)
})

test('quota uses nested whitelist and hides owner aggregate and arbitrary fields', async (t) => {
  const f = await fixture(t, {
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          key: { name: 'mine', masked_key: 'sk…1234', secret: key },
          usd: { used: 2, limit: 10, remaining: 8, secret: 'x' },
          windows: { '1d': { used: 2, remaining: 3, secret: 'x' } },
          requests: { used: 4 },
          user_concurrency: { inflight: 19 },
          owner: 'x',
        }),
      ),
  })
  const res = await fetch(f.url + '/api/quota', { headers })
  const b = await res.json()
  assert.equal(b.key.name, 'mine')
  assert.equal(b.key.secret, undefined)
  assert.equal(b.user_concurrency, undefined)
  assert.equal(b.owner, undefined)
  assert.equal(b.usd.secret, undefined)
  assert.equal(b.windows['1d'].secret, undefined)
})

test('unsafe upstream errors are sanitized and deadlines include response body', async (t) => {
  const f = await fixture(t, {
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { code: 'secret:' + key, message: key } }), { status: 401 }),
  })
  const res = await fetch(f.url + '/api/usage', { headers })
  assert.equal(res.status, 401)
  assert.ok(!(await res.text()).includes(key))
  const slow = await fixture(t, {
    timeoutMs: 30,
    fetchImpl: async () => new Response(new ReadableStream({ start() {}, cancel() {} })),
  })
  const expired = await fetch(slow.url + '/api/usage', { headers })
  assert.equal(expired.status, 504)
})

test('oversized or malformed upstream response is rejected without exposing content', async (t) => {
  for (const body of ['x'.repeat(300), '<html>private</html>']) {
    const f = await fixture(t, { maxResponseBytes: 100, fetchImpl: async () => new Response(body) })
    const res = await fetch(f.url + '/api/usage', { headers })
    assert.equal(res.status, 502)
    assert.ok(!(await res.text()).includes('private'))
  }
})

test('Key and IP limits are independent, spoofed forwarding headers cannot bypass IP limit', async (t) => {
  const f = await fixture(t, { keyLimit: 1, ipLimit: 10 })
  assert.equal((await fetch(f.url + '/api/usage', { headers })).status, 200)
  assert.equal((await fetch(f.url + '/api/usage', { headers })).status, 429)
  assert.equal((await fetch(f.url + '/api/usage', { headers: { authorization: 'Bearer different-key' } })).status, 200)
  const ip = await fixture(t, { ipLimit: 1 })
  assert.equal((await fetch(ip.url + '/api/usage', { headers })).status, 200)
  assert.equal(
    (
      await fetch(ip.url + '/api/usage', {
        headers: { authorization: 'Bearer second-key', 'x-forwarded-for': '8.8.8.8' },
      })
    ).status,
    429,
  )
})

test('static page has CSP and no credential persistence, unknown paths fail closed', async (t) => {
  const f = await fixture(t)
  const page = await fetch(f.url)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/)
  assert.match(await page.text(), /Key 用量/)
  assert.equal((await fetch(f.url + '/server/main.mjs')).status, 404)
  assert.equal((await fetch(f.url + '/healthz')).status, 200)
  assert.equal(
    (await fetch(f.url + '/api/usage', { headers: { ...headers, origin: 'https://evil.example' } })).status,
    403,
  )
})

test('can mount beneath an existing host without exposing a broad reverse proxy', async (t) => {
  const f = await fixture(t, { basePath: '/usage' })
  assert.equal((await fetch(f.url + '/usage/')).status, 200)
  assert.equal((await fetch(f.url + '/usage/api/usage', { headers })).status, 200)
  assert.equal((await fetch(f.url + '/api/usage', { headers })).status, 404)
  assert.equal((await fetch(f.url + '/usage-other/api/usage', { headers })).status, 404)
  assert.equal((await fetch(f.url + '/healthz')).status, 200)
})

test('real upstream redirects never receive the key at a different target', async (t) => {
  const http = await import('node:http')
  let received = 0
  const destination = http.createServer((_req, res) => {
    received++
    res.end('{}')
  })
  destination.listen(0, '127.0.0.1')
  await once(destination, 'listening')
  const source = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/secret` })
    res.end()
  })
  source.listen(0, '127.0.0.1')
  await once(source, 'listening')
  t.after(() => {
    destination.closeAllConnections()
    destination.close()
    source.closeAllConnections()
    source.close()
  })
  const f = await fixture(t, { upstream: `http://127.0.0.1:${source.address().port}`, fetchImpl: fetch })
  assert.equal((await fetch(f.url + '/api/usage', { headers })).status, 502)
  assert.equal(received, 0)
})

test('oversized declared body is canceled or aborted before the upstream query settles', async () => {
  let canceled = false
  let upstreamSignal
  await assert.rejects(
    queryUpstream({
      upstream: new URL('http://127.0.0.1:8787'),
      kind: 'usage',
      authorization: headers.authorization,
      maxResponseBytes: 100,
      fetchImpl: async (_url, { signal }) => {
        upstreamSignal = signal
        return new Response(
          new ReadableStream({
            cancel() {
              canceled = true
            },
          }),
          { headers: { 'content-type': 'application/json', 'content-length': '10000000' } },
        )
      },
    }),
    { status: 502, code: 'upstream_error' },
  )
  assert.equal(canceled || upstreamSignal.aborted, true)
})
