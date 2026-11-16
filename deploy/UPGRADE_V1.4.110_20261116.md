# Official v1.4.110 upgrade — 2026-11-16

## Released

- Official release: https://github.com/dofastted/vm2api/releases/tag/v1.4.110
- Source commit: `8ff8f026318cd58729bbe82a33ae7097a4662a45`, merged into local main and pushed to `babibo397/vm2api:main`.
- Base: official Linux amd64 `sha256:5ffd18ed936c36b1ca0cdd35d9fd4787842c18657fc148f6377c52b69b7e0bf2`.
- Pushed: `hx-repo.tencentcloudcr.com/devops/vm2api:vm2api-v1.4.110-local-8ff8f026`.
- Deployed: `hx-repo-xjp.tencentcloudcr.com/devops/vm2api@sha256:6b5a125bef6d564161dc7195ff75d236cc9cfc82c5ab45a413b8d7d76188bc6a`.
- Previous image: `hx-repo-xjp.tencentcloudcr.com/devops/vm2api@sha256:d5dcf561c437214a79dec1db1940dbfd84dbaf4b3be6ed2b9e1441ac66af327f`.

The official UI, binaries, entrypoint and migrations are unchanged. The image overlays exactly 16 JavaScript files for existing proxy health, strict optional CRAG validation, Codex quota/lifecycle and Key usage fixes. No custom Go changes or new dependencies. Upstream equivalents replace obsolete local remote-slot publication patches.

## Deployment

Target: explicit kubectl context `local-xjp`, namespace `vm2api`. The default kubectl context targets another cluster and must not be used.

The user explicitly confirmed preserving the live hostname affinity `.131/.141/.137`, `nodetype=new-api`, 500m CPU/2Gi memory requests, 2 CPU/4Gi limits, `regcred`, existing PVC, configuration and single replica. Deployment specification comparison confirms only the image and source-revision annotation changed. The portal image and its original `.131/.141` affinity remain unchanged.

The gateway was initially scaled to zero for a final consistent snapshot. The user then requested direct image replacement without scaling; it was immediately restored to one replica with the new image. Future image updates use `deploy/v1.4.110-image-patch.json`, which contains no replica change. The existing single-replica Recreate strategy still causes a brief interruption when replacing the Pod.

New Pod `vm2api-77fd9f547-h8clg` started at 2026-11-16 10:33:20 Asia/Shanghai on `.137`. `KIN_AUTO_SYNC_WRAP=0` was already configured and preserved. No whole-fleet sync, slot reset, remote container replacement or account recreation was performed.

## Verification

- Packaged-source regressions: 123/123 on official Node 22.23.5, covering proxy protocols/health, quota deadlines/refresh, credentials, Codex teardown and Key self/range/reader/portal integration.
- Cluster merge regressions: 94 unique tests passed, including separate root/non-root permission checks.
- Lifecycle/upstream integration: 76 tests passed, including 21 already counted in packaged tests. Subscription tests require `KIN_DATA_DIR` cleared to keep fixtures independent.
- Independent review found no missing source overlays or incompatible lifecycle callers. Source syntax, formatting of changed lifecycle files and diff checks passed.
- A read-only-mounted fresh production DB backup was copied into a network-disabled candidate container: migrations 054→058 passed; all 31 existing tables retained identical row digests; quick_check, foreign-key check and second migration pass passed.
- A temporary Pod on `.137` pulled the Singapore digest using `regcred`, verified VERSION1.4.110, all 16 source hashes, and Codex kernel0.1.2 SHA256 `ec9abb0160eaa0c8fda474c52fcfab592a4a2b905da4e4525e14fee9fb61376d`.
- Live VERSION, refreshed persistent Codex binary hash, schema058 and database quick_check passed.
- All 13 current slots retain the same node/proxy/container IDs and credential/installation hashes. All 13 panel service diagnoses pass: nine active kernels, four normal `codex_kernel_idle` kernels that start on demand. Their remote containers, node links, relays, egress and credentials all pass. No inference request was sent for testing.
- Gateway and internal portal: two existing managed Keys return200 and reconcile request count/cost with SQLite; invalid Key401; no self-query usage log rows. Concurrent real business traffic continued.
- Public `/usage/` page and `/healthz` return200. The same two-Key query/quota/SQL reconciliation and invalid-Key401 checks also passed through public HTTPS. Portal remains at https://vm2api.fireflyops.cn/usage/.

## Backup and rollback

Private artifacts: `~/.config/vm2api/{backups,reports}/upgrade-v1.4.110-20261116/`, directories0700, files0600. Secrets are not committed.

Before upgrade, an online-consistent SQLite backup was downloaded and validated (231563264bytes, SHA256 `f1f2acfa78963f708e0cb941f735afc37fea1cacf60b26b0515406545c5b6e7c`, quick_check ok). A runtime archive covers bin/share/vms/config and non-log data files (SHA256 `f8d5ff417de076d4153e850629cd2f348f9aa5ec4a5ffb3553047c002622dc13`). Deployment, referenced ConfigMap and Secret were saved privately.

After the old Pod exited and before the new image started, a complete PVC snapshot of data/vms/bin/share/config was saved at PVC root `upgrade-backups/v1.4.110-20261116/persistent.tar`, then compressed to `persistent.tar.gz` (262532067bytes, SHA256 `5c3202d6aaf45bbce8c60caa337c38e354f76009ee3efa918bb505a7db8c7ecf`). Unix sockets are intentionally omitted; the gateway recreates them. The final archive was downloaded locally as `persistent-final.tar.gz`; its SHA256 matches the PVC copy. All826 archive entries validated, with every expected root present. Extracted DB plus WAL passed quick_check and foreign-key checks, and retains pre-upgrade schema054. The temporary verification and maintenance Pods were removed; both PVC and local backups remain.

Official migrations055–058 are not reversible, and the entrypoint refreshes persistent binaries. Image rollback alone is insufficient. A rollback must first preserve post-upgrade data, stop writes under an agreed maintenance action, restore the matching pre-upgrade data/vms/bin/share/config snapshot and use the old digest. Never overwrite an active SQLite DB; restoring the old DB discards later writes unless reconciled separately. Respect the user request not to scale replicas during routine updates.

## Capacity and scope limits

Before this upgrade the 4Gi gateway had already restarted three times, with the latest recorded termination OOMKilled. This upgrade does not establish that capacity is fixed. Observed snapshots through more than12minutes after startup remained Ready with0 restarts and about995–1171Mi with nine kernels active; that is not comparable to sustained load across all13 kernels. Preserve the current allocation and report any later OOM separately.

The full repository suite and real model inference were not run. Remote worker/egress helpers remain at their existing versions: generic installer/reload would mutate remote containers and was not part of this control-plane update. No model-provider reachability or long-term memory stability guarantee is claimed.
