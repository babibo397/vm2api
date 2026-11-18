# Official v1.4.142 upgrade — 2026-11-18

## Release and image

- Official release: https://github.com/dofastted/vm2api/releases/tag/v1.4.142
- Official Linux amd64 base: `ghcr.io/dofastted/vm2api:v1.4.142@sha256:1967dae16bafdaa50f55829d81edeb0b04a9f3b49aa79f873d4ff0be7fcdbf77`.
- Local source tree: official `v1.4.142` merged into the existing `v1.4.110` overlay; the 16 local source overlays are copied exactly by `deploy/Dockerfile.proxy-health`.
- Pushed tag: `hx-repo.tencentcloudcr.com/devops/vm2api:vm2api-v1.4.142-local-3299d823`.
- Pushed and deployed digest: `sha256:a91b072b689b828cda2179bd5f3c2e68a91e2d3515c3d244202f931e9f4a84d4`.
- Previous deployed digest: `sha256:6b5a125bef6d564161dc7195ff75d236cc9cfc82c5ab45a413b8d7d76188bc6a`.

The image was pulled from the Singapore mirror with `regcred` on node `.137`. The check confirmed `VERSION=1.4.142`, all 16 overlay hashes, and the official Codex kernel hash `95727081222f4096e9e63d29e6c9c2e009ff00365a70add30a885063fe7f9993`.

## Deployment

Target: Kubernetes context `local-xjp`, namespace `vm2api`. The only live gateway mutation was the Deployment image. Replicas remain `1`, strategy remains `Recreate`, and the existing `nodetype=new-api`, hostname affinity `.131/.141/.137`, CPU/memory requests and limits, PVC `vm2api-data`, and `imagePullSecrets: regcred` remain in place. No account slot was recreated or reset. The old `ContainerStatusUnknown` Pod was left untouched; the Deployment created `vm2api-9b544f598-gbf25` on `.137` and it is Ready with zero restarts.

The v1.4.142 slot-image warmup is disabled explicitly in the persistent routing file because the gateway already runs close to its 4 GiB limit. Only `cluster.slot_image_warm=false` was added; the pre-change routing hash was `ccfd9038b645ba16231c4e1ab324950c45d215fb3bffc03e284a571bd98c7ea5` and the post-change hash is `11515b5a8d60e57ad0cd2dbda6255dcd6da00e21c77a9731516ddb556de437a8`.

## Verification

- Official Node 22 focused suites: quota/proxy/cluster/key usage `209/209`; lifecycle, including unreachable-node Codex force-delete `116/116`; additional Key/Proxy/Cluster tests `217 passed`, `1 skipped` because the official image lacks `ssh-keygen`; database migration tests `38/38`; portal server `10/10`; portal web/time `16/16`; one host-only date-input test `1/1`.
- A read-only copy of the production database migrated `058 → 061`; all 33 existing table row digests stayed unchanged, `quick_check=ok`, foreign-key errors `0`, and a second migration pass was idempotent.
- Live Pod checks: `VERSION=1.4.142`, schema `061` with 57 migration records, `quick_check=ok`, foreign-key errors `0`, healthz `200`, and the Codex kernel hash above. All 13 slot identities (node, proxy, container, credential and installation hashes) are unchanged; all 13 sockets exist and 9 idle/active health checks answered successfully without starting a kernel or calling a model provider.
- The independent usage portal remains `1/1` Ready and its local `/usage/` page returns `200`; no usage/quota query was sent during the final rollout check.
- Post-rollout sample: gateway memory `1110Mi`, CPU `182m`, restarts `0`. This is a point-in-time sample, not a long-term capacity guarantee.

## Backup and rollback

Private backup directory: `~/.config/vm2api/backups/upgrade-v1.4.142-20261118/`; reports are under `~/.config/vm2api/reports/upgrade-v1.4.142-20261118/` with restrictive permissions.

- `kin-online.db.gz`: 59,275,861 bytes, SHA256 `32e114ca1fdcd81b4940eb870c69b2bf0ac26e3913558704ffa40d4a0ce79e34`; decompressed DB SHA256 `ef3b014a832c8241527b40238cf767eacd624a7639fd14e49c6e85eb2ae289b2`; Node SQLite `quick_check=ok`, foreign-key errors `0`, pre-upgrade schema `058`.
- `runtime-files.tar.gz`: 288,742,352 bytes, SHA256 `57349d42c80951ac0320ecda92a9de5d7a857f003b7d41113542e705bf902a47`; `gzip -t` and `tar -tzf` pass with 798 entries.

Rollback requires restoring the matching pre-upgrade database and persistent `bin/`, `share/`, `vms/`, and `config` snapshot before using the previous image digest. Image-only rollback is unsafe because v1.4.142 applies migrations through `061` and refreshes persistent runtime files. No real model inference was sent.
