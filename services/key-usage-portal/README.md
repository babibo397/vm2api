# Key usage portal

Chinese self-service usage page for vm2api managed Keys. Production entry point:
`https://vm2api.fireflyops.cn/usage/`. A stateless Node.js 22 service serves the
React/Vite assets and forwards only these authenticated, read-only requests:

| Browser route | Fixed gateway route |
| --- | --- |
| `GET /usage/api/usage` | `GET /v1/me/usage/range` |
| `GET /usage/api/quota` | `GET /v1/me/quota` |

The runtime strips the configured `/usage` mount before route matching. The
nginx Ingress preserves the prefix; do not add a rewrite annotation. `/usage`
redirects to `/usage/`. `/healthz` is always available at the service root and
does not call the gateway or require a Key. Other gateway routes are not proxied.

## Local development and checks

Use Node.js 22 or newer. From this directory:

```sh
npm ci --ignore-scripts
npm --prefix web ci --ignore-scripts
npm test
npm --prefix web test
npm run build:web
VM2API_UPSTREAM=http://127.0.0.1:8787 npm start
```

Open `http://127.0.0.1:8080/`. For frontend development, run
`npm --prefix web run dev` in another terminal; Vite proxies `/api` to port 8080.
Use synthetic Keys and an isolated gateway database for tests. These commands
do not create model requests.

To check the production prefix locally, rebuild and run with both settings:

```sh
PORTAL_BASE_PATH=/usage/ npm run build:web
BASE_PATH=/usage PUBLIC_ORIGIN=http://127.0.0.1:8080 \
  VM2API_UPSTREAM=http://127.0.0.1:8787 npm start
```

Then open `http://127.0.0.1:8080/usage/`. `PORTAL_BASE_PATH` is a **build-time**
setting for asset and API URLs; `BASE_PATH` is a **runtime** setting. Changing
only one breaks the deployment.

## Runtime configuration

| Variable | Default | Production value / purpose |
| --- | --- | --- |
| `PORT` | `8080` | Service listener |
| `BASE_PATH` | empty (root) | `/usage` |
| `PUBLIC_ORIGIN` | derived from request host | `https://vm2api.fireflyops.cn`, without a path |
| `VM2API_UPSTREAM` | `http://vm2api.vm2api.svc.cluster.local:8787` | Fixed internal gateway origin, no path/query/credentials |
| `STATIC_DIR` | `web/dist` relative to the server | Optional absolute directory containing the built assets |
| `TRUST_PROXY_CIDRS` | empty | Comma-separated exact ingress Pod CIDRs; see below |
| `KEY_RATE_LIMIT` | `20` | Requests per Key per 60-second window |
| `IP_RATE_LIMIT` | `60` | Requests per resolved client IP per 60-second window |

The production manifest uses one replica, 100m CPU / 128Mi memory requests and
500m / 256Mi limits. The service admits at most four concurrent queries, caps an
upstream JSON response at 1 MiB, and applies a 10-second upstream deadline.
The gateway independently bounds range execution to four child readers and an
8-second deadline. Capacity is released after the reader actually exits.

Rate-limit tables are bounded, process-local memory; restarting resets them.
Do not increase the replica count without accounting for the resulting
per-replica limits. The gateway remains responsible for authoritative Key
authentication and per-Key data isolation.

## Privacy and accounting

- The browser keeps the entered Key and results only in page memory. Clearing
  the Key or refreshing removes them. No URL, cookie, browser storage, analytics
  script, or service worker persists it.
- Only the presented Bearer token is forwarded to the gateway. The service has
  no administrator Key, database volume, user database, or shared query cache.
  Credentials and upstream errors are not logged or reflected. The portal
  Ingress disables access logging; keep authorization headers out of any
  additional proxy, tracing, or error-log configuration.
- API and static responses use `Cache-Control: no-store`, and the page uses a
  same-origin CSP. The public Ingress terminates TLS and redirects HTTP to HTTPS.
- The range API accepts at most 90 days; hour buckets accept at most seven days.
  Bounds use `[start, end)` in UTC, with Asia/Shanghai as the default display
  timezone. Pagination retains the first response's normalized end time.
- Request summaries are intended to be retained by the gateway for 90 days
  from feature enablement. Deploying this portal does **not** change retention.
  The gateway retention setting must be applied separately, leaving debug
  content retention unchanged. Already-pruned history cannot be recovered.
- Costs are the current recorded `actual_cost` values in retained logs, in USD.
  Unpriced requests and incomplete/unknown coverage are disclosed. Historical
  price corrections can change these figures; they are not an immutable bill.
  Queries do not invoke models, spend inference quota, or use inference slots.

## Container build and release

Run these commands from the repository root. The two images are separate.
The gateway overlay retains the existing remote-slot, credit, lifecycle and
proxy-health fixes and copies the new range reader/API modules into the pinned
official base. Build the portal with the production prefix:

```sh
release_revision=$(git rev-parse HEAD)
release_short=$(git rev-parse --short=12 HEAD)
docker buildx build --platform linux/amd64 \
  -f deploy/Dockerfile.proxy-health \
  --build-arg SOURCE_REVISION="$release_revision" \
  -t "hx-repo.tencentcloudcr.com/devops/vm2api:key-usage-$release_short" \
  --push .
docker buildx build --platform linux/amd64 \
  --build-arg PORTAL_BASE_PATH=/usage/ \
  -t "hx-repo.tencentcloudcr.com/devops/vm2api-usage:key-usage-$release_short" \
  --push services/key-usage-portal
```

Deployment pulls from `hx-repo-xjp.tencentcloudcr.com/devops`, using the
namespace-local `regcred`. Verify replication and obtain the **Linux amd64
manifest digest from the Singapore registry** for each image. This registry
may expose the child manifest without the build's outer OCI index. Preflight
both digest-pinned pulls on an allowed node before updating the live gateway.

For later releases, update the digest in
`deploy/key-usage/deployment.yaml` with the verified portal digest before
applying it. The committed digest records the verified 2026-11-11 release. Set the
gateway image to its own verified digest; never reuse the portal digest. Keep
the final digest references in the release record and tracked manifests.

## Kubernetes rollout

The four manifests under `deploy/key-usage/` own only the portal Deployment,
ClusterIP Service, Ingress and NetworkPolicy in namespace `vm2api`. They do not
alter the existing gateway Deployment, `/` Ingress, Service, PVC or secrets.
Both `nodetype=new-api` and required hostname affinity to
`172.20.127.131` / `172.20.127.141` are mandatory. The portal is non-root, has a
read-only root filesystem, drops capabilities and does not mount an API token.

1. Record the existing gateway image digest and Deployment revision. Back up
   the online SQLite database and record current summary/debug retention.
2. Verify namespace-local `regcred`, the `fireflyops.cn` TLS certificate,
   current ingress Pod IPs, image pulls, public routing and node constraints.
   Read-only inspection on 2026-11-11 found wildcard TLS valid until
   2026-12-15. The public host's A record differed from the controller's reported
   load balancer address; verify the actual public route rather than changing
   DNS based only on Ingress status. No new hostname is needed for `/usage/`.
3. Roll out the backward-compatible gateway image first. Preserve its PVC,
   secrets, configuration, scheduling and all previous overlay fixes. Verify
   existing slots/health, then apply the approved 90-day summary retention
   separately. Keep debug retention unchanged.
4. Replace the portal image digest, refresh trusted proxy CIDRs if necessary,
   and validate the exact four manifests:

   ```sh
   kubectl --context local-xjp apply --dry-run=client --validate=true \
     -f deploy/key-usage/deployment.yaml \
     -f deploy/key-usage/service.yaml \
     -f deploy/key-usage/ingress.yaml \
     -f deploy/key-usage/networkpolicy.yaml
   kubectl --context local-xjp apply --dry-run=server \
     -f deploy/key-usage/deployment.yaml \
     -f deploy/key-usage/service.yaml \
     -f deploy/key-usage/ingress.yaml \
     -f deploy/key-usage/networkpolicy.yaml
   ```

   Client dry-run checks schema without creating resources; server dry-run also
   exercises admission without persisting resources. Neither verifies that
   the image exists or that NetworkPolicy is enforced. Do not recursively apply
   the repository's whole `deploy/` directory or unrelated manifests.
5. Apply those four files, then wait for rollout:

   ```sh
   kubectl --context local-xjp apply -f deploy/key-usage/
   kubectl --context local-xjp -n vm2api rollout status deployment/vm2api-usage
   ```

6. Verify public TLS, `/usage/`, `/usage/assets/…`, the `/usage` redirect, and
   `/usage/api/quota` / `/usage/api/usage` rejection of invalid Keys. Check an
   authorized real Key with credentials suppressed, then desktop/mobile state,
   no-store headers, both-Key isolation and unchanged gateway inference counts.
   The Kubernetes probes use internal `/healthz`; the public `/healthz` path
   continues to belong to the existing gateway.

For private verification before enabling the Ingress:

```sh
kubectl --context local-xjp -n vm2api port-forward service/vm2api-usage 8080:8080
```

The page loads at `http://127.0.0.1:8080/usage/`; API requests that carry an
Origin header must match the configured production `PUBLIC_ORIGIN`. Use a
local development server for unrestricted local browser interaction.

## Forwarded IP trust

On 2026-11-11 the nginx controller in namespace `nginx-ingress` was one
non-hostNetwork Pod at `172.20.81.60`. The manifest trusts only
`172.20.81.60/32`. Obtain current addresses with this read-only command before
rollout and after a controller replacement:

```sh
kubectl --context local-xjp -n nginx-ingress get pods \
  -l app.kubernetes.io/name=nginx-ingress,app.kubernetes.io/instance=nginx-ingress,app.kubernetes.io/component=controller \
  -o 'custom-columns=NAME:.metadata.name,IP:.status.podIP,READY:.status.containerStatuses[*].ready'
```

Refresh `TRUST_PROXY_CIDRS` to the exact current controller IPs (`/32` for IPv4,
`/128` for IPv6) and roll the portal. If the peer is not trusted, the service
ignores `X-Forwarded-For` and limits the socket peer instead; a stale list can
make users behind that ingress share the 60/minute IP limit. Never widen this
to the entire Pod/VPC range or `0.0.0.0/0`.

The observed controller enables `compute-full-forwarded-for` and appends its
original socket peer (`$realip_remote_addr`) to the incoming chain. The portal
walks that chain right-to-left and stops at the first untrusted address. It
does not trust `X-Real-IP` or the client's claimed leftmost address. Do not add
an intermediate load balancer/SNAT address to the trust list without verifying
how that hop removes forged headers. If the ingress sees a shared upstream
peer, the IP limit intentionally applies to that peer; the per-Key limit still
applies independently.

## NetworkPolicy limitation

The included policy selects **only portal Pods**. It allows ingress from the
actual `nginx-ingress` controller namespace and labels on TCP 8080, egress to
same-namespace `app.kubernetes.io/name=vm2api` Pods on TCP 8787, and DNS to
`kube-system` / `k8s-app=kube-dns` on UDP and TCP 53. It cannot isolate HTTP
paths; the middleware's fixed route allowlist supplies that restriction.

Read-only inspection on 2026-11-11 found TKE route-ENI with Cilium chaining,
overlay and underlay disabled, VPC security groups disabled, and no identified
NetworkPolicy enforcement agent. **Enforcement is unverified and appears
absent.** Existing policy objects or successful dry-runs are not evidence of
network isolation. Treat this manifest as intended policy until an authorized
network configuration change and a negative connectivity test demonstrate
enforcement. The portal still restricts upstreams in application code, but the
current cluster cannot be represented as providing verified egress isolation.

## Rollback

For a later portal update, restore the previously verified image digest in
`deployment.yaml` and reapply it, or use the recorded Deployment revision with
`kubectl --context local-xjp -n vm2api rollout undo deployment/vm2api-usage`.
Verify that the restored image was built for `/usage/` and retains the runtime
`BASE_PATH=/usage`. A rollout resets local rate-limit counters.

For a first-release rollback, remove only the four portal resources using the
four files under `deploy/key-usage/`. The gateway and its data remain available.
The compatible gateway extension may remain installed. If it also needs
rollback, restore its recorded image/revision independently, preserving the
PVC and existing configuration. Lowering retention is a separate data-deleting
operation, not an automatic rollback step.

## Current gateway capacity

The 2026-11-11 rollout found 14 existing account slots and repeated gateway
`OOMKilled` restarts at the old 2Gi limit. The gateway now requests 500m CPU /
2Gi memory and limits 2 CPU / 3Gi memory. These are gateway resources; the
portal retains 100m/128Mi requests and 500m/256Mi limits. The gateway patch
preserves its existing node selector, required hostname affinity, `regcred`,
PVC and Recreate strategy:

```sh
kubectl --context local-xjp -n vm2api patch deployment vm2api \
  --type=strategic --patch-file deploy/key-usage-gateway-patch.json
```

The 3Gi stabilization attempt later failed: one Pod was evicted for node memory
pressure and its replacement was OOMKilled at the 3Gi container limit. The user
selected keeping the current deployment and delivering the portal with this
capacity limitation. Do not describe gateway stability as verified or change
capacity/scheduling automatically. Full evidence and image-only rollback are
in `deploy/KEY_USAGE_RELEASE_20261111.md`.
