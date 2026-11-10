import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeProxyFetch } from '../../src/lib/protocol/codex-models.mjs'
import { queryOpenaiQuota, CHATGPT_USAGE_URL } from '../../src/lib/oauth/openai-quota.mjs'
import { createCodexQuotaMonitor } from '../../src/lib/oauth/codex-quota-monitor.mjs'
import { getVm, listVms } from '../../src/lib/vm/vm-registry.mjs'
import { orderCodexSessionSlots } from '../../src/lib/pool/codex-slot-pool.mjs'

async function localServer(t, handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

function writeSlot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-quota-deadline-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'vm-a'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-a.json'),
    JSON.stringify({
      id: 'vm-a',
      platform: 'openai',
      family: 'codex',
      status: 'stopped',
      schedulable: true,
      proxy: { url: 'socks5h://127.0.0.1:1080' },
      codex: {
        has_access: true,
        credits: {
          has_credits: true,
          unlimited: false,
          balance: '12',
          fetched_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        },
        extra: {
          codex_7d_used_percent: 100,
          codex_7d_window_minutes: 10080,
          codex_7d_reset_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
      },
    }),
  )
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-a', 'codex-credentials.json'),
    JSON.stringify({
      accounts: [
        {
          access_token: 'fixture-access-secret',
          refresh_token: 'fixture-refresh-secret',
          chatgpt_account_id: 'fixture-account',
        },
      ],
    }),
  )
  return root
}

test('a stalled 200 quota body is aborted without renewing credits, and the next monitor pass recovers', async (t) => {
  const root = writeSlot(t)
  const previous = structuredClone(getVm(root, 'vm-a').codex.credits)
  let stall = true
  let forcedClose = false
  let bodyClosed
  const closed = new Promise((resolve) => {
    bodyClosed = resolve
  })
  const baseUrl = await localServer(t, (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/usage' && stall) {
      res.writeHead(200)
      res.write('{"credits":')
      // A broken deadline must fail the assertion rather than hang the test runner.
      const safety = setTimeout(() => {
        forcedClose = true
        res.destroy()
      }, 1000)
      res.once('close', () => {
        clearTimeout(safety)
        bodyClosed()
      })
      return
    }
    res.end(
      JSON.stringify(
        req.url === '/usage'
          ? {
              rate_limit: {
                primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 86_400 },
              },
              credits: { has_credits: true, unlimited: false, balance: '12' },
              rate_limit_reset_credits: { available_count: 0 },
            }
          : [],
      ),
    )
  })
  const actualFetch = makeProxyFetch('', 3000)
  let now = Date.now()
  let result
  const monitor = createCodexQuotaMonitor({
    now: () => now,
    listTargets: () => listVms(root),
    queryQuota: async (vm) => {
      result = await queryOpenaiQuota({
        projectRoot: root,
        vmId: vm.id,
        rotate: false,
        timeoutMs: 100,
        fetchImpl: (url, init) => actualFetch(`${baseUrl}${url === CHATGPT_USAGE_URL ? '/usage' : '/credits'}`, init),
      })
      return result
    },
  })
  await monitor.tick()
  assert.deepEqual(result, { ok: false, error: 'timeout', message: '上游超时', status: 502 })
  await closed
  assert.equal(forcedClose, false, 'the deadline must cancel the actual HTTP body')
  assert.deepEqual(getVm(root, 'vm-a').codex.credits, previous)
  assert.equal(orderCodexSessionSlots(listVms(root)).error, 'quota_exhausted')
  assert.doesNotMatch(JSON.stringify(result), /fixture-access-secret|fixture-refresh-secret/)

  stall = false
  now += 60_000
  await monitor.tick()
  assert.equal(result.ok, true)
  assert.deepEqual(orderCodexSessionSlots(listVms(root)).ids, ['vm-a'])
})

test('makeProxyFetch honors an already-aborted caller signal without sending the request', async (t) => {
  let requests = 0
  const url = await localServer(t, (_req, res) => {
    requests += 1
    res.end('{}')
  })
  const controller = new AbortController()
  controller.abort(new Error('fixture-access-secret'))
  await assert.rejects(makeProxyFetch('')(url, { signal: controller.signal }), (error) => {
    assert.equal(error.name, 'AbortError')
    assert.doesNotMatch(error.message, /fixture-access-secret/)
    return true
  })
  assert.equal(requests, 0)
})

test('makeProxyFetch preserves caller cancellation after response headers arrive', async (t) => {
  let forcedClose = false
  let bodyClosed
  const closed = new Promise((resolve) => {
    bodyClosed = resolve
  })
  const url = await localServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{')
    const safety = setTimeout(() => {
      forcedClose = true
      res.destroy()
    }, 1000)
    res.once('close', () => {
      clearTimeout(safety)
      bodyClosed()
    })
  })
  const controller = new AbortController()
  const response = await makeProxyFetch('')(url, { signal: controller.signal })
  const body = response.json()
  controller.abort()
  await assert.rejects(body, { name: 'AbortError' })
  await closed
  assert.equal(forcedClose, false)
})
