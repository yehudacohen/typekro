---
title: Valkey Factories
description: Factory functions for Hyperspike Valkey clusters on Kubernetes
---

# Valkey Factories

Factory functions for the [Hyperspike Valkey operator](https://github.com/hyperspike/valkey-operator) with built-in readiness evaluation. Manage Valkey clusters as Kubernetes-native resources.

## Import

```typescript
// Import specific functions (recommended)
import { valkey } from 'typekro/valkey';

// Or namespace import
import * as valkeyModule from 'typekro/valkey';
```

## Quick Example

```typescript
import { valkey } from 'typekro/valkey';

const cache = valkey({
  name: 'app-cache',
  namespace: 'default',
  spec: {
    shards: 3,
    replicas: 1,
    volumePermissions: true,
    storage: {
      storageClassName: 'gp3',
      resources: { requests: { storage: '10Gi' } },
    },
    resources: {
      requests: { cpu: '250m', memory: '512Mi' },
      limits: { cpu: '1', memory: '2Gi' },
    },
    prometheus: true,
  },
  id: 'appCache',
});
```

## Available Factories

| Factory | Kind | Scope | Description |
|---------|------|-------|-------------|
| `valkey` | Valkey | Namespace | Valkey cluster (sharded with optional replicas) |
| `valkeyHelmRepository` | HelmRepository | Namespace | OCI Helm registry for the operator |
| `valkeyHelmRelease` | HelmRelease | Namespace | Operator installation via Helm |

## valkey()

Creates a Valkey cluster managed by the Hyperspike operator.

```typescript
const cache = valkey({
  name: 'prod-cache',
  namespace: 'caching',
  spec: {
    // Cluster topology
    shards: 3,              // Number of primary nodes (default: 3)
    replicas: 1,            // Replicas per shard (default: 0)

    // Storage
    volumePermissions: true,
    storage: {
      storageClassName: 'gp3',
      resources: { requests: { storage: '50Gi' } },
    },

    // Resources
    resources: {
      requests: { cpu: '500m', memory: '1Gi' },
      limits: { cpu: '2', memory: '4Gi' },
    },

    // Security
    tls: true,
    certIssuer: 'letsencrypt-prod',
    certIssuerType: 'ClusterIssuer',
    anonymousAuth: false,
    servicePassword: { name: 'valkey-secret', key: 'password' },

    // Monitoring
    prometheus: true,
    serviceMonitor: true,
    prometheusLabels: { prometheus: 'kube-prometheus' },

    // External access via Envoy proxy
    externalAccess: {
      enabled: true,
      type: 'Proxy',
      proxy: {
        replicas: 2,
        hostname: 'valkey.example.com',
      },
    },

    // Scheduling
    nodeSelector: { 'node-type': 'cache' },
    tolerations: [{
      key: 'dedicated',
      operator: 'Equal',
      value: 'cache',
      effect: 'NoSchedule',
    }],
  },
  id: 'prodCache',
});
```

### Valkey Readiness

The readiness evaluator checks the Hyperspike status model:

| State | Ready | Reason |
|-------|-------|--------|
| `status.ready: true` | `true` | `Ready` |
| `status.ready: false` with condition | `false` | Condition reason (e.g., `ShardsNotReady`) |
| `status.ready: false` without condition | `false` | `NotReady` |
| No `ready` field | Falls back to condition-based evaluation |
| Missing status | `false` | `StatusMissing` |

### External Access Modes

- **Proxy** (default) — Envoy proxy for external connections with optional TLS
- **LoadBalancer** — Kubernetes LoadBalancer service per shard

## Bootstrap Composition

Install the Hyperspike Valkey operator via Helm:

```typescript
import { valkeyBootstrap } from 'typekro/valkey';

// 'kro' = KRO mode — creates a ResourceGraphDefinition for continuous reconciliation
// 'direct' = Direct mode — applies resources immediately without KRO controller
const factory = valkeyBootstrap.factory('kro', {
  namespace: 'valkey-operator-system',
  waitForReady: true,
});

await factory.deploy({
  name: 'valkey-operator',
  namespace: 'valkey-operator-system',
});
```

### Bootstrap Status

```typescript
instance.status.ready    // boolean — operator is running
instance.status.phase    // 'Ready' | 'Installing'
instance.status.failed   // boolean — true if Ready condition is explicitly False
instance.status.version  // deployed operator version (app version, not chart version)
```

> **Note:** `phase` cannot distinguish `'Failed'` from `'Installing'` due to a
> [CEL evaluator limitation](https://github.com/yehudacohen/typekro/issues/48).
> Use the `failed` field to detect deployment failures. If `failed` is `true`,
> check the HelmRelease conditions directly for failure details.

## Usage in Compositions

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';
import { valkey } from 'typekro/valkey';

const AppWithCache = kubernetesComposition({
  name: 'app-with-cache',
  kind: 'AppWithCache',
  spec: type({ name: 'string', image: 'string' }),
  status: type({ ready: 'boolean', cacheReady: 'boolean' }),
}, (spec) => {
  const cache = valkey({
    id: 'cache',
    name: `${spec.name}-cache`,
    spec: { shards: 3, volumePermissions: true },
  });

  const deploy = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    env: {
      VALKEY_HOST: `${spec.name}-cache`,
      VALKEY_PORT: '6379',
    },
  });

  return {
    ready: deploy.status.readyReplicas > 0,
    cacheReady: cache.status.ready,
  };
});
```

## Prerequisites

The Hyperspike Valkey operator must be installed. Use the `valkeyBootstrap` composition or install manually:

```bash
LATEST=$(curl -s https://api.github.com/repos/hyperspike/valkey-operator/releases/latest | jq -cr .tag_name)
helm install valkey-operator \
  --namespace valkey-operator-system \
  --create-namespace \
  oci://ghcr.io/hyperspike/valkey-operator \
  --version ${LATEST}-chart
```

For TLS support, [cert-manager](https://cert-manager.io/) must be installed with an appropriate certificate issuer.

## Next Steps

- [Kubernetes Factories](/api/kubernetes/) — Core Kubernetes resources
- [CloudNativePG](/api/cnpg/) — PostgreSQL cluster management
- [Cert-Manager](/api/cert-manager/) — TLS certificate management
- [Hyperspike Documentation](https://docs.hyperspike.io/valkey-operator/) — Upstream reference
