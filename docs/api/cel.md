# CEL Expressions API

Explicit CEL expressions for advanced patterns that can't be expressed with JavaScript.

## When to Use

**Recommended**: Use natural JavaScript expressions (auto-converted to CEL):

```typescript
return {
  ready: deployment.status.readyReplicas > 0,
  url: `https://${service.status.clusterIP}`,
  phase: deployment.status.readyReplicas > 0 ? 'running' : 'pending'
};
```

**Use explicit CEL for**:
- Complex list operations (filter, map, size)
- Advanced CEL functions not available in JavaScript

## JavaScript vs Explicit CEL

| Pattern | JavaScript (Recommended) | Explicit CEL |
|---------|--------------------------|--------------|
| Boolean | `deploy.status.readyReplicas > 0` | `Cel.expr(deploy.status.readyReplicas, ' > 0')` |
| String | `` `https://${svc.status.clusterIP}` `` | `Cel.template('https://%s', svc.status.clusterIP)` |
| Conditional | `ready ? 'yes' : 'no'` | `Cel.conditional(ready, 'yes', 'no')` |
| List ops | ❌ Not supported | `Cel.expr('size(pods.filter(p, p.ready))')` |

## Core Functions

### `Cel.expr()`

Creates a CEL expression from parts.

```typescript
function expr<T>(...parts: RefOrValue<unknown>[]): CelExpression<T>
```

**Examples:**

```typescript
import { Cel } from 'typekro';

// Simple expression
const count = Cel.expr('size(deployments)');

// With resource references
const isReady = Cel.expr(deploy.status.readyReplicas, ' >= ', deploy.spec.replicas);

// Complex expression
const healthyPods = Cel.expr('size(pods.filter(p, p.status.phase == "Running"))');
```

### `Cel.template()`

Creates a string with interpolated values using `%s` placeholders.

```typescript
function template(template: string, ...values: RefOrValue[]): CelExpression<string>
```

**Examples:**

```typescript
// Basic template
const url = Cel.template('https://%s/api', service.status.clusterIP);

// Multiple placeholders
const endpoint = Cel.template(
  'https://%s:%s/api',
  service.status.clusterIP,
  service.spec.ports[0].port
);
```

### `Cel.conditional()`

Creates a ternary expression.

```typescript
function conditional<T>(
  condition: RefOrValue<boolean>,
  trueValue: RefOrValue<T>,
  falseValue: RefOrValue<T>
): CelExpression<T>
```

**Examples:**

```typescript
const phase = Cel.conditional(
  Cel.expr(deploy.status.readyReplicas, ' > 0'),
  'running',
  'pending'
);

const logLevel = Cel.conditional(
  Cel.expr(config.data.environment, ' == "production"'),
  'warn',
  'debug'
);
```

### `Cel.concat()`

Concatenates strings using the CEL `+` operator.

```typescript
function concat(...parts: RefOrValue[]): CelExpression<string>
```

**Examples:**

```typescript
const fullName = Cel.concat(deploy.metadata.name, '-service');
const url = Cel.concat('http://', service.status.clusterIP, ':8080');
```

### `Cel.math()`

Creates mathematical CEL expressions.

```typescript
function math<T>(operation: string, ...operands: RefOrValue[]): CelExpression<T>
```

**Examples:**

```typescript
const total = Cel.math('sum', deploy.status.readyReplicas, deploy.status.unavailableReplicas);
```

## Utility Functions

### `Cel.min()` / `Cel.max()`

```typescript
const minReplicas = Cel.min(deploy.spec.replicas, 10);
const maxReplicas = Cel.max(deploy.status.readyReplicas, 1);
```

### `Cel.size()`

```typescript
const containerCount = Cel.size(deploy.spec.template.spec.containers);
```

### `Cel.string()` / `Cel.int()` / `Cel.double()`

Type conversion functions:

```typescript
const portStr = Cel.string(service.spec.ports[0].port);
const replicaInt = Cel.int(config.data.replicas);
```

## Template Literal Tag

The `cel` template tag provides natural syntax:

```typescript
import { cel } from 'typekro';

const url = cel`https://${spec.hostname}/api`;
// Produces: "https://" + spec.hostname + "/api"
```

## Context-Aware API

For advanced serialization scenarios:

```typescript
const celWithContext = Cel.withContext({ celPrefix: 'resources' });

const expr = celWithContext.expr(deploy.status.readyReplicas, ' > 0');
```

## Type Safety

Always specify the expected return type:

```typescript
// Explicit type parameter
const isReady = Cel.expr<boolean>(deploy.status.readyReplicas, ' > 0');
const url = Cel.template<string>('https://%s', service.status.clusterIP);
```

## Common Patterns

### List Operations

```typescript
// Count items in a list
const containerCount = Cel.expr('size(deployment.spec.template.spec.containers)');

// Filter conditions
const readyCondition = Cel.expr('deployment.status.conditions.filter(c, c.type == "Available")[0].status');

// Check if any condition is true
const hasAvailable = Cel.expr('deployment.status.conditions.exists(c, c.type == "Available" && c.status == "True")');
```

### Null Safety

```typescript
// Check existence before access
const endpoint = Cel.expr(
  'has(service.status.loadBalancer.ingress) ? service.status.loadBalancer.ingress[0].ip : "pending"'
);
```

### Complex Conditions

```typescript
const status = Cel.expr(
  'deployment.status.readyReplicas == deployment.spec.replicas ? "healthy" : ',
  'deployment.status.readyReplicas > 0 ? "degraded" : "unhealthy"'
);
```

## Next Steps

- [JavaScript to CEL](/guide/javascript-to-cel) - Supported JavaScript patterns
- [kubernetesComposition](./kubernetes-composition.md) - Using CEL in compositions
- [Types](./types.md) - CelExpression type definition
