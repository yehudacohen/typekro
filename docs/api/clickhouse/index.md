---
title: ClickHouse Factories
description: Factory functions for ClickHouse clusters via the Altinity clickhouse-operator
---

# ClickHouse Factories

Factory functions for [ClickHouse](https://clickhouse.com/) on Kubernetes via the official [Altinity clickhouse-operator](https://github.com/Altinity/clickhouse-operator) (Apache-2.0). TypeKro wraps the official `altinity-clickhouse-operator` Helm chart and the `ClickHouseInstallation` (CHI) / `ClickHouseKeeperInstallation` (CHK) CRDs — never hand-rolled manifests.

## Import

```typescript
// Import specific functions (recommended)
import {
  clickhouseOperatorBootstrap,
  makeClickHouseCluster,
  clickHouseInstallation,
  clickHouseKeeperInstallation,
} from 'typekro/clickhouse';

// Or namespace import
import * as clickhouse from 'typekro/clickhouse';
```

## Quick Example

```typescript
import { clickhouseOperatorBootstrap, makeClickHouseCluster } from 'typekro/clickhouse';

// 1. Install the operator — exactly ONCE per cluster. The bootstrap owns the
// operator Namespace, so TypeKro hoists that namespace out of the RGD graph
// (retained) and the instance CR stays in the `clickhouse-system` namespace.
const operator = clickhouseOperatorBootstrap.factory('kro', {
  namespace: 'clickhouse-system',
});
await operator.deploy({
  name: 'clickhouse-operator',
  namespace: 'clickhouse-system',
});

// 2. Fix the TOPOLOGY at construction time (build-time)...
const clickhouse = makeClickHouseCluster({
  zones: ['us-east-2a', 'us-east-2b'], // zone-pinned replicas (EBS is zonal)
  replicas: 2,
  shards: 1,
  users: [{ name: 'signoz' }],         // user names are build-time path fragments
});

// 3. ...and deploy with RUNTIME spec (all fields proxy/schema-ref safe).
await clickhouse.factory('kro', { namespace: 'observability' }).deploy({
  name: 'signoz-clickhouse',
  namespace: 'observability',
  version: '25.12.5',
  storage: { size: '100Gi', storageClassName: 'gp3-expandable' },
  keeper: { host: 'keeper-signoz.observability.svc.cluster.local' },
  users: { signoz: { passwordSha256Hex: '<sha256-hex>' } },
});
```

## Available Factories

| Factory | Kind | Description |
|---------|------|-------------|
| `clickhouseOperatorBootstrap` | Composition | Operator install (namespace + shared Helm repo singleton + HelmRelease) |
| `makeClickHouseCluster(topology)` | Composition constructor | Build-time topology → composition with proxy-safe runtime spec |
| `clickHouseCluster` | Composition | `makeClickHouseCluster()` with the default single-node topology |
| `clickHouseInstallation` | ClickHouseInstallation | Low-level typed CHI (concrete topology only) |
| `clickHouseKeeperInstallation` | ClickHouseKeeperInstallation | Typed CHK coordination service |
| `clickhouseHelmRepository` | HelmRepository | Altinity chart repository (Flux source) |
| `clickhouseOperatorHelmRelease` | HelmRelease | Operator chart release |

## One Operator Per Cluster

The Altinity operator is **cluster-scoped and owns the ClickHouse CRDs** (`clickhouseinstallations.clickhouse.altinity.com`, `clickhousekeeperinstallations.clickhouse-keeper.altinity.com`, and friends). Install exactly one `clickhouseOperatorBootstrap` per cluster; every CHI/CHK in the cluster is reconciled by that single install. Multiple installs fight over CRD ownership and watch the same resources.

The bootstrap defaults to `shared: true`, which tags the operator's Namespace and HelmRelease with `scopes: ['cluster']` so `factory.deleteInstance()` leaves the shared operator intact. Tear shared infra down explicitly with `deleteInstance(name, { scopes: ['cluster'] })`. Set `shared: false` only for throwaway environments (e.g. kind-cluster integration tests).

### Singleton Helm repository ownership

The Altinity chart repository (`https://helm.altinity.com`) is a single cluster-level Flux source. The bootstrap deploys it via `singleton(...)` with a fixed identity (`clickhouse-helm-repository`) instead of inlining it: an inlined HelmRepository would be owned by one instance's KRO ApplySet, and a second bootstrap instance would fail with an ApplySet-reassignment error. `toYaml()` emits the singleton owner RGD before the bootstrap RGD (deps-first).

### CRD hook behavior under Flux

The chart installs CRDs via a Helm hook (`crdHook.enabled`). When deploying through Flux (as this composition does), helm-controller applies its own CRD policy (`install.crds` / `upgrade.crds`) — CRD **upgrades** across operator versions deserve explicit review rather than blind chart bumps. Leave `crdHook` unset to use chart defaults.

## Build-Time Topology vs Runtime Spec

`makeClickHouseCluster(topology)` splits the CHI honestly into two halves:

**Build-time (constructor arguments — must be concrete JS values):**

- `zones` — availability zones to pin replicas to
- `replicas`, `shards` — cluster layout
- `keeper` — whether the cluster coordinates through Keeper (defaults to `true` when `replicas > 1`)
- `users[].name` and `users[].networksIp` — user names become CHI configuration **path fragments**

**Runtime (spec fields — schema refs / proxies serialize to clean CEL):**

- `name`, `namespace`, `version`, `clusterName`
- `storage.size`, `storage.storageClassName`
- `keeper.host`, `keeper.port`
- `users.<name>.passwordSha256Hex` (one literal key per declared user)
- `podResources`

### Why zones are build-time (and why zone pinning exists at all)

The zone-pinned layout enumerates pod templates and per-replica layout entries — the *number and identity* of emitted resources depends on it, so it can never be instance-dynamic.

The pinning itself works around two facts:

1. **EBS volumes are zonal.** A replica rescheduled into another AZ strands its PVC and the pod wedges `Pending`.
2. **The operator cannot spread by zone natively.** Its `podDistribution` supports only the `kubernetes.io/hostname` topologyKey ([Altinity/clickhouse-operator#772](https://github.com/Altinity/clickhouse-operator/issues/772)).

So the factory compiles an explicit per-replica `layout.replicas:` list where each replica references a pod template pinned to one zone via `nodeAffinity` on `topology.kubernetes.io/zone` (round-robin when `replicas > zones.length`). On EKS, pair this with a `WaitForFirstConsumer` + `allowVolumeExpansion: true` gp3 StorageClass.

If a build-time field receives a schema ref, the factory **throws loudly at graph construction** with the field name and the fix — it never leaks `__KUBERNETES_REF__` markers into generated YAML:

```text
clickHouseInstallation: 'replicas' is a BUILD-TIME topology field and received a
schema reference or CEL expression. ... For schema-driven compositions, fix the
topology at construction time with makeClickHouseCluster({ zones, replicas,
shards, users }) and pass only runtime fields through the spec.
```

### The low-level `clickHouseInstallation()`

`clickHouseInstallation(config)` remains available as the concrete-topology escape hatch (direct mode, or compositions whose topology is a literal). It applies the same loud build-time guards. Prefer `makeClickHouseCluster()` in compositions.

## Users Shape

Users are an **array**, not a name-keyed map:

```typescript
users: [
  {
    name: 'signoz',                       // build-time: becomes `signoz/password_sha256_hex`
    passwordSha256Hex: schema.spec.hash,  // runtime value: refs serialize to CEL
    networksIp: ['::/0'],                 // default: ['::/0']
  },
]
```

User names become CHI configuration path fragments (`<name>/password_sha256_hex`, `<name>/networks/ip`), so they must be concrete — a map keyed by schema proxies would serialize `__typekroSchemaKey/...` garbage. Password hashes and network lists are plain value positions: schema refs serialize to clean CEL (proven under `TYPEKRO_STRICT_CEL=1` in the test suite).

In `makeClickHouseCluster`, declared user names become **literal keys** in the generated runtime spec schema — `spec.users.signoz.passwordSha256Hex` — so each declared user's credential is a required, typed, ref-safe field.

For credentials generated or managed by another controller, select the Secret-backed
runtime shape when constructing the cluster. The CHI contains only the Secret
reference; the cleartext password never enters the TypeKro instance or deployment
state:

```typescript
const clickhouse = makeClickHouseCluster({
  users: [{ name: 'otelcollector', credentialSource: 'secret' }],
});

clickhouse({
  // ...name, namespace, version, storage...
  users: {
    otelcollector: {
      passwordSecretRef: { name: 'clickhouse-credentials', key: 'password' },
    },
  },
});
```

The low-level `clickHouseInstallation()` accepts the same
`passwordSecretRef: { name, key }` field. A user must not declare both a Secret
reference and `passwordSha256Hex`.

## Status Contract

`makeClickHouseCluster` exposes a typed service contract so downstream compositions (e.g. a SigNoz factory) never reconstruct Altinity hostnames by hand:

```typescript
status: {
  ready: boolean;                     // CHI reconcile == 'Completed'
  phase: 'Installing' | 'Ready' | 'Failed';
  clickhouse: {
    host: string;                     // clickhouse-{name}.{namespace}.svc.cluster.local
    port: number;                     // 9000
    nativeUrl: string;                // clickhouse://host:9000
    httpUrl: string;                  // http://host:8123
    clusterName: string;              // 'cluster' unless overridden
    database: string;                 // 'default'
    user?: string;                    // first declared user
  };
  keeper?: { host: string; port: number };
  installation: {
    name: string;
    namespace: string;
    endpoint?: string;                // operator-reported
    hostsCount?: number;
    hostsCompletedCount?: number;
  };
}
```

```typescript
signoz({
  clickhouse: {
    host: clickhouse.status.clickhouse.host,
    port: clickhouse.status.clickhouse.port,
    cluster: clickhouse.status.clickhouse.clusterName,
  },
});
```

The connection details are derived from the operator's **verified naming conventions** (checked against clickhouse-operator `release-0.27.1` sources):

- CR-level Service: `clickhouse-{chi-name}`, type ClusterIP (`pkg/model/chi/namer/patterns.go` `patternCRServiceName`) — the stable entrypoint.
- Per-host Services: `chi-{chi}-{cluster}-{shard}-{replica}` (StatefulSet-level pattern in the same file).
- Default ports: native TCP `9000`, HTTP `8123`, Keeper client `2181` (`pkg/apis/clickhouse.altinity.com/v1/type_host.go` `ChDefaultTCPPortNumber` / `ChDefaultHTTPPortNumber` / `KpDefaultZKPortNumber`).
- Reconcile state machine: `status.status` ∈ `InProgress | Completed | Aborted | Terminating` (`pkg/apis/clickhouse.altinity.com/v1/type_status.go`), shared by CHI and CHK.

**Where each field lives on the KRO CR.** The contract is anchored on the **owned CHI resource** so it serializes as KRO status CEL and is visible on the live KRO CR's status (GitOps/KRO consumers can read it):

- `ready`, `phase`, `installation.endpoint`, host counters — CEL over `clickhouse.status.*`.
- `clickhouse.host`, `clickhouse.nativeUrl`, `clickhouse.httpUrl` — CEL string concat over `clickhouse.metadata.name` / `clickhouse.metadata.namespace` (the operator's `clickhouse-{chi-name}` CR-service naming), with the port constants embedded in the URL strings.
- `clickhouse.clusterName` — `clickhouse.spec.configuration.clusters[0].name` (the resolved name in the CHI itself).
- `keeper.host` / `keeper.port` — `clickhouse.spec.configuration.zookeeper.nodes[0].*`.
- `installation.name` / `installation.namespace` — `clickhouse.metadata.*`.

Only the **bare build-time constants** — `clickhouse.port` (9000), `clickhouse.database` (`'default'`), and `clickhouse.user` (first declared user) — are hydrated client-side and absent from the KRO CR status: KRO status CEL cannot express a literal-only field (nor reference `schema.spec.*`), and there is no honest resource field to anchor them on. The native port is still KRO-visible inside `nativeUrl`/`httpUrl`.

Operator health is deliberately **not** part of this contract: the operator is separate
one-per-cluster infrastructure whose own bootstrap status carries `ready`, `failed`, `phase`, and
`version`. Its phase is `Ready`, `Installing`, or `Failed`, derived from the Flux HelmRelease
`Ready` condition.

**Hydration (bimodal — both factory modes).** The metadata-anchored fields `clickhouse.host`/`nativeUrl`/`httpUrl` and `installation.name`/`namespace` are built with **natural JS template literals** over the CHI resource proxy — e.g. `` `clickhouse-${clickhouse.metadata.name}.${clickhouse.metadata.namespace}.svc.cluster.local` ``. On typekro >= 0.24.0 (which carries the [typekro#97](https://github.com/yehudacohen/typekro/pull/97) resource-metadata-proxy fix) these resolve in **both** factory modes: in `factory('kro')` the analyzer converts them to status CEL and `clickhouse.metadata.*` resolves resource-anchored (not degraded to `schema.spec.name`), so they reach the live CR status; in `factory('direct')` the template literal is plain JS, so live-status re-execution evaluates it against the real resource and hydrates a concrete string. This replaced an earlier raw `Cel.expr("...")` workaround that was opaque to direct mode (the typekro#94 gap). `ready`/`phase`/`installation.endpoint`/`hostsCount`/`hostsCompletedCount` (plain `clickhouse.status.*` access / JS comparisons) hydrate in both modes too. The remaining resource-anchored fields — `clickhouse.clusterName`, `keeper.host`, `keeper.port` — stay raw `Cel.expr` rather than natural template literals for **ergonomic** reasons: they are deep reads through optional nested arrays (`configuration.clusters[0]` / `zookeeper.nodes[0]`) where natural proxy access needs non-null assertions that add noise, and `keeper.port` must additionally stay a number (a template literal would coerce it to a string). This is **not** a hydration limitation — being resource-path CEL, they resolve in **both** modes: status CEL in `factory('kro')`, and the cel-js reference resolver evaluates them against the live CHI in `factory('direct')` (`clusterName` hydrates to the concrete `'cluster'` in the direct-mode integration test).

## SigNoz Compatibility

SigNoz's ClickHouse migrations hardcode the logical cluster name **`cluster`** — the default `clusterName` here. Keep the default for any CHI a SigNoz deployment points at; override only for non-SigNoz consumers.

## Keeper (CHK)

`clickHouseKeeperInstallation()` compiles a minimal `clickhouse-keeper.altinity.com/v1` CHK (replicated tables need coordination; use an odd `replicas` count for quorum):

```typescript
const keeper = clickHouseKeeperInstallation({
  name: 'keeper',
  namespace: 'observability',
  replicas: 3,
  storage: { size: '10Gi', storageClassName: 'gp3-expandable' },
  id: 'clickhouseKeeper',
});
```

The CHI consumes it through the operator's `zookeeper` configuration section (which serves clickhouse-keeper too): `keeper: { host, port? }` with port defaulting to `2181`.

## Operator Bootstrap Options

```typescript
await clickhouseOperatorBootstrap.factory('kro').deploy({
  name: 'clickhouse-operator',
  namespace: 'clickhouse-system',   // default
  version: '0.27.1',                // pinned chart version
  metrics: { enabled: true },       // metrics exporter (chart default: true)
  crdHook: { enabled: true },       // CRD install hook — see Flux note above
  resources: { requests: { cpu: '100m', memory: '128Mi' } },
  customValues: { nodeSelector: { 'kubernetes.io/os': 'linux' } },
  shared: true,                     // default — cluster-scoped lifecycle
});
```

`customValues` works in **both** modes: a concrete object deep-merges into the mapped values at build time; in graph mode the schema ref routes through TypeKro's runtime values merge, so the override map lands in the KRO-serialized HelmRelease values (merged last — user overrides win).

## Related

- [YAML & Helm Integration](/api/yaml-closures) — the underlying HelmRepository/HelmRelease integration
- [CloudNativePG](/api/cnpg/) — the same operator-wrapping pattern for PostgreSQL
- [kubernetesComposition](/api/kubernetes-composition) — the composition API used by `makeClickHouseCluster`
