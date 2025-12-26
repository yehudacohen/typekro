# Factory Functions

TypeKro provides factory functions for creating Kubernetes resources with full type safety.

## Quick Example

```typescript
import { Deployment, Service } from 'typekro/simple';

const deploy = Deployment({
  id: 'app',  // Required for cross-resource references
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3,
  ports: [{ containerPort: 80 }]
});

const svc = Service({
  id: 'svc',
  name: 'my-app-svc',
  selector: { app: 'my-app' },
  ports: [{ port: 80, targetPort: 80 }]
});
```

## Import Patterns

See [Import Patterns](/api/imports) for complete import documentation.

```typescript
// Recommended: direct imports from typekro/simple
import { Deployment, Service, ConfigMap, Secret, YamlFile, HelmChart } from 'typekro/simple';

// Alternative: namespace import from main package
import { simple } from 'typekro';
const deploy = simple.Deployment({ id: 'app', name: 'app', image: 'nginx' });

// Core factories (full Kubernetes API)
import { deployment, service, role, roleBinding } from 'typekro';
```

## Categories

| Category | Description |
|----------|-------------|
| [Workloads](./workloads) | Deployment, StatefulSet, DaemonSet, Job, CronJob |
| [Networking](./networking) | Service, Ingress, NetworkPolicy |
| [Config](./config) | ConfigMap, Secret |
| [Storage](./storage) | PersistentVolumeClaim, PersistentVolume |
| [RBAC](./rbac) | Role, RoleBinding, ServiceAccount, ClusterRole |
| [YAML](./yaml) | yamlFile for external manifests |

## Simple vs Core Factories

**Simple Factories** - Minimal configuration with sensible defaults:
```typescript
import { Deployment } from 'typekro/simple';

const deploy = Deployment({
  id: 'app',
  name: 'app',
  image: 'nginx',
  replicas: 3
});
```

**Core Factories** - Full Kubernetes API access:
```typescript
import { deployment } from 'typekro';

const deploy = deployment({
  id: 'app',
  metadata: { name: 'app', namespace: 'prod' },
  spec: {
    replicas: 3,
    selector: { matchLabels: { app: 'my-app' } },
    template: { /* full pod template */ }
  }
});
```

## The `id` Parameter

Every resource that needs to be referenced requires an `id`. See [Resource IDs](/advanced/resource-ids) for complete documentation.

```typescript
import { Deployment } from 'typekro/simple';

// ✅ With id - can be referenced in status expressions
const deploy = Deployment({ id: 'app', name: 'app', image: 'nginx' });
return { ready: deploy.status.readyReplicas > 0 };

// ❌ Without id - cannot be referenced
const deploy = Deployment({ name: 'app', image: 'nginx' });
// deploy.status.readyReplicas won't generate correct CEL
```

## Next Steps

- **[Workloads](./workloads)** - Deployment, StatefulSet, DaemonSet
- **[Networking](./networking)** - Service, Ingress, NetworkPolicy
- **[YAML](./yaml)** - External manifest integration
