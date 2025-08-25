# Basic WebApp Pattern

The most common TypeKro pattern - a web application with deployment and service.

## Complete Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition, simple, Cel } from 'typekro';

// Define the application schema
const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: '"development" | "staging" | "production"'
});

const WebAppStatus = type({
  ready: 'boolean',
  url: 'string',
  replicas: 'number'
});

// Create the resource graph with kubernetesComposition
export const webapp = kubernetesComposition(
  {
    name: 'basic-webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  // Resource builder: create named resources
  (schema) => ({
    deployment: simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [{ containerPort: 3000 }],
      env: {
        NODE_ENV: schema.spec.environment
      }
    }),
    
    service: simple.Service({
      name: Cel.template('%s-service', schema.spec.name),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'ClusterIP'
    })
  }),
  // Status builder: compute status from resources
  (schema, resources) => ({
    ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' >= ', schema.spec.replicas),
    url: Cel.template('http://%s', resources.service.status.clusterIP),
    replicas: resources.deployment.status.readyReplicas
  })
);
```

## Usage

### Deploy Directly
```typescript
const factory = webapp.factory('direct', { namespace: 'dev' });
await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest', 
  replicas: 2,
  environment: 'development'
});
```

### Generate YAML
```typescript
const yaml = webapp.toYaml({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3,
  environment: 'production'
});
```

### KRO Deployment
```typescript
const kroFactory = webapp.factory('kro', { namespace: 'production' });
await kroFactory.deploy({
  name: 'prod-app',
  image: 'nginx:1.24',
  replicas: 5,
  environment: 'production'
});
```

## Key Concepts Demonstrated

- **Structured Composition**: Resource and status builders provide clear separation
- **Schema Definition**: Using ArkType for type-safe specifications  
- **Resource Creation**: `simple.Deployment` and `simple.Service` factories
- **CEL Templates**: Using `Cel.template()` for dynamic string construction
- **CEL Expressions**: Using `Cel.expr()` for dynamic boolean logic
- **Resource References**: Type-safe access to resource status fields
- **Environment Configuration**: Schema-driven configuration patterns