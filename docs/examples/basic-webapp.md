# Basic WebApp Pattern

The most common TypeKro pattern - a web application with deployment and service.

## Complete Example

```typescript
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService, Cel } from 'typekro';

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

// Create the resource graph
export const webapp = toResourceGraph(
  {
    name: 'basic-webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  // Resource builder
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [{ containerPort: 3000 }],
      env: {
        NODE_ENV: schema.spec.environment
      }
    }),
    
    service: simpleService({
      name: Cel.template('%s-service', schema.spec.name),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'ClusterIP'
    })
  }),
  // Status builder
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
const factory = await webapp.factory('direct', { namespace: 'dev' });
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

## Key Concepts Demonstrated

- **Schema Definition**: Using ArkType for type-safe specifications
- **Resource Creation**: `simpleDeployment` and `simpleService` factories
- **Cross-References**: Service selector references deployment labels
- **Status Mapping**: CEL expressions for dynamic status computation
- **Environment Configuration**: Conditional logic based on environment