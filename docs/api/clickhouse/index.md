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
- `storage` — the storage *mode*. PVC (the default) or the full S3 disk configuration; see [Storage](#storage)
- `systemLogs`, `probes` — where ClickHouse's own `system.*_log` tables live, how long they are kept, and the server container's probes; see [System log tables and startup time](#system-log-tables-and-startup-time)

**Runtime (spec fields — schema refs / proxies serialize to clean CEL):**

- `name`, `namespace`, `version`, `clusterName`
  ::: warning `clusterName` is constrained, and the constraint is enforced in three places
  The value is the cluster identity the operator concatenates into every generated object name
  **and** the `ON CLUSTER '<name>'` target of the [scheduled backup](#scheduled-backups-and-restore) — where a
  quote or a semicolon would be extra SQL rather than a bad name. It must match
  `^[a-zA-Z][a-zA-Z0-9-]{0,14}$`: a letter, then up to 14 more letters, digits or dashes. A
  trailing dash is fine. (The **keeper**'s `clusterName` is separate and wider — see
  [Keeper (CHK)](#keeper-chk).)

  That is the Altinity CRD's own alphabet and cap plus **one** TypeKro restriction, not a house
  style. The CRD constrains `spec.configuration.clusters[].name` to `^[a-zA-Z0-9-]{0,15}$` with
  `minLength: 1` / `maxLength: 15` (`namePartClusterMaxLen`), so an underscore, an empty value or a
  16th character is rejected by the API server whatever TypeKro accepts. The added rule is the
  **leading letter**: the operator writes the cluster name verbatim as an XML element name when it
  renders `remote_servers.xml` (`pkg/model/chi/config/generator.go`, `Iline(b, indent, "<%s>",
  cluster.GetName())`), and an XML name may not begin with a digit or a dash — `<9cluster>` is an
  unparseable configuration file and the server will not start. Nothing else is added: a trailing
  dash is legal XML and leaves a valid DNS-1123 object name, so it is accepted.

  A **literal** is rejected at construction. A **schema reference** cannot be — so the pattern
  travels into the generated RGD (`clusterName: string | maxLength=15 pattern="…"`) and KRO rejects
  a bad instance. The backup script re-checks the name it receives in `$CLICKHOUSE_CLUSTER` and
  escapes it before interpolation, and refuses to run rather than issue a statement built from a
  name it does not recognise.
  :::
- `storage.size`, `storage.storageClassName` — the **local** volume (the data volume in PVC mode; the thin cache volume in S3 mode)
- `keeper.host`, `keeper.port`
- `users.<name>.passwordSha256Hex` or `users.<name>.passwordSecretRef` (one
  literal key per declared user, selected by the build-time credential source)
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

## Storage

`storage` is a discriminated union on `mode`. `'pvc'` is the default and is unchanged from earlier releases.

```typescript
// PVC (default) — local MergeTree data volume
const local = makeClickHouseCluster();

// S3 — object storage is the durable record, with a bounded local cache
const objectStore = makeClickHouseCluster({
  storage: {
    mode: 's3',
    bucket: 'example-observability',
    prefix: 'clickhouse',
    region: 'us-east-2',
    diskType: 's3_plain_rewritable',
    cache: { size: '50Gi' },
    auth: { irsa: { roleArn: 'arn:aws:iam::123456789012:role/clickhouse-s3' } },
  },
});

await objectStore.factory('kro').deploy({
  name: 'observability',
  namespace: 'observability',
  version: '25.12.5',
  // In S3 mode this volume holds server metadata and the cache — size it for
  // the cache, not for the dataset.
  storage: { size: '100Gi', storageClassName: 'gp3-expandable' },
});
```

### What the S3 coordinates must look like

Every component of the object-storage location is validated at construction, and the *composed* URL is validated again as a whole. The reason is the destination's second life: the same string is the `<endpoint>` text of `config.d/storage.xml` **and** the `BACKUP … TO S3('<url>')` string literal the backup CronJob builds, where a `'` is not a bad URL but extra SQL. Validating components individually is a set of doors that has to stay complete, so the composed result is re-checked too.

| Option | Rule |
| --- | --- |
| `bucket`, `backup.bucket` | AWS bucket naming: 3-63 characters of lowercase letters, digits, `.` and `-`, starting and ending alphanumeric, no `..`, not IP-address-shaped |
| `region` | `^[a-z]{2}(-[a-z]+)+-\d$` — `us-east-2`, `eu-central-1`, `us-gov-west-1`. A shape, not an enumeration, so a new region needs no release; an availability *zone* (`us-east-1a`) is not a region and is rejected |
| `prefix`, `backup.prefix` | `/`-separated segments of `[A-Za-z0-9._~!$()*+,;=:@-]` — no quotes, whitespace, control characters, `&`, `%` or `..` |
| `endpoint` | An absolute `http(s)` URL made only of RFC 3986 URL characters (no whitespace, quotes, angle brackets, `&` or backslash). An internationalized host must be given in punycode |
| `policyName` | A bare ClickHouse identifier — it is rendered as an XML *element name*, where escaping does not exist |
| `backup.database` | A bare SQL identifier — it is interpolated into `BACKUP DATABASE <db>` |

Errors name the option you set, including `storage.backup.bucket` / `storage.backup.prefix` rather than the disk's own.

### Why S3 configuration is build-time

`storage.mode` and everything under it compiles into a `storage_configuration` XML document embedded in the CHI's `configuration.files`, **and** decides which resources exist (the IRSA ServiceAccount, the backup CronJob). That is the same class of choice `zones` already occupies, so it lives in the constructor and a schema ref there throws loudly rather than serializing a `__KUBERNETES_REF__` marker into server configuration.

Only `storage.size` and `storage.storageClassName` stay in the runtime spec.

### Durability: `s3` vs `s3_plain_rewritable`

This is the decision the discriminated `diskType` exists to force. A boolean `s3: true` would hide it.

| | `diskType: 's3'` (default) | `diskType: 's3_plain_rewritable'` |
| --- | --- | --- |
| Part **data** | in the bucket | in the bucket |
| Part **metadata** | on the local disk | **in the bucket** |
| Bucket is self-describing | ❌ no — the local disk holds the map to the objects | ✅ yes |
| Node loss | data loss unless a backup exists | restart + reattach, no restore step |
| Durable without backups | ❌ | ✅ |
| Replication (`replicas > 1`) | ✅ supported | ❌ **rejected by the factory** |
| Mutations (`ALTER … UPDATE/DELETE`, lightweight deletes) | ✅ | ❌ not supported |
| `ALTER … MODIFY TTL` | ✅ | ⚠️ only with `materialize_ttl_after_modify = 0` |
| Minimum ClickHouse | any supported release | **24.5** |
| Recommended pairing | `storage.backup` | single-replica, no backup required |

`s3_plain_rewritable` arrived in ClickHouse 24.4, and 24.5 generalized it to the `metadata_type: plain_rewritable` form this factory emits (`type: object_storage` + `object_storage_type: s3` + `metadata_type: plain_rewritable`), so **24.5 is the pinned floor**. It is enforced in BOTH modes: a concrete `version` below the floor (or one the factory cannot read as `major.minor`, such as a moving tag or a digest pin) is rejected at construction, and because `version` is per-instance runtime spec the same floor travels into the generated KRO schema as a `pattern=` marker on `spec.version`, so the API server rejects an instance that selects an older server before the ClickHouseInstallation is ever created. ClickHouse's own documentation is explicit that mutations and table replication are **not** supported for this metadata type, which is why the factory refuses `replicas > 1` and why TTL DDL must skip materialization. TTL-driven expiry itself runs during merges, which this disk type does support. See [External disks for storing data](https://clickhouse.com/docs/operations/storing-data).

`status.storage` puts the resulting guarantee on the cluster contract, so nobody has to read the XML to find out:

```typescript
status: {
  storage: {
    mode: 'pvc' | 's3';
    diskType?: 's3' | 's3_plain_rewritable';
    policyName?: string;              // 's3_main' by default
    bucket?: string;
    selfDescribingBucket?: boolean;   // true only for s3_plain_rewritable
    backupSchedule?: string;          // present when a backup CronJob exists
  };
}
```

These are construction-time values, so — like `clickhouse.port`, `clickhouse.database` and `clickhouse.user` — they have no natural CHI field to read. Rather than emit them as literals (which KRO drops from the instance status, leaving the declared schema promising fields the live CR never carries), the composition writes them into a **ConfigMap it owns**, `<installation>-clickhouse-contract`, and projects them back from that resource. They therefore appear on the live KRO CR status in both factory modes, and the ConfigMap itself is a readable copy of the cluster's durability contract.

### What gets rendered

```xml
<clickhouse>
    <storage_configuration>
        <disks>
            <s3>
                <type>s3</type>
                <endpoint>https://example-observability.s3.us-east-2.amazonaws.com/clickhouse/</endpoint>
                <use_environment_credentials>true</use_environment_credentials>
            </s3>
            <s3_cache>
                <type>cache</type>
                <disk>s3</disk>
                <path>/var/lib/clickhouse/disks/s3_cache/</path>
                <max_size>53687091200</max_size>
                <cache_on_write_operations>true</cache_on_write_operations>
            </s3_cache>
        </disks>
        <policies>
            <s3_main>
                <volumes><main><disk>s3_cache</disk></main></volumes>
            </s3_main>
        </policies>
    </storage_configuration>
</clickhouse>
```

Alongside it, `configuration.settings` carries `merge_tree/storage_policy: s3_main`. **That setting is the point**: it makes the S3 policy the MergeTree *default*, so tables created by tooling outside TypeKro — the ClickStack/HyperDX gateway collector's goose migrations, SigNoz's migrator — land on object storage with no `SETTINGS storage_policy` clause and no per-table DDL.

A server-wide default is server-*wide*, so the same settings block also pins ClickHouse's own `system.*_log` tables back to the local disk. That is not a detail — left alone it eventually stops the server from booting. See [System log tables and startup time](#system-log-tables-and-startup-time).

The cache lives under `/var/lib/clickhouse/`, which is the operator's data-volume mount, so `cache.size` must fit inside `storage.size` (the factory rejects a cache larger than its volume). Override the location with `cache.path` if you mount something else.

### Credentials

Access keys are never accepted inline. There are exactly two transports.

**IRSA (EKS).** The composition creates a ServiceAccount annotated with `eks.amazonaws.com/role-arn` and runs the CHI pod template as it; the disk configuration uses `<use_environment_credentials>true</use_environment_credentials>`, so the AWS SDK inside ClickHouse picks up the projected web-identity token. No key material appears in any manifest.

```typescript
auth: { irsa: { roleArn: 'arn:aws:iam::123456789012:role/clickhouse-s3' } }
```

The ServiceAccount defaults to `<instance-name>-s3`; set `auth.irsa.serviceAccountName` to choose the name.

**Secret-backed keys (MinIO, non-EKS).** The keys become pod env vars via `secretKeyRef` (`optional: false`, so a missing Secret fails the pod loudly) and the disk configuration references them with ClickHouse's `from_env` attribute — the *values* never enter the CHI spec.

```typescript
auth: {
  secretRef: {
    name: 'minio-credentials',
    accessKeyIdKey: 'AWS_ACCESS_KEY_ID',        // default
    secretAccessKeyKey: 'AWS_SECRET_ACCESS_KEY', // default
  },
}
```

For a custom S3-compatible service, set `endpoint` to the service's base URL (`http://minio.minio.svc.cluster.local:9000`) and leave `region` unset — the factory appends the bucket and prefix path-style. With no `endpoint`, `region` is required and the endpoint is the AWS virtual-hosted form.

### IAM policy for the IRSA role

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": "arn:aws:s3:::example-observability"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::example-observability/clickhouse/*"
    }
  ]
}
```

`ListBucket` should be scoped with a `s3:prefix` condition where your policy language allows it. Add a second statement for the backup prefix (`.../backups/*`) when `storage.backup` is configured — the prune step needs `s3:DeleteObject` and `s3:ListBucket` there. The role's trust policy is the usual EKS OIDC web-identity trust for `system:serviceaccount:<namespace>:<serviceAccountName>`.

### Scheduled backups and restore

With `diskType: 's3'`, part metadata is local — so durability *is* the backup. Declare one:

```typescript
storage: {
  mode: 's3',
  bucket: 'example-observability',
  region: 'us-east-2',
  cache: { size: '50Gi' },
  auth: { irsa: { roleArn: 'arn:aws:iam::123456789012:role/clickhouse-s3' } },
  backup: {
    schedule: '0 2 * * *',
    prefix: 'backups',            // default; must not be the bucket root
    database: 'default',          // must be a bare SQL identifier
    retention: { days: 14 },      // renders a real prune step
  },
}
```

That renders a CronJob whose run:

1. generates a timestamped name (`%Y%m%d%H%M%S`) and issues `BACKUP DATABASE <db> [ON CLUSTER '<clusterName>'] TO S3('<endpoint>/<timestamp>')`. The statement carries **no credentials** — `BACKUP` executes server-side, and the storage compiler renders an `<s3>` section for the backup endpoint into `config.d/storage.xml`, so nothing sensitive reaches `system.query_log`;
2. with `retention.days`, follows up with an `amazon/aws-cli` prune container that deletes expired timestamped prefixes. The backup runs as an `initContainer` in that case, because Job containers otherwise run in parallel and the prune must see a finished backup.

Set `backup.auth.secretRef` to connect as a specific ClickHouse user; without it the job connects as `default` with no password (the dev-first default).

### Sharded clusters back up every shard

A plain `BACKUP DATABASE db TO S3(...)` is executed by the ONE server the client connected to, and that server holds only its own shard's parts — on a multi-shard cluster it produces a backup that succeeds, restores cleanly, and is missing every other shard's data. So the rendered statement gains `ON CLUSTER '<clusterName>'` whenever the topology has more than one shard or replica, or a keeper is configured. ClickHouse then fans the statement out to every host of the cluster and coordinates them through [Zoo]Keeper into **one** backup at **one** destination path (the `backup_restore_keeper_*` settings in the [BACKUP/RESTORE reference](https://clickhouse.com/docs/operations/backup) exist for that coordination).

There are deliberately no `{shard}` / `{replica}` macros in the destination: that convention produces N independent per-shard backups needing N restore statements, which is a different design.

Because the fan-out needs Keeper, `makeClickHouseCluster` **rejects at construction** a topology with more than one shard or replica that declares `storage.backup` but no keeper:

```typescript
// throws: backing up every shard needs `BACKUP ... ON CLUSTER`, which needs a keeper
makeClickHouseCluster({ shards: 2, storage: { /* … */ backup: { schedule: '0 2 * * *' } } });

// correct: the coordinated statement has somewhere to coordinate
makeClickHouseCluster({ shards: 2, keeper: true, storage: { /* … */ backup: { schedule: '0 2 * * *' } } });
```

(`keeper` already defaults to `true` for `replicas > 1`; multi-*shard* topologies must opt in.)

### Restore

**Restore is deliberately not automated** — restoring over a live database is a decision, not a schedule. List the available backups and restore one by name, **matching the backup's own shape**: a backup taken `ON CLUSTER` is restored `ON CLUSTER`.

```sql
-- from a clickhouse-client pod against the cluster
SHOW DATABASES;

-- single-node topology (1 shard, 1 replica, no keeper)
RESTORE DATABASE default
  FROM S3('https://<bucket>.s3.<region>.amazonaws.com/backups/20260101020000');

-- sharded/replicated topology — the same cluster name the CronJob used
RESTORE DATABASE default ON CLUSTER 'cluster'
  FROM S3('https://<bucket>.s3.<region>.amazonaws.com/backups/20260101020000');
```

The cluster name is `spec.clusterName` (default `cluster`), and it is also published on the status contract as `status.clickhouse.clusterName`.

Restore into a fresh database first (`RESTORE DATABASE default AS default_restored FROM …`) when the live one still exists, then swap with `EXCHANGE TABLES` or `RENAME DATABASE`. The restore reads its credentials from the same `<s3>` config section the backup wrote through, so it needs no keys in the statement either.

## System Log Tables and Startup Time

ClickHouse writes its own telemetry into `system.*_log` MergeTree tables — `query_log`, `trace_log`, `metric_log`, `part_log`, `blob_storage_log` and a dozen more. The server writes them continuously, in small batches; in normal operation nothing ever reads them.

Two ClickHouse defaults combine badly with an object-store-backed cluster, and the composition changes both.

### The failure mode

This one was misdiagnosed twice before it was understood, because **the symptom is nowhere near the cause**. It is worth reading even if you never change these settings.

A cluster runs healthily for days or weeks. Nothing is deployed, no configuration changes, load is flat. Then the server stops being able to start, and stays that way.

What you see:

```text
Application: Listening for replica communication (interserver): http://[::]:9009
AsyncLoader: Processed: 92.9%
AsyncLoader: Stop worker in ForegroundLoad
```

…and then nothing. `Ready for connections` is never logged, **8123 and 9000 never open, and only the interserver port 9009 does**. Every client, collector and dashboard behind the server crash-loops with connection-refused, which is what gets investigated first, and it is not the problem. The container exits 137 (SIGKILL), restarts, and does the same thing again — 100+ times.

Two things make it hard to see:

1. **Part counts look fine.** In the incident that produced this section, the maximum active part count on any table was 57. The cost is not part count — it is **object-store metadata**: each `system.*_log` table accumulates parts, `tmp_merge_*` directories and `__meta` entries in the bucket, and startup walks and tidies all of them one S3 round trip at a time. A `SELECT count() FROM system.parts` tells you nothing; a bucket holding ~91k objects does.
2. **Nothing changed.** The trigger is *time*, not load, not a release, not a config edit. Startup time grows with uptime, silently, until it crosses the probe deadline. Then it is total.

The kill is the second half. The clickhouse-operator's default liveness probe is `GET /ping` with `initialDelaySeconds: 60`, `periodSeconds: 3`, `failureThreshold: 10` — so it SIGKILLs at roughly 90 seconds — and it sets **no startup probe** (`reconcile.host.wait.probes.startup: no` in the operator's own config). Startup in the incident had reached 2m48s. The server was being killed mid-load, every time, and could not recover on its own.

**How to recognise it.** On a server you can still reach, the one query that names the cause:

```sql
SELECT DISTINCT database, disk_name FROM system.parts WHERE active AND database = 'system';
-- system    s3        ← the bug
-- system    default   ← what you want
```

On one that will not start, the signature is: exit 137 with a high restart count; `AsyncLoader` stopping partway with no `Ready for connections`; only 9009 listening; and log lines about `deleteFileFromS3`, `RemoveRecursiveObjectStorageOperation` and `tmp_merge_*` under `store/` for `system.*` tables while it dies.

### What the composition does about it

**Pins the system logs to the local disk.** ClickHouse supports a per-log `<storage_policy>`, so `configuration.settings` carries `metric_log/storage_policy: default` and the same for most other default-enabled logs. The exceptions are `query_log`, `part_log` and `trace_log`: the clickhouse-operator replaces their sections with one that declares a full `<engine>`, and ClickHouse **refuses to start** if a log has both `<engine>` and `<storage_policy>`/`<ttl>` (#235). For these three the composition writes its own `config.d/system-logs.xml`, which replaces each section outright (`replace="1"`) and puts the policy and TTL inside the engine definition: `ENGINE = MergeTree PARTITION BY event_date ORDER BY event_time TTL event_date + INTERVAL 14 DAY DELETE SETTINGS storage_policy = 'default'`. Because it replaces the whole section, it also overrides anything a caller sets for those three logs through their own `configuration.settings` or custom operator `configdFiles`. Their retention moves from the operator's 30 days to the composition's 14, and the changed definition is what makes ClickHouse rename the old table to `<name>_0` at the next restart (see below). This is verified against the default system-log configuration of the operator version TypeKro installs (0.27.1). If you override the operator's `configs.configdFiles`, check that what you set for these three logs is what you want replaced.

`systemLogs.ttl: false` means TypeKro does not manage retention. Every log keeps its upstream TTL, in every storage mode: none for most logs, ClickHouse's own TTLs on `processors_profile_log`, `asynchronous_insert_log` and `blob_storage_log`, and the operator's 30 days on `query_log`, `part_log` and `trace_log`. When the composition still has to replace those three sections (for the storage pin), it writes the operator's 30-day TTL back into the engine. The server-wide `merge_tree/storage_policy` is untouched, so **where your data lands does not change** — only ClickHouse's own telemetry moves back to the local disk, which is where it was always supposed to be.

**Gives them a retention TTL.** ClickHouse ships no TTL on most of these tables, so they grow without bound on *any* disk. Every one gets `event_date + INTERVAL 14 DAY DELETE` by default.

**Adds a startup probe.** The pod template now carries all three probes, so the operator's defaults no longer apply (it only fills in a probe the template left unset):

| Probe | Path | Period | Timeout | Failures | Effect |
| --- | --- | --- | --- | --- | --- |
| `startupProbe` | `/ping` | 10s | 5s | 90 | ~15 minutes to finish loading, killed after that |
| `livenessProbe` | `/ping` | 10s | 5s | 6 | restarted after ~60s wedged, *once started* |
| `readinessProbe` | `/ping` | 10s | 5s | 3 | removed from the Service, not restarted |

Liveness answers "is this process wedged"; startup answers "is this process still coming up". Kubernetes suspends liveness and readiness until the startup probe first succeeds, so the server may take as long as it needs to boot and is still killed promptly if it wedges *after* startup. The liveness probe deliberately carries **no** `initialDelaySeconds` — the startup probe already gates it.

**Makes a template change roll out in one restart.** When a change is both restart-requiring config and a pod template change (a probe change, say), clickhouse-operator 0.27 first restarts the server in place under the *old* template, and only rolls the StatefulSet afterwards. It skips that in-place restart only when a container's environment changed. So each pod template's `clickhouse` container carries `TYPEKRO_POD_TEMPLATE_HASH`, a digest of that template (#238). A template change moves the digest, and the operator restarts the pod once with the new template and config together. A config-only change leaves it alone and keeps the cheaper in-place restart. The first reconcile after upgrading adds the variable, which restarts ClickHouse once through a normal rollout. Operators before 0.27 always restart in place first; there the variable has no effect.

The tables pinned and trimmed are the ones ClickHouse 25.7 enables in its own shipped `programs/server/config.xml`, minus the one the operator switches off: `query_log`, `trace_log`, `query_views_log`, `part_log`, `text_log`, `metric_log`, `latency_log`, `error_log`, `query_metric_log`, `asynchronous_metric_log`, `crash_log`, `processors_profile_log`, `asynchronous_insert_log`, `backup_log`, `s3queue_log` and `blob_storage_log`.

Three deliberate omissions. `query_thread_log` is removed by the operator (`<query_thread_log remove="1"/>`), and emitting any setting for it would switch it back on. `session_log` ships **commented out**, and a system log exists if and only if its config section exists — emitting a section for it would *enable* a log the server does not run. `opentelemetry_span_log` declares its own `<engine>`, and ClickHouse refuses to start when a log has both `<engine>` and `<storage_policy>`/`<ttl>`; it has no `event_date` either, and is only written when span propagation is switched on.

### Configuring it

```typescript
const clickhouse = makeClickHouseCluster({
  storage: { mode: 's3', /* … */ },
  systemLogs: {
    retentionDays: 30,        // default: 14
    // storagePolicy: false,  // leave them on the server-wide default (the old behaviour)
    // ttl: false,            // leave retention to the upstream defaults (ClickHouse's and the operator's)
  },
  probes: {
    startup: { failureThreshold: 180 },  // partial overrides merge over the defaults
    // readiness: false,                 // omit it and take the operator's default
  },
});
```

Both are **build-time** topology, for the same reason `storage` is: `systemLogs` compiles into server configuration text and `probes` into the enumerated pod templates, so a schema reference in either is rejected at construction rather than serialized as a `__KUBERNETES_REF__` marker.

### Remediating a cluster that is already affected

Applying the fix is not enough on its own, and this is the part that is easy to miss.

ClickHouse compares the `CREATE` query it would write against the live table. When they differ — and changing the storage policy or TTL makes them differ — it **renames the existing table** to `system.query_log_0` and creates a fresh one. So the new tables are correct from the next restart, but the renamed ones stay exactly where they were, on object storage, and are still loaded at every boot. The boot time does not improve until they are gone.

**This is not only an object-store concern.** Enabling the retention TTL — or later changing `retentionDays` — changes the `CREATE` query just the same, so a **PVC** installation gets the identical one-time `_0` rename on its next restart. There the cost is disk rather than boot time, but the part that surprises people is the same: the renamed `_0` tables keep the *old* definition, so **the new TTL does not apply to them** and they are never trimmed. Whatever the storage mode, expect the rollover once, and drop the leftovers by hand.

Once the server is reachable:

```sql
-- The renamed originals, still on the old disk.
SELECT database, name FROM system.tables WHERE database = 'system' AND name LIKE '%\_log\_%';
DROP TABLE IF EXISTS system.query_log_0 SYNC;  -- and so on, per table listed
```

If the server will not start at all, the startup probe is what buys the time to get in: raise `probes.startup.failureThreshold` until it boots, drop the renamed tables, then put it back. These tables are safe to drop — ClickHouse writes "It is safe to truncate or drop this table at any time" into their own `COMMENT`.

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

For Secret-backed credentials, select the representation when declaring the
topology and pass only Secret coordinates at runtime:

```typescript
const clickhouse = makeClickHouseCluster({
  users: [{ name: 'otelcollector', credentialSource: 'secret' }],
});

await clickhouse.factory('kro').deploy({
  name: 'observability',
  namespace: 'observability',
  version: '25.7',
  storage: { size: '10Gi' },
  users: {
    otelcollector: {
      passwordSecretRef: {
        name: 'clickstack-credentials',
        key: 'clickhouse-password',
      },
    },
  },
});
```

This compiles to the Altinity operator's native `valueFrom.secretKeyRef`
shape. The password does not enter the ClickHouseInstallation, RGD instance,
or TypeKro state. The Secret must be in the ClickHouseInstallation namespace.

User names become CHI configuration path fragments (`<name>/password_sha256_hex`, `<name>/networks/ip`), so they must be concrete — a map keyed by schema proxies would serialize `__typekroSchemaKey/...` garbage. Password hashes and network lists are plain value positions: schema refs serialize to clean CEL (proven under `TYPEKRO_STRICT_CEL=1` in the test suite).

In `makeClickHouseCluster`, declared user names become **literal keys** in the generated runtime spec schema — for example `spec.users.signoz.passwordSha256Hex` or `spec.users.otelcollector.passwordSecretRef` — so each declared user's credential is a required, typed, ref-safe field.

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
  storage: {                          // see Storage above
    mode: 'pvc' | 's3';
    diskType?: 's3' | 's3_plain_rewritable';
    policyName?: string;
    bucket?: string;
    selfDescribingBucket?: boolean;
    backupSchedule?: string;
  };
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

The remaining fields — `clickhouse.port`, `clickhouse.database`, `clickhouse.user`, and the whole `storage` block — are **construction-time values with no natural CHI field to read**. KRO status CEL cannot express a literal-only leaf (nor reference `schema.spec.*`), so emitting them as literals meant the declared schema promised fields the live CR never carried. They are instead written into a ConfigMap the composition **owns** (`<installation>-clickhouse-contract`, resource id `clickhouseContract`) and projected back from it:

- `clickhouse.database` / `clickhouse.user` — `clickhouseContract.data.database` / `.user`.
- `clickhouse.port` — `int(clickhouseContract.data.nativePort)`; ConfigMap values are strings, so the CEL `int(...)` conversion restores the declared number.
- `storage.mode` / `diskType` / `policyName` / `bucket` / `backupSchedule` — `clickhouseContract.data.storage*`.
- `storage.selfDescribingBucket` — `clickhouseContract.data.storageSelfDescribingBucket == "true"`.

Every declared status leaf is therefore a resource projection, and `kubectl get clickhouseclusters -o yaml` shows the whole contract — durability included — in both factory modes. See [typekro#188](https://github.com/yehudacohen/typekro/issues/188) for the underlying framework gap (a literal status leaf is accepted at build time and then silently dropped by KRO).

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

### Cluster names are capped at 15 bytes

The Altinity CRD constrains `spec.configuration.clusters[].name` to `minLength: 1` / `maxLength: 15` / `^[a-zA-Z0-9-]{0,15}$` (`See namePartClusterMaxLen const`) on **both** the CHI and the CHK, while `metadata.name` is uncapped. The value is a fragment of the object names the operator generates (`chi-<installation>-<cluster>-<shard>-<replica>`, `chk-…`); an empty value is rejected too — the CRD does not allow one.

- **CHI** — `clusterName` defaults to `DEFAULT_CHI_CLUSTER_NAME` (`cluster`). SigNoz's migrations hardcode that name, so keep the default for a SigNoz consumer.
- **CHK** — `clusterName` follows **Altinity's CRD alphabet and cap, plus the one rule the operator's own naming requires**: `^[A-Za-z0-9-]*[A-Za-z0-9][A-Za-z0-9-]*$` with the 15-byte bound (`ClickHouseKeeperClusterNameSchema`) — up to 15 letters, digits and dashes, with **at least one alphanumeric**. There is *no* leading-letter rule: the keeper's generator emits `<server><id>/<hostname>/<port>` built from host names (`pkg/model/chk/config/generator.go`, `getRaftConfig`) and never uses the cluster name as an element name, so `9keeper`, `-keeper`, `keeper-` and `2024` are all valid here while `9cluster` is rejected for the CHI.

  The at-least-one-alphanumeric rule is the only addition, and it is not house style. An **all-dash** name (`-`, `---`) satisfies the CRD's `^[a-zA-Z0-9-]{0,15}$`, so admission accepts it — and the object can then never reconcile. The operator runs the cluster name through its short-name sanitizer `strings.Trim(s, "-_.")`, which strips every leading and trailing `-`, `_` and `.`, so an all-dash name sanitizes to the **empty string**; the CHK defaults `pdbManaged` to true and names the PodDisruptionBudget it creates by the pattern `chk-{chk}-{cluster}`, which then yields e.g. `chk-keeper-` — a name ending in a dash, invalid as Kubernetes metadata. The CHI needs no such rule: its leading-letter requirement already guarantees an alphanumeric, so a CHI cluster name can never be all dashes.

  `clusterName` defaults to the **installation name**. When that name is a **literal** and cannot be a legal cluster name, the factory throws at **build time**, naming the length, the cap and the remedy. Deriving from the installation name is kept on purpose: changing a cluster name replaces the StatefulSet with fresh volumes and loses the keeper's coordination state, so an installation whose name already fitted the cap keeps exactly the object names it had. Pass `clusterName: DEFAULT_CHK_CLUSTER_NAME` (`'keeper'`) — or any short stable value — for a longer installation name.

An explicit `clusterName` is validated at build time on both resources — against its own rule — so an illegal value fails at graph construction rather than at apply. Both share the 15-byte cap, both accept a trailing dash, and both require at least one alphanumeric; they differ only in whether a **leading** digit or dash is allowed.

#### KRO mode: the check moves to the operator

The build-time throw only covers a **literal** name. In `factory('kro')` the keeper's `name` is a schema reference, so the rendered RGD carries `clusters[0].name: ${schema.spec.name}` and the value is unknown until an instance is created. The generated KRO schema types `spec.name` as a bare `string` with no length bound, so an over-long *instance* name is caught by Altinity's admission check, not by TypeKro. The factory emits one build-time **warning** saying exactly that. It does not throw, and `clusterName` is deliberately not mandatory for references: requiring it would force it on existing KRO-mode deployments, where changing the cluster name loses keeper state.

Two ways to close the gap for a **new** deployment:

```typescript
// 1. Pin the cluster name, so the instance name can never reach it.
const keeper = clickHouseKeeperInstallation({
  name: spec.name,                        // any length
  clusterName: DEFAULT_CHK_CLUSTER_NAME,  // 'keeper'
  replicas: 3,
});

// 2. Or have KRO reject a bad instance at admission, by bounding the enclosing
//    composition's own spec field. The schema generator carries an arktype
//    bound's maxLength and pattern into the RGD, so KRO rejects the instance
//    before the operator ever sees it.
kubernetesComposition(
  { /* … */ spec: type({ name: ClickHouseKeeperClusterNameSchema /* Altinity's rule */ }) },
  (spec) => clickHouseKeeperInstallation({ name: spec.name, replicas: 3 })
);
```

For an **existing** KRO-mode deployment whose instance names already fit the cap, neither is needed — leave the cluster name alone.

Consumers that need the value — a `keeper_path` prefix, an operator-generated Service name, or the `ON CLUSTER '<name>'` target of their own DDL — must read it from the exported constant or the `clusterName` they passed, or from the cluster composition's status (`status.clickhouse.clusterName`, projected from the CHI's own `spec.configuration.clusters[0].name`). Never assume a particular derivation.

**What else is capped.** The same 15-byte cap, with `minLength: 1` and the same pattern, applies to the shard name, the replica name and `spec.templates.hostTemplates[].spec.name` (the generated host's name), on the CHI, the CHIT and the CHK alike. TypeKro emits none of those today — the zone-pinned layout emits only `templates.podTemplate` per replica, and no `hostTemplates` at all. Pod, volume-claim and service **template** names carry no cap in the CRD.

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
