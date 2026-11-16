# Upgrade to official v1.4.110 — 2026-11-16

## Plan

1. Merge official v1.4.110, retaining only the required proxy, Codex lifecycle/quota and Key usage patches. Run focused compatibility regressions in the packaged Node runtime.
2. Capture the live deployment, slots, proxy bindings, credentials fingerprints and resources privately. Back up SQLite consistently and test migrations 055–058 on a copy. Preserve files overwritten by the new entrypoint.
3. Build and push an immutable Linux amd64 image based on the official release. Verify the Singapore mirror using regcred before changing the live image.
4. Stop the single control plane for the final consistent persistent snapshot, then update only its image. Keep node affinity .131/.141/.137, 4Gi memory, regcred, PVC and usage portal unchanged.
5. Verify release/kernel versions, database integrity, slot identities and health, Key usage SQL reconciliation, public portal and bounded restart/memory stability without model inference.

## Rollback requirements

Official migrations are not reversible. Rollback requires the matching pre-upgrade database and persistent binaries/configuration with the control plane stopped, plus the previous pinned image. Preserve any post-upgrade state before restoring a backup. Do not use generic install.sh or whole-fleet reload; they can mutate remote slot services.

## Result

Pending validation and release. Private artifacts are outside Git under ~/.config/vm2api/{backups,reports}/upgrade-v1.4.110-20261116/.
