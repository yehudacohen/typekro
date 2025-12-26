# Workloads API

Simple factory functions for Kubernetes workload resources with type safety and sensible defaults.

## Quick Reference

| Factory | Use Case | Key Status Field |
|---------|----------|------------------|
| `Deployment()` | Stateless apps, web servers | `status.readyReplicas` |
| `StatefulSet()` | Databases, stateful services | `status.readyReplicas` |
| `Job()` | One-time batch processing | `status.succeeded` |
| `CronJob()` | Scheduled tasks | `status.lastScheduleTime` |
| `DaemonSet()` | Node-level agents | `status.numberReady` |

## Deployment()

```typescript
import { Deployment } from 'typekro/simple';

const app = Deployment({
  id: 'app',           // Required for cross-resource references
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3,
  ports: [{ containerPort: 80 }],
  env: { NODE_ENV: 'production' },
  resources: {
    requests: { cpu: '100m', memory: '128Mi' },
    limits: { cpu: '500m', memory: '512Mi' }
  }
});

// Status reference
return { ready: app.status.readyReplicas > 0 };
```

## StatefulSet()

```typescript
import { StatefulSet, Service } from 'typekro/simple';

const db = StatefulSet({
  id: 'db',
  name: 'postgres',
  image: 'postgres:15',
  replicas: 3,
  serviceName: 'postgres-headless',
  ports: [{ containerPort: 5432 }],
  env: { POSTGRES_PASSWORD: 'secret' }
});

const headless = Service({
  id: 'headless',
  name: 'postgres-headless',
  selector: { app: 'postgres' },
  ports: [{ port: 5432 }],
  clusterIP: 'None'
});

return { ready: db.status.readyReplicas >= spec.replicas };
```

## Job()

```typescript
import { Job } from 'typekro/simple';

const job = Job({
  id: 'migration',
  name: 'db-migration',
  image: 'migrate:v1',
  command: ['migrate', '--up'],
  env: { DATABASE_URL: spec.dbUrl },
  completions: 1,
  backoffLimit: 3
});

return { completed: job.status.succeeded >= 1 };
```

## CronJob()

```typescript
import { CronJob } from 'typekro/simple';

const backup = CronJob({
  id: 'backup',
  name: 'daily-backup',
  image: 'backup:latest',
  schedule: '0 2 * * *',  // Daily at 2 AM
  command: ['backup-db']
});

return { lastBackup: backup.status.lastScheduleTime || 'never' };
```

## DaemonSet()

```typescript
import { DaemonSet } from 'typekro/simple';

const agent = DaemonSet({
  id: 'agent',
  name: 'log-collector',
  image: 'fluentd:latest',
  env: { LOG_LEVEL: 'info' },
  volumeMounts: [{ name: 'logs', mountPath: '/var/log', readOnly: true }],
  volumes: [{ name: 'logs', hostPath: { path: '/var/log' } }]
});

return { ready: agent.status.numberReady > 0 };
```

## Complete Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service, ConfigMap } from 'typekro/simple';

const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number'
});

const webapp = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: WebAppSpec,
  status: type({ ready: 'boolean', endpoint: 'string' })
}, (spec) => {
  const config = ConfigMap({
    id: 'config',
    name: `${spec.name}-config`,
    data: { LOG_LEVEL: 'info' }
  });

  const app = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    replicas: spec.replicas,
    ports: [{ containerPort: 3000 }],
    env: { LOG_LEVEL: config.data.LOG_LEVEL }
  });

  const svc = Service({
    id: 'svc',
    name: `${spec.name}-svc`,
    selector: { app: spec.name },
    ports: [{ port: 80, targetPort: 3000 }]
  });

  return {
    ready: app.status.readyReplicas >= spec.replicas,
    endpoint: `http://${svc.status.clusterIP}`
  };
});
```

## Configuration Options

All workload factories accept these common options:

```typescript
interface CommonConfig {
  id: string;                    // Required for cross-references
  name: string;                  // Resource name
  image: string;                 // Container image
  env?: Record<string, string>;  // Environment variables
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
}
```

## Best Practices

1. **Always include `id`** - Required for status references and cross-resource dependencies
2. **Set resource limits** - Prevents runaway containers from affecting cluster stability
3. **Use appropriate workload type** - Deployment for stateless, StatefulSet for stateful, etc.

## Enhanced Resource Methods

All workload factories return `Enhanced` resources with additional methods:

```typescript
const deploy = Deployment({ id: 'app', name: 'app', image: 'nginx' });

// Custom readiness evaluation
deploy.withReadinessEvaluator((resource) => ({
  ready: resource.status?.readyReplicas === resource.spec?.replicas,
  message: `${resource.status?.readyReplicas}/${resource.spec?.replicas} ready`
}));

// Explicit dependencies
deploy.withDependencies('database', 'configMap');
```

See [Custom Integrations](/advanced/custom-integrations) for details.

## Next Steps

- [Networking](./networking.md) - Service, Ingress, NetworkPolicy
- [Config](./config.md) - ConfigMap, Secret
- [Storage](./storage.md) - PVC, PersistentVolume
