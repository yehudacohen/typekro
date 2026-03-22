---
title: Inngest Factories
description: Factory functions for deploying Inngest on Kubernetes via Helm
---

# Inngest Factories

Deploy [Inngest](https://www.inngest.com/) on Kubernetes using the [official Helm chart](https://github.com/inngest/inngest-helm). Inngest is a workflow orchestration platform with no CRDs — all configuration is through Helm values.

## Import

```typescript
import { inngestBootstrap } from 'typekro/inngest';
```

## Quick Example

```typescript
import { inngestBootstrap } from 'typekro/inngest';

// 'kro' = KRO mode (continuous reconciliation via ResourceGraphDefinition)
// 'direct' = Direct mode (immediate apply, no KRO controller needed)
const factory = inngestBootstrap.factory('kro', {
  namespace: 'inngest',
  waitForReady: true,
});

await factory.deploy({
  name: 'inngest',
  namespace: 'inngest',
  inngest: {
    eventKey: 'your-event-key',
    signingKey: 'your-signing-key',
  },
});
```

## Available Factories

| Factory | Kind | Description |
|---------|------|-------------|
| `inngestHelmRepository` | HelmRepository | OCI chart registry |
| `inngestHelmRelease` | HelmRelease | Inngest deployment via Helm |

## Bootstrap Composition

### Basic (bundled PostgreSQL + Redis)

```typescript
await factory.deploy({
  name: 'inngest',
  namespace: 'inngest',
  inngest: {
    eventKey: 'your-event-key',
    signingKey: 'your-signing-key',
  },
});
```

### With external databases (CNPG + Valkey)

Disable bundled databases and provide connection URIs:

```typescript
await factory.deploy({
  name: 'inngest',
  namespace: 'inngest',
  inngest: {
    eventKey: 'your-event-key',
    signingKey: 'your-signing-key',
    postgres: { uri: 'postgresql://inngest:password@my-db-rw:5432/inngest' },
    redis: { uri: 'redis://my-cache:6379' },
    sdkUrl: ['http://my-app:5173/api/inngest'],
  },
  postgresql: { enabled: false },
  redis: { enabled: false },
  resources: {
    requests: { cpu: '500m', memory: '1Gi' },
    limits: { cpu: '2', memory: '4Gi' },
  },
});
```

### With ingress and autoscaling

```typescript
await factory.deploy({
  name: 'inngest',
  namespace: 'inngest',
  inngest: {
    eventKey: 'your-event-key',
    signingKey: 'your-signing-key',
    host: 'inngest.example.com',
  },
  ingress: {
    enabled: true,
    className: 'nginx',
    hosts: [{ host: 'inngest.example.com' }],
    tls: [{ secretName: 'inngest-tls', hosts: ['inngest.example.com'] }],
  },
  keda: {
    enabled: true,
    minReplicas: 2,
    maxReplicas: 20,
  },
});
```

### Bootstrap Status

```typescript
instance.status.ready    // boolean — Inngest is processing events
instance.status.phase    // 'Ready' | 'Installing'
instance.status.failed   // boolean — true if HelmRelease Ready=False
instance.status.version  // deployed chart version (static, deploy-time)
```

> **Note:** `phase` cannot distinguish `'Failed'` from `'Installing'` due to a
> [CEL evaluator limitation](https://github.com/yehudacohen/typekro/issues/48).
> Use the `failed` field to detect deployment failures.

## Key Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `inngest.eventKey` | Yes | Event authentication key |
| `inngest.signingKey` | Yes | Request signing key |
| `inngest.postgres.uri` | No | External PostgreSQL URI (disables bundled PG) |
| `inngest.redis.uri` | No | External Redis/Valkey URI (disables bundled Redis) |
| `inngest.sdkUrl` | No | SDK URLs to auto-sync functions from |
| `postgresql.enabled` | No | Bundled PostgreSQL (default: true) |
| `redis.enabled` | No | Bundled Redis (default: true) |

## Usage in Compositions

> **Note:** This example uses [CloudNativePG](/api/cnpg/) and [Valkey](/api/valkey/)
> for external databases. See their respective docs for setup.

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { inngestBootstrap } from 'typekro/inngest';
import { cluster } from 'typekro/cnpg';
import { valkey } from 'typekro/valkey';

const MyPlatform = kubernetesComposition({
  name: 'my-platform',
  kind: 'MyPlatform',
  spec: type({ name: 'string', image: 'string' }),
  status: type({ ready: 'boolean' }),
}, (spec) => {
  // PostgreSQL via CNPG
  const db = cluster({
    id: 'database',
    name: `${spec.name}-db`,
    spec: {
      instances: 3,
      storage: { size: '50Gi' },
      bootstrap: { initdb: { database: 'inngest', owner: 'inngest' } },
    },
  });

  // Valkey cache
  const cache = valkey({
    id: 'cache',
    name: `${spec.name}-cache`,
    spec: { shards: 3, volumePermissions: true },
  });

  // Inngest with external DBs
  const inngest = inngestBootstrap({
    name: `${spec.name}-inngest`,
    inngest: {
      eventKey: 'your-key',
      signingKey: 'your-signing-key',
      postgres: { uri: `postgresql://inngest:password@${spec.name}-db-rw:5432/inngest` },
      redis: { uri: `redis://${spec.name}-cache:6379` },
    },
    postgresql: { enabled: false },
    redis: { enabled: false },
  });

  return {
    ready: db.status.readyInstances > 0 && cache.status.ready,
  };
});
```

## Prerequisites

No operator installation needed — Inngest is deployed directly via Helm. Requirements:

- **Flux CD** — for HelmRelease reconciliation
- **PostgreSQL** — bundled or external (e.g., [CloudNativePG](/api/cnpg/))
- **Redis/Valkey** — bundled or external (e.g., [Valkey](/api/valkey/))
- **KEDA** — optional, for queue-depth autoscaling
- **cert-manager** — optional, for TLS ingress

## Next Steps

- [CloudNativePG](/api/cnpg/) — External PostgreSQL clusters
- [Valkey](/api/valkey/) — External Valkey cache clusters
- [Kubernetes Factories](/api/kubernetes/) — Core Kubernetes resources
- [Inngest Self-Hosting Docs](https://www.inngest.com/docs/self-hosting) — Upstream reference
