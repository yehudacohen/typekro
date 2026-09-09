# ClickStack (HyperDX) Factories

Deploy [ClickStack](https://clickhouse.com/docs/use-cases/observability/clickstack) — ClickHouse Inc.'s
observability stack (the HyperDX UI/API, an OTel gateway collector, and schema migrations) — via the
OFFICIAL `clickstack` Helm chart (3.2.x, MIT) from
[`ClickHouse/ClickStack-helm-charts`](https://github.com/ClickHouse/ClickStack-helm-charts), wired to an
**external ClickHouse** you already run (e.g. an Altinity-operator-managed
[`ClickHouseInstallation`](../clickhouse/)).

## Credential modes

The default accepts `clickhouse.password`, `clickhouse.appPassword`, and a required, non-empty
`apiKey` inline. The published chart placeholder is rejected. Those values enter the HelmRelease
and RGD instance, so use that mode only when etcd/RBAC protection is sufficient.

For production, construct the Secret-backed variant:

```typescript
const clickstack = makeClickstackBootstrap({
  credentials: { source: 'secretValues' },
});

await clickstack.factory('kro', { namespace: 'typekro-system' }).deploy({
  name: 'clickstack',
  namespace: 'observability',
  clickhouse: {
    host: 'clickhouse-observability.observability.svc.cluster.local',
    username: 'otelcollector',
  },
  credentialsSecret: {
    name: 'clickstack-credentials',
    valuesKey: 'values.yaml',
  },
});
```

The Secret key is a Helm values fragment containing `hyperdx.secrets` and, when a preconfigured UI
connection is desired, `hyperdx.deployment.defaultConnections`. Flux merges it before TypeKro's
non-sensitive inline values. TypeKro deliberately omits those credential-bearing paths from the
HelmRelease and rejects inline password/API-key fields in this variant. The Secret must be in the
ClickStack workload namespace because Flux values references are namespace-local. The fragment must
override `hyperdx.secrets.HYPERDX_API_KEY`: an idempotent reconciliation CronJob refuses the chart's
published placeholder and keeps the installation non-ready until an authoritative Team is updated.
It reruns every minute so API-key and external-Mongo URI rotations converge without replacing an
immutable completed Job.

Omit `namespace` to let TypeKro create and own the documented `clickstack` default Namespace. Pass
`namespace` when a parent platform owns the workload Namespace; ClickStack targets that Namespace
without creating or deleting it. The same rule is preserved when the factory is nested in another
composition, so one Kubernetes Namespace never gains competing lifecycle owners.

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
// 1. The stack (internal dev-first Mongo, external ClickHouse). Omitting the
// runtime namespace asks TypeKro to hoist and own its `clickstack` default.
const bootstrap = makeClickstackBootstrap({ credentials: { source: 'secretValues' } });
const factory = bootstrap.factory('kro', { namespace: 'typekro-system' });
const stack = await factory.deploy({
  name: 'clickstack',
  clickhouse: {
    host: 'clickhouse-observability.clickhouse.svc.cluster.local',
    username: 'otelcollector',
  },
  credentialsSecret: { name: 'clickstack-credentials', valuesKey: 'values.yaml' },
});

// 2. Cluster telemetry into it (wired from the status contract):
const telemetry = clickstackK8sTelemetry.factory('kro', { namespace: 'clickstack-telemetry' });
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
credential source, the external ClickHouse's [`storage`](#s3-backed-clickhouse) story,
static raw chart `values`, RGD `name`/`kind`. Runtime spec (proxy-safe): release name,
namespace, chart version, the ClickHouse connection, credential Secret coordinates or inline API key,
and HyperDX conveniences.

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

## S3-backed ClickHouse

When the external ClickHouse keeps its data in object storage
([`makeClickHouseCluster({ storage: { mode: 's3' } })`](/api/clickhouse/#storage)), the storage
**policy** needs nothing here: the `clickhouse` factory sets `merge_tree/storage_policy` as the
server default, so the gateway collector's goose migrations create `otel_logs` / `otel_traces` /
`otel_metrics_*` / `hyperdx_sessions` on the S3 policy with no `SETTINGS storage_policy` clause and
no per-table DDL from TypeKro. The kind integration suite asserts exactly that
(`test/integration/clickstack/s3-backed.test.ts`).

`storage` here covers the three things a server default cannot express — TTL retention, the
collector's persistent sending queue, and the status contract:

```typescript
const bootstrap = makeClickstackBootstrap({
  mongo: { mode: 'internal', storage: { storageClassName: 'gp3-expandable' } },
  storage: {
    mode: 's3',
    diskType: 's3_plain_rewritable',
    // Per-signal TTL, applied by an idempotent DDL CronJob.
    retention: { logs: '30d', traces: '7d', metrics: '90d' },
    // Survive a ClickHouse restart during a node rebuild.
    persistentQueue: { enabled: true, size: '10Gi' },
  },
});
```

### Retention (TTL)

Durations are `'<n>d'`, `'<n>h'` or `'<n>m'`, compiled into
`ALTER TABLE … MODIFY TTL <column> + INTERVAL n UNIT DELETE`. `logs` covers `otel_logs` and
`hyperdx_sessions` (a log-kind table in HyperDX's own source definitions), `traces` covers
`otel_traces`, and `metrics` covers `otel_metrics_gauge` / `_sum` / `_histogram`. Each table's TTL
keys off the timestamp column HyperDX itself queries — `Timestamp`, `TimeUnix`, `TimestampTime`.

It runs as a **CronJob**, not a one-shot Job, for two honest reasons: the tables do not exist until
the collector has migrated, and TypeKro does not own their DDL. The script therefore skips a missing
table and re-checks on a later run, and only issues `MODIFY TTL` when the table's current
`create_table_query` does not already carry the target interval — so a converged cluster does no
metadata churn. `retentionSchedule` defaults to `'17 * * * *'`.

Every statement carries `SETTINGS materialize_ttl_after_modify = 0`, because the materialization
pass is a **mutation** and the `plain_rewritable` metadata type does not support mutations. Expiry
still happens during merges.

The job reads its connection from the chart-owned `clickstack-config` ConfigMap and
`clickstack-secret` Secret via `envFrom` — the same pair the gateway collector uses — so it works
identically in inline and Secret-backed credential modes and keeps no credential in the manifest.

### Persistent collector queue

::: warning NOT VERIFIED AGAINST A LIVE CHART RENDER
This is emitted through the chart's supported `global.otelCollector.customConfig` merge seam, and a
YAML **list** in that overlay *replaces* the supervisor's own list rather than appending to it. So
`persistentQueue.extensions` must enumerate every extension the collector needs (default:
`['health_check', 'file_storage/hyperdx']`) and `persistentQueue.exporterName` must match the
exporter the OpAMP supervisor actually defines (default: `'clickhouse'`). Both are options precisely
because the correct values depend on the ClickStack version you deploy — inspect the rendered
collector config before relying on this in production.
:::

The gateway buffers in memory by default, so a ClickHouse restart — exactly what an S3-backed node
rebuild causes — drops in-flight telemetry. `persistentQueue: { enabled: true }` adds a
`file_storage` extension, points the exporter's `sending_queue` at it, and pins the volume backing
its directory. Omit `size` for an `emptyDir` (survives a ClickHouse restart, not a collector pod
restart); pass `size` for an ephemeral PVC that survives both.

## Status Contract

Beyond `ready`/`phase` (KRO CEL from the owned HelmRelease and Team-bootstrap CronJob), the status
exposes typed connection details so downstream compositions never reconstruct chart naming rules:

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

- `ready`, `phase` — generation-aware CEL over `clickstackHelmRelease.status.conditions`, combined
  with the authoritative Team-bootstrap CronJob's current schedule and last successful execution.
  `ready` becomes true only after Flux has observed the current HelmRelease generation **and** the
  current credential bootstrap has completed successfully; `phase` remains `Installing` until both
  gates pass and becomes `Failed` on a current-generation Helm failure.
- `ui.url`, `gateway.otlpHttpEndpoint`, `gateway.otlpGrpcEndpoint`, `app.host` — CEL string concat
  over `clickstackHelmRelease.metadata.name` / `.namespace` (the mapper pins `fullnameOverride` to
  the release name, so the HyperDX Service is `<name>` and the gateway Service is
  `<name>-otel-collector`), with the chart-default ports embedded in the URL strings.

Only the **bare build-time constants** `app.appPort` (3000), `app.apiPort` (8000) and the whole
`storage` block (`mode`, `diskType`, `policyName`, `retention`, `persistentQueue` — sitting next to
`gateway.otlpHttpEndpoint` so one read answers both "where do I send telemetry" and "what happens to
it"), plus the spec-derived `version`, are **client-hydrated** and absent from the KRO CR status — KRO status CEL
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

Its aggregate status waits for both collector releases and distinguishes a definite Flux failure
from an in-progress install:

```typescript
status: {
  ready: boolean;
  failed: boolean;
  phase: 'Ready' | 'Installing' | 'Failed';
}
```

`ready` is true only when both releases report `Ready=True`; `failed` is true when either reports
`Ready=False`.
