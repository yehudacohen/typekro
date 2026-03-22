---
title: CloudNativePG Factories
description: Factory functions for CloudNativePG PostgreSQL clusters on Kubernetes
---

# CloudNativePG Factories

Factory functions for [CloudNativePG](https://cloudnative-pg.io/) Custom Resource Definitions with built-in readiness evaluation. Manage PostgreSQL clusters, backups, and connection pooling as Kubernetes-native resources.

## Import

```typescript
// Import specific functions (recommended)
import { cluster, backup, scheduledBackup, pooler } from 'typekro/cnpg';

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
    backup: {
      barmanObjectStore: {
        destinationPath: 's3://my-backups/prod-db',
        s3Credentials: {
          accessKeyId: { name: 'aws-creds', key: 'ACCESS_KEY_ID' },
          secretAccessKey: { name: 'aws-creds', key: 'SECRET_ACCESS_KEY' },
        },
      },
      retentionPolicy: '30d',
    },
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
| Switchover in progress | `false` | `Failover` |
| Unknown phase | Falls back to condition-based evaluation |

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
    method: 'barmanObjectStore',
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

## Bootstrap Composition

Install the CNPG operator via Helm:

```typescript
import { cnpgBootstrap } from 'typekro/cnpg';

// KRO mode — operator reconciled continuously
const factory = cnpgBootstrap.factory('kro', {
  namespace: 'cnpg-system',
  waitForReady: true,
});

await factory.deploy({
  name: 'cnpg',
  namespace: 'cnpg-system',
  version: '0.23.0',
  installCRDs: true,
});
```

### Bootstrap Status

```typescript
instance.status.ready    // boolean — operator is running
instance.status.phase    // 'Ready' | 'Installing'
instance.status.version  // deployed chart version
```

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

The CloudNativePG operator must be installed in your cluster. Use the `cnpgBootstrap` composition or install manually:

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
