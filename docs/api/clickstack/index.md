# ClickStack (HyperDX) Factories

Deploy [ClickStack](https://clickhouse.com/docs/use-cases/observability/clickstack) — ClickHouse Inc.'s
observability stack (the HyperDX UI/API, an OTel gateway collector, and schema migrations) — via the
OFFICIAL `clickstack` Helm chart (3.0.x, MIT) from
[`ClickHouse/ClickStack-helm-charts`](https://github.com/ClickHouse/ClickStack-helm-charts), wired to an
**external ClickHouse** you already run (e.g. an Altinity-operator-managed
[`ClickHouseInstallation`](../clickhouse/)).

## Secrets Caveat

`clickhouse.password`, `clickhouse.appPassword`, and `apiKey` travel as **plaintext** runtime spec
values all the way into the generated HelmRelease's `spec.values.hyperdx.secrets.*` — a Kubernetes
object stored in etcd, readable by anyone with read access to the HelmRelease/RGD instance
(`kubectl get helmrelease -o yaml`). This is unlike `clickstackK8sTelemetry`'s `apiKeySecret` (a
`secretKeyRef` env var — the value never appears in any CR spec). There is currently **no
existing-Secret alternative** for these three fields. Do not treat this family as production-ready
for credentials that need stronger-than-etcd-RBAC protection until that gap is closed.

## Import

```typescript
import {
  clickstackBootstrap,
  makeClickstackBootstrap,
  clickstackK8sTelemetry,
  makeClickstackK8sTelemetry,
} from 'typekro/clickstack';
```

## Quick Example

```typescript
// 1. The stack (internal dev-first Mongo, external ClickHouse):
const factory = clickstackBootstrap.factory('kro', { namespace: 'typekro-system' });
const stack = await factory.deploy({
  name: 'clickstack',
  clickhouse: {
    host: 'clickhouse-observability.clickhouse.svc.cluster.local',
    username: 'otelcollector',
    password: '…',
  },
  apiKey: '…',
});

// 2. Cluster telemetry into it (wired from the status contract):
const telemetry = clickstackK8sTelemetry.factory('kro', { namespace: 'typekro-system' });
await telemetry.deploy({
  name: 'telemetry',
  endpoint: stack.status.gateway.otlpHttpEndpoint,
  apiKeySecret: { name: 'clickstack-api-key' },
});
```

## External ClickHouse ONLY (and never `clickstack-operators`)

The chart's bundled ClickHouse and MongoDB are **hard-pinned off** (`clickhouse.enabled: false`,
`mongodb.enabled: false`) and those pins beat any build-time `values` passthrough — in both direct and
KRO mode. Their CRDs belong to the `clickstack-operators` prerequisite chart, whose ClickHouse operator
(ClickHouse Inc.'s own) **collides with the Altinity clickhouse-operator** managing your
ClickHouseInstallations, and which drags in a MongoDB operator besides. This integration never installs
it.

Point `spec.clickhouse` at your CHI — the [`clickhouse` factories'](../clickhouse/) status contract
gives you the coordinates (`chi.status.clickhouse.host`, ports, cluster name) without hand-building
service names.

## MongoDB Modes (build-time)

HyperDX requires MongoDB for app state (dashboards, alerts, users — metadata only):

- **`makeClickstackBootstrap()`** (default): an **internal single-replica** `mongo:7`
  StatefulSet + Service — no operator, no CRDs, no auth. Dev-first; NOT an HA datastore.
- **`makeClickstackBootstrap({ mongo: { mode: 'external' } })`**: the variant's runtime spec REQUIRES
  `mongoUri` (topology shapes the schema); nothing Mongo-shaped is deployed.

## Build-Time Options vs Runtime Spec

Build-time (constructor — must be concrete; schema refs are rejected loudly): the Mongo mode + storage,
static raw chart `values`, RGD `name`/`kind`. Runtime spec (proxy-safe): release name, namespace, chart
version, the ClickHouse connection, API key, HyperDX conveniences.

Note `customValues` is **not part of the runtime schema** — it's absent from `bootstrapBaseShape`, so
KRO-mode callers (whose spec is validated against that schema, and whose values come out as CEL) cannot
use it at all: the mapped values tree carries CEL template leaves, which cannot live inside a KRO
runtime map-merge (the serialized CEL is invalid). It IS accepted as an internal, **direct-mode-only**
escape hatch by the wider runtime-config type the values mapper consumes — only a CONCRETE object
merges, and there's no test coverage backing it as a supported feature. For anything beyond ad hoc
direct-mode tweaks, go through the build-time `values` instead.

## Schema / Replication Caveat

On first start the gateway collector's goose migrations create `otel_logs` / `otel_traces` /
`otel_metrics_*` / `hyperdx_sessions` in the external ClickHouse as **plain single-node MergeTree**
tables — matching a 1-shard×1-replica CHI. Multi-replica (`ON CLUSTER` / `Replicated*`) schemas are NOT
supported by ClickStack's tooling; see `CLICKSTACK_CLICKHOUSE_GUIDANCE` before scaling the CHI. Version
coupling is loose (chart vendors CH 25.7; a `<26.2` compat schema variant exists; the optional
JSON-typed schema via `HYPERDX_OTEL_EXPORTER_CLICKHOUSE_JSON_ENABLE` wants CH 25.3+).

## Status Contract

Beyond `ready`/`phase` (KRO CEL from the owned HelmRelease), the status exposes typed connection
details so downstream compositions never reconstruct chart naming rules:

```typescript
status: {
  ready: boolean;
  phase: 'Ready' | 'Installing' | 'Failed';
  ui: { url: string };
  gateway: { otlpHttpEndpoint: string; otlpGrpcEndpoint: string };
  app: { host: string; appPort: number; apiPort: number };
}
```

**Where each field lives on the KRO CR.** The connection contract is anchored on the **owned
HelmRelease resource**, so it serializes as KRO status CEL and is visible on the live KRO CR's
status (GitOps/KRO consumers can read it):

- `ready`, `phase` — CEL over `clickstackHelmRelease.status.conditions`.
- `ui.url`, `gateway.otlpHttpEndpoint`, `gateway.otlpGrpcEndpoint`, `app.host` — CEL string concat
  over `clickstackHelmRelease.metadata.name` / `.namespace` (the mapper pins `fullnameOverride` to
  the release name, so the HyperDX Service is `<name>` and the gateway Service is
  `<name>-otel-collector`), with the chart-default ports embedded in the URL strings.

Only the **bare build-time constants** `app.appPort` (3000) and `app.apiPort` (8000), plus the
spec-derived `version`, are **client-hydrated** and absent from the KRO CR status — KRO status CEL
cannot express a literal-only field (nor reference `schema.spec.*`), and there is no honest
HelmRelease field to anchor them on. Both ports are still KRO-visible inside `ui.url` and the
gateway endpoints.

## Kubernetes Telemetry

`clickstackK8sTelemetry` implements the
[documented ingestion pattern](https://clickhouse.com/docs/use-cases/observability/clickstack/ingesting-data/kubernetes):
TWO instances of the **stock** `opentelemetry-collector` chart — a daemonset (presets:
`logsCollection`, `hostMetrics`, `kubeletMetrics`, `kubernetesAttributes`) and a deployment (presets:
`kubernetesEvents`, `clusterMetrics`) — both exporting `otlphttp` to the ClickStack gateway. The
HyperDX API key is wired via `secretKeyRef` + OTel `${env:…}` expansion, so the key value never lands
in Helm values.
