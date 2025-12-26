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
