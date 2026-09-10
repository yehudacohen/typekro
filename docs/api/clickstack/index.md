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
    diskType: 's3',
    // Per-signal TTL, applied by an idempotent DDL CronJob.
    // NOT available with `diskType: 's3_plain_rewritable'` — see below.
    retention: { logs: '30d', traces: '7d', metrics: '90d' },
    // Survive a collector or ClickHouse restart during a node rebuild.
    persistentQueue: { enabled: true, size: '10Gi' },
  },
});
```

### Retention (TTL)

Durations are `'<n>d'`, `'<n>h'` or `'<n>m'`, compiled into
`ALTER TABLE … MODIFY TTL toDateTime(<column>) + INTERVAL n UNIT DELETE`. `logs` covers `otel_logs` and
`hyperdx_sessions` (a log-kind table in HyperDX's own source definitions), `traces` covers
`otel_traces`, and `metrics` covers `otel_metrics_gauge` / `_sum` / `_histogram`. Each table's TTL
keys off the timestamp column HyperDX itself queries — `Timestamp`, `TimeUnix`, `TimestampTime`.

The collector's own migration **already sets a 30-day TTL**
(`toDateTime(Timestamp) + toIntervalDay(30)`, with `ttl_only_drop_parts = 1` — verified live against
chart 3.2.0), so `retention` *overrides* that default rather than establishing the first one. The
`toDateTime(…)` wrapper matches the form the collector stores, which keeps the stored expression and
the idempotence probe directly comparable.

It runs as a **CronJob**, not a one-shot Job, for two honest reasons: the tables do not exist until
the collector has migrated, and TypeKro does not own their DDL. The script therefore skips a missing
table and re-checks on a later run, and only issues `MODIFY TTL` when the table's current TTL is not
already the intended one — so a converged cluster does no metadata churn. `retentionSchedule`
defaults to `'17 * * * *'`.

The idempotence probe compares the **complete** TTL clause, not a substring of it: it extracts
everything between `TTL ` and the trailing ` SETTINGS …` out of `system.tables.engine_full`,
collapses whitespace, and tests that for equality against the intended clause. A substring probe was
wrong in both directions — `toIntervalDay(3)` occurs inside `toIntervalDay(30)`, so a needed change
would be skipped, and a table carrying the intended interval *plus* extra clauses (a `WHERE`, a
second `TO VOLUME` entry) would also be reported as converged. On a mismatch the job logs the clause
it actually found, so a change in ClickHouse's rendering shows up in the Job log rather than as
silent per-run churn.

Every statement carries `SETTINGS materialize_ttl_after_modify = 0`, because the materialization
pass is a **mutation** and the `plain_rewritable` metadata type does not support mutations. Expiry
still happens during merges.

::: danger `retention` is incompatible with `diskType: 's3_plain_rewritable'`
The combination is **rejected at construction**. `materialize_ttl_after_modify = 0` skips the
materialization mutation, but that is not enough: the immutable metadata type refuses the metadata
`ALTER` itself. Verified live against ClickHouse 25.7 —

```text
Code: 344. DB::Exception: ALTER TABLE commands are not supported on immutable disk 's3',
except for setting and comment alteration. (SUPPORT_IS_DISABLED)
```

— while the identical statement against a table on the server's local policy succeeds, so this is a
property of the disk type, not of the statement. Rendering the CronJob anyway would ship a job that
CrashLoops on every run while reporting a retention policy that never takes effect.

**The two durability stories therefore trade off against TTL:**

| ClickHouse `diskType` | Node loss | TypeKro-managed `retention` |
| --- | --- | --- |
| `s3_plain_rewritable` | restart and reattach, no restore step | ✗ — keep the 30-day TTL the collector's migrations create |
| `s3` + `storage.backup` | restore from the scheduled backup | ✓ |
:::

The job reads its connection from the chart-owned `clickstack-config` ConfigMap and
`clickstack-secret` Secret via `envFrom` — the same pair the gateway collector uses — so it works
identically in inline and Secret-backed credential modes and keeps no credential in the manifest.

### Persistent collector queue

::: warning THE OVERLAY IS ONE YAML DOCUMENT
This is emitted through the chart's supported `global.otelCollector.customConfig` merge seam — the
same overlay that carries the ingest pipelines — and a YAML **list** in it *replaces* the
supervisor's own list rather than appending to it. So `persistentQueue.extensions` must enumerate
every extension the collector needs (default: `['health_check', 'file_storage/hyperdx']`) and
`persistentQueue.exporterNames` must name exporters the OpAMP supervisor actually defines (default:
`['clickhouse']`). Both are options precisely because the correct values depend on the ClickStack
version you deploy — inspect the rendered collector config before relying on this in production.

An exporter name the agent does not define **cannot be rejected at build time**: the exporter set
lives in the remote configuration the supervisor hands the agent, not in anything TypeKro renders.
It fails silently at runtime — the `exporters` map grows an exporter no pipeline references while
the real one keeps its in-memory queue. Check the rendered config, or check the queue directory on
the claim: the `file_storage` extension names its bbolt database `exporter_<name>_<signal>` after
the component that opened it.
:::

::: tip LIVE-VERIFIED, AND IT USED TO BE BROKEN
The overlay's contributors are composed structurally and serialised once
(`utils/collector-config.ts`). They used to be YAML **strings** that were concatenated, and both
open a top-level `service:` key, so the rendered document declared `service` twice and the
supervisor rejected the whole file on every poll:

```
Could not merge local config file: /etc/otelcol-contrib/custom/custom.config.yaml
yaml: unmarshal errors: line 18: mapping key "service" already defined at line 1
```

The agent then ran with **neither** the ingest pipelines **nor** the queue, while the Pod reported
Ready — readiness comes from the supervisor's own `health_check`, not from the agent. Enabling the
queue was a silent no-op that also took OTLP ingestion down. The integration suite now asserts that
the rendered ConfigMap declares `service` exactly once, that the supervisor's log carries no merge
rejection, and that a bbolt database for each queued exporter exists on the claim.
:::

The gateway buffers in memory by default, so a ClickHouse restart — exactly what an S3-backed node
rebuild causes — drops in-flight telemetry. `persistentQueue: { enabled: true }` adds a
`file_storage` extension, points the exporter's `sending_queue` at it, and pins the volume backing
its directory.

That volume is a **standalone `PersistentVolumeClaim` owned by the composition**, mounted by
`claimName`. It is deliberately neither of the two shapes a chart can template for you: an
`emptyDir` is deleted with the Pod, and a *generic ephemeral volume*'s PVC is
[deleted along with the Pod that owns it](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/) —
so either would be destroyed by exactly the collector restart the queue exists to survive. There is
no ephemeral fallback and no "omit `size`" path: `size` defaults to `'10Gi'`.

#### The queue means exactly one gateway collector replica

There is no access-mode knob and no shared-volume escape hatch, because the volume was never the
binding constraint. The `file_storage` extension keeps the queue in a
[bbolt](https://github.com/etcd-io/bbolt) database, and bbolt takes an **exclusive file lock** for
the lifetime of the handle — the extension's own README states one collector instance per
directory, and
[collector-contrib#5894](https://github.com/open-telemetry/opentelemetry-collector-contrib/issues/5894)
is the report of the second instance hanging on that lock. A `ReadWriteMany` volume does not fix
that: it hands both replicas the *same* locked database, so it would only trade a `Multi-Attach`
failure for a blocked collector or a corrupt queue.

So a build-time `values['otel-collector'].replicaCount` above 1 is **rejected at construction**,
and the rendered chart values pin `replicaCount: 1`. The claim is always `ReadWriteOnce`, which
stops a second Pod on another node from even attaching.

```typescript
// throws: the queue is a bbolt database under an exclusive lock — one replica
makeClickstackBootstrap({
  storage: { mode: 's3', persistentQueue: { enabled: true } },
  values: { 'otel-collector': { replicaCount: 3 } },
});

// correct
makeClickstackBootstrap({
  storage: { mode: 's3', persistentQueue: { enabled: true } },
  values: { 'otel-collector': { replicaCount: 1 } },
});
```

#### …and a `Recreate` rollout, because one replica does not bound an upgrade

`replicaCount: 1` bounds the **steady state**. It says nothing about what happens *during* a
rollout, and a rollout is where the queue's single-writer rule actually bites.

The collector chart leaves the Deployment on Kubernetes' default `RollingUpdate`
(`rollout.strategy` in its `values.yaml`), whose default `maxSurge: 25%` rounds **up** to one extra
Pod. So changing anything in the pod template — a new chart version, an image tag, an annotation —
creates the replacement collector while the old one is still running and still holds both the claim
and the queue. That overlap fails in one of two ways, depending on where the replacement lands:

- **On another node — a stuck rollout.** The `ReadWriteOnce` claim is still attached to the old
  Pod's node, so the replacement never leaves `ContainerCreating`
  (`Multi-Attach error for volume`). `RollingUpdate` will not terminate the old Pod until the new
  one is Ready, and `maxUnavailable: 25%` of one replica rounds **down** to zero, so nothing gives:
  the rollout deadlocks until `progressDeadlineSeconds` expires.
- **On the same node — a silent two-writer window.** The replacement starts, and its `file_storage`
  extension cannot take bbolt's exclusive lock while the old collector holds it. Readiness does not
  notice, because it comes from the OpAMP supervisor's own `health_check` rather than from the
  agent's extensions — the same blind spot as the `custom-config` mount below — so the Pod reports
  Ready and the rollout "succeeds" over a queue the new collector could not open. Observed live on
  a single-node cluster: under `RollingUpdate` the replacement went Ready in under 10 seconds.

The single-replica pin does not prevent either; it is what makes the overlap harmful.

Whenever `persistentQueue` is enabled, TypeKro therefore also pins:

```yaml
otel-collector:
  replicaCount: 1
  rollout:
    strategy: Recreate
```

`Recreate` removes the overlap entirely: the old collector is deleted, its claim detaches and its
lock is released, and only then is the replacement created. Nothing carries a `rollingUpdate` block
alongside it — the chart's Deployment template emits that only on the `RollingUpdate` branch, and
the API server rejects a `Recreate` strategy that has one.

**The cost is a brief gateway outage on every rollout**, and the persistent queue is precisely what
makes that cost acceptable: producers upstream of the gateway retry, and telemetry the gateway has
already accepted sits on the claim rather than in the departing Pod's memory, so the replacement
resumes draining the same queue instead of starting empty. Without a queue there would be nothing
to make the gap safe — which is why the pin is scoped to the queue. **With no `persistentQueue` the
gateway keeps the chart's `RollingUpdate` default** and stays available across a rollout.

Unlike `replicaCount`, a build-time `values['otel-collector'].rollout.strategy` is not rejected at
construction — it is simply **overridden**. The deadlock is a property of the queue, not a
trade-off the caller gets to take.

::: info Future path: per-replica queues
Running several collectors each with their **own** queue is a real design, and a different one: it
needs the upstream chart's `mode: statefulset` with `volumeClaimTemplates`, so every replica gets a
private directory. This composition renders the gateway as the chart's default Deployment mounting
one standalone claim, so that shape is not modelled today — the construction error names it rather
than leaving a shared-volume option that cannot deliver it.
:::

The HelmRelease depends on the claim, so it exists before the collector's first Pod. The claim is
treated as ready while `Pending`, because a `WaitForFirstConsumer` StorageClass (the common default)
does not bind a claim until a Pod mounts it — and that Pod comes from the HelmRelease waiting on it.

::: warning The queue values re-emit the chart's own `custom-config` volume
Helm **replaces** a list-valued override rather than appending to it, and the chart mounts the
ConfigMap it renders from `global.otelCollector.customConfig` through the same
`extraVolumes` / `extraVolumeMounts` the queue needs — its `values.yaml` carries the warning itself:

> if you override extraVolumes/extraVolumeMounts yourself, Helm replaces these lists entirely

Verified live what happens otherwise: the queue volume evicts the custom-config mount, the OpAMP
supervisor logs `Could not read local config file: open
/etc/otelcol-contrib/custom/custom.config.yaml: no such file or directory` on every poll, and the
agent starts **without** the overlay — losing both the ingest pipelines and the queue's own
`file_storage` wiring, while the Pod still reports Ready (readiness comes from the *supervisor's*
health_check, not the agent's). TypeKro therefore re-emits the chart's entry alongside the queue's,
and both a unit test and the integration suite assert the two mounts coexist.
:::

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
