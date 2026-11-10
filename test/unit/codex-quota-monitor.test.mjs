import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCodexQuotaMonitor } from '../../src/lib/oauth/codex-quota-monitor.mjs'
import { queryOpenaiQuota, CHATGPT_USAGE_URL, CHATGPT_RESET_CREDITS_URL } from '../../src/lib/oauth/openai-quota.mjs'
import { getVm, listVms, setScheduleOff } from '../../src/lib/vm/vm-registry.mjs'
import { evaluateOpenAIQuotaGate } from '../../src/lib/pool/openai-quota-policy.mjs'
import { orderCodexSessionSlots } from '../../src/lib/pool/codex-slot-pool.mjs'

const NOW = Date.parse('2026-11-10T10:00:00Z')

function credits(at = NOW, patch = {}) {
  return { has_credits: true, unlimited: false, balance: '12.50', fetched_at: new Date(at).toISOString(), ...patch }
}

function slot(id = 'vm-a', patch = {}) {
  return {
    id,
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: true,
    has_token: true,
    has_refresh: true,
    proxy: { url: 'socks5h://127.0.0.1:1080' },
    ...patch,
  }
}

function fixture(t, codexPatch = {}) {
  const now = Date.now()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-quota-monitor-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'vm-a'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-a.json'),
    JSON.stringify(
      slot('vm-a', {
        status: 'stopped',
        temp_unschedulable_reason: 'quota_7d_header',
        temp_unschedulable_until: now + 86_400_000,
        codex: {
          has_access: true,
          has_refresh: true,
          chatgpt_account_id: 'fixture-account',
          credits: credits(now - 20 * 60_000),
          extra: {
            codex_5h_used_percent: 20,
            codex_5h_window_minutes: 300,
            codex_5h_reset_at: new Date(now + 3_600_000).toISOString(),
            codex_7d_used_percent: 100,
            codex_7d_window_minutes: 10080,
            codex_7d_reset_at: new Date(now + 86_400_000).toISOString(),
          },
          ...codexPatch,
        },
      }),
    ),
  )
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-a', 'codex-credentials.json'),
    JSON.stringify({
      accounts: [
        { access_token: 'fixture-access', refresh_token: 'fixture-refresh', chatgpt_account_id: 'fixture-account' },
      ],
    }),
  )
  return root
}

function usageFetch(spendable, resetCredits = []) {
  return async (url, options) => {
    assert.equal(options.method, 'GET', 'refresh must never redeem a reset credit')
    if (String(url).startsWith(CHATGPT_USAGE_URL)) {
      return {
        status: 200,
        json: async () => ({
          rate_limit: {
            primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 86_400 },
            secondary_window: { used_percent: 20, limit_window_seconds: 18000, reset_after_seconds: 3600 },
          },
          credits: { has_credits: spendable, unlimited: false, balance: spendable ? '12.50' : '0' },
          rate_limit_reset_credits: { available_count: resetCredits.length },
        }),
      }
    }
    if (String(url).startsWith(CHATGPT_RESET_CREDITS_URL)) return { status: 200, json: async () => resetCredits }
    throw new Error('unexpected upstream request')
  }
}

test('refresh restores admission for a stopped Codex slot with stale credits and a full weekly window', async (t) => {
  const resetCredits = [{ expires_at: new Date(Date.now() + 86_400_000).toISOString() }]
  const root = fixture(t, { reset_credits: { available_count: 1, credits: resetCredits } })
  assert.equal(orderCodexSessionSlots(listVms(root)).error, 'quota_exhausted')
  const monitor = createCodexQuotaMonitor({
    listTargets: () => listVms(root),
    queryQuota: (vm) =>
      queryOpenaiQuota({ projectRoot: root, vmId: vm.id, rotate: false, fetchImpl: usageFetch(true, resetCredits) }),
  })
  await monitor.tick()
  assert.deepEqual(orderCodexSessionSlots(listVms(root)).ids, ['vm-a'])
  assert.equal(getVm(root, 'vm-a').codex.extra.codex_7d_used_percent, 100)
  assert.equal(getVm(root, 'vm-a').temp_unschedulable_reason, undefined)
  assert.equal(getVm(root, 'vm-a').codex.reset_credits.available_count, 1)
})

test('an exhausted credit response keeps a full weekly window blocked', async (t) => {
  const root = fixture(t)
  const monitor = createCodexQuotaMonitor({
    listTargets: () => listVms(root),
    queryQuota: (vm) =>
      queryOpenaiQuota({ projectRoot: root, vmId: vm.id, rotate: false, fetchImpl: usageFetch(false) }),
  })
  await monitor.tick()
  assert.equal(getVm(root, 'vm-a').codex.credits.has_credits, false)
  assert.equal(orderCodexSessionSlots(listVms(root)).error, 'quota_exhausted')
})

test('a real quota-query auth failure never rotates OAuth or renews stale credit data', async (t) => {
  const root = fixture(t)
  const before = structuredClone(getVm(root, 'vm-a').codex.credits)
  const requests = []
  const monitor = createCodexQuotaMonitor({
    listTargets: () => listVms(root),
    queryQuota: (vm) =>
      queryOpenaiQuota({
        projectRoot: root,
        vmId: vm.id,
        rotate: false,
        fetchImpl: async (url, options) => {
          requests.push({ url, method: options.method })
          return { status: 401, json: async () => ({ error: 'unauthorized' }) }
        },
      }),
  })
  await monitor.tick()
  assert.deepEqual(requests, [{ url: CHATGPT_USAGE_URL, method: 'GET' }])
  assert.deepEqual(getVm(root, 'vm-a').codex.credits, before)
  assert.equal(orderCodexSessionSlots(listVms(root)).error, 'quota_exhausted')
})

test('a malformed upstream credit reading cannot renew the stale credit waiver', async (t) => {
  const root = fixture(t)
  const before = structuredClone(getVm(root, 'vm-a').codex.credits)
  const fetchUsage = usageFetch(true)
  const monitor = createCodexQuotaMonitor({
    listTargets: () => listVms(root),
    queryQuota: (vm) =>
      queryOpenaiQuota({
        projectRoot: root,
        vmId: vm.id,
        rotate: false,
        fetchImpl: async (url, options) => {
          const response = await fetchUsage(url, options)
          if (url !== CHATGPT_USAGE_URL) return response
          const payload = await response.json()
          delete payload.credits.unlimited
          return { ...response, json: async () => payload }
        },
      }),
  })
  await monitor.tick()
  assert.deepEqual(getVm(root, 'vm-a').codex.credits, before)
  assert.equal(orderCodexSessionSlots(listVms(root)).error, 'quota_exhausted')
})

test('an operator stop during an in-flight refresh remains off after credits recover', async (t) => {
  const root = fixture(t)
  let finishUsage
  const pendingUsage = new Promise((resolve) => {
    finishUsage = resolve
  })
  const fetchUsage = usageFetch(true)
  const monitor = createCodexQuotaMonitor({
    listTargets: () => listVms(root),
    queryQuota: (vm) =>
      queryOpenaiQuota({
        projectRoot: root,
        vmId: vm.id,
        rotate: false,
        fetchImpl: async (url, options) => {
          if (url === CHATGPT_USAGE_URL) await pendingUsage
          return fetchUsage(url, options)
        },
      }),
  })
  const running = monitor.tick()
  await new Promise(setImmediate)
  setScheduleOff(root, 'vm-a', true)
  finishUsage()
  await running
  const vm = getVm(root, 'vm-a')
  assert.equal(vm.codex.credits.has_credits, true)
  assert.equal(vm.schedule_off, true)
  assert.equal(vm.schedulable, false)
  assert.deepEqual(orderCodexSessionSlots(listVms(root)).ids, [])
})

test('refreshes at five minutes before the credit waiver expires and accepts both credit projections', async () => {
  let now = NOW
  const summary = slot('summary', { codex_credits: credits() })
  const raw = slot('raw', { codex: { credits: credits() } })
  const queried = []
  const monitor = createCodexQuotaMonitor({
    now: () => now,
    listTargets: () => [summary, raw],
    queryQuota: async (vm) => {
      queried.push(vm.id)
      return { ok: true }
    },
  })
  await monitor.tick()
  now += 299_999
  await monitor.tick()
  assert.deepEqual(queried, [])
  now += 1
  await monitor.tick()
  assert.deepEqual(queried.sort(), ['raw', 'summary'])
})

test('missing, malformed and future credit timestamps are refreshed', async () => {
  const queried = []
  const monitor = createCodexQuotaMonitor({
    now: () => NOW,
    listTargets: () => [
      slot('missing'),
      slot('invalid', { codex_credits: credits(NOW, { fetched_at: 'bad-date' }) }),
      slot('future', { codex_credits: credits(NOW + 60_000) }),
    ],
    queryQuota: async (vm) => {
      queried.push(vm.id)
      return { ok: true }
    },
  })
  await monitor.tick()
  assert.deepEqual(queried.sort(), ['future', 'invalid', 'missing'])
})

test('failed queries preserve stale credit gates and retry no sooner than one minute after failure', async () => {
  let now = NOW
  const vm = slot('vm-a', {
    codex_credits: credits(NOW - 20 * 60_000),
    utilization_7d: 1,
    reset_7d: new Date(NOW + 86_400_000).toISOString(),
  })
  const original = structuredClone(vm)
  let attempts = 0
  const logged = []
  const monitor = createCodexQuotaMonitor({
    now: () => now,
    listTargets: () => [vm],
    log: (event) => logged.push(event),
    queryQuota: async () => {
      attempts += 1
      now += 20_000
      if (attempts === 1) throw Object.assign(new Error('fixture-secret'), { code: 'fixture-secret' })
      return { ok: false, error: 'upstream_auth', message: 'fixture-secret', credits: credits(now) }
    },
  })
  await monitor.tick()
  now += 59_999
  await monitor.tick()
  assert.equal(attempts, 1)
  now += 1
  await monitor.tick()
  assert.equal(attempts, 2)
  assert.deepEqual(vm, original)
  assert.equal(evaluateOpenAIQuotaGate(vm, {}, now).reason, 'quota_7d_local')
  assert.deepEqual(logged, [
    { vm_id: 'vm-a', error: 'quota_refresh_failed' },
    { vm_id: 'vm-a', error: 'upstream_auth' },
  ])
})

test('targets retain quota restrictions and legacy quota-off but exclude operator, credential and proxy blocks', async () => {
  const targets = [
    slot('normal'),
    slot('stopped', { status: 'stopped' }),
    slot('quota', { schedule_state: 'restricted', temp_unschedulable_reason: 'quota_7d_header' }),
    slot('legacy-off', { schedulable: false, schedule_disabled_reason: 'quota_7d_header' }),
    slot('manual-off', { schedulable: false, schedule_manual: true, schedule_disabled_reason: 'quota_7d_header' }),
    slot('authoritative-off', { schedule_off: true }),
    slot('invalid-credential', { unschedulable: { reason: 'oauth_invalid_grant' } }),
    slot('operator-off', { schedulable: false }),
    slot('dead', { status: 'dead' }),
    slot('error', { status: 'error' }),
    slot('disabled', { status: 'disabled' }),
    slot('no-token', { has_token: false, has_refresh: false }),
    slot('no-proxy', { proxy: null }),
    slot('blocked-proxy', { proxy: { url: 'socks5h://[2001:db8::1]:1080' } }),
    slot('claude', { platform: 'anthropic', family: 'claude' }),
  ]
  const queried = []
  const monitor = createCodexQuotaMonitor({
    now: () => NOW,
    listTargets: () => targets,
    queryQuota: async (vm) => {
      queried.push(vm.id)
      return { ok: true }
    },
  })
  await monitor.tick()
  assert.deepEqual(queried.sort(), ['legacy-off', 'normal', 'quota', 'stopped'])
})

test('authentication failures back off five minutes while ordinary failures and other slots keep refreshing', async () => {
  let now = NOW
  const attempts = { auth: 0, status401: 0, status403: 0, ordinary: 0 }
  const monitor = createCodexQuotaMonitor({
    now: () => now,
    listTargets: () => Object.keys(attempts).map((id) => slot(id)),
    queryQuota: async (vm) => {
      attempts[vm.id] += 1
      if (vm.id === 'auth') return { ok: false, error: 'upstream_auth' }
      if (vm.id === 'status401') return { ok: false, status: 401 }
      if (vm.id === 'status403') throw Object.assign(new Error('forbidden'), { status: 403 })
      return { ok: false, error: 'fetch_failed' }
    },
  })
  await monitor.tick()
  now += 60_000
  await monitor.tick()
  assert.deepEqual(attempts, { auth: 1, status401: 1, status403: 1, ordinary: 2 })
  now = NOW + 299_999
  await monitor.tick()
  assert.deepEqual(attempts, { auth: 1, status401: 1, status403: 1, ordinary: 3 })
  now += 1
  await monitor.tick()
  assert.deepEqual(attempts, { auth: 2, status401: 2, status403: 2, ordinary: 3 })
})

test('overlapping ticks share a pass with at most two upstream queries in flight', async () => {
  const pending = []
  let active = 0
  let peak = 0
  let completed = 0
  const monitor = createCodexQuotaMonitor({
    now: () => NOW,
    listTargets: () => ['a', 'b', 'c', 'd', 'e'].map((id) => slot(id)),
    queryQuota: async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => pending.push(resolve))
      active -= 1
      completed += 1
      return { ok: true }
    },
  })
  const first = monitor.tick()
  assert.equal(monitor.tick(), first)
  await new Promise(setImmediate)
  assert.equal(active, 2)
  while (completed < 5) {
    for (const resolve of pending.splice(0)) resolve()
    await new Promise(setImmediate)
  }
  await first
  assert.equal(peak, 2)
  assert.equal(completed, 5)
})

test('start refreshes immediately and every minute; stop prevents timer and queued work', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW })
  const pending = []
  const queried = []
  const monitor = createCodexQuotaMonitor({
    listTargets: () => ['a', 'b', 'c'].map((id) => slot(id)),
    queryQuota: async (vm) => {
      queried.push(vm.id)
      await new Promise((resolve) => pending.push(resolve))
      return { ok: true }
    },
  })
  t.after(() => monitor.stop())
  const started = monitor.start()
  await new Promise(setImmediate)
  assert.deepEqual(queried, ['a', 'b'])
  monitor.stop()
  for (const resolve of pending.splice(0)) resolve()
  await started
  t.mock.timers.tick(180_000)
  await monitor.tick()
  assert.deepEqual(queried, ['a', 'b'], 'stop must discard queued c and prevent later passes')

  const periodic = []
  const running = createCodexQuotaMonitor({
    listTargets: () => [slot()],
    queryQuota: async () => {
      periodic.push(Date.now())
      return { ok: true }
    },
  })
  t.after(() => running.stop())
  await running.start()
  t.mock.timers.tick(59_999)
  await new Promise(setImmediate)
  assert.equal(periodic.length, 1)
  t.mock.timers.tick(1)
  await new Promise(setImmediate)
  assert.equal(periodic.length, 2)
  running.stop()
  t.mock.timers.tick(60_000)
  await new Promise(setImmediate)
  assert.equal(periodic.length, 2)
})
