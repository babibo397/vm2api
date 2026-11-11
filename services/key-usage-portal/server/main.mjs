import { createPortalServer } from './app.mjs'

function positiveInt(value, fallback, max) {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('Invalid numeric server configuration')
  return n
}
const server = createPortalServer({
  upstream: process.env.VM2API_UPSTREAM || 'http://vm2api.vm2api.svc.cluster.local:8787',
  staticDir: process.env.STATIC_DIR,
  publicOrigin: process.env.PUBLIC_ORIGIN || null,
  basePath: process.env.BASE_PATH || '',
  trustedProxyCidrs: (process.env.TRUST_PROXY_CIDRS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
  keyLimit: positiveInt(process.env.KEY_RATE_LIMIT, 20, 600),
  ipLimit: positiveInt(process.env.IP_RATE_LIMIT, 60, 6000),
})
server.listen(positiveInt(process.env.PORT, 8080, 65535), '0.0.0.0', () => console.log('Key usage portal ready'))
const close = () => {
  server.close(() => process.exit(0))
  setTimeout(() => {
    server.closeAllConnections()
    process.exit(0)
  }, 12000).unref()
}
process.once('SIGTERM', close)
process.once('SIGINT', close)
