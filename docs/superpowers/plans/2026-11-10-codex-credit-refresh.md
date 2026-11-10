# Codex credit refresh implementation plan

**Goal:** Keep eligible Codex slots schedulable after their subscription windows are exhausted while fresh upstream credit readings permit continued use.

**Design:** A dedicated control-plane monitor checks once per minute, refreshing eligible GPT quota snapshots after five minutes (before the existing ten-minute credit TTL). Start it immediately with the server, independently of the optional Claude usage monitor. Use the existing `queryOpenaiQuota` path through the slot proxy, without automatic OAuth rotation or reset-credit redemption. Two concurrent queries, no overlapping passes, and a one-minute failure retry floor bound load. Failed queries never renew stale credit timestamps or waive quota gates.

**Constraints:** Preserve manual scheduling disable, invalid/missing credentials and blocked proxy exclusions. Include slots restricted only by quota, including legacy stopped Codex records that remain schedulable. Keep existing ten-minute freshness validation and upstream quota errors authoritative. Do not run outbound monitors in `KIN_CRS_MOCK=1`.

**Tradeoff:** Background refresh keeps both the UI and admission state fresh; extending the TTL would conceal stale balances, and request-time-only refresh would leave the UI restricted until traffic arrives. The user authorized this targeted automatic-refresh repair and deployment.

## Task 1: Monitor and regression coverage
- [ ] Add failing tests in `test/unit/codex-quota-monitor.test.mjs` covering the observed stale-credit/7d-full case through real quota persistence and admission; five-minute proactive refresh; false/zero credit results; query failure retry; concurrency/overlap; manual-off/proxy/credential exclusions and quota-restricted inclusion; lifecycle stop.
- [ ] Implement `createCodexQuotaMonitor({ listTargets, queryQuota, now, log })` in `src/lib/oauth/codex-quota-monitor.mjs`, exposing `tick`, `start`, and `stop`.
- [ ] Run the new tests plus existing Codex credits, quota, usage and slot pool tests using the deployed Node 22 runtime.

## Task 2: Integrate and release
- [ ] Wire server startup/shutdown and dynamic `routingConfig.codex.quota` into the monitor, invoking `queryOpenaiQuota` with `rotate: false`.
- [ ] Extend the pinned official-image overlay to copy the new monitor and server integration.
- [ ] Independently review the change, then merge local main and push the fork while preserving unrelated local work.
- [ ] Build/push amd64 to `hx-repo.tencentcloudcr.com/devops/vm2api`, verify synchronized pull from `hx-repo-xjp.tencentcloudcr.com/devops/vm2api`.
- [ ] Back up live state; deploy by immutable digest using `regcred`, retaining both `nodetype=new-api` and hostname affinity for `.131`/`.141`, one replica and Recreate.
- [ ] Verify health, code hashes, startup credit refresh, a second automatic refresh, scheduling and reset-credit count. Record rollback and verification evidence.

**Review focus:** failed requests preserve fail-closed behavior; quota-blocked slots remain refresh targets; manual disable is never reopened; bad proxies never cause direct fallback; no overlapping/unbounded refresh work or token rotation race.

**Review refinements:** Exclude GPT slots from the optional generic usage monitor so the dedicated monitor owns background GPT quota queries. Authentication failures back off for five minutes; normal failures retry no faster than once per minute. Keep `rotate: false`: the Codex kernel owns automatic token rotation and writes the same credentials file, so the monitor must not introduce a competing refresh-token writer.

**Deadline correction:** Quota requests must remain abortable until their response bodies are fully read. A stalled JSON body must return a timeout, close its stream, preserve the old credit reading and release the monitor pass so later accounts and ticks can continue. Compose the quota request's abort signal with the existing proxy fetch timeout and add a real partial-response HTTP regression.
