# JavaScript to CEL Conversion

TypeKro automatically converts JavaScript expressions to CEL when they contain resource or schema references. Write natural JavaScript syntax - TypeKro handles the CEL generation.

## How It Works

When you access `spec.name` or `dbService.status.clusterIP`, TypeKro detects these references and converts the entire expression to CEL:

```typescript
// Write JavaScript
deployment.status.readyReplicas > 0

// TypeKro generates CEL
${deployment.status.readyReplicas > 0}

// Template literals work too
`https://${service.status.loadBalancer.ingress[0].ip}`
```

## Supported JavaScript Patterns

### Basic Expressions

```typescript
// Comparison operators
ready: deployment.status.readyReplicas > 0,
allReady: deployment.status.readyReplicas === spec.replicas,

// Logical operators
systemReady: deployment.status.ready && database.status.ready,
hasIssues: !deployment.status.ready || deployment.status.replicas === 0,

// Arithmetic operations
utilizationPercent: (deployment.status.readyReplicas / spec.replicas) * 100,
totalPods: deployment.status.readyReplicas + worker.status.readyReplicas,
```

### Template Literals

```typescript
// Simple string interpolation
url: `https://${service.status.loadBalancer.ingress[0].ip}`,
connectionString: `postgres://user:pass@${dbService.status.clusterIP}:5432/mydb`,

// Complex templates
healthUrl: `http://${service.spec.clusterIP}:${service.spec.ports[0].port}/health?ready=${deployment.status.readyReplicas > 0}`,
```

### Optional Chaining

TypeKro converts JavaScript optional chaining to Kro's conditional CEL expressions:

```typescript
// JavaScript optional chaining
url: service.status?.loadBalancer?.ingress?.[0]?.ip,
port: service.spec?.ports?.[0]?.port,

// Converts to Kro CEL with ? operator
// ${service.status.?loadBalancer.?ingress[0].?ip}
// ${service.spec.?ports[0].?port}
```

### Conditional Expressions

```typescript
// Ternary operators
phase: deployment.status.readyReplicas > 0 ? 'running' : 'pending',
logLevel: spec.environment === 'production' ? 'warn' : 'debug',

// Complex conditionals
status: deployment.status.readyReplicas === 0 
  ? 'stopped' 
  : deployment.status.readyReplicas < spec.replicas 
    ? 'scaling' 
    : 'ready',
```

### Logical Fallbacks

```typescript
// Logical OR fallbacks
host: service.status?.loadBalancer?.ingress?.[0]?.ip || 'pending',
replicas: deployment.status?.readyReplicas || 0,

// Nullish coalescing
timeout: spec.timeout ?? 30,
maxConnections: configMap.data?.maxConnections ?? '100',
```

### Array and Object Operations

```typescript
// Array access
firstPort: service.spec.ports[0].port,
lastIngress: ingress.status.loadBalancer.ingress[ingress.status.loadBalancer.ingress.length - 1],

// Object property access
serviceName: service.metadata.name,
namespace: deployment.metadata.namespace,
```

## Deployment Strategies

JavaScript expressions work with both deployment strategies:

- **Direct factory**: Expressions evaluated at deployment time
- **Kro factory**: Expressions converted to CEL for runtime evaluation

```typescript
// Same composition works with both
const directFactory = webapp.factory('direct', { namespace: 'dev' });
const kroFactory = webapp.factory('kro', { namespace: 'prod' });
```

## Complete Example

Here's a comprehensive example showing JavaScript expressions in action:

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: '"development" | "staging" | "production"'
});

const WebAppStatus = type({
  ready: 'boolean',
  url: 'string',
  phase: 'string',
  environment: 'string'
});

const webapp = kubernetesComposition(
  {
    name: 'fullstack-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'FullStackApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  (spec) => {
    const deploy = Deployment({
      id: 'webapp',
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
      ports: [{ containerPort: 3000 }],
      env: { NODE_ENV: spec.environment }
    });

    const svc = Service({
      id: 'svc',
      name: `${spec.name}-service`,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    });

    // All JavaScript expressions automatically convert to CEL
    return {
      ready: deploy.status.readyReplicas > 0,
      url: svc.status.loadBalancer?.ingress?.[0]?.ip 
        ? `https://${svc.status.loadBalancer.ingress[0].ip}`
        : 'pending',
      phase: deploy.status.readyReplicas === 0 
        ? 'stopped'
        : deploy.status.readyReplicas < spec.replicas
          ? 'scaling'
          : 'ready',
      environment: spec.environment
    };
  }
);

// Works with both deployment strategies
const factory = webapp.factory('direct', { namespace: 'prod' });
await factory.deploy({ 
  name: 'my-app', 
  image: 'nginx', 
  replicas: 3, 
  environment: 'production' 
});
```

## Performance & Type Safety

- **Performance**: Only expressions with resource references are converted
- **Type Safety**: Full TypeScript support with autocomplete and error checking

```typescript
// Static values - no conversion needed
environment: 'production',

// Dynamic values - converted to CEL
ready: deployment.status.readyReplicas > 0,
```

## Limitations

While TypeKro supports most common JavaScript patterns, some are not supported:

### Conversion Support Matrix

| Pattern | Supported | Example |
|---------|-----------|---------|
| Comparisons (`>`, `<`, `===`, `!==`) | ✅ | `x > 0`, `x === 'ready'` |
| Logical operators (`&&`, `\|\|`, `!`) | ✅ | `a && b`, `x \|\| 'default'` |
| Arithmetic (`+`, `-`, `*`, `/`) | ✅ | `(a / b) * 100` |
| Template literals | ✅ | `` `https://${host}` `` |
| Ternary conditionals | ✅ | `x > 0 ? 'yes' : 'no'` |
| Optional chaining | ✅ | `obj?.prop?.nested` |
| Array index access | ✅ | `arr[0]`, `arr[arr.length - 1]` |
| Property access | ✅ | `obj.prop.nested` |
| `Array.find()` | ❌ | Use `Cel.expr()` |
| `Array.filter()` | ❌ | Use `Cel.expr()` |
| `Array.map()` | ❌ | Use `Cel.expr()` |
| `Array.length` | ❌ | Use `Cel.size()` |
| Destructuring | ❌ | N/A |
| Variable assignments | ❌ | N/A |
| Loops | ❌ | N/A |
| Function calls | ❌ | N/A |

### Unsupported Patterns

```typescript
// ❌ Complex function calls
status: deployment.status.conditions.find(c => c.type === 'Available').status,

// ❌ Destructuring
const { readyReplicas } = deployment.status,

// ❌ Loops and iteration
for (const condition of deployment.status.conditions) { ... }

// ❌ Variable assignments
let ready = deployment.status.readyReplicas > 0;
```

### Workarounds

For unsupported patterns, use the explicit CEL escape hatch:

```typescript
import { Cel } from 'typekro';

// Use explicit CEL for list operations
availableStatus: Cel.expr(
  'deployment.status.conditions.filter(c, c.type == "Available")[0].status'
),

// Use CEL size() for counting
readyPodCount: Cel.expr('size(pods.filter(p, p.status.phase == "Running"))'),

// Use CEL for array length
containerCount: Cel.size(deployment.spec.template.spec.containers),
```

## Migration from Manual CEL

Replace manual CEL expressions with JavaScript:

```typescript
// Before
ready: Cel.expr(deployment.status.readyReplicas, ' > 0'),
url: Cel.template('https://%s', service.status.clusterIP),

// After  
ready: deployment.status.readyReplicas > 0,
url: `https://${service.status.clusterIP}`,
```

## Next Steps

- [CEL API Reference](/api/cel) - Explicit CEL for advanced cases
- [Magic Proxy](./magic-proxy.md) - How the reference system works