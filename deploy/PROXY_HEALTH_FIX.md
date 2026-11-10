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

Build the repository's official `Dockerfile` from the latest upstream source
plus the remote-slot fixes. It rebuilds the console and open-source Go helpers;
the remaining slot binaries are fetched and verified against the upstream
`deploy/payload.json` release manifest. No runtime source overlay is needed.

```sh
revision=$(git rev-parse HEAD)
short_revision=$(git rev-parse --short=12 HEAD)
tag="vm2api-v1.4.061-source-$short_revision"
docker buildx build --platform linux/amd64 --provenance=false \
  -f Dockerfile --label "org.opencontainers.image.revision=$revision" \
  -t "hx-repo.tencentcloudcr.com/devops/vm2api:$tag" --push .
```

`Dockerfile.proxy-health` remains an alternative overlay build based on the
pinned official image; the source build above is the deployment procedure.

For the synchronized Singapore registry, deploy the resulting image under
`hx-repo-xjp.tencentcloudcr.com/devops/vm2api` using the same tag and
`spec.template.spec.imagePullSecrets: [{ name: regcred }]` on the Deployment.
Verify the replicated manifest before pinning a digest: this registry currently
serves the Linux amd64 child manifest but not the build's outer OCI index.
Use the verified child digest, and validate the pull with a temporary Pod before
replacing the running service. Keep one control-plane replica
with `Recreate`, its existing PVC, database encryption secret, configuration
and node scheduling constraints. Back up SQLite and VM/config files before
upgrading; this upstream release adds no database migrations relative to
v1.4.054. Record the previous Deployment revision for `kubectl rollout undo`.

After rollout, verify the image digest, source hash, node SSH connections and
proxy probe result. A healthy unused proxy does not establish that a remote
slot can reach a model provider; verify that separately with the first slot.

## Remote slot creation without CRAG v2

The official v1.4.061 payload contains the legacy CRAG ELF, but not a complete
licensed CRAG v2 package. Remote image preparation and generic live-file
publication previously required that optional package even for Codex slots,
which do not use CRAG. The remote-slot fix permits the package to be absent
for those generic operations. Installed packages still undergo validation,
and explicit CRAG operations retain their package and license requirements.

Verify a remote Ubuntu Docker image can be prepared and an empty Codex slot
can start without a local Docker socket. Remove the temporary validation slot
afterward; real account/provider validation still requires imported credentials.
