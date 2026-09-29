---
title: Kubernetes Factories
description: Factory functions for Kubernetes native resources
---

# Kubernetes Factories

Factory functions for creating Kubernetes native resources with full type safety.

## Quick Example

```typescript
import { Deployment, Service } from 'typekro/simple';

const deploy = Deployment({
  id: 'app',
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3
});

const svc = Service({
  id: 'svc',
  name: 'my-app-svc',
  selector: { app: 'my-app' },
  ports: [{ port: 80 }]
});
```

## Import Patterns

See [Import Patterns](/api/imports) for complete import documentation.

```typescript
// Recommended: direct imports from subpath
import { Deployment, Service } from 'typekro/simple';

// Alternative: namespace import
import { simple } from 'typekro';
const deploy = simple.Deployment({ id: 'app', name: 'app', image: 'nginx' });
```

## Categories

### Workloads

| Factory | Description |
|---------|-------------|
| `Deployment` | Stateless application deployments |
| `StatefulSet` | Stateful applications with stable identities |
| `DaemonSet` | Run pods on every node |
| `Job` | Batch processing |
| `CronJob` | Scheduled tasks |

### Networking

| Factory | Description |
|---------|-------------|
| `Service` | Expose applications |
| `Ingress` | HTTP routing |
| `NetworkPolicy` | Pod network isolation |

### Configuration

| Factory | Description |
|---------|-------------|
| `ConfigMap` | Configuration data |
| `Secret` | Sensitive data |

### Core Resources

For resources not in simple factories, use core factories:

```typescript
import { namespace, pod } from 'typekro';

const ns = namespace({
  metadata: { name: 'my-namespace' }
});

const debugPod = pod({
  metadata: { name: 'debug', namespace: 'default' },
  spec: {
    containers: [{ name: 'debug', image: 'busybox', command: ['sleep', '3600'] }]
  }
});
```

`customResourceDefinition()` accepts the Kubernetes CRD manifest shape. Its OpenAPI schema
uses Kubernetes field names, including `enum` and `x-kubernetes-validations`; direct
deployments preserve those fields when creating, patching, and reading the CRD.

For an Alchemy operation host that must authorize each Kubernetes effect, use
`kroProviderWithHooks({ beforeKubernetesEffect })` from `typekro/alchemy`.
The callback runs before every direct Kubernetes create, patch, replace or delete,
including retries, and returns a fresh create-only or UID/resourceVersion
precondition for guarded resources. It may return `{ precondition, release }` to
hold an operation lock until that write succeeds or fails. It returns `undefined` for direct resources
outside the host's guarded scope. A proven absent delete may return
`{ skip: 'already-absent', release }`. `beforeReconcile` and `beforeDelete` remain preflight hooks; they run
before TypeKro's reads and preparation and cannot provide short-lived write
authority. When the host returns create-only authority for server-side apply of
a proven absent resource, TypeKro performs an atomic create with the same
field manager. Other patch forms cannot use create-only authority. The
effect-time hook cannot be combined with a preflight mutation
precondition or an injected deployer. Callbacks are not stored in Alchemy state,
so each operation host must supply them when it runs.

Alchemy hosts that make a stamped copy of a TypeKro resource should call
`copyResourceMetadata(original, stamped)` from `typekro/alchemy` before passing the
copy to `KroResource`. That preserves factory scope and readiness metadata across
the copy; `getResourceScope(stamped)` can verify the selected scope. Direct
Alchemy declarations also carry that scope as a serializable input so a later
state-driven delete retains the same cluster or namespaced identity.

### Storage

| Factory | Description |
|---------|-------------|
| `Pvc` | PersistentVolumeClaim |
| `PersistentVolume` | Storage volumes |

### Autoscaling

| Factory | Description |
|---------|-------------|
| `Hpa` | Horizontal Pod Autoscaler |

### Helm

| Factory | Description |
|---------|-------------|
| `HelmChart` | Simplified Helm chart deployment |

## The `id` Parameter

Every factory requires an `id` for cross-resource references:

```typescript
import { Deployment, Service } from 'typekro/simple';

const db = Deployment({ id: 'db', name: 'postgres', image: 'postgres' });
const dbService = Service({
  id: 'dbSvc',
  name: 'postgres-svc',
  selector: { app: 'postgres' },
  ports: [{ port: 5432 }]
});

const app = Deployment({
  id: 'app',
  name: 'api',
  image: 'myapi',
  env: {
    DB_HOST: dbService.status.clusterIP  // Cross-reference using id
  }
});
```

## Next Steps

- [Factory Functions](/api/factories/) - Detailed API reference
- [Examples](/examples/basic-webapp) - See factories in action
