# Agent Substrate installation

`agentSubstrateInstallation(options)` installs the Kubernetes control plane of
[Agent Substrate](https://github.com/agent-substrate/substrate) v1.0.0 as ordinary TypeKro
declarations, in dependency order, with readiness for every rollout and an uninstall that follows
the graph in reverse.

```typescript
import { agentSubstrateInstallation } from 'typekro/agent-substrate';

const substrate = agentSubstrateInstallation({
  ingressAllowedSpiffeIds: ['spiffe://cluster.local/ns/app/sa/client'],
  workerPools: [{ namespace: 'agents', name: 'default', replicas: 2 }],
});
await substrate.factory('direct', { waitForReady: true }).deploy({});
```

## The pinned bundle

The bundle is not supplied by the caller. `releases/v1.0.0.ts` is the release rendered from
commit `b34fbee742906494b5eb4f1f36987176bf8770a4`, which tag `v1.0.0` names, by
`scripts/vendor-agent-substrate-release.ts`:

| Field | Value |
| --- | --- |
| Canonical sha256 | `efafeb40b52f619855adcd5d5f0c2c0ebae795dff216f01b030ce4c44af7c7e5` |
| Source files | 16 files under `manifests/ate-install/`, each recorded with its git blob |
| Images | `ghcr.io/agent-substrate/substrate/<image>:v1.0.0@sha256:…`, the index the tag names |
| Built-in scopes | Kubernetes v1.36.1 OpenAPI paths |

The composition refuses a bundle whose canonical sha256 differs from `agentSubstrateBundleSha256`
or that runs any image other than the release's. `bun run scripts/vendor-agent-substrate-release.ts
--check` re-renders the bundle from upstream and fails unless it matches: the tag must name the
commit, every file is fetched at the commit, and every platform image must carry
`org.opencontainers.image.revision` equal to the commit.

The render is what `ate-setup deploy ate-system` at that commit applies for a canonical install
from published images: no preview gates, the Envoy dataplane, the default footprint, the gVisor
SandboxConfig `gvisor-default`, and egress credential injection off. The script's header lists
each transformation.

Left out, because another owner holds them: the bundled PostgreSQL (`postgres/`), the microVM
SandboxConfig (it needs staged guest assets), the Kubernetes Secrets credential provider, and
GKE Managed Prometheus monitoring (`atenet-router-monitoring.yaml`, which needs that CRD).

## Prerequisites the installation does not create

`ate-setup` generates these from runtime state; the installation references them by name. Create
them before the control plane can become ready:

- In `ate-system`: Secrets `actor-id-ca-pool`, `actor-id-ca-certs`, `actor-id-jwt-pool`,
  `egress-mitm-ca-pool`, `postgres-server-ca` and `ate-api-server-secret-envvars`, and ConfigMaps
  `ate-api-config`, `ate-api-authentication` and `ate-api-server-envvars` (the PostgreSQL
  connection and snapshot store).
- In `podcertificate-controller-system`: Secrets `pod-identity-ca-pool`, `service-dns-ca-pool`
  and `postgres-ca-pool`.
- The cluster must serve `certificates.k8s.io/v1beta1` PodCertificateRequests and
  ClusterTrustBundles.

## Options

Only these values change the release objects:

- `ingressAllowedSpiffeIds` becomes the router's `--ingress-allowed-spiffe-ids`. Unset, no client
  reaches actors through the router.
- `workerPools` adds gVisor WorkerPools that run the release's `ateworker-gvisor` image, each in a
  namespace the installation owns. `sandboxConfig` (a `configRef`) and placement are optional, as
  upstream: without `configRef` a pool resolves the class default.

The namespace is always `ate-system` (and `podcertificate-controller-system` for the pod
certificate controller). The release's flags, Service DNS names, NetworkPolicies and certificate
identities name it literally, so the installation is not relocatable.

## Readiness

`readiness.ts` writes each kind's readiness once, as CEL. The resource-level evaluators run it
with cel-js and the root `status.ready` is the conjunction of the same expressions over every CRD,
Deployment, DaemonSet, SandboxConfig and WorkerPool, so the two agree:

- CRDs: `Established` and `NamesAccepted`.
- Deployments: the current generation observed, and every desired replica updated, ready and
  available, with no older pod left. DaemonSets: every scheduled pod updated, ready and available.
- WorkerPools: every replica ready (a pool of zero is ready once resolved), and each sandbox class
  `Resolved` for the current generation, on the `configRef` it names (or any class default), with
  no `pendingConfigRef`.
- Any object being deleted is not ready.

Cluster-scoped objects carry the `agent-substrate-cluster` deletion scope. Uninstall them with
`deleteInstance(name, { scopes: ['agent-substrate-cluster'] })`, after the application has drained
and finalized its actors.

## Tests

- `test/factories/agent-substrate/`: the bundle identity, scopes against the bundle CRDs and the
  Kubernetes OpenAPI, root and resource readiness, and the complete render validated against the
  Kubernetes v1.36.1 schemas, the bundle CRDs and its admission policy.
- `test/integration/agent-substrate/kind-install.test.ts`: installs and uninstalls on a disposable
  kind cluster (`bun run test:integration:agent-substrate`). CI has no cluster and does not run it.
