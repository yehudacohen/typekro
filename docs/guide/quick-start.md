# Quick Start

Get up and running with TypeKro in under 5 minutes. This guide shows you the fastest path to deploying type-safe Kubernetes infrastructure.

## 1. Install TypeKro

```bash
bun add typekro
```

## 2. Create Your First App

Create `simple-app.ts`:

```typescript
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService, Cel } from 'typekro';

const AppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number'
});

const AppStatus = type({
  ready: 'boolean',
  url: 'string'
});

export const app = toResourceGraph(
  {
    name: 'simple-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'SimpleApp',
    spec: AppSpec,
    status: AppStatus,
  },
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [{ containerPort: 80 }]
    }),
    
    service: simpleService({
      name: Cel.template('%s-service', schema.spec.name),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 80 }]
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
    url: Cel.template('http://%s', resources.service.status.clusterIP)
  })
);
```

## 3. Deploy It

### Option A: Direct Deployment

```typescript
// deploy.ts
import { app } from './simple-app.js';

const factory = app.factory('direct', { namespace: 'default' });
await factory.deploy({
  name: 'hello-world',
  image: 'nginx:latest',
  replicas: 2
});

console.log('Deployed! 🚀');
```

```bash
bun run deploy.ts
```

### Option B: Generate YAML

```typescript
// generate.ts
import { writeFileSync } from 'fs';
import { app } from './simple-app.js';

const yaml = app.toYaml({
  name: 'hello-world',
  image: 'nginx:latest',
  replicas: 2
});

writeFileSync('app.yaml', yaml);
console.log('YAML generated! 📄');
```

```bash
bun run generate.ts
kubectl apply -f app.yaml
```

## 4. Verify It Works

```bash
kubectl get pods
kubectl get services
```

## What's Next?

- **Add a database**: [Database Integration Example](../examples/database-app.md)
- **Learn cross-references**: [Cross-Resource References](./cross-references.md)
- **Explore CEL expressions**: [CEL Expressions](./cel-expressions.md)
- **See more examples**: [Examples Gallery](../examples/)

## Common Patterns

### Environment-Specific Configuration

```typescript
const config = schema.spec.environment === 'production' 
  ? { replicas: 5, resources: { cpu: '500m', memory: '1Gi' } }
  : { replicas: 1, resources: { cpu: '100m', memory: '256Mi' } };

const deployment = simpleDeployment({
  name: schema.spec.name,
  image: schema.spec.image,
  replicas: config.replicas,
  resources: config.resources
});
```

### Cross-Resource References

```typescript
const database = simpleDeployment({
  name: 'db',
  image: 'postgres:15'
});

const app = simpleDeployment({
  name: 'app',
  image: 'myapp:latest',
  env: {
    DATABASE_HOST: database.status.podIP  // Runtime reference
  }
});
```

### Conditional Resources

```typescript
const resources = {
  app: simpleDeployment({ /* ... */ }),
  
  // Only create ingress in production
  ...(schema.spec.environment === 'production' && {
    ingress: simpleIngress({
      name: Cel.expr(schema.spec.name, '-ingress'),
      host: Cel.template('%s.example.com', schema.spec.name),
      serviceName: Cel.expr(schema.spec.name, '-service')
    })
  })
};
```

That's it! You now have a type-safe, deployable Kubernetes application. 🎉