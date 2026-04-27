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
| Workflow engine | Inngest (external DB mode) | `INNGEST_BASE_URL`; credentials are injected from a generated Secret via `envFrom` |
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
INNGEST_EVENT_KEY=<from generated Secret>
INNGEST_SIGNING_KEY=<from generated Secret>
```

The composition creates an Inngest credentials Secret and prepends it to `app.envFrom`. User-provided `app.env` values are still merged on top of generated direct environment variables, so they can override direct values such as `DATABASE_URL` or `INNGEST_BASE_URL`.

### Status

```typescript
instance.status.ready       // all components healthy
instance.status.databaseUrl // postgresql://app@...-db-pooler:5432/...
instance.status.databaseHost // ...-db-pooler
instance.status.databasePort // 5432
instance.status.cacheUrl    // redis://...-cache:6379
instance.status.cacheHost   // ...-cache
instance.status.cachePort   // 6379
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
| `app.envFrom` | No | Additional Secret/ConfigMap envFrom sources. TypeKro prepends the generated Inngest credentials Secret, so later entries can override only by defining the same env keys in a later source according to Kubernetes envFrom behavior |
| `database.storageSize` | Yes | PG storage (e.g., '50Gi') |
| `database.instances` | No | PG replicas (default: 1) |
| `database.storageClass` | No | Storage class |
| `database.database` | No | Database name (default: `app`) |
| `database.owner` | No | DB owner (default: 'app') |
| `cache.shards` | No | Valkey shards (default: 3) |
| `cache.replicas` | No | Replicas per shard (default: 0) |
| `cache.volumePermissions` | No | Enable the Valkey volume permissions init container |
| `cache.storageSize` | No | Storage size per Valkey shard (default: '1Gi') |
| `processing.eventKey` | Yes | Inngest event key (hex string) |
| `processing.signingKey` | Yes | Inngest signing key (hex string) |
| `processing.sdkUrl` | No | App SDK URLs for function sync |
| `processing.replicas` | No | Inngest server replicas (default: 1) |
| `processing.resources` | No | CPU/memory requests and limits for the Inngest server |
| `cnpgOperator` | No | CloudNativePG operator singleton settings; accepts the underlying CNPG bootstrap fields such as `name`, `namespace`, `version`, `resources`, `customValues`, and `shared` |
| `valkeyOperator` | No | Valkey operator singleton settings; accepts the underlying Valkey bootstrap fields such as `name`, `namespace`, `version`, `resources`, `customValues`, and `shared` |

### Prerequisites

Install the TypeKro runtime first so Flux and KRO are available. The webapp
composition bootstraps CloudNativePG and Valkey operators itself as shared
singleton dependencies.

- **TypeKro runtime** — Flux CD plus KRO controller
- **CloudNativePG** operator — bootstrapped by this composition
- **Valkey** operator — bootstrapped by this composition

```typescript
import { typeKroRuntimeBootstrap } from 'typekro';

// Install runtime first
await typeKroRuntimeBootstrap().factory('direct', { ... }).deploy({ ... });

// Then deploy the full stack; CNPG and Valkey operator singletons are included
await webAppWithProcessing.factory('kro', { ... }).deploy({ ... });
```

## Next Steps

- [CloudNativePG](/api/cnpg/) — PostgreSQL cluster management
- [Valkey](/api/valkey/) — Cache cluster management
- [Inngest](/api/inngest/) — Workflow engine deployment
