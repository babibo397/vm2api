import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { createKeySelfHandler } from '../../src/lib/protocol/key-self.mjs'
import { createPortalServer } from '../../services/key-usage-portal/server/app.mjs'

test('HTTP portal reconciles real SQLite usage per Key without recording inference or exposing owner data', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-portal-integration-'))
  const dbPath = path.join(dir, 'kin.db')
  const db = createDatabase({ dbPath })
  const store = new ApiKeyStore({ db })
  const logs = new UsageLogsRepo(db)
  const one = store.create({ name: 'One' })
  const two = store.create({ name: 'Two' })
  const start = '2026-11-09T16:00:00.000Z'
  const end = '2026-11-10T16:00:00.000Z'
  for (const [id, key, cost, time] of [
    ['one-a', one.id, 0.25, start],
    ['one-b', one.id, 0.75, start],
    ['one-end', one.id, 999, end],
    ['two-a', two.id, 17, start],
  ]) {
    logs.insertSummary({
      id,
      request_id: id,
      api_key_id: key,
      actual_cost: cost,
      created_at: time,
      method: 'POST',
      path: '/v1/responses',
      log_mode: 'normal',
      status: 200,
      requested_model: 'public-model',
      upstream_model: 'private-model',
      input_tokens: 10,
      output_tokens: 5,
    })
  }
  const before = store.getById(one.id)
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const handler = createKeySelfHandler({
    json,
    apiKeyStore: store,
    getUsageDbPath: () => dbPath,
    requireAuth(req, res) {
      const auth = store.authenticate(req.headers.authorization?.slice(7))
      if (!auth.ok) {
        json(res, 401, {})
        return false
      }
      req.apiKeyKind = 'managed'
      req.apiKeyRecord = auth.record
      return true
    },
  })
  const gateway = http.createServer((req, res) =>
    handler(req, res, new URL(req.url, 'http://test'), Date.parse('2026-11-11T12:00:00Z')),
  )
  const listen = (server) =>
    new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
  const upstream = await listen(gateway)
  const portal = createPortalServer({ upstream, basePath: '/usage', keyLimit: 100, ipLimit: 100 })
  const origin = await listen(portal)
  t.after(async () => {
    for (const server of [portal, gateway]) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const query = new URLSearchParams({ start, end, limit: '1' })
  async function call(key, route = `/api/usage?${query}`) {
    const response = await fetch(`${origin}/usage${route}`, { headers: { authorization: `Bearer ${key}` } })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return { status: response.status, data: await response.json() }
  }
  const a = await call(one.key)
  assert.equal(a.status, 200)
  const sql = db
    .prepare(
      'SELECT COUNT(*) AS requests, SUM(actual_cost) AS cost FROM usage_logs WHERE api_key_id=? AND created_at>=? AND created_at<?',
    )
    .get(one.id, start, end)
  assert.equal(a.data.summary.requests, sql.requests)
  assert.equal(a.data.summary.cost, sql.cost)
  assert.equal(a.data.summary.total_tokens, 30)
  assert.equal(a.data.models.items[0].model, 'public-model')
  const b = await call(two.key)
  assert.equal(b.data.summary.requests, 1)
  assert.equal(b.data.summary.cost, 17)
  const pageRoute = `/api/usage?${query}&cursor=${encodeURIComponent(a.data.recent.next_cursor)}`
  const page = await call(one.key, pageRoute)
  assert.equal(page.status, 200)
  assert.notEqual(page.data.recent.items[0].request_id, a.data.recent.items[0].request_id)
  assert.equal((await call(two.key, pageRoute)).status, 400)
  assert.equal((await call(one.key, `/api/usage?${query}&key_id=${two.id}`)).status, 400)
  assert.equal((await call('sk-vm-invalid')).status, 401)
  const quota = await call(one.key, '/api/quota')
  assert.equal(quota.status, 200)
  assert.equal(quota.data.key.name, 'One')
  assert.doesNotMatch(
    JSON.stringify([a.data, quota.data]),
    /private-model|api_key_id|user_id|user_concurrency|key_hash/,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get().n, 4)
  assert.deepEqual(store.getById(one.id), before)
})
