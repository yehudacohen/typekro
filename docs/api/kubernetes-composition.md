# kubernetesComposition API

The `kubernetesComposition` function is TypeKro's primary API for creating typed resource graphs using an imperative composition pattern.

## Overview

The `kubernetesComposition` API provides a structured way to create TypeKro resource graphs using two separate functions: a resource builder that creates named resources, and a status builder that computes status from the created resources. This pattern provides clear separation between resource creation and status computation while maintaining full type safety.

## Syntax

```typescript
function kubernetesComposition<TSpec, TStatus>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  compositionFunction: (spec: TSpec) => TStatus
): ResourceGraph<TSpec, TStatus>
```

### Parameters

- **`definition`**: Resource graph definition containing metadata and schema
- **`compositionFunction`**: Function that receives the spec and creates resources (auto-registered) and returns status

### Returns

A `ResourceGraph` instance that can be deployed or converted to YAML.

## Basic Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

const webApp = kubernetesComposition(
  {
    name: 'simple-webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: type({ name: 'string', image: 'string', replicas: 'number' }),
    status: type({ ready: 'boolean', url: 'string' })
  },
  // Single composition function: creates resources (auto-registered) and returns status
  (spec) => {
    // Resources are automatically registered when created
    const deployment = Deployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
      ports: [{ containerPort: 80 }]
    });
    
    const service = Service({
      name: `${spec.name}-service`,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 80 }]
    });

    // ✨ Return status using natural JavaScript expressions - automatically converted to CEL
    return {
      ready: deployment.status.readyReplicas > 0,
      url: `http://${service.status.clusterIP}`
    };
  }
);
```

## Deployment

```typescript
// Direct deployment
const factory = webApp.factory('direct', { namespace: 'default' });
await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest', 
  replicas: 2
});

// Generate YAML
const yaml = webApp.toYaml({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 2
});
```

## Key Benefits

- **Clear separation**: Resource creation and status computation are separate functions
- **Named resources**: Resources are organized in a named object structure  
- **Type-safe references**: Resources can reference each other with full type safety
- **Full TypeScript support**: Complete validation and IDE support
- **CEL integration**: Use CEL expressions for dynamic values and templates

## Comparison with toResourceGraph

| Aspect | kubernetesComposition | toResourceGraph |
|--------|----------------------|------------------|
| **Function signature** | Separate resource & status builders | Combined in schema object |
| **Resource creation** | Named object return | Named object return |
| **Status definition** | Separate status builder | Separate status builder |
| **Pattern** | Explicit two-function pattern | Unified schema-based pattern |
| **Use case** | Alternative API surface | Primary recommended API |

Both APIs generate identical output and support the same features - they are equivalent in functionality with different API ergonomics.

## See Also

- [Imperative Composition Guide](../guide/imperative-composition.md) - Complete guide with examples
- [toResourceGraph API](./to-resource-graph.md) - Alternative declarative API
- [Factory Functions](./factories.md) - Available resource factories