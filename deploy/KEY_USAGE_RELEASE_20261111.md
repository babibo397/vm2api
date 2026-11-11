# Key usage portal release — 2026-11-11

Public entry: https://vm2api.fireflyops.cn/usage/

Source commit: `587d2c58`; merged into local `main` and pushed to `babibo397/vm2api:main`.
Official gateway base remains `v1.4.061` at its pinned digest, retaining the remote-slot, proxy-health, credit and kernel-lifecycle overlay fixes.

## Released images

| Component | Source tag | Verified Singapore amd64 digest |
| --- | --- | --- |
| Gateway | `hx-repo.tencentcloudcr.com/devops/vm2api:key-usage-587d2c58` | `hx-repo-xjp.tencentcloudcr.com/devops/vm2api@sha256:d5dcf561c437214a79dec1db1940dbfd84dbaf4b3be6ed2b9e1441ac66af327f` |
| Portal | `hx-repo.tencentcloudcr.com/devops/vm2api-usage:key-usage-587d2c58` | `hx-repo-xjp.tencentcloudcr.com/devops/vm2api-usage@sha256:5a8e4df3a71eb496da0bff843314f73f067d7cc57ed0171b811a948e080ad8e6` |

A temporary Pod pulled both digest-pinned images from Singapore using `regcred` on `172.20.127.131`; both verification containers exited 0. The temporary Pod was then removed.

## Delivery status

The user chose **keep the current deployment and deliver the portal plus a capacity report** after the 3Gi stability observation failed. The page and self-service query feature are delivered; gateway capacity stability remains unresolved. No node upgrades, extra servers, scheduling relaxation or further capacity changes are authorized by this delivery.

## Deployment and capacity

- Context `local-xjp`, namespace `vm2api`; Ingress `/usage` Prefix with no rewrite, existing TLS Secret `fireflyops.cn`.
- Both Deployments retain `nodetype=new-api` AND required hostname affinity to `172.20.127.131` / `172.20.127.141`, plus `imagePullSecrets: regcred`.
- Portal is one replica, no PVC/admin credential/service-account token, 100m CPU /128Mi requests, 500m /256Mi limits.
- Gateway remains one replica with Recreate and existing SQLite PVC. Final resources: 500m CPU /2Gi requests; 2CPU /3Gi limits. Apply its image/resources with `deploy/key-usage-gateway-patch.json` as a strategic patch.
- Summary retention set to `retain_days=90`; debug retention stays 3 days, mode normal, max log storage stays 2048MiB and muted classes unchanged. This is an upper retention window, not a promise to recover pruned records or bypass the size cap.
- The old gateway 2Gi limit caused repeated cgroup OOM kills while running 14 account kernels. The previous-image Pod also restarted three times before this rollout, though its historical termination reason was no longer available. No range-query children were present during diagnosis. Requests/limits were raised after checking scheduler capacity and physical memory; node constraints were preserved.
- Initial slot inspection accidentally filtered `vm-*` names; corrected full inventory and database backup contain all 14 slots. All 14 node/proxy/container identities match the pre-release database snapshot. `wilson` kernel was warmed through the normal start API, without resetting or replacing its slot.

## Verification

| Check | Evidence |
| --- | --- |
| Gateway packaged-source regressions | 131/131 on Node22 amd64, including Key auth/self/range, read isolation, native SQL deadlines, IPC byte caps, remote slots, proxy binding, credits and kernel/runtime behavior |
| Portal packaged service | 10/10 on Node22 amd64 with read-only root, non-root image and temporary test-fixture tmpfs |
| Frontend | 17/17, production `/usage/` build; native date-input, stale-result cancellation, pagination and sparse-time positions |
| Actual HTTP + isolated SQLite | Two-Key separation, cursor binding, SQL/cost/token reconciliation; no inference rows or quota-counter writes |
| Live gateway/internal portal/public HTTPS | Two existing managed Keys returned 200 and reconciled with SQL; invalid Key returned 401; zero self-query rows in usage log |
| Public page/assets | HTTPS certificate verified by OS curl and browser; page, JS, CSS 200; `/usage` redirects308; no-store/CSP/anti-framing headers present |
| Browser | Desktop and390px mobile, no page-wide overflow or app console errors; query, pagination, Key change, invalid Key, clear/refresh, custom inclusive dates tested with synthetic data; public error flow tested |
| Slots | 14/14 health checks passed after warming, and all 14 node/proxy/container identities matched backup. Later OOM restarts made this a point-in-time check, not a sustained-health guarantee |

Production inference continued concurrently during some live checks, so total log counts sometimes increased from real traffic. Synthetic isolation tests, not a global production counter freeze, prove that usage queries do not invoke models or change inference counters.

Full repository `npm test` was attempted but did not complete successfully in the available image: untouched CLI/persona version expectations, missing optional egress binary and kernel gid fixtures failed. No full-suite pass is claimed; related packaged suites above passed.

## Limits and rollback

The range API accepts at most90 days (hour buckets7 days), derives Key identity from Bearer authentication, caps four child readers with an8-second execution deadline and1MiB responses; portal deadline10s. Child processes use read-only SQLite and SIGKILL/await-exit cleanup. Keys remain in browser memory only.

NetworkPolicy objects are installed, but enforcement was not verified and appears absent with the current TKE route-ENI configuration. Do not treat the manifest as proof of network isolation. Application fixed-host/path restrictions remain enforced.

Consistent pre-release SQLite backup was transferred in verified chunks after the connection interrupted two streaming downloads; SHA256 matched and `quick_check` returned `ok` (13,358 usage rows). Private backup and verification artifacts are under `~/.config/vm2api/{backups,reports}/key-usage-20261111/`; they are not committed.

To roll back the gateway image while retaining the corrected memory allocation:

```sh
kubectl --context local-xjp -n vm2api set image deployment/vm2api \
  vm2api=hx-repo-xjp.tencentcloudcr.com/devops/vm2api:vm2api-v1.4.061-lifecycle-4fefc188@sha256:d912f28bebfa34ea0568d5d50fdd6af454b97701176d305213d651ff7a05a9c5
```

The first-release portal can be removed using only the four manifests under `deploy/key-usage/`. Do not restore the old full Deployment or reduce retention automatically; that would reintroduce the observed2Gi OOM ceiling or delete retained history. No database schema migration is introduced by this feature.

## Stability observation

**Failed: do not describe the gateway as stable.**

- The original 3Gi Pod `vm2api-c9589cbb5-pt9xr` started at10:25:27Z and initially showed zero restarts with all14 kernels. At10:36 it was still Ready, with gateway working set about2558Mi.
- At10:38:22Z it was evicted for **node memory pressure**: available48248Ki was below the100Mi threshold; gateway usage was2966368Ki (~2897Mi), exceeding its2Gi request.
- The replacement `vm2api-c9589cbb5-zxnjj` was pending for roughly5 minutes because `.131` had memory pressure and `.141` had insufficient schedulable memory. It started10:43:43Z and was **OOMKilled at10:57:53Z** at the3Gi container limit.
- It restarted10:57:57Z and was Ready at the last delivery check, with restartCount1. The portal itself remained Ready with zero restarts and roughly27Mi working set.
- Observations contain a gap between10:36 and11:00; no continuous ten-minute clean observation is claimed. Query-reader children were absent during memory diagnosis; ordinary inference traffic and14 kernel processes continued.

The user explicitly selected “保持现状，先交付查询页和容量问题说明” after these findings. Therefore the current3Gi gateway limit/2Gi request and original two-node restrictions remain. A future capacity change could upgrade an existing node to16Gi and reserve4Gi for the gateway, or use another node only after explicit scheduling approval; neither has been performed. More memory would provide headroom but is not proof against a leak or unbounded workload growth.
