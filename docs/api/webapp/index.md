---
title: Web Application Compositions
description: Higher-level compositions that wire databases, caches, and workflow engines together
---

# Web Application Compositions

Higher-level compositions that wire together [CNPG](/api/cnpg/) PostgreSQL, [Valkey](/api/valkey/) cache, [Inngest](/api/inngest/) workflow engine, and your application deployment. All connection strings are automatically injected as environment variables.

## Import

```typescript
import { webAppWithProcessing } from 'typekro/webapp';
```

## webAppWithProcessing

Deploys a complete application stack with automatic wiring:

| Component | Resource | Wired env var |
|-----------|----------|---------------|
| PostgreSQL | CNPG Cluster + PgBouncer Pooler | `DATABASE_URL` |
| Cache | Valkey cluster | `VALKEY_URL`, `REDIS_URL` |
| Workflow engine | Inngest (external DB mode) | `INNGEST_BASE_URL`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` |
| Application | Deployment + Service | — |

### Quick Example

```typescript
import { webAppWithProcessing } from 'typekro/webapp';

// 'kro' = continuous reconciliation, 'direct' = immediate apply
const factory = webAppWithProcessing.factory('kro', {
  namespace: 'production',
  waitForReady: true,
});

const instance = await factory.deploy({
  name: 'my-app',
  namespace: 'production',
  app: {
    image: 'my-app:latest',
    port: 3000,
    replicas: 2,
    env: {
      NODE_ENV: 'production',
    },
  },
  database: {
    instances: 3,
    storageSize: '50Gi',
    storageClass: 'gp3',
    database: 'myapp',
  },
  cache: {
    shards: 3,
    replicas: 1,
  },
  processing: {
    eventKey: 'your-hex-event-key',
    signingKey: 'your-hex-signing-key',
    sdkUrl: ['http://my-app:3000/api/inngest'],
  },
});
```

### What gets deployed

Given `name: 'my-app'`, the composition creates:

| Resource | Name | Type |
|----------|------|------|
| PostgreSQL cluster | `my-app-db` | CNPG Cluster (3 instances) |
| Connection pooler | `my-app-db-pooler` | CNPG Pooler (PgBouncer, transaction mode) |
| Cache | `my-app-cache` | Valkey cluster |
| Workflow engine | `my-app-inngest` | Inngest (HelmRelease, external DB) |
| Application | `my-app` | Deployment + Service |

### Environment variables injected into the app

```
DATABASE_URL=postgresql://app@my-app-db-pooler:5432/myapp
VALKEY_URL=redis://my-app-cache:6379
REDIS_URL=redis://my-app-cache:6379
INNGEST_BASE_URL=http://my-app-inngest:8288
INNGEST_EVENT_KEY=<from config>
INNGEST_SIGNING_KEY=<from config>
```

User-provided `app.env` values are merged on top, so you can override any of these.

### Status

```typescript
instance.status.ready       // all components healthy
instance.status.databaseUrl // postgresql://app@...-db-pooler:5432/...
instance.status.cacheUrl    // redis://...-cache:6379
instance.status.inngestUrl  // http://...-inngest:8288
instance.status.appUrl      // http://...:3000

instance.status.components.app       // app deployment ready
instance.status.components.database  // CNPG cluster healthy
instance.status.components.cache     // Valkey ready
instance.status.components.inngest   // Inngest ready
```

### Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | App name (prefix for all resources) |
| `namespace` | No | Target namespace (default: 'default') |
| `app.image` | Yes | Container image |
| `app.port` | No | Container port (default: 3000) |
| `app.replicas` | No | Replica count (default: 1) |
| `app.env` | No | Extra env vars (merged with auto-wired ones) |
| `database.storageSize` | Yes | PG storage (e.g., '50Gi') |
| `database.instances` | No | PG replicas (default: 1) |
| `database.storageClass` | No | Storage class |
| `database.database` | No | Database name (default: app name) |
| `database.owner` | No | DB owner (default: 'app') |
| `cache.shards` | No | Valkey shards (default: 3) |
| `cache.replicas` | No | Replicas per shard (default: 0) |
| `processing.eventKey` | Yes | Inngest event key (hex string) |
| `processing.signingKey` | Yes | Inngest signing key (hex string) |
| `processing.sdkUrl` | No | App SDK URLs for function sync |
| `processing.replicas` | No | Inngest server replicas (default: 1) |

### Prerequisites

The following operators must be installed before deploying:

- **CloudNativePG** operator — `cnpgBootstrap` from `typekro/cnpg`
- **Valkey** operator — `valkeyBootstrap` from `typekro/valkey`
- **Flux CD** — for Inngest HelmRelease

```typescript
import { cnpgBootstrap } from 'typekro/cnpg';
import { valkeyBootstrap } from 'typekro/valkey';

// Install operators first
await cnpgBootstrap.factory('direct', { ... }).deploy({ ... });
await valkeyBootstrap.factory('direct', { ... }).deploy({ ... });

// Then deploy the full stack
await webAppWithProcessing.factory('kro', { ... }).deploy({ ... });
```

## Next Steps

- [CloudNativePG](/api/cnpg/) — PostgreSQL cluster management
- [Valkey](/api/valkey/) — Cache cluster management
- [Inngest](/api/inngest/) — Workflow engine deployment
