# CEL Expressions

Common Expression Language (CEL) expressions in TypeKro enable dynamic, runtime evaluation of complex logic. CEL expressions are particularly powerful for status fields, conditional configurations, and computed values.

## What is CEL?

CEL (Common Expression Language) is a non-Turing complete expression language designed for safe evaluation of expressions. In TypeKro, CEL expressions:

- Evaluate at runtime against live cluster state
- Provide type-safe expression building
- Enable complex conditional logic
- Work seamlessly with cross-resource references

## Basic CEL Usage

### Simple Expressions

```typescript
import { Cel } from 'typekro';

const statusMappings = {
  // Boolean expression
  ready: Cel.expr(deployment.status.readyReplicas, '> 0'),
  
  // Comparison
  allReady: Cel.expr(
    deployment.status.readyReplicas, 
    '== ', 
    deployment.spec.replicas
  ),
  
  // String concatenation
  phase: Cel.expr(
    deployment.status.readyReplicas, 
    '> 0 ? "running" : "pending"'
  )
};
```

### Template Expressions

For string interpolation with multiple values:

```typescript
const statusMappings = {
  // Simple template
  url: Cel.template('https://%s', service.status.loadBalancer.ingress[0].hostname),
  
  // Multiple placeholders
  connectionString: Cel.template(
    'postgresql://%s:%d/%s',
    database.status.podIP,
    dbService.spec.ports[0].port,
    'myapp'
  ),
  
  // Complex template
  healthUrl: Cel.template(
    'http://%s:%d/health?ready=%s',
    service.spec.clusterIP,
    service.spec.ports[0].port,
    deployment.status.readyReplicas > 0 ? 'true' : 'false'
  )
};
```

## CEL Expression Types

### Conditional Expressions

```typescript
// Simple conditional
const phase = Cel.expr(
  deployment.status.readyReplicas,
  '> 0 ? "running" : "pending"'
);

// Complex conditional with multiple conditions
const healthStatus = Cel.expr(
  `${deployment.status.readyReplicas} > 0 && ${service.status.loadBalancer.ingress.length} > 0`,
  '? "healthy" : "unhealthy"'
);

// Nested conditionals
const scalingStatus = Cel.expr(
  deployment.status.readyReplicas,
  '== 0 ? "stopped" : ',
  deployment.status.readyReplicas,
  '< ',
  deployment.spec.replicas,
  '? "scaling" : "ready"'
);
```

### Mathematical Operations

```typescript
// Arithmetic
const utilizationPercent = Cel.expr(
  deployment.status.readyReplicas,
  '* 100 / ',
  deployment.spec.replicas
);

// Comparisons
const overCapacity = Cel.expr(
  deployment.status.readyReplicas,
  '> ',
  deployment.spec.replicas
);

// Complex calculations
const resourceScore = Cel.expr(
  `(${deployment.status.readyReplicas} * 10) + (${service.spec.ports.length} * 5)`
);
```

### String Operations

```typescript
// String concatenation
const fullName = Cel.expr(
  `"${deployment.metadata.namespace}-" + ${deployment.metadata.name}`
);

// String methods
const upperName = Cel.expr(
  deployment.metadata.name,
  '.toUpperCase()'
);

// String contains
const hasLabel = Cel.expr(
  `"${deployment.metadata.labels.environment}".contains("prod")`
);
```

### List Operations

```typescript
// List length
const portCount = Cel.expr(service.spec.ports, '.size()');

// List filtering
const httpPorts = Cel.expr(
  service.spec.ports,
  '.filter(p, p.name.startsWith("http"))'
);

// List mapping
const portNumbers = Cel.expr(
  service.spec.ports,
  '.map(p, p.port)'
);

// List existence
const hasHttpPort = Cel.expr(
  service.spec.ports,
  '.exists(p, p.name == "http")'
);
```

## Advanced CEL Patterns

### Resource State Checking

```typescript
const statusMappings = {
  // Check if all pods are ready
  allPodsReady: Cel.expr(
    deployment.status.readyReplicas,
    '== ',
    deployment.spec.replicas,
    '&& ',
    deployment.status.readyReplicas,
    '> 0'
  ),
  
  // Check service availability
  serviceReady: Cel.expr(
    service.status.loadBalancer.ingress,
    '.size() > 0'
  ),
  
  // Complex readiness check
  systemReady: Cel.expr(
    `${deployment.status.readyReplicas} > 0 && `,
    `${database.status.readyReplicas} > 0 && `,
    `${service.status.loadBalancer.ingress.length} > 0`
  )
};
```

### Environment-Based Logic

```typescript
const statusMappings = {
  // Different logic per environment
  replicaTarget: Cel.expr(
    `"${schema.spec.environment}" == "production" ? 5 : 2`
  ),
  
  // Environment-specific URLs
  baseUrl: Cel.expr(
    `"${schema.spec.environment}" == "production" ? `,
    `"https://api.example.com" : "https://api-staging.example.com"`
  ),
  
  // Feature flags
  debugEnabled: Cel.expr(
    `"${schema.spec.environment}" != "production"`
  )
};
```

### Time-Based Expressions

```typescript
// Note: CEL has limited time functions, but you can use them
const statusMappings = {
  // Check if deployment is recent
  isRecent: Cel.expr(
    `now() - ${deployment.metadata.creationTimestamp} < duration("1h")`
  ),
  
  // Uptime calculation
  uptimeHours: Cel.expr(
    `(now() - ${deployment.metadata.creationTimestamp}) / duration("1h")`
  )
};
```

## CEL in Different Contexts

### Status Mappings

Most common use case - computing dynamic status:

```typescript
const graph = toResourceGraph(
  {
    name: 'webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  builder,
  // StatusBuilder function
  (schema, resources) => ({
    // CEL expressions for dynamic status
    phase: Cel.expr(
      deployment.status.readyReplicas,
      '> 0 ? "running" : "pending"'
    ),
    
    url: Cel.template(
      'https://%s',
      service.status.loadBalancer.ingress[0].hostname
    ),
    
    readyReplicas: deployment.status.readyReplicas,
    
    healthScore: Cel.expr(
      `(${deployment.status.readyReplicas} * 100) / ${deployment.spec.replicas}`
    )
  }
});
```

### Environment Variables

Use CEL for dynamic environment configuration:

```typescript
const app = Deployment({
  name: 'web-app',
  env: {
    // Static values
    NODE_ENV: 'production',
    
    // CEL expressions for dynamic values
    DATABASE_URL: Cel.template(
      'postgresql://user:pass@%s:5432/app',
      database.status.podIP
    ),
    
    REPLICA_COUNT: Cel.expr(deployment.spec.replicas),
    
    IS_LEADER: Cel.expr(
      `${deployment.metadata.name} == "${deployment.spec.template.metadata.labels.app}-0"`
    )
  }
});
```

### Conditional Resource Creation

```typescript
const resources = {
  app: Deployment({ /* ... */ }),
  
  // Conditional ingress based on CEL
  ...(Cel.expr(`"${schema.spec.environment}" == "production"`) && {
    ingress: Ingress({ /* ... */ })
  })
};
```

## Type Safety with CEL

### Typed CEL Expressions

CEL expressions maintain type safety:

```typescript
// ✅ Type-safe boolean expression
const ready: CelExpression<boolean> = Cel.expr(
  deployment.status.readyReplicas, 
  '> 0'
);

// ✅ Type-safe string template
const url: CelExpression<string> = Cel.template(
  'https://%s', 
  service.status.loadBalancer.ingress[0].hostname
);

// ✅ Type-safe number expression
const count: CelExpression<number> = Cel.expr(
  deployment.status.readyReplicas
);
```

### Generic CEL Functions

Create reusable CEL expression builders:

```typescript
function isReady<T extends { status: { readyReplicas: number } }>(
  resource: T
): CelExpression<boolean> {
  return Cel.expr(resource.status.readyReplicas, '> 0');
}

function getUrl<T extends { status: { loadBalancer: { ingress: Array<{ hostname: string }> } } }>(
  service: T,
  protocol: string = 'https'
): CelExpression<string> {
  return Cel.template(`${protocol}://%s`, service.status.loadBalancer.ingress[0].hostname);
}

// Usage
const deploymentReady = isReady(deployment);
const serviceUrl = getUrl(webService);
```

## CEL Best Practices

### 1. Keep Expressions Simple

```typescript
// ✅ Simple and readable
const ready = Cel.expr(deployment.status.readyReplicas, '> 0');

// ❌ Too complex
const complexStatus = Cel.expr(
  `${deployment.status.readyReplicas} > 0 && ${service.status.loadBalancer.ingress.length} > 0 && ${database.status.phase} == "Running" && ${configMap.metadata.name}.length() > 0`
);
```

### 2. Use Templates for String Building

```typescript
// ✅ Clean template
const url = Cel.template('https://%s:%d/api', host, port);

// ❌ Complex concatenation
const url = Cel.expr(`"https://" + ${host} + ":" + ${port} + "/api"`);
```

### 3. Provide Meaningful Names

```typescript
// ✅ Descriptive
const allPodsReady = Cel.expr(deployment.status.readyReplicas, '== ', deployment.spec.replicas);
const databaseConnected = Cel.expr(database.status.readyReplicas, '> 0');

// ❌ Generic
const expr1 = Cel.expr(deployment.status.readyReplicas, '== ', deployment.spec.replicas);
const expr2 = Cel.expr(database.status.readyReplicas, '> 0');
```

### 4. Handle Edge Cases

```typescript
// ✅ Safe with null checks
const safeUrl = Cel.expr(
  service.status.loadBalancer.ingress,
  '.size() > 0 ? ',
  service.status.loadBalancer.ingress[0].hostname,
  ': "pending"'
);

// ❌ Unsafe - could fail if ingress is empty
const unsafeUrl = Cel.template('https://%s', service.status.loadBalancer.ingress[0].hostname);
```

## Debugging CEL Expressions

### Expression Validation

```typescript
try {
  const expr = Cel.expr(deployment.status.readyReplicas, '> 0');
  // Expression is valid
} catch (error) {
  if (error instanceof CelExpressionError) {
    console.error('Invalid CEL expression:', error.expression);
  }
}
```

### Testing CEL Logic

```typescript
// Test CEL expressions in isolation
const testExpression = Cel.expr('5 > 3');  // Should be true
const testTemplate = Cel.template('Hello %s', 'World');  // Should be "Hello World"
```

## Common CEL Functions

### String Functions
- `contains(substring)` - Check if string contains substring
- `startsWith(prefix)` - Check if string starts with prefix
- `endsWith(suffix)` - Check if string ends with suffix
- `size()` - Get string length

### List Functions
- `size()` - Get list length
- `filter(var, condition)` - Filter list elements
- `map(var, expression)` - Transform list elements
- `exists(var, condition)` - Check if any element matches
- `all(var, condition)` - Check if all elements match

### Math Functions
- `+`, `-`, `*`, `/` - Basic arithmetic
- `%` - Modulo
- `abs()` - Absolute value
- `max()`, `min()` - Maximum/minimum values

### Comparison Operators
- `==`, `!=` - Equality
- `<`, `<=`, `>`, `>=` - Comparison
- `&&`, `||` - Logical operators
- `!` - Negation

## Next Steps

- **[Status Hydration](./status-hydration.md)** - Understand how CEL expressions are evaluated
- **[Examples](../examples/)** - See CEL expressions in real applications
- **[API Reference](../api/cel.md)** - Complete CEL API documentation