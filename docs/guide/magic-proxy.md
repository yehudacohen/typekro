# Magic Proxy System

TypeKro uses two proxy systems to make resource references feel natural while generating CEL expressions under the hood.

## Two Types of Proxies

TypeKro has two distinct proxy types:

| Proxy Type | What It Wraps | Example Access | Generated CEL |
|------------|---------------|----------------|---------------|
| **Schema Proxy** | The `spec` parameter | `spec.name` | `${schema.spec.name}` |
| **Magic Proxy** | Resources (Deployment, Service, etc.) | `deploy.status.readyReplicas` | `${deploy.status.readyReplicas}` |

Both create `KubernetesRef` objects at runtime, but they reference different things:
- **Schema Proxy**: References input values from your composition's spec
- **Magic Proxy**: References live Kubernetes resource state

## The Problem They Solve

In Kubernetes, resources reference each other's **live state**. A Deployment's environment variable might need a Service's cluster IP - but that IP doesn't exist until the Service is created.

TypeKro's proxies let you write natural TypeScript that becomes runtime-aware CEL expressions.

```typescript
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';
import { type } from 'arktype';

const composition = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: type({ name: 'string', image: 'string' }),
  status: type({ dbHost: 'string' })
}, (spec) => {  // ← spec is a Schema Proxy
  const dbService = Service({
    id: 'dbSvc',
    name: 'db-service',
    selector: { app: 'db' },
    ports: [{ port: 5432 }]
  });  // ← dbService is wrapped with a Magic Proxy

  const app = Deployment({
    id: 'app',
    name: spec.name,                        // Schema Proxy → ${schema.spec.name}
    image: spec.image,                      // Schema Proxy → ${schema.spec.image}
    env: { DB_HOST: dbService.status.clusterIP }  // Magic Proxy → ${dbSvc.status.clusterIP}
  });

  return { dbHost: dbService.status.clusterIP };
});
```

## Schema Proxy: Referencing Input Values

The `spec` parameter in your composition function is a Schema Proxy. Access its properties to create references to input values:

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment } from 'typekro/simple';

const composition = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: type({ name: 'string', image: 'string', replicas: 'number' }),
  status: type({ appName: 'string' })
}, (spec) => {
  const app = Deployment({
    id: 'app',
    name: spec.name,        // Becomes: ${schema.spec.name}
    image: spec.image,      // Becomes: ${schema.spec.image}
    replicas: spec.replicas // Becomes: ${schema.spec.replicas}
  });
  
  return {
    appName: spec.name      // Schema reference in status
  };
});
```

## Magic Proxy: Referencing Resource State

Resources returned by factory functions are wrapped with Magic Proxies. Access their properties to create references to live Kubernetes state:

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

const composition = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: type({ name: 'string' }),
  status: type({ ready: 'number', endpoint: 'string' })
}, (spec) => {
  const deployment = Deployment({ 
    id: 'deploy', 
    name: 'web-app', 
    image: 'nginx:latest' 
  });
  
  const service = Service({
    id: 'svc',
    name: 'web-service',
    selector: { app: 'web-app' },
    ports: [{ port: 80 }]
  });
  
  return {
    ready: deployment.status.readyReplicas,  // ${deploy.status.readyReplicas}
    endpoint: service.status.clusterIP       // ${svc.status.clusterIP}
  };
});
```

## JavaScript Expressions Work!

TypeKro automatically converts JavaScript expressions to CEL:

```typescript
// ✅ These all work - auto-converted to CEL
return {
  ready: app.status.readyReplicas > 0,
  allReady: app.status.readyReplicas >= spec.replicas,
  url: `https://${service.status.clusterIP}`,
  phase: app.status.readyReplicas > 0 ? 'running' : 'pending'
};
```

## When to Use Explicit CEL

Only use `Cel.expr()` for advanced list operations:

```typescript
import { Cel } from 'typekro';

// ❌ Array methods don't convert
length: deployment.spec.containers.length

// ✅ Use explicit CEL for list operations
containerCount: Cel.size(deployment.spec.template.spec.containers),
podNames: Cel.expr('pods.map(p, p.metadata.name)'),
```

## Cross-Resource References

Resources can reference each other. The `id` field enables this (see [Resource IDs](/advanced/resource-ids) for details):

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

const composition = kubernetesComposition({
  name: 'fullstack',
  apiVersion: 'example.com/v1',
  kind: 'FullStack',
  spec: type({ name: 'string', image: 'string' }),
  status: type({ databaseReady: 'boolean', appReady: 'boolean', ready: 'boolean' })
}, (spec) => {
  const postgres = Deployment({ 
    id: 'db',  // id enables references to this resource
    name: 'postgres', 
    image: 'postgres:15' 
  });
  
  const dbService = Service({
    id: 'dbSvc',
    name: 'postgres-service',
    selector: { app: 'postgres' },
    ports: [{ port: 5432 }]
  });
  
  // App references database service
  const app = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    env: {
      DATABASE_HOST: dbService.status.clusterIP  // Cross-resource reference
    }
  });
  
  return {
    databaseReady: postgres.status.readyReplicas > 0,
    appReady: app.status.readyReplicas > 0,
    ready: postgres.status.readyReplicas > 0 && app.status.readyReplicas > 0
  };
});
```

## Type Safety

The proxy maintains full TypeScript type safety:

```typescript
const app = Deployment({ id: 'app', name: 'web-app', image: 'nginx:latest' });

// ✅ Proper types
app.metadata.name;              // string
app.spec.replicas;              // number  
app.status.readyReplicas;       // number

// ❌ Compile-time errors
app.spec.invalidField;          // Property doesn't exist
```

## Debugging

Use `toYaml()` to see generated CEL expressions:

```typescript
const yaml = composition.toYaml({ name: 'test', image: 'nginx' });
console.log(yaml);  // See actual CEL expressions
```

## Next Steps

- [JavaScript to CEL](./javascript-to-cel.md) - Supported expression patterns
- [CEL API Reference](/api/cel) - Advanced CEL patterns
