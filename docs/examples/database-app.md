# Database + App

Cross-resource references for database connection strings.

## Complete Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service, Secret } from 'typekro/simple';

export const fullstack = kubernetesComposition({
  name: 'fullstack',
  apiVersion: 'example.com/v1alpha1',
  kind: 'FullStack',
  spec: type({ name: 'string', appImage: 'string', replicas: 'number' }),
  status: type({ ready: 'boolean', dbReady: 'boolean', appReady: 'boolean' }),
}, (spec) => {
  Secret({ id: 'dbSecret', name: `${spec.name}-db-secret`, stringData: { password: 'secret123' } });

  const db = Deployment({
    id: 'db',
    name: `${spec.name}-db`,
    image: 'postgres:15',
    ports: [{ containerPort: 5432 }],
    env: { POSTGRES_PASSWORD: 'secret123', POSTGRES_DB: spec.name }
  });

  const dbSvc = Service({
    id: 'dbSvc',
    name: `${spec.name}-db-svc`,
    selector: { app: `${spec.name}-db` },
    ports: [{ port: 5432, targetPort: 5432 }]
  });

  const dbUrl = `postgresql://postgres:secret123@${spec.name}-db-svc:5432/${spec.name}`;

  const app = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.appImage,
    replicas: spec.replicas,
    ports: [{ containerPort: 3000 }],
    env: {
      DATABASE_HOST: dbSvc.status.clusterIP,
      DATABASE_URL: dbUrl
    }
  });

  return {
    ready: db.status.readyReplicas > 0 && app.status.readyReplicas >= spec.replicas,
    dbReady: db.status.readyReplicas > 0,
    appReady: app.status.readyReplicas >= spec.replicas
  };
});
```

## Deploy

```typescript
const factory = fullstack.factory('direct', { namespace: 'dev' });
await factory.deploy({ name: 'myapp', appImage: 'node:20', replicas: 2 });
```

## Key Concepts

- **Cross-resource references**: `dbSvc.status.clusterIP` references the database service's runtime IP
- **Service discovery**: App connects to database via service name
- **Status aggregation**: Overall readiness depends on both database and app
- **Template literals**: Dynamic connection strings with `` `${spec.name}` ``
- **Resource IDs**: Every resource that's referenced (in status or from other resources) has an `id`

::: tip When is `id` optional?
The Secret in this example has `id: 'dbSecret'` but it's not referenced anywhere. You could omit it, but including `id` on all resources is good practice for consistency and future-proofing.
:::

## Production Version: Full Stack Composition

For production, use the `webAppWithProcessing` composition which deploys a real PostgreSQL cluster (CNPG), connection pooler (PgBouncer), cache (Valkey), and workflow engine (Inngest) — all with proper readiness checks and auto-wired connection strings:

```typescript
import { buildContainer } from 'typekro/containers';
import { webAppWithProcessing } from 'typekro/webapp';

const { imageUri } = await buildContainer({
  context: './apps/my-app',
  imageName: 'my-app',
  registry: { type: 'orbstack' },
});

const factory = webAppWithProcessing.factory('direct', {
  namespace: 'production',
  waitForReady: true,
  kubeConfig,
});

await factory.deploy({
  name: 'my-app',
  app: { image: imageUri, port: 3000 },
  database: {
    storageSize: '50Gi',
    storageClass: 'gp3',
    instances: 3,
  },
  cache: { shards: 3 },
  processing: {
    eventKey: process.env.INNGEST_EVENT_KEY!,
    signingKey: process.env.INNGEST_SIGNING_KEY!,
  },
});
```

See [Web App Compositions](/api/webapp/) for the full reference.

## Next Steps

- [Helm Integration](./helm-integration.md) - Use Helm charts for databases
- [Multi-Environment](./multi-environment.md) - Environment-specific configs
- [Collections & forEach](./collections.md) - Deploy multiple instances from arrays
