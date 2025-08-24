# Basic WebApp Pattern

The most common TypeKro pattern - a web application with deployment and service.

## Complete Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition, simpleDeployment, simpleService, Cel } from 'typekro';

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

// Create the resource graph with imperative composition
export const webapp = kubernetesComposition(
  {
    name: 'basic-webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  (spec) => {
    // Resources auto-register when created - no explicit builders needed!
    const deployment = simpleDeployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
      ports: [{ containerPort: 3000 }],
      env: {
        NODE_ENV: spec.environment
      }
    });
    
    const service = simpleService({
      name: Cel.template('%s-service', spec.name),
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'ClusterIP'
    });

    // Return status with CEL expressions and resource references
    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' >= ', spec.replicas),
      url: Cel.template('http://%s', service.status.clusterIP),
      replicas: deployment.status.readyReplicas
    };
  }
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

### KRO Deployment
```typescript
const kroFactory = await webapp.factory('kro', { namespace: 'production' });
await kroFactory.deploy({
  name: 'prod-app',
  image: 'nginx:1.24',
  replicas: 5,
  environment: 'production'
});
```

## Key Concepts Demonstrated

- **Imperative Composition**: Natural JavaScript flow with auto-registration
- **Schema Definition**: Using ArkType for type-safe specifications
- **Resource Creation**: `simpleDeployment` and `simpleService` factories
- **CEL Templates**: Using `Cel.template()` for dynamic string construction
- **CEL Expressions**: Using `Cel.expr()` for dynamic boolean logic
- **Resource References**: Direct access to resource status fields
- **Environment Configuration**: Conditional logic based on environment