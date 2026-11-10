# Remote-slot proxy health fix

Based on upstream v1.4.061 (`049679d7046e8c961a3bfaae6e736d997f7d6c88`).
The control plane can manage remote Docker slots over SSH without a local
Docker socket. Previously every successful SOCKS5 probe also required a local
`kin-egress`, even for unused proxies or proxies used only by remote slots.
That produced `egress_down:not_running` and could hold healthy remote slots.

The pool now checks a local helper only when a known local slot uses it.
Local helper failures hold only local bindings; recovery of the SOCKS endpoint
releases matching proxy holds on remote bindings. Actual SOCKS failures still
protect all bindings. Explicitly disabling a proxy persists across probes and
restarts, including results from probes already in flight. Remote helper startup
and diagnosis remain owned by the existing remote slot lifecycle.

## Image

`Dockerfile.proxy-health` uses the official Linux amd64 release by digest and
replaces only the changed JavaScript module. The upstream UI, binaries and
entrypoint remain from that same release; no runtime ConfigMap source overlay
is needed. Use a dedicated tag when sharing a repository with other services.

```sh
revision=$(git rev-parse HEAD)
short_revision=$(git rev-parse --short=12 HEAD)
tag="vm2api-v1.4.061-egress-$short_revision"
docker buildx build --platform linux/amd64 \
  -f deploy/Dockerfile.proxy-health --build-arg SOURCE_REVISION="$revision" \
  -t "hx-repo.tencentcloudcr.com/devops/new-api:$tag" --push .
```

For the synchronized Singapore registry, deploy the resulting image under
`hx-repo-xjp.tencentcloudcr.com/devops/new-api` using the same tag/digest and
the namespace's `regcred` image pull secret. Keep one control-plane replica
with `Recreate`, its existing PVC, database encryption secret, configuration
and node scheduling constraints. Back up SQLite and VM/config files before
upgrading; this upstream release adds no database migrations relative to
v1.4.054. Record the previous Deployment revision for `kubectl rollout undo`.

After rollout, verify the image digest, source hash, node SSH connections and
proxy probe result. A healthy unused proxy does not establish that a remote
slot can reach a model provider; verify that separately with the first slot.
