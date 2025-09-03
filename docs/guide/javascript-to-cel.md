# JavaScript to CEL Conversion

TypeKro automatically converts JavaScript expressions to CEL when they contain resource or schema references. Write natural JavaScript syntax - TypeKro handles the CEL generation.

## How It Works

When you access `schema.spec.name` or `resources.database.status.podIP`, TypeKro detects these references and converts the entire expression to CEL:

```typescript
// Write JavaScript
resources.deployment.status.readyReplicas > 0

// TypeKro generates CEL
${resources.deployment.status.readyReplicas > 0}

// Template literals work too
`https://${resources.service.status.loadBalancer.ingress[0].ip}`
```

## Supported JavaScript Patterns

### Basic Expressions

```typescript
// Comparison operators
ready: resources.deployment.status.readyReplicas > 0,
allReady: resources.deployment.status.readyReplicas === schema.spec.replicas,

// Logical operators
systemReady: resources.deployment.status.ready && resources.database.status.ready,
hasIssues: !resources.deployment.status.ready || resources.deployment.status.replicas === 0,

// Arithmetic operations
utilizationPercent: (resources.deployment.status.readyReplicas / schema.spec.replicas) * 100,
totalPods: resources.deployment.status.readyReplicas + resources.worker.status.readyReplicas,
```

### Template Literals

```typescript
// Simple string interpolation
url: `https://${resources.service.status.loadBalancer.ingress[0].ip}`,
connectionString: `postgres://user:pass@${resources.database.status.podIP}:5432/mydb`,

// Complex templates
healthUrl: `http://${resources.service.spec.clusterIP}:${resources.service.spec.ports[0].port}/health?ready=${resources.deployment.status.readyReplicas > 0}`,
```

### Optional Chaining

TypeKro converts JavaScript optional chaining to Kro's conditional CEL expressions:

```typescript
// JavaScript optional chaining
url: resources.service.status?.loadBalancer?.ingress?.[0]?.ip,
port: resources.service.spec?.ports?.[0]?.port,

// Converts to Kro CEL with ? operator
// ${resources.service.status.?loadBalancer.?ingress[0].?ip}
// ${resources.service.spec.?ports[0].?port}
```

### Conditional Expressions

```typescript
// Ternary operators
phase: resources.deployment.status.readyReplicas > 0 ? 'running' : 'pending',
logLevel: schema.spec.environment === 'production' ? 'warn' : 'debug',

// Complex conditionals
status: resources.deployment.status.readyReplicas === 0 
  ? 'stopped' 
  : resources.deployment.status.readyReplicas < schema.spec.replicas 
    ? 'scaling' 
    : 'ready',
```

### Logical Fallbacks

```typescript
// Logical OR fallbacks
host: resources.service.status?.loadBalancer?.ingress?.[0]?.ip || 'pending',
replicas: resources.deployment.status?.readyReplicas || 0,

// Nullish coalescing
timeout: schema.spec.timeout ?? 30,
maxConnections: resources.configMap.data?.maxConnections ?? '100',
```

### Array and Object Operations

```typescript
// Array access
firstPort: resources.service.spec.ports[0].port,
lastIngress: resources.ingress.status.loadBalancer.ingress[resources.ingress.status.loadBalancer.ingress.length - 1],

// Object property access
serviceName: resources.service.metadata.name,
namespace: resources.deployment.metadata.namespace,
```

## Factory Pattern Integration

JavaScript expressions work with both deployment strategies:

- **Direct factory**: Expressions evaluated at deployment time with resolved values
- **Kro factory**: Expressions converted to CEL for runtime evaluation

```typescript
// Same code works with both patterns
const directFactory = await graph.factory('direct', { namespace: 'prod' });
const kroFactory = await graph.factory('kro', { namespace: 'prod' });
```

## Complete Example

Here's a comprehensive example showing JavaScript expressions in action:

```typescript
import { type } from 'arktype';
import { toResourceGraph } from 'typekro';
import * as simple from 'typekro/simple';

const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: '"development" | "staging" | "production"',
  database: {
    enabled: 'boolean',
    storage: 'string'
  }
});

const WebAppStatus = type({
  ready: 'boolean',
  url: 'string',
  phase: 'string',
  components: {
    webapp: 'boolean',
    database: 'boolean',
    service: 'boolean'
  },
  environment: 'string',
  health: {
    database: 'boolean',
    endpoint: 'string'
  }
});

const graph = toResourceGraph(
  {
    name: 'fullstack-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'FullStackApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  // Resource builder with JavaScript expressions
  (schema) => {
    const resources: any = {};

    // Main application deployment
    resources.webapp = simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [{ containerPort: 3000 }],
      env: {
        NODE_ENV: schema.spec.environment,
        // JavaScript template literal - automatically converted to CEL
        DATABASE_URL: schema.spec.database.enabled 
          ? `postgres://user:pass@${resources.database?.status.podIP}:5432/mydb`
          : 'sqlite:///tmp/app.db'
      }
    });

    // Service for the webapp
    resources.webappService = simple.Service({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    });

    // Conditional database - only if enabled
    if (schema.spec.database.enabled) {
      resources.database = simple.Deployment({
        name: `${schema.spec.name}-db`,
        image: 'postgres:13',
        env: {
          POSTGRES_DB: 'mydb',
          POSTGRES_USER: 'user',
          POSTGRES_PASSWORD: 'pass'
        },
        volumes: [{
          name: 'data',
          persistentVolumeClaim: { claimName: `${schema.spec.name}-db-pvc` }
        }]
      });

      resources.databaseService = simple.Service({
        name: `${schema.spec.name}-db-service`,
        selector: { app: `${schema.spec.name}-db` },
        ports: [{ port: 5432, targetPort: 5432 }]
      });
    }

    return resources;
  },
  // Status builder with JavaScript expressions - all automatically converted to CEL
  (schema, resources) => ({
    // Simple boolean expression
    ready: resources.webapp.status.readyReplicas > 0 && 
           (!schema.spec.database.enabled || resources.database?.status.readyReplicas > 0),

    // Template literal with conditional logic
    url: resources.webappService.status?.loadBalancer?.ingress?.[0]?.ip
      ? `https://${resources.webappService.status.loadBalancer.ingress[0].ip}`
      : 'pending',

    // Conditional expression
    phase: resources.webapp.status.readyReplicas === 0 
      ? 'stopped'
      : resources.webapp.status.readyReplicas < schema.spec.replicas
        ? 'scaling'
        : 'ready',

    // Object with nested JavaScript expressions
    components: {
      webapp: resources.webapp.status.readyReplicas > 0,
      database: schema.spec.database.enabled 
        ? resources.database?.status.readyReplicas > 0 
        : true,
      service: resources.webappService.status?.ready === true
    },

    // Direct schema reference
    environment: schema.spec.environment,

    // Complex nested object
    health: {
      // Logical AND with optional chaining
      database: schema.spec.database.enabled 
        ? resources.database?.status.conditions?.find(c => c.type === 'Available')?.status === 'True'
        : true,
      
      // Template with fallback
      endpoint: resources.webappService.status?.loadBalancer?.ingress?.[0]?.ip
        ? `https://${resources.webappService.status.loadBalancer.ingress[0].ip}/health`
        : 'http://localhost:3000/health'
    }
  })
);

// Usage - same JavaScript expressions work with both patterns
const directFactory = await graph.factory('direct', { namespace: 'dev' });
const kroFactory = await graph.factory('kro', { namespace: 'prod' });
```

## Performance & Type Safety

- **Performance**: Only expressions with resource references are converted
- **Type Safety**: Full TypeScript support with autocomplete and error checking

```typescript
// Static values - no conversion needed
environment: 'production',

// Dynamic values - converted to CEL
ready: resources.deployment.status.readyReplicas > 0,
```

## Limitations

While TypeKro supports most common JavaScript patterns, there are some limitations:

### Unsupported Patterns

```typescript
// ❌ Complex function calls
status: resources.deployment.status.conditions.find(c => c.type === 'Available').status,

// ❌ Destructuring
const { readyReplicas } = resources.deployment.status,

// ❌ Loops and iteration
for (const condition of resources.deployment.status.conditions) { ... }

// ❌ Variable assignments
let ready = resources.deployment.status.readyReplicas > 0;
```

### Workarounds

For unsupported patterns, you can use the explicit CEL escape hatch:

```typescript
import { Cel } from 'typekro';

// Use explicit CEL for complex operations
status: Cel.expr(
  resources.deployment.status.conditions,
  '.filter(c, c.type == "Available")[0].status'
),

// Use CEL functions for list operations
readyPods: Cel.filter(
  resources.deployment.status.pods,
  'item.status.phase == "Running"'
),
```

## Migration from Manual CEL

Replace manual CEL expressions with JavaScript:

```typescript
// Before
ready: Cel.expr(resources.deployment.status.readyReplicas, ' > 0'),
url: Cel.template('https://%s', resources.service.status.clusterIP),

// After  
ready: resources.deployment.status.readyReplicas > 0,
url: `https://${resources.service.status.clusterIP}`,
```

## Next Steps

- **[CEL Expressions](./cel-expressions.md)** - Learn about explicit CEL expressions for advanced cases
- **[Status Hydration](./status-hydration.md)** - Understand how expressions are evaluated
- **[Examples](../examples/)** - See JavaScript expressions in real applications
- **[Magic Proxy](./magic-proxy.md)** - Deep dive into the magic proxy system