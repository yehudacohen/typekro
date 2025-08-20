# CEL Expressions API

The Common Expression Language (CEL) module provides a type-safe way to create dynamic expressions for status computation, resource references, and conditional logic in TypeKro resource graphs.

## Overview

CEL expressions in TypeKro allow you to:
- Reference values from other resources dynamically
- Perform complex computations in status builders
- Create conditional logic for resource configuration
- Build string templates with interpolated values

## Core Functions

### `Cel.expr()`

Creates a CEL expression that evaluates to a computed value.

```typescript
function expr<T = unknown>(...parts: RefOrValue<unknown>[]): CelExpression<T> & T
function expr<T = unknown>(
  context: SerializationContext,
  ...parts: RefOrValue<unknown>[]
): CelExpression<T> & T
```

#### Parameters

- **`parts`**: Variable number of expression parts that can be:
  - `string` - Literal CEL expression text
  - `KubernetesRef` - References to other resources
  - `CelExpression` - Nested CEL expressions
  - `number | boolean` - Primitive values
- **`context`** (optional): Serialization context for advanced use cases

#### Returns

A `CelExpression<T>` that evaluates to type `T` at runtime.

#### Examples

```typescript
import { Cel, deployment, service } from 'typekro';

// Simple expression
const replicas = Cel.expr('size(deployments)');

// Expression with resource references
const url = Cel.expr(
  'http://',
  myService.spec.clusterIP,
  ':',
  myService.spec.ports[0].port
);

// Complex computation
const readyReplicas = Cel.expr(
  myDeployment.status.readyReplicas,
  ' >= ',
  myDeployment.spec.replicas
);
```

### `Cel.template()`

Creates a CEL string template with interpolated expressions.

```typescript
function template(template: string, values?: Record<string, RefOrValue<unknown>>): CelExpression<string>
```

#### Parameters

- **`template`**: Template string with `%{variable}` placeholders
- **`values`** (optional): Object mapping variable names to values

#### Returns

A `CelExpression<string>` that evaluates to a formatted string.

#### Examples

```typescript
// Basic template
const message = Cel.template(
  'Deployment %{name} has %{replicas} replicas',
  {
    name: myDeployment.metadata.name,
    replicas: myDeployment.status.readyReplicas
  }
);

// Template with resource references
const endpoint = Cel.template(
  'https://%{host}:%{port}/api',
  {
    host: myService.spec.clusterIP,
    port: myService.spec.ports[0].port
  }
);
```

### `Cel.map()`

Creates a CEL expression that transforms a list using a mapping function.

```typescript
function map<T, R>(
  list: RefOrValue<T[]>,
  mapExpr: string
): CelExpression<R[]>
```

#### Parameters

- **`list`**: Source list to transform
- **`mapExpr`**: CEL expression for the transformation (use `item` variable)

#### Returns

A `CelExpression<R[]>` containing the transformed list.

#### Examples

```typescript
// Transform pod names to URLs
const podUrls = Cel.map(
  myDeployment.status.podNames,
  'item + ".default.svc.cluster.local"'
);

// Extract port numbers
const ports = Cel.map(
  myService.spec.ports,
  'item.port'
);
```

### `Cel.filter()`

Creates a CEL expression that filters a list based on a condition.

```typescript
function filter<T>(
  list: RefOrValue<T[]>,
  condition: string
): CelExpression<T[]>
```

#### Parameters

- **`list`**: Source list to filter
- **`condition`**: CEL boolean expression for filtering (use `item` variable)

#### Returns

A `CelExpression<T[]>` containing filtered items.

#### Examples

```typescript
// Filter ready pods
const readyPods = Cel.filter(
  myDeployment.status.pods,
  'item.status.phase == "Running"'
);

// Filter exposed ports
const exposedPorts = Cel.filter(
  myService.spec.ports,
  'item.nodePort != null'
);
```

### `Cel.conditional()`

Creates a conditional CEL expression.

```typescript
function conditional<T>(
  condition: RefOrValue<boolean>,
  trueValue: RefOrValue<T>,
  falseValue: RefOrValue<T>
): CelExpression<T>
```

#### Parameters

- **`condition`**: Boolean expression or reference
- **`trueValue`**: Value when condition is true
- **`falseValue`**: Value when condition is false

#### Returns

A `CelExpression<T>` that evaluates to one of the provided values.

#### Examples

```typescript
// Conditional scaling
const targetReplicas = Cel.conditional(
  Cel.expr(myDeployment.status.readyReplicas, ' < ', myDeployment.spec.replicas),
  myDeployment.spec.replicas,
  1
);

// Environment-based configuration
const logLevel = Cel.conditional(
  myConfigMap.data.environment === 'production',
  'warn',
  'debug'
);
```

## Type Definitions

### `CelExpression<T>`

Core interface for CEL expressions with type safety.

```typescript
interface CelExpression<T = unknown> {
  readonly [CEL_EXPRESSION_BRAND]: true;
  readonly expression: string;
  readonly expectedType: string;
}
```

### `RefOrValue<T>`

Union type for values that can be either direct values or references.

```typescript
type RefOrValue<T> = T | KubernetesRef<T> | CelExpression<T>
```

### `SerializationContext`

Context object for advanced CEL serialization scenarios.

```typescript
interface SerializationContext {
  celPrefix: string;
  resourceId?: string;
  resourceType?: string;
}
```

## Advanced Patterns

### Resource Status Computation

Use CEL expressions in status builders to compute dynamic status values:

```typescript
const myApp = createResourceGraph('my-app', (schema) => {
  const deploy = deployment({
    metadata: { name: 'web-server' },
    spec: {
      replicas: 3,
      selector: { matchLabels: { app: 'web' } },
      template: {
        metadata: { labels: { app: 'web' } },
        spec: {
          containers: [{
            name: 'web',
            image: 'nginx:1.21'
          }]
        }
      }
    }
  });

  return {
    deployment: deploy,
    status: {
      // CEL expression for computed status
      healthStatus: Cel.conditional(
        Cel.expr(deploy.status.readyReplicas, ' >= ', deploy.spec.replicas),
        'healthy',
        'degraded'
      ),
      
      // Template with multiple references
      summary: Cel.template(
        'Deployment %{name}: %{ready}/%{desired} replicas ready',
        {
          name: deploy.metadata.name,
          ready: deploy.status.readyReplicas,
          desired: deploy.spec.replicas
        }
      )
    }
  };
});
```

### Cross-Resource References

Reference values from other resources in your expressions:

```typescript
const webApp = createResourceGraph('web-app', (schema) => {
  const configMap = configMap({
    metadata: { name: 'app-config' },
    data: {
      maxConnections: '100',
      timeout: '30s'
    }
  });

  const deploy = deployment({
    metadata: { name: 'web-server' },
    spec: {
      template: {
        spec: {
          containers: [{
            name: 'web',
            image: 'nginx:1.21',
            env: [
              {
                name: 'MAX_CONNECTIONS',
                // Reference value from ConfigMap
                value: configMap.data.maxConnections
              },
              {
                name: 'CONNECTION_URL',
                // Computed value using CEL
                value: Cel.template(
                  'redis://redis-service:6379/0?timeout=%{timeout}',
                  { timeout: configMap.data.timeout }
                )
              }
            ]
          }]
        }
      }
    }
  });

  return { configMap, deployment: deploy };
});
```

### List Operations

Work with arrays and collections using CEL list functions:

```typescript
const microservices = createResourceGraph('microservices', (schema) => {
  const services = ['auth', 'api', 'worker'].map(name => 
    service({
      metadata: { name: Cel.expr(name, "-service") },
      spec: {
        selector: { app: name },
        ports: [{ port: 8080, targetPort: 8080 }]
      }
    })
  );

  return {
    services,
    status: {
      // Count ready services
      readyServices: Cel.expr('size(services)'),
      
      // List service endpoints
      endpoints: Cel.map(
        services,
        'item.spec.clusterIP + ":" + string(item.spec.ports[0].port)'
      ),
      
      // Find services with external access
      externalServices: Cel.filter(
        services,
        'item.spec.type == "LoadBalancer"'
      )
    }
  };
});
```

## Best Practices

### 1. Use Appropriate CEL Functions

- **`Cel.expr()`** for general computations and boolean logic
- **`Cel.template()`** for string interpolation and formatting
- **`Cel.map()`** and **`Cel.filter()`** for list operations
- **`Cel.conditional()`** for if-then-else logic

### 2. Type Safety

Always specify the expected return type for better IDE support:

```typescript
// Good: Explicit type annotation
const isHealthy: CelExpression<boolean> = Cel.expr(
  myDeployment.status.readyReplicas, ' >= ', myDeployment.spec.replicas
);

// Better: Type parameter
const isHealthy = Cel.expr<boolean>(
  myDeployment.status.readyReplicas, ' >= ', myDeployment.spec.replicas
);
```

### 3. Resource Reference Patterns

Use consistent patterns for referencing resources:

```typescript
// Direct property access
const serviceName = myService.metadata.name;

// Nested property access
const firstPortNumber = myService.spec.ports[0].port;

// Status field access (common in status builders)
const readyReplicas = myDeployment.status.readyReplicas;
```

### 4. Error Handling

CEL expressions should handle potential null values:

```typescript
// Safe access with defaults
const replicas = Cel.expr(
  'has(deployment.status.readyReplicas) ? deployment.status.readyReplicas : 0'
);

// Conditional with existence check
const endpoint = Cel.conditional(
  Cel.expr('has(service.status.loadBalancer.ingress)'),
  Cel.template('http://%{ip}', { 
    ip: myService.status.loadBalancer.ingress[0].ip 
  }),
  'pending'
);
```

## Related APIs

- [Status Hydration Guide](/guide/status-hydration) - Using CEL in status builders
- [Resource Graphs Guide](/guide/resource-graphs) - Resource reference patterns  
- [Factory Functions API](/api/factories) - Creating resources with CEL expressions
- [Types API](/api/types) - Type definitions for CEL expressions