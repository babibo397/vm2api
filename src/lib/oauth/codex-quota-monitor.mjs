import { isCodexVm } from '../vm/vm-kind.mjs'
import { isLeftoverQuotaScheduleOff } from '../pool/availability.mjs'
import { vmHasProxyPath } from './credential-refresh-monitor.mjs'

const INTERVAL_MS = 60_000
const REFRESH_AFTER_MS = 5 * 60_000
const AUTH_RETRY_MS = 5 * 60_000
const HARD_DOWN = new Set(['dead', 'error', 'disabled'])
const SAFE_ERRORS = new Set([
  'vm_not_found',
  'not_gpt_slot',
  'no_oauth_token',
  'proxy_required',
  'ipv6_disabled',
  'upstream_auth',
  'upstream_error',
  'timeout',
  'fetch_failed',
])

function isTarget(vm) {
  if (!vm?.id || !isCodexVm(vm)) return false
  if (vm.schedule_off === true || vm.unschedulable?.reason) return false
  if (vm.schedulable === false && !isLeftoverQuotaScheduleOff(vm)) return false
  // Legacy Codex records may be stopped while their independent kernel serves.
  if (HARD_DOWN.has(String(vm.status || '').toLowerCase())) return false
  if (!(vm.has_token || vm.has_refresh || vm.codex?.has_access || vm.codex?.has_refresh)) return false
  return vmHasProxyPath(vm)
}

function needsRefresh(vm, now) {
  const credits = vm.codex?.credits ?? vm.codex_credits
  const sampledAt = Date.parse(credits?.fetched_at || '')
  return !Number.isFinite(sampledAt) || sampledAt > now || now - sampledAt >= REFRESH_AFTER_MS
}

function authFailure(result) {
  return (
    result?.error === 'upstream_auth' || result?.code === 'upstream_auth' || [401, 403].includes(Number(result?.status))
  )
}

/** Refresh credits independently of traffic and the optional Claude usage monitor. */
export function createCodexQuotaMonitor({ listTargets, queryQuota, now = Date.now, log = () => {} }) {
  let timer = null
  let inflight = null
  let stopped = false
  let generation = 0
  const retryAt = new Map()

  const reportFailure = (vmId, code) => {
    try {
      log({ vm_id: vmId, error: SAFE_ERRORS.has(code) ? code : 'quota_refresh_failed' })
    } catch {}
  }

  const tick = () => {
    if (stopped) return Promise.resolve([])
    if (inflight) return inflight
    const pass = generation
    inflight = Promise.resolve()
      .then(async () => {
        const listed = listTargets() || []
        const ids = new Set(listed.map((vm) => vm?.id))
        for (const id of retryAt.keys()) if (!ids.has(id)) retryAt.delete(id)
        const targets = listed.filter(isTarget)
        const results = []
        let cursor = 0
        const worker = async () => {
          while (!stopped && generation === pass && cursor < targets.length) {
            const vm = targets[cursor++]
            const at = now()
            if (!needsRefresh(vm, at) || (retryAt.get(vm.id) || 0) > at) continue
            // Deduplicate repeated ids and enforce the retry floor on slow failures.
            retryAt.set(vm.id, Infinity)
            let retryDelay = INTERVAL_MS
            try {
              const result = await queryQuota(vm)
              const ok = result?.ok === true
              if (!ok) {
                if (authFailure(result)) retryDelay = AUTH_RETRY_MS
                reportFailure(vm.id, result?.error)
              }
              results.push({ vm_id: vm.id, ok })
            } catch (error) {
              if (authFailure(error)) retryDelay = AUTH_RETRY_MS
              reportFailure(vm.id, error?.code)
              results.push({ vm_id: vm.id, ok: false })
            } finally {
              retryAt.set(vm.id, now() + retryDelay)
            }
          }
        }
        await Promise.all([worker(), worker()])
        return results
      })
      .catch(() => {
        reportFailure(null, null)
        return []
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  const start = () => {
    stopped = false
    if (!timer) {
      timer = setInterval(() => {
        void tick()
      }, INTERVAL_MS)
      timer.unref?.()
    }
    return tick()
  }

  const stop = () => {
    stopped = true
    generation += 1
    if (timer) clearInterval(timer)
    timer = null
  }

  return { tick, start, stop }
}
