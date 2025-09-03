# Basic WebApp Pattern

The most common TypeKro pattern - a web application with deployment and service using the **imperative composition pattern**.

## Complete Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

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
  // Imperative composition: resources auto-register when created
  (spec) => {
    // Create resources - they auto-register!
    const deployment = Deployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
      ports: [{ containerPort: 3000 }],
      env: {
        NODE_ENV: spec.environment
      }
    });
    
    const service = Service({
      name: `${spec.name}-service`,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'ClusterIP'
    });

    // ✨ Return status using natural JavaScript expressions
    return {
      ready: deployment.status.readyReplicas >= spec.replicas,
      url: `http://${service.status.clusterIP}`,
      replicas: deployment.status.readyReplicas
    };
  }
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

- **Imperative Composition**: Resources auto-register when created within the composition function
- **Schema Definition**: Using ArkType for type-safe specifications  
- **Resource Creation**: `Deployment` and `Service` factories from `typekro/simple`
- **JavaScript Expressions**: Natural JavaScript syntax automatically converted to CEL
- **Resource References**: Type-safe access to resource status fields
- **Environment Configuration**: Schema-driven configuration patterns
- **Auto-Registration**: No need for explicit resource builders - resources register automatically