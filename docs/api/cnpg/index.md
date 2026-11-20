---
title: CloudNativePG Factories
description: Factory functions for CloudNativePG PostgreSQL clusters on Kubernetes
---

# CloudNativePG Factories

Factory functions for [CloudNativePG](https://cloudnative-pg.io/) Custom Resource Definitions with built-in readiness evaluation. Manage PostgreSQL clusters, backups, and connection pooling as Kubernetes-native resources.

## Import

```typescript
// Import specific functions (recommended)
import { cluster, backup, scheduledBackup, pooler, objectStore } from 'typekro/cnpg';

// Or namespace import
import * as cnpg from 'typekro/cnpg';
```

## Quick Example

```typescript
import { cluster, scheduledBackup, pooler } from 'typekro/cnpg';

// Create a 3-instance PostgreSQL cluster
const db = cluster({
  name: 'my-database',
  namespace: 'databases',
  spec: {
    instances: 3,
    storage: { size: '50Gi', storageClass: 'gp3' },
    postgresql: {
      parameters: { shared_buffers: '256MB', max_connections: '200' },
    },
    bootstrap: {
      initdb: { database: 'myapp', owner: 'myapp', encoding: 'UTF8' },
    },
  },
  id: 'primaryDatabase',
});

// Schedule nightly backups
const nightly = scheduledBackup({
  name: 'nightly-backup',
  namespace: 'databases',
  spec: {
    cluster: { name: 'my-database' },
    schedule: '0 0 2 * * *',
    immediate: true,
    backupOwnerReference: 'cluster',
  },
  id: 'nightlyBackup',
});

// Add PgBouncer connection pooling
const pool = pooler({
  name: 'my-database-pooler',
  namespace: 'databases',
  spec: {
    cluster: { name: 'my-database' },
    type: 'rw',
    instances: 2,
    pgbouncer: {
      poolMode: 'transaction',
      parameters: { default_pool_size: '25' },
    },
  },
  id: 'dbPooler',
});
```

## Available Factories

| Factory | Kind | Scope | Description |
|---------|------|-------|-------------|
| `cluster` | Cluster | Namespace | PostgreSQL cluster (primary + replicas) |
| `backup` | Backup | Namespace | On-demand backup |
| `scheduledBackup` | ScheduledBackup | Namespace | Cron-based automated backups |
| `pooler` | Pooler | Namespace | PgBouncer connection pooling |
| `cnpgHelmRepository` | HelmRepository | Namespace | Helm chart repository for CNPG |
| `cnpgHelmRelease` | HelmRelease | Namespace | Operator installation via Helm |
| `objectStore` | ObjectStore | Namespace | Barman Cloud plugin object store (S3, workload identity) |
| `barmanCloudPluginHelmRelease` | HelmRelease | Namespace | Barman Cloud plugin installation via Helm |

## cluster()

Creates a PostgreSQL cluster managed by the CNPG operator.

```typescript
const db = cluster({
  name: 'prod-db',
  namespace: 'databases',
  spec: {
    instances: 3,
    imageName: 'ghcr.io/cloudnative-pg/postgresql:16.2',
    storage: {
      size: '100Gi',
      storageClass: 'gp3',
    },
    postgresql: {
      parameters: {
        shared_buffers: '256MB',
        max_connections: '200',
        work_mem: '8MB',
      },
      pg_hba: ['host all all 10.0.0.0/8 md5'],
    },
    bootstrap: {
      initdb: {
        database: 'myapp',
        owner: 'myapp',
        encoding: 'UTF8',
        dataChecksums: true,
      },
    },
    // WAL archiving and base backups through the Barman Cloud plugin.
    plugins: [barmanCloudPlugin({ objectStoreName: 'prod-db-backups' })],
    resources: {
      requests: { cpu: '500m', memory: '1Gi' },
      limits: { cpu: '2', memory: '4Gi' },
    },
    affinity: {
      enablePodAntiAffinity: true,
      topologyKey: 'kubernetes.io/hostname',
      podAntiAffinityType: 'required',
    },
    monitoring: { enabled: true },
  },
  id: 'prodDatabase',
});
```

### Cluster Readiness

The cluster readiness evaluator tracks CNPG-specific lifecycle phases:

| Phase | Ready | Reason |
|-------|-------|--------|
| Cluster in healthy state | `true` | `Healthy` |
| Setting up primary | `false` | `SettingUpPrimary` |
| Creating replica | `false` | `CreatingReplica` |
| Failing over | `false` | `Failover` |
| Switchover in progress | `false` | `Failover`* |
| Unknown phase | Falls back to condition-based evaluation |

*Switchover (planned) and failover (unplanned) are both transient non-ready states. They share the `Failover` reason since both represent a primary transition in progress.

### Bootstrap Methods

```typescript
// Initialize a new database
bootstrap: { initdb: { database: 'myapp', owner: 'myapp' } }

// Recover from backup (PITR)
bootstrap: {
  recovery: {
    source: 'external-cluster-name',
    recoveryTarget: { targetTime: '2024-01-15T10:00:00Z' },
  },
}

// Clone from pg_basebackup
bootstrap: { pg_basebackup: { source: 'source-cluster' } }
```

## backup()

Creates an on-demand backup.

```typescript
const bk = backup({
  name: 'manual-backup',
  namespace: 'databases',
  spec: {
    cluster: { name: 'prod-db' },
    ...barmanCloudBackupMethod(),
    target: 'prefer-standby',
  },
  id: 'manualBackup',
});
```

### Backup Readiness

| Phase | Ready | Reason |
|-------|-------|--------|
| completed | `true` | `Completed` |
| started | `false` | `InProgress` |
| failed | `false` | `Failed` |
| new | `false` | `Pending` |

## scheduledBackup()

Creates a cron-scheduled backup. Uses [robfig/cron](https://pkg.go.dev/github.com/robfig/cron) format with seconds: `second minute hour day month day-of-week`.

```typescript
const nightly = scheduledBackup({
  name: 'nightly-backup',
  namespace: 'databases',
  spec: {
    cluster: { name: 'prod-db' },
    schedule: '0 0 2 * * *',     // 2 AM daily
    immediate: true,              // Run first backup immediately
    method: 'volumeSnapshot',
    backupOwnerReference: 'cluster',
  },
  id: 'nightlyBackup',
});
```

## pooler()

Creates a PgBouncer connection pooler.

```typescript
const pool = pooler({
  name: 'prod-pooler',
  namespace: 'databases',
  spec: {
    cluster: { name: 'prod-db' },
    type: 'rw',
    instances: 3,
    pgbouncer: {
      poolMode: 'transaction',
      parameters: {
        default_pool_size: '25',
        max_client_conn: '200',
      },
    },
  },
  id: 'prodPooler',
});
```

### Pool Modes

- `session` (default) — Connection assigned for the entire client session
- `transaction` — Connection returned to pool after each transaction (recommended for most apps)

## Barman Cloud Plugin

CloudNativePG deprecated its in-tree Barman Cloud support (`spec.backup.barmanObjectStore`) in 1.26
and removes it in 1.32.0. Object store backups now go through the
[Barman Cloud plugin](https://cloudnative-pg.io/plugin-barman-cloud/), which TypeKro installs from
the official `plugin-barman-cloud` chart, pinned at 0.9.0 (plugin v0.16.0).

Requirements, from the plugin's documentation:

- CloudNativePG 1.30 or later. `cnpgBootstrap` and `cnpgHelmRelease` install chart 0.29.2
  (operator 1.30.2) by default, which the plugin supports. An install that pins an older
  `version`, such as 0.23.0 (operator 1.25.0), needs an operator upgrade first: see
  [Upgrading the operator](#upgrading-the-operator), including its Kubernetes floor and the
  one-minor-at-a-time path. `BARMAN_CLOUD_TESTED_CNPG_CHART_VERSION` (0.29.2, operator 1.30.2)
  names the chart the live backup and restore test ran against; pin it as `version` to keep a
  plugin-compatible operator if the default later moves. The plugin factories
  require `operatorVersion`, the operator version running in the plugin's namespace, and refuse
  one older than 1.30.0 (`CNPG_BARMAN_CLOUD_OPERATOR_INCOMPATIBLE`), at admission in KRO mode
  too. TypeKro does not read the live operator's version: `operatorVersion` is what you state it
  is.
- The plugin runs in the operator's namespace (`cnpg-system` by default).
- cert-manager is running: the chart issues the plugin's TLS certificates with it.

The plugin factories own two chart values: `crds.create: true` (the chart installs the
`ObjectStore` CRD) and `service.name: barman-cloud` (the chart says it must not change: the
plugin's TLS certificates are issued for it). Raw `values` that change either are refused
(`CNPG_BARMAN_CLOUD_RESERVED_CHART_VALUE`), and both are applied after your values, so values only
known per KRO instance can't change them either. Other keys, such as `service.port`, may be set.

```typescript
import {
  barmanCloudBackupMethod,
  barmanCloudPlugin,
  barmanCloudPluginBootstrap,
  barmanCloudRecovery,
  cluster,
  objectStore,
  scheduledBackup,
} from 'typekro/cnpg';

// Install the plugin next to the operator.
const plugin = barmanCloudPluginBootstrap.factory('direct', { namespace: 'cnpg-system' });
await plugin.deploy({
  name: 'barman-cloud',
  namespace: 'cnpg-system',
  version: '0.9.0',
  operatorVersion: '1.30.2',
});

// An S3 object store. Credentials come only from the pod's workload identity.
const store = objectStore({
  name: 'prod-db-backups',
  namespace: 'databases',
  spec: {
    configuration: {
      destinationPath: 's3://example-backups/cnpg/production',
      s3Credentials: { inheritFromIAMRole: true },
      wal: { compression: 'gzip' },
    },
    retentionPolicy: '30d',
  },
});

// A cluster archiving to it, and nightly plugin backups.
const db = cluster({
  name: 'prod-db',
  namespace: 'databases',
  spec: {
    instances: 3,
    storage: { size: '100Gi' },
    plugins: [barmanCloudPlugin({ objectStoreName: 'prod-db-backups' })],
  },
});
const nightly = scheduledBackup({
  name: 'prod-db-nightly',
  namespace: 'databases',
  spec: { cluster: { name: 'prod-db' }, schedule: '0 0 2 * * *', ...barmanCloudBackupMethod() },
});

// A new cluster recovered from those backups.
const restored = cluster({
  name: 'prod-db-restore',
  namespace: 'databases',
  spec: {
    instances: 3,
    storage: { size: '100Gi' },
    ...barmanCloudRecovery({ objectStoreName: 'prod-db-backups', serverName: 'prod-db' }),
  },
});
```

### Workload identity only

barman-cloud runs in a sidecar of each instance pod, as the cluster's service account (CNPG names
it after the cluster). Bind an IAM role to it with an EKS Pod Identity association, or with IRSA by
annotating it through `spec.serviceAccountTemplate.metadata.annotations`
(`eks.amazonaws.com/role-arn`). `objectStore()` refuses access keys or session tokens in
`s3Credentials`, static AWS keys in the sidecar's `env`, a missing or false
`inheritFromIAMRole: true`, and a destination that isn't `s3://<bucket>/<prefix>` with a valid
bucket name.

The check fails closed. The spec, `configuration` and `s3Credentials`, and `wal`, `data`,
`instanceSidecarConfiguration` and its `env` entries when given, must be written out in the
composition (`CNPG_BARMAN_CLOUD_NOT_CONCRETE`): taking one of them whole from the composition spec
would let an instance add static keys. Only leaf values may come from the spec:
`destinationPath`, `endpointURL`, `endpointCA`, `s3AddressingStyle`, `tags`, `historyTags`,
`retentionPolicy`, the compression, encryption and parallelism settings, the sidecar's
`logLevel`, `resources` and `retentionPolicyIntervalSeconds`, and an env entry's `value` or
`valueFrom`. `inheritFromIAMRole` must be the literal `true`. A `destinationPath` only known per
instance must come from a required field declared with
`BARMAN_CLOUD_DESTINATION_PATH_CONSTRAINT.type` (whose pattern and CEL rule are on the instance
schema) or from `s3DestinationPath(bucket, prefix)` over fields declared with the bucket and
prefix constraint types; any other is refused when the composition is built.

### ObjectStore Readiness

The plugin reports no conditions on an `ObjectStore`. It is ready once the API server has admitted
it (the CRD's rules included) and it can be read back. The readiness message lists the servers
whose recovery windows the plugin has recorded.

### Compositions

| Composition | Creates | Enforced in both modes |
|-------------|---------|------------------------|
| `barmanCloudPluginBootstrap` | HelmRepository, plugin HelmRelease | `version` is required and is the pinned chart version; `operatorVersion` is required and is CloudNativePG 1.30.0 or later |
| `cnpgS3BackedCluster` | ObjectStore, Cluster, ScheduledBackup | `bucket` is a required S3 general-purpose bucket name; `prefix` is required and non-empty; no credential inputs |

`bucket` follows the
[S3 general-purpose bucket naming rules](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html):
3 to 63 lowercase letters, digits, dots and hyphens, starting and ending with a letter or digit,
no two adjacent dots, not in the form of an IP address, and none of the reserved prefixes
(`xn--`, `sthree-`, `amzn-s3-demo-`) or suffixes (`-s3alias`, `--ol-s3`, `.mrap`, `--x-s3`,
`--table-s3`).

In KRO mode the instance schema carries each constraint as an `enum`, a `pattern` and length
markers, or a CEL `validation` rule for what a pattern can't express (the bucket's IP-address and
reserved prefix and suffix rules), with `required=true`, so the API server refuses a bad or
missing value before KRO creates anything. A composition that composes one of these and passes
its own spec field as `version`, `operatorVersion`, `bucket` or `prefix` declares that field, as
a required key, with `BARMAN_CLOUD_PLUGIN_VERSION_CONSTRAINT.type`,
`BARMAN_CLOUD_OPERATOR_VERSION_CONSTRAINT.type`, `BARMAN_CLOUD_BUCKET_CONSTRAINT.type` or
`BARMAN_CLOUD_PREFIX_CONSTRAINT.type`. Any other reference is refused when the composition is
built, because nothing would check it.

```typescript
const factory = cnpgS3BackedCluster.factory('kro', { namespace: 'databases' });
await factory.deploy({
  name: 'orders',
  namespace: 'databases',
  instances: 3,
  storageSize: '20Gi',
  bucket: 'example-backups',
  prefix: 'cnpg/production',
  schedule: '0 0 2 * * *',
});
```

`cnpgS3BackedCluster` status:

| Field | True when |
|-------|-----------|
| `clusterReady` | the cluster's `Ready` condition is `True` |
| `walArchiving` | the cluster's `ContinuousArchiving` condition is `True` |
| `scheduledBackupReady` | the operator has registered the base backup schedule (`status.lastCheckTime`) and reports no error |
| `ready` | all three |

A schedule is registered when the operator first reconciles it, not after its first backup, so a
nightly schedule doesn't hold up `ready` or a deploy with `waitForReady`. `ready` does not wait
for a base backup to exist.

### Live backup and restore test

`test/integration/cnpg/barman-cloud-backup-restore.test.ts` installs operator chart 0.29.2
(pinned with `BARMAN_CLOUD_TESTED_CNPG_CHART_VERSION`), the plugin and cert-manager, backs a cluster up to an S3-compatible gateway through
an `ObjectStore` with `inheritFromIAMRole: true` (a test instance-metadata endpoint stands in for
the IAM role), restores it into a new cluster and reads the rows back. It also deploys
`cnpgS3BackedCluster` with `waitForReady: true` and checks that it converges. It installs cluster-scoped operators, so
it runs only on request, on a disposable cluster:
`TYPEKRO_TEST_STORAGE_CLASS=standard bun run test:integration:cnpg-barman-cloud`. On kind with
kindnet network policies, Flux's controllers could not reach cluster DNS while Flux's
NetworkPolicies were in place; the recorded run removed them on the throwaway cluster (see the
test file's header). Don't do that on a shared or real cluster.

## Bootstrap Composition

Install the CNPG operator via Helm:

```typescript
import { cnpgBootstrap } from 'typekro/cnpg';

// KRO mode — operator reconciled continuously
const factory = cnpgBootstrap.factory('kro', {
  namespace: 'cnpg-system', // owned Namespace is hoisted out of the graph (retained)
  waitForReady: true,
});

await factory.deploy({
  name: 'cnpg',
  namespace: 'cnpg-system',
  version: '0.29.2',
  installCRDs: true,
});
```

The factory namespace holds the KRO instance and **can be the same as**
`spec.namespace` (as shown above, both `cnpg-system`). Even though the bootstrap
graph owns the CNPG operator Namespace, TypeKro **hoists that owned Namespace out
of the RGD graph** and emits it as a retained resource created deps-first, so the
instance CR living in the same namespace can never have its finalizer stranded by
KRO garbage-collecting its own namespace. (Set `instanceNamespace` on the factory
only if you deliberately want the CR in a *different* namespace.)

### Bootstrap Status

```typescript
instance.status.ready    // boolean — operator is running
instance.status.phase    // 'Ready' | 'Installing' | 'Failed'
instance.status.failed   // boolean — true if HelmRelease Ready=False
instance.status.version  // deployed chart version
```

### Upgrading the operator

**Breaking change in the next release.** `cnpgBootstrap` and `cnpgHelmRelease` install chart
**0.29.2 (operator 1.30.2)** when no `version` is given (`DEFAULT_CNPG_CHART_VERSION`). Earlier
TypeKro releases defaulted to 0.23.0 (operator 1.25.0). Redeploying an existing install without a
`version` therefore moves its operator from 1.25 to 1.30, five minor versions at once.

**Kubernetes compatibility.** Chart 0.29.2 declares `kubeVersion: >=1.29.0-0` (0.23.0 declared
no floor), so Helm refuses to install it on a cluster older than Kubernetes 1.29. CloudNativePG
1.30 officially supports Kubernetes 1.34, 1.35 and 1.36; it is tested on 1.31, 1.32, 1.33 and
1.37 without official support
([supported releases](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.2/docs/src/supported_releases.md)).
Check your cluster's version before taking the new default.

Pick one of three paths for an existing install:

1. **Supported production path: one minor at a time.** Pin `version` and step through each
   operator minor, reading that release's upgrade notes and waiting for every cluster to be
   healthy before the next step. CloudNativePG recommends not skipping minor releases. The latest
   chart for each minor:

   | Operator | Chart `version` |
   | --- | --- |
   | 1.26.1 | `0.25.0` |
   | 1.27.1 | `0.26.1` |
   | 1.28.1 | `0.27.1` |
   | 1.29.1 | `0.28.3` (declares `kubeVersion: >=1.29.0-0`) |
   | 1.30.2 | `0.29.2` |

   Once on 0.29.2, you can drop the pinned `version` to follow the default.
2. **Direct jump from 1.25 to 1.30: what this release tested.** Leaving `version` unset upgrades
   the operator in one step. The live test (`test/integration/cnpg/operator-upgrade.test.ts`)
   covers exactly this on one disposable kind cluster (Kubernetes 1.36) with one single-instance
   cluster: the cluster comes back healthy on its image with its rows, and a new cluster gets
   PostgreSQL 18. That is not a guarantee for multi-instance clusters, poolers, replicas,
   backups in flight or other configurations. Prefer path 1 for clusters you care about.
3. **Keep the old operator.** Pass `version: '0.23.0'` to stay on operator 1.25.0. CloudNativePG
   1.25 left support on August 22, 2025, and the Barman Cloud plugin needs 1.30 or later.

Before any step to 1.30, from the CloudNativePG
[1.30 release notes](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.2/docs/src/release_notes/v1.30.md)
and [upgrade guide](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.2/docs/src/installation_upgrade.md):

- **PostgreSQL 14 is not supported** by operator 1.30. Upgrade those clusters to PostgreSQL 15 or
  later first, or keep them on an older operator.
- **New clusters default to PostgreSQL 18** (`ghcr.io/cloudnative-pg/postgresql:18.7-system-trixie`)
  when they set no `imageName`. Existing clusters keep their image. Set `imageName` (or an image
  catalog) on new clusters that must stay on an older major version.
- **Every cluster rolls.** Upgrading the operator upgrades the instance manager in every pod, one
  instance at a time, and ends with a switchover (`primaryUpdateStrategy: unsupervised`, the
  default); single-instance clusters restart. Applications reconnect. Poolers on the default
  PgBouncer image roll to 1.26.1.
- **Read "Upgrading to 1.30.0"** in the upgrade guide: role passwords are SCRAM-encoded by the
  operator, `search_path` is pinned on operator connections, primaries are elected through a
  per-cluster `Lease` (the chart grants the RBAC), and instances created by an operator older
  than 1.24 need a rolling update before their status port can be reached.

## Usage in Compositions

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';
import { cluster, pooler } from 'typekro/cnpg';

const AppWithDB = kubernetesComposition({
  name: 'app-with-db',
  kind: 'AppWithDB',
  spec: type({ name: 'string', image: 'string', dbSize: 'string' }),
  status: type({ ready: 'boolean', dbReady: 'boolean' }),
}, (spec) => {
  const db = cluster({
    id: 'database',
    name: `${spec.name}-db`,
    spec: {
      instances: 3,
      storage: { size: spec.dbSize },
      bootstrap: { initdb: { database: spec.name, owner: 'app' } },
    },
  });

  const pool = pooler({
    id: 'pooler',
    name: `${spec.name}-pooler`,
    spec: {
      cluster: { name: `${spec.name}-db` },
      type: 'rw',
      pgbouncer: { poolMode: 'transaction' },
    },
  });

  const deploy = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    env: {
      DATABASE_URL: `postgresql://app@${spec.name}-pooler:5432/${spec.name}`,
    },
  });

  return {
    ready: deploy.status.readyReplicas > 0,
    dbReady: db.status.readyInstances >= 3,
  };
});
```

## Prerequisites

The CloudNativePG operator must be installed in your cluster. Use the `cnpgBootstrap` composition or install manually. Object store backups also need the Barman Cloud plugin and cert-manager; see [Barman Cloud Plugin](#barman-cloud-plugin).

```bash
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm install cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --create-namespace
```

## Next Steps

- [Kubernetes Factories](/api/kubernetes/) — Core Kubernetes resources
- [Cert-Manager](/api/cert-manager/) — TLS certificate management
- [Helm Integration](/examples/helm-integration) — Using Helm charts with TypeKro
- [CloudNativePG Documentation](https://cloudnative-pg.io/documentation/) — Upstream reference
