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

**Runtime (spec fields — schema refs / proxies serialize to clean CEL):**

- `name`, `namespace`, `version`, `clusterName`
  ::: warning `clusterName` is constrained, and the constraint is enforced in three places
  The value is the cluster identity the operator concatenates into every generated object name
  **and** the `ON CLUSTER '<name>'` target of the [scheduled backup](#scheduled-backups-and-restore) — where a
  quote or a semicolon would be extra SQL rather than a bad name. It must match
  `^[a-zA-Z]([a-zA-Z0-9-]{0,13}[a-zA-Z0-9])?$`: a letter, then up to 14 more letters, digits or
  dashes, not ending in a dash.

  That is the *intersection* of two independent limits, not a house style. The Altinity CRD
  constrains `spec.configuration.clusters[].name` to `^[a-zA-Z0-9-]{0,15}$` with `maxLength: 15`
  (`namePartClusterMaxLen`), so an underscore or a 16th character is rejected by the API server
  whatever TypeKro accepts; ClickHouse reads the same value as an identifier, so a leading digit or
  dash is not one.

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

`s3_plain_rewritable` arrived in ClickHouse 24.4, and 24.5 generalized it to the `metadata_type: plain_rewritable` form this factory emits (`type: object_storage` + `object_storage_type: s3` + `metadata_type: plain_rewritable`), so **24.5 is the pinned floor** — the factory rejects an older `version` at construction. ClickHouse's own documentation is explicit that mutations and table replication are **not** supported for this metadata type, which is why the factory refuses `replicas > 1` and why TTL DDL must skip materialization. TTL-driven expiry itself runs during merges, which this disk type does support. See [External disks for storing data](https://clickhouse.com/docs/operations/storing-data).

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

These are construction-time values, so — like `clickhouse.port`, `clickhouse.database` and `clickhouse.user` — they have no natural CHI field to read. Rather than emit them as literals (which KRO drops from the instance status, leaving the declared schema promising fields the live CR never carries), the composition writes them into a **ConfigMap it owns**, `<installation>-contract`, and projects them back from that resource. They therefore appear on the live KRO CR status in both factory modes, and the ConfigMap itself is a readable copy of the cluster's durability contract.

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

The remaining fields — `clickhouse.port`, `clickhouse.database`, `clickhouse.user`, and the whole `storage` block — are **construction-time values with no natural CHI field to read**. KRO status CEL cannot express a literal-only leaf (nor reference `schema.spec.*`), so emitting them as literals meant the declared schema promised fields the live CR never carried. They are instead written into a ConfigMap the composition **owns** (`<installation>-contract`, resource id `clickhouseContract`) and projected back from it:

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
