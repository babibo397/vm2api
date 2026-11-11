# Codex slot destruction lifecycle repair

**Goal:** Rebuilding or deleting a Codex slot must terminate its control-plane kernel before removing its socket and local directory.

**Evidence:** vm-03 had a live Codex PID and a bound Unix socket shown in `/proc/net/unix`, but the socket and limit-stamp files no longer existed. Health failed with ENOENT. A scoped stop/start restored the slot; all three account kernels then returned HTTP 200. The current destroy path delegates to the remote container only, while reset immediately wipes the local run directory.

**Design:** Make Codex destruction await the existing `stopCodexKernelAndWait` lifecycle helper. Hold a per-slot teardown guard through stopping, remote destruction, and local file cleanup; reject concurrent destruction and use a lifecycle epoch to invalidate lazy starts already waiting when teardown begins. Reset starts the new kernel only after this guard is released. If stopping fails, return failure before host destruction or file deletion. Pass the project root at every caller and make DELETE respect Codex failures. Preserve the Claude path. Never reset a real account to validate this repair.

- [x] Add and observe failing regression tests for live-kernel destruction, concurrent lazy starts and destruction, failed stop preventing wipe, DELETE failure propagation, and unchanged Claude behavior.
- [x] Implement the targeted lifecycle change and verify using Node 22.
- [x] Independently review, extend the pinned v1.4.061 overlay, merge local main and push the fork.
- [x] Build/test/push the image, pull with regcred in the cluster, deploy using the Singapore registry and existing two-node restriction.
- [x] Verify three real account kernels remain healthy, preservation of account/identity data and current image hashes; save rollback evidence.

**Version check:** Latest official release is still v1.4.061. Upstream main 5124bc4a adds an unrelated, unreleased Claude/Fable change and contains no fix for this lifecycle defect.

**Pre-release verification:** 70 targeted Node 22 tests pass. Independent review reproduced two concurrency gaps, both now covered by real-child regressions: lazy startup during teardown and a delayed request-size recycle unlinking a replacement socket. Size recycling now joins the shared awaited-stop promise. Final independent review has no findings; Biome and `git diff --check` pass.

**Release verification:** Source `4fefc188` merged to local main and pushed to fork main. Published `vm2api-v1.4.061-lifecycle-4fefc188`, digest `sha256:d912f28bebfa34ea0568d5d50fdd6af454b97701176d305213d651ff7a05a9c5`; deployment revision 8 uses the Singapore mirror. Actual packaged tests cover 204 cases (202 root-run plus two non-root permission cases), all passing. Mock startup and regcred preflight passed. Image-only rollout preserved every scheduling/storage setting; all 11 source hashes match. After supported start-API warmup, all three kernels returned HTTP 200; account/installation hashes and proxy/node/container identities are unchanged. Public and new-api internal health passed. Private evidence and rollback files are in `~/.config/vm2api/{reports,backups}/codex-startup-20261110/`.
