import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { createKeySelfHandler, KEY_SELF_PATHS } from '../../src/lib/protocol/key-self.mjs'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const START = '2026-11-09T16:00:00.000Z'
const END = '2026-11-10T16:00:00.000Z'
const query = (extra = '') => new URLSearchParams(`start=${START}&end=${END}${extra}`)
async function modules() {
  return {
    ...(await import('../../src/lib/protocol/key-usage-range.mjs')),
    ...(await import('../../src/lib/db/key-usage-reader.mjs')),
  }
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-range-'))
  const dbPath = path.join(dir, 'kin.db')
  const db = createDatabase({ dbPath })
  const logs = new UsageLogsRepo(db)
  let seq = 0
  const add = (row = {}) =>
    logs.insertSummary({
      id: `r-${String(++seq).padStart(4, '0')}`,
      request_id: `req-${seq}`,
      created_at: START,
      method: 'POST',
      path: '/v1/messages',
      log_mode: 'normal',
      api_key_id: 'mine',
      status: 200,
      requested_model: 'public',
      upstream_model: 'secret-internal',
      model: 'secret-internal',
      actual_cost: 0.5,
      ...row,
    })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  // Preserve a known historical creation boundary for retention assertions.
  db.prepare("UPDATE schema_migrations SET applied_at = '2026-01-01T00:00:00.000Z' WHERE version = '001'").run()
  return { db, dbPath, logs, add }
}

test('range route is registered without changing the legacy route', () => {
  assert.ok(KEY_SELF_PATHS.has('/v1/me/usage/range'))
  assert.ok(KEY_SELF_PATHS.has('/v1/me/usage'))
})

test('range validation requires real offset timestamps, ordered bounded spans and safe parameters', async () => {
  const { parseUsageRangeQuery } = await modules()
  const parsed = parseUsageRangeQuery(
    new URLSearchParams({ start: '2026-11-10T00:00:00+08:00', end: '2026-11-11T00:00:00+08:00' }),
    NOW,
  )
  assert.deepEqual(parsed.range, { start: START, end: END, timezone: 'Asia/Shanghai', bucket: 'day' })
  assert.equal(parsed.limit, 20)
  for (const extra of [
    '&key_id=other',
    '&limit=0',
    '&limit=101',
    '&limit=1.5',
    '&bucket=week',
    '&tz=Mars/Base',
    '&start=2026-11-01T00:00:00Z',
    '&cursor=!',
    '&limit=',
  ]) {
    assert.throws(
      () => parseUsageRangeQuery(query(extra), NOW),
      (e) => e.status === 400,
      extra,
    )
  }
  for (const start of ['2026-11-10T00:00:00', '2026-02-30T00:00:00Z', '2026-11-10T00:00:00+24:00', END]) {
    assert.throws(
      () => parseUsageRangeQuery(new URLSearchParams({ start, end: END }), NOW),
      (e) => e.status === 400,
    )
  }
  assert.throws(
    () => parseUsageRangeQuery(new URLSearchParams({ start: '2026-01-01T00:00:00Z', end: END }), NOW),
    (e) => e.status === 400,
  )
  assert.throws(
    () => parseUsageRangeQuery(new URLSearchParams({ start: '2026-11-01T00:00:00Z', end: END, bucket: 'hour' }), NOW),
    (e) => e.status === 400,
  )
  const future = parseUsageRangeQuery(new URLSearchParams({ start: START, end: '2026-12-01T00:00:00Z' }), NOW)
  assert.equal(future.range.end, '2026-11-11T12:00:00.000Z')
})

test('one key and identical half-open bounds drive all sections, outcomes, costs and null client models', async (t) => {
  const { dbPath, add } = fixture(t)
  add({ created_at: '2026-11-09T15:59:59.999Z', actual_cost: 999 })
  add({ input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_creation_tokens: 40 })
  add({
    created_at: '2026-11-10T15:59:59.999Z',
    status: 500,
    error_code: 'upstream_error',
    requested_model: '',
    actual_cost: null,
  })
  add({ status: 0, actual_cost: null })
  add({ status: null, error_code: 'client_disconnected', actual_cost: 0 })
  add({ created_at: END, actual_cost: 999 })
  add({ api_key_id: 'other', actual_cost: 999 })
  const { parseUsageRangeQuery, readKeyUsageRange } = await modules()
  const result = await readKeyUsageRange({ dbPath, apiKeyId: 'mine', ...parseUsageRangeQuery(query(), NOW), now: NOW })
  assert.deepEqual(result.summary, {
    requests: 4,
    success: 1,
    errors: 1,
    other: 2,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 30,
    cache_creation_tokens: 40,
    total_tokens: 100,
    cost: 0.5,
    unpriced_requests: 2,
  })
  assert.deepEqual(result.series, [{ bucket: '2026-11-10', ...result.summary }])
  assert.equal(
    result.models.items.reduce((n, r) => n + r.requests, 0),
    4,
  )
  assert.ok(result.models.items.some((r) => r.model === null))
  assert.equal(result.recent.items.length, 4)
  assert.equal(result.recent.items.filter((r) => r.outcome === 'other').length, 2)
  assert.equal(result.recent.items.find((r) => r.status === 500).cost, null)
  assert.equal(result.coverage.status, 'unknown')
  assert.equal(result.coverage.available_from, '2026-01-01T00:00:00.000Z')
  assert.equal(result.as_of, '2026-11-11T12:00:00.000Z')
  assert.doesNotMatch(JSON.stringify(result), /secret-internal|api_key_id|user_id|upstream_model/)
})

test('top 50 models retain exact remaining aggregate and pruned empty history is partial', async (t) => {
  const { db, dbPath, add } = fixture(t)
  for (let i = 0; i < 53; i++) add({ requested_model: `public-${i}`, actual_cost: i, input_tokens: 1 })
  db.prepare("INSERT INTO settings(key,value) VALUES ('usage_logs_pruned_through',?)").run(
    JSON.stringify('2026-11-10T00:00:00.000Z'),
  )
  const { parseUsageRangeQuery, readKeyUsageRange } = await modules()
  const data = await readKeyUsageRange({ dbPath, apiKeyId: 'mine', ...parseUsageRangeQuery(query(), NOW), now: NOW })
  assert.equal(data.models.items.length, 50)
  assert.equal(data.models.truncated, true)
  assert.equal(data.models.other.requests, 3)
  assert.equal(data.models.other.cost, 3)
  assert.equal(data.models.items.reduce((n, r) => n + r.cost, 0) + data.models.other.cost, 1378)
  assert.equal(data.coverage.status, 'partial')
  assert.equal(data.coverage.missing_before, '2026-11-10T00:00:00.000Z')
  const empty = await readKeyUsageRange({ dbPath, apiKeyId: 'empty', ...parseUsageRangeQuery(query(), NOW), now: NOW })
  assert.equal(empty.summary.requests, 0)
  assert.equal(empty.coverage.status, 'partial')
})

test('signed cursors seek ties without duplicates and cannot cross keys, ranges or be altered', async (t) => {
  const { dbPath, add } = fixture(t)
  for (let i = 0; i < 5; i++) add()
  const { parseUsageRangeQuery, readKeyUsageRange } = await modules()
  const input = { dbPath, apiKeyId: 'mine', ...parseUsageRangeQuery(query('&limit=2'), NOW), now: NOW }
  const one = await readKeyUsageRange(input)
  assert.equal(one.recent.has_more, true)
  const two = await readKeyUsageRange({ ...input, cursor: one.recent.next_cursor })
  const three = await readKeyUsageRange({ ...input, cursor: two.recent.next_cursor })
  assert.equal(
    new Set([...one.recent.items, ...two.recent.items, ...three.recent.items].map((r) => r.request_id)).size,
    5,
  )
  assert.equal(three.recent.next_cursor, null)
  for (const change of [
    { apiKeyId: 'other' },
    { range: { ...input.range, end: '2026-11-10T15:00:00.000Z' } },
    { cursor: one.recent.next_cursor.slice(0, -3) + 'abc' },
  ]) {
    await assert.rejects(
      readKeyUsageRange({ ...input, cursor: one.recent.next_cursor, ...change }),
      (e) => e.status === 400,
    )
  }
})

test('local hourly labels distinguish repeated DST hours and support fractional UTC offsets', async (t) => {
  const { dbPath, add } = fixture(t)
  add({ created_at: '2026-11-01T05:15:00.000Z' })
  add({ created_at: '2026-11-01T06:15:00.000Z' })
  const { parseUsageRangeQuery, readKeyUsageRange } = await modules()
  const opts = parseUsageRangeQuery(
    new URLSearchParams({
      start: '2026-11-01T04:00:00Z',
      end: '2026-11-02T05:00:00Z',
      tz: 'America/New_York',
      bucket: 'hour',
    }),
    NOW,
  )
  const data = await readKeyUsageRange({ dbPath, apiKeyId: 'mine', ...opts, now: NOW })
  assert.deepEqual(
    data.series.map((r) => r.bucket),
    ['2026-11-01T01:00:00-04:00', '2026-11-01T01:00:00-05:00'],
  )
})

test('legacy plaintext owner is checked before migration and authentication has no writes on rejection', (t) => {
  const { db } = fixture(t)
  const store = new ApiKeyStore({ db })
  store.users.insert({
    id: 'owner',
    username: 'owner',
    password_hash: 'x',
    role: 'user',
    created_at: START,
    updated_at: START,
  })
  const key = store.create({ name: 'legacy', user_id: 'owner' })
  db.prepare('UPDATE api_keys SET key = ?, key_hash = NULL WHERE id = ?').run(key.key, key.id)
  store.users.update({ ...store.users.getById('owner'), enabled: false })
  assert.deepEqual(store.authenticate(key.key), { ok: false, reason: 'user_disabled' })
  assert.equal(db.prepare('SELECT key_hash FROM api_keys WHERE id = ?').get(key.id).key_hash, null)
})

test('range handler is no-store, requires a managed bearer and never falls back to inference-thread logs', async (t) => {
  const { dbPath, db } = fixture(t)
  const store = new ApiKeyStore({ db })
  const key = store.create({ name: 'expired', expires_at: '2020-01-01T00:00:00.000Z', quota_requests: 1 })
  store.recordUsage(key.id, {})
  const before = store.getById(key.id)
  const handle = createKeySelfHandler({
    json: (res, status, body) => Object.assign(res, { status, body }),
    requireAuth: (req) => {
      const result = store.authenticate(req.headers.authorization?.slice(7))
      if (!result.ok) return false
      req.apiKeyKind = 'managed'
      req.apiKeyRecord = result.record
      return true
    },
    apiKeyStore: store,
    getUsageLogs: () => assert.fail('main-thread fallback'),
    getUsageDbPath: () => dbPath,
  })
  const res = {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v
    },
  }
  await handle(
    { headers: { authorization: `Bearer ${key.key}` } },
    res,
    new URL(`http://localhost/v1/me/usage/range?${query()}`),
    NOW,
  )
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.body.object, 'api_key_usage_range')
  assert.deepEqual(store.getById(key.id), before)
  const bad = {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v
    },
  }
  await handle(
    { headers: { 'x-api-key': key.key } },
    bad,
    new URL(`http://localhost/v1/me/usage/range?${query()}`),
    NOW,
  )
  assert.equal(bad.status, 401)
  assert.equal(bad.headers['cache-control'], 'no-store')
})

test('fractional offset hourly labels use wall-clock hours', async (t) => {
  const { dbPath, add } = fixture(t)
  add({ created_at: '2026-11-10T00:10:00.000Z' })
  const { parseUsageRangeQuery, readKeyUsageRange } = await modules()
  const options = parseUsageRangeQuery(
    new URLSearchParams({
      start: '2026-11-10T00:00:00Z',
      end: '2026-11-11T00:00:00Z',
      bucket: 'hour',
      tz: 'Asia/Kathmandu',
    }),
    NOW,
  )
  const data = await readKeyUsageRange({ dbPath, apiKeyId: 'mine', ...options, now: NOW })
  assert.equal(data.series[0].bucket, '2026-11-10T05:00:00+05:45')
})

test('range errors are no-store and safe, bound cursor validation precedes process admission', async (t) => {
  const { db } = fixture(t)
  const store = new ApiKeyStore({ db })
  const key = store.create({ name: 'normal' })
  const handle = createKeySelfHandler({
    apiKeyStore: store,
    json: (res, status, body) => Object.assign(res, { status, body }),
    readUsageRange: async () => {
      throw Object.assign(new Error('secret-path-and-key'), { status: 504, code: 'internal-secret' })
    },
  })
  async function call(headers, q = query()) {
    const res = {
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v
      },
    }
    await handle({ headers }, res, new URL(`http://localhost/v1/me/usage/range?${q}`), NOW)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.doesNotMatch(JSON.stringify(res.body), /secret-path-and-key|internal-secret/)
    return res
  }
  assert.equal((await call({ authorization: `Bearer ${key.key}` })).status, 504)
  assert.equal((await call({ authorization: 'Bearer master-token' })).status, 401)
  store.update(key.id, { status: 'disabled' })
  assert.equal((await call({ authorization: `Bearer ${key.key}` })).status, 401)
  store.update(key.id, { status: 'active' })
  assert.equal((await call({ authorization: `Bearer ${key.key}` }, query('&key_id=other'))).status, 400)
})

test('range rate limit is key-scoped and does not consume inference accounting', async (t) => {
  const { db } = fixture(t)
  const store = new ApiKeyStore({ db })
  const a = store.create({ name: 'a' }),
    b = store.create({ name: 'b' })
  const handle = createKeySelfHandler({
    apiKeyStore: store,
    json: (res, status, body) => Object.assign(res, { status, body }),
    readUsageRange: async () => ({ object: 'api_key_usage_range' }),
  })
  async function call(key, now = NOW) {
    const res = {
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v
      },
    }
    await handle(
      { headers: { authorization: `Bearer ${key.key}` } },
      res,
      new URL(`http://localhost/v1/me/usage/range?${query()}`),
      now,
    )
    return res
  }
  for (let i = 0; i < 20; i++) assert.equal((await call(a)).status, 200)
  const limited = await call(a)
  assert.equal(limited.status, 429)
  assert.equal(limited.headers['retry-after'], '60')
  assert.equal((await call(b)).status, 200)
  assert.equal((await call(a, NOW + 60000)).status, 200)
  assert.equal(store.getById(a.id).requests, 0)
  assert.equal(store.getById(a.id).quota_requests_used, 0)
})

test('range queries seek the existing per-key time index', async (t) => {
  const { db, add } = fixture(t)
  add()
  const { queryKeyUsageRange } = await import('../../src/lib/db/repos/key-usage-range-repo.mjs')
  const { parseUsageRangeQuery } = await modules()
  const options = { apiKeyId: 'mine', ...parseUsageRangeQuery(query(), NOW), now: NOW }
  const statements = []
  const prepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    if (/FROM usage_logs WHERE api_key_id/.test(sql)) statements.push(sql)
    return prepare(sql)
  }
  queryKeyUsageRange(db, options)
  db.prepare = prepare
  assert.equal(statements.length, 4)
  for (const sql of statements) {
    const params = Array.from({ length: (sql.match(/\?/g) || []).length }, () => 'x')
    const details = prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => row.detail)
      .join('\n')
    assert.match(details, /USING INDEX idx_reqlog_key \(api_key_id=\? AND created_at>\? AND created_at<\?\)/)
  }
})

test('oversized UTF-8 log identities are rejected in the query child before IPC without truncation', async (t) => {
  const { db, dbPath, add } = fixture(t)
  const { fork } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const { createKeyUsageReader, parseUsageRangeQuery } = await modules()
  const wireMessages = []
  const read = createKeyUsageReader({
    startProcess: () => {
      const child = fork(fileURLToPath(new URL('../../src/lib/db/key-usage-worker.mjs', import.meta.url)), [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: [],
        env: { NODE_NO_WARNINGS: '1' },
        serialization: 'advanced',
      })
      child.on('message', (message) => wireMessages.push(message))
      return child
    },
  })
  // 350000 chars fit below 1MiB as UTF-16 code points, but require 1050000 UTF-8 bytes.
  const huge = '界'.repeat(350000)
  for (const field of ['requested_model', 'request_id', 'error_code']) {
    db.exec('DELETE FROM usage_logs')
    add({ [field]: huge })
    await assert.rejects(
      read({ dbPath, apiKeyId: 'mine', ...parseUsageRangeQuery(query(), NOW), now: NOW }),
      (error) => error.status === 503 && !error.message.includes('界'),
    )
    assert.deepEqual(wireMessages.at(-1), { ok: false }, `${field} never crossed IPC as a success payload`)
  }
  db.exec('DELETE FROM usage_logs')
  add({ request_id: 'small-visible-request' })
  const small = await read({ dbPath, apiKeyId: 'mine', ...parseUsageRangeQuery(query(), NOW), now: NOW })
  assert.equal(small.recent.items[0].request_id, 'small-visible-request')
})

test('valid responses above IPC buffering size arrive completely before child disconnect', async (t) => {
  const { dbPath, add } = fixture(t)
  const model = 'visible-'.repeat(1024)
  for (let i = 0; i < 20; i++) add({ requested_model: model, request_id: `full-${i}` })
  const { readKeyUsageRange, parseUsageRangeQuery } = await modules()
  const data = await readKeyUsageRange({ dbPath, apiKeyId: 'mine', ...parseUsageRangeQuery(query(), NOW), now: NOW })
  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf8')
  assert.ok(bytes > 128 * 1024 && bytes <= 1024 * 1024 - 8 * 1024)
  assert.equal(data.summary.requests, 20)
  assert.equal(data.recent.items.length, 20)
  assert.ok(data.recent.items.every((item) => item.model === model))
  assert.equal(new Set(data.recent.items.map((item) => item.request_id)).size, 20)
})

test('corrupt oversized internal row IDs cannot expand the public cursor beyond accepted bounds', async (t) => {
  const { db, dbPath, add } = fixture(t)
  add({ request_id: 'first' })
  add({ request_id: 'second' })
  db.prepare('UPDATE usage_logs SET id = ? WHERE request_id = ?').run('z'.repeat(800000), 'first')
  const { readKeyUsageRange, parseUsageRangeQuery } = await modules()
  await assert.rejects(
    readKeyUsageRange({ dbPath, apiKeyId: 'mine', ...parseUsageRangeQuery(query('&limit=1'), NOW), now: NOW }),
    (error) => error.status === 503,
  )
})
