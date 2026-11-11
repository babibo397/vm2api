# Key Usage Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone Chinese self-service page where a vm2api managed Key holder can inspect their own usage over a chosen time range.

**Architecture:** A stateless Node service serves a React/Vite page and forwards only two self-service requests to the fixed internal vm2api service. A new authenticated vm2api range endpoint runs bounded queries in disposable read-only SQLite child processes, never on the inference event loop. Existing gateway APIs remain compatible.

**Tech Stack:** Node.js 22, node:sqlite, child_process, React/Vite, native HTTP/fetch, Kubernetes nginx Ingress.

**Spec:** `docs/superpowers/specs/2026-11-11-key-usage-portal-design.md`

## Global Constraints

- User approved implementation with “开始” on 2026-11-11; continue through verification and deployment without another execution-method approval.
- Reuse current isolated worktree. Preserve primary checkout `.gitignore` and untracked `deploy/k8s/` edits.
- No real inference/reset/delete operations for tests; synthetic DB/keys first, controlled self-service reads for live verification.
- Only vm2api managed Keys; same-Key scoping derived from authentication, never input key_id. No master key in portal.
- Query maximum 90 days; hour buckets maximum 7 days; `[start,end)` UTC bounds with Asia/Shanghai default display.
- First version retains current SQLite; no portal PVC, PostgreSQL, Redis or persistent Key storage.
- Worker execution deadline 8 seconds, at most 4 running, no unbounded queue or main-thread fallback; portal deadline 10 seconds.
- Portal Key limit 20/minute and IP limit 60/minute; bounded in-memory state. Browser stores Key only in memory.
- All query responses no-store; log no credentials; no redirects or arbitrary upstream paths; no owner-level aggregate output.
- All application Pods restricted by nodetype=new-api AND hostname In [172.20.127.131,172.20.127.141], using regcred.
- Push registry hx-repo.tencentcloudcr.com/devops; pull hx-repo-xjp.tencentcloudcr.com/devops; distinct vm2api and vm2api-usage images with immutable digests.

## Review Focus

- Stale response after Key or range switch must not display another query's data (Task 3 deferred-response test).
- Arbitrary time offsets, inclusive calendar dates, DST and future bounds must not overlap or silently shift accounting (Tasks 1/3 boundary tests).
- Huge scans, worker death and repeated timeouts must release resources only after execution actually ends and keep inference responsive (Task 1 real-worker tests).
- Truncated history/unpriced data/late price corrections must not appear as complete zero-cost billing (Tasks 1/3 fixture tests).
- Forged key_id/cursor/path/forwarding headers, disabled legacy owner, and auth errors must not leak data or credentials (Tasks 1/2 isolation tests).

## Shared Wire Contract

Portal forwards GET `/api/usage` to gateway GET `/v1/me/usage/range`; query whitelist `start,end,tz,bucket,limit,cursor`. Authorization: Bearer only. All datetime inputs include offset or Z. No input `key_id`. Portal GET `/api/quota` forwards `/v1/me/quota` but only returns `{key,usd,windows,requests}` with nested safe field whitelist. Errors use `{error:{code,message}}` with safe messages.

Range success shape (gateway and portal):

```js
{
  object: 'api_key_usage_range',
  range: { start: 'ISO UTC', end: 'ISO UTC', timezone: 'Asia/Shanghai', bucket: 'day' },
  as_of: 'ISO UTC',
  coverage: { status: 'unknown|partial|complete', available_from: null, missing_before: null, reason: 'retained_logs_only' },
  summary: { requests: 0, success: 0, errors: 0, other: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0, cost: 0, unpriced_requests: 0 },
  series: [{ bucket: '2026-11-11', ...summaryFields }],
  models: { items: [{ model: 'client model or null', ...summaryFields }], truncated: false, other: null },
  recent: { items: [{ request_id: 'r', created_at: 'ISO UTC', model: null, status: 200, outcome: 'success|error|other', error_code: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost: null, duration_ms: 10 }], has_more: false, next_cursor: null }
}
```

Summary fields reused identically. `cost` is known current log actual_cost, not immutable historical billing. Series bucket is local day `YYYY-MM-DD` or local hour including offset; UI treats it as a display label, never assumes the browser timezone. Models top 50 plus exact aggregate remainder. Cursor bound to Key and range; normalized end from first response used on subsequent pages.

### Task 1: Authenticated range API and isolated reader

**Files:** Create `src/lib/protocol/key-usage-range.mjs`, `src/lib/db/key-usage-reader.mjs`, `src/lib/db/key-usage-worker.mjs`, `src/lib/db/repos/key-usage-range-repo.mjs`; modify `src/lib/protocol/key-self.mjs`, `src/lib/admin/api-keys.mjs`; tests `test/unit/key-usage-range.test.mjs`, `test/unit/key-usage-reader.test.mjs`, relevant key-self/auth tests. Update `docs/API.md`.

**Interfaces:** Produces new range route automatically through KEY_SELF_PATHS, existing createKeySelfHandler injection remains compatible. `readKeyUsageRange({dbPath,apiKeyId,range,limit,cursor,...})` returns Shared Wire Contract, with controlled errors. May expose injection seams for unit tests. Resolve singleton file via getDbPath; do not mutate existing shared SQLite worker pool.

- [ ] Add RED tests asserting per-Key isolation and identical bounds for summary/series/models/recent, offset validation, midnight/end exclusion, future clamp, invalid spans/cursors, unknown/unpriced and pruned history, >50-model remainder and pending/error outcomes.
- [ ] Add RED real-worker tests for query_only writes forbidden, active<=4, kill on deadline, capacity held until exit and no main-thread fallback; auth regression checks disabled legacy owner, expired/exhausted allowed and no inference quota writes.
- [ ] Implement bounded disposable workers (read-only DB, short read transaction, terminated in finally) and safe range query. Use worker concurrency global to gateway module; no need for permanent extra pool lifecycle hooks. Uniform errors 400 validation, 401 unavailable key, 429 self rate, 503 capacity/start failure, 504 execution deadline.
- [ ] Extend self route and set no-store. Remove internal model fallback for new public range; do not expose owner info. Preserve old usage response contract. Apply _ownerActive consistently to legacy authentication before migration.
- [ ] Run focused Node 22 tests, key-self suite, syntax/Biome; record actual RED/GREEN evidence. Leave source uncommitted for coordinator to integrate.

### Task 2: Standalone middleware and packaging (coordinator)

**Files:** Create `services/key-usage-portal/server/{app,proxy,rate-limit,main}.mjs`, `services/key-usage-portal/test/*.test.mjs`, package.json/package-lock.json, Dockerfile, .dockerignore, README.md. Frontend nested web package belongs to Task 3.

**Interfaces:** `createPortalServer({upstream,staticDir,fetchImpl,limits,...})` returns node:http Server; production PORT 8080 and fixed config VM2API_UPSTREAM. Serves web/dist, healthz, api usage/quota only. Consumes shared contract; no broad reverse proxy.

- [ ] Write RED tests with local fake upstream: Bearer only/headers stripped; whitelist route/query; no cross-origin redirect; safe bounded JSON response; no-store; quota nested projection excludes user_concurrency; structured safe errors; slow body deadline; key/IP throttling and bounded state; safe static path/SPA serving and CSP.
- [ ] Implement native HTTP/fetch service. Trust forwarding IP only from configured ingress hops/CIDRs; otherwise socket peer. Hash presented Key for local limiting; do not log arbitrary errors or requests. Return safe 502/504 without raw upstream bodies. No user-specified upstream.
- [ ] Run middleware tests; build independent Node 22 multi-stage image with web build, nonroot process and no persistent volume. Backend package remains dependency-free.
- [ ] Document env variables, local run/tests, build/deploy and privacy/retention behavior.

### Task 3: Chinese responsive self-service webpage

**Files:** Own only `services/key-usage-portal/web/**` (package/lock, vite config, src modules, styles, tests); design QA files under plan scratch workspace, not production bundle.

**Interfaces:** GET same-origin `/api/usage` and `/api/quota` with in-memory Bearer; Shared Wire Contract. `npm run build` produces web/dist; `npm test` verifies meaningful state/time helpers. Vite development proxy to localhost:8080; no seeded production data.

- [ ] Establish a complete restrained code-native design: clear Key entry, time selection, summary band, trend, model table and request table; useful empty/error/loading states. No decorative raster media needed. Image concept tool currently unavailable; record this concrete blocker and use documented tokens/layout as reference.
- [ ] Write RED date/state tests for Shanghai inclusive end-day, presets, offset submission, hour/day change, pending-request cancellation, Key change clearing all data, pagination range preservation and null costs.
- [ ] Implement React/Vite modular UI, default Shanghai timezone, today/yesterday/7d/30d/custom range, hour/day, same-Key quota, charts and safe tables, no key storage or third-party network scripts. No info about internal accounts/proxies or server architecture in user flow.
- [ ] Test/build; supply deterministic synthetic demo fixture ONLY in test/dev harness, unavailable production. Coordinator handles browser QA with mock upstream and real reads.
- [ ] Leave files uncommitted; report build and tests, key UX decisions and any contract mismatch.

### Task 4: Integration review, browser QA and deployment

**Files:** Update `deploy/Dockerfile.proxy-health`; create tracked `deploy/key-usage/{deployment,service,ingress,networkpolicy}.yaml`, release docs. Only image refs in primary existing untracked k8s files may be updated after deployment.

- [ ] Review Tasks 1–3 independently and resolve findings. Run packaged gateway regressions plus both-Key end-to-end requests against isolated DB. Exercise middleware+page desktop/mobile in Browser/IAB; use Playwright fallback only if needed with reason.
- [ ] Verify timeout/resource behavior and raw SQL reconciliation. Inspect source/diff for credentials or data persistence. Render screenshot and fix layout/interaction problems.
- [ ] Back up live Deployment and online SQLite state plus current retention config. Inspect existing DNS/TLS/Ingress and plugin NetworkPolicy support. Reuse wildcard certificate only if valid for selected hostname; no need to disclose private certificate material.
- [ ] Commit reviewed source, ff local main preserving unrelated edits, push fork. Build/test/push immutable gateway overlay and portal images; preflight pull from Singapore registry with regcred and constrained nodes.
- [ ] Deploy compatible gateway first; restore/warm existing running kernels via supported start API if necessary, compare slot identities and health. Apply only approved summary retention_days=90, keep debug settings. Then deploy portal/Ingress/policy with node constraints.
- [ ] Verify public portal TLS, page/API health, invalid key isolation, controlled real self query with secrets suppressed, all existing slots healthy, normal new-api internal health, no inference counts increased due verification. Save rollback and report final URL/limits.

## Rulings

- Existing approved design and “开始” authorize execution; do not add another plan approval gate from generic skill defaults.
- Independent implementation files may run in parallel under developer multi-agent instructions; coordinator owns shared contract and commits.
- Dedicated disposable range workers meet the isolation intent more narrowly than altering the existing admin worker pool; maximum four and real termination are mandatory.
- No image-generation tool is currently available. Use code-native dashboard design with browser screenshot inspection; no blocked wait for artwork in a data-only app.

## Verified execution and entrypoint

- Public page: `https://vm2api.fireflyops.cn/usage/`, selected by user on 2026-11-11; no DNS change.
- Query isolation uses disposable child processes, SIGKILL on completion/deadline, and waits for actual exit before releasing capacity. Native SQLite blocked `Worker.terminate()` for 4705ms in a reproduction, so worker threads cannot guarantee the deadline. Cap 4, query deadline 8s; portal deadline 10s.
