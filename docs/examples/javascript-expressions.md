# JavaScript Expressions Example

TypeKro automatically converts JavaScript expressions to CEL when they contain resource or schema references. Write natural JavaScript - TypeKro handles the conversion.

## Complete Example

```typescript
import { type } from 'arktype';
import { toResourceGraph, Cel } from 'typekro';
import * as simple from 'typekro/simple';

// Define comprehensive schemas
const FullStackAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: '"development" | "staging" | "production"',
  features: {
    database: 'boolean',
    redis: 'boolean',
    monitoring: 'boolean'
  },
  scaling: {
    minReplicas: 'number',
    maxReplicas: 'number',
    targetCPU: 'number'
  }
});

const FullStackAppStatus = type({
  ready: 'boolean',
  healthy: 'boolean',
  url: 'string',
  phase: 'string',
  replicas: 'number',
  utilizationPercent: 'number',
  components: {
    webapp: 'boolean',
    database: 'boolean',
    redis: 'boolean',
    loadBalancer: 'boolean'
  },
  endpoints: 'string[]',
  environment: 'string',
  health: {
    overall: 'string',
    database: 'string',
    redis: 'string',
    uptime: 'string'
  }
});

// Create the resource graph with comprehensive JavaScript expressions
export const fullStackApp = toResourceGraph(
  {
    name: 'fullstack-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'FullStackApp',
    spec: FullStackAppSpec,
    status: FullStackAppStatus,
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
        // Static values (no conversion needed)
        NODE_ENV: schema.spec.environment,
        PORT: '3000',
        
        // JavaScript template literals (automatically converted to CEL)
        APP_NAME: `${schema.spec.name}-${schema.spec.environment}`,
        
        // Conditional expressions (automatically converted to CEL)
        LOG_LEVEL: schema.spec.environment === 'production' ? 'warn' : 'debug',
        
        // Complex template with multiple references
        DATABASE_URL: schema.spec.features.database 
          ? `postgres://user:pass@${resources.database?.status.podIP}:5432/${schema.spec.name}`
          : 'sqlite:///tmp/app.db',
          
        // Conditional with fallback
        REDIS_URL: schema.spec.features.redis 
          ? `redis://${resources.redis?.status.podIP || 'localhost'}:6379`
          : '',
          
        // Arithmetic expressions
        MAX_CONNECTIONS: schema.spec.scaling.maxReplicas * 10,
        WORKER_THREADS: schema.spec.replicas > 4 ? 4 : schema.spec.replicas
      }
    });

    // Service for the webapp
    resources.webappService = simple.Service({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: schema.spec.environment === 'production' ? 'LoadBalancer' : 'ClusterIP'
    });

    // Conditional database
    if (schema.spec.features.database) {
      resources.database = simple.Deployment({
        name: `${schema.spec.name}-db`,
        image: 'postgres:15',
        env: {
          POSTGRES_DB: schema.spec.name,
          POSTGRES_USER: 'user',
          POSTGRES_PASSWORD: 'password'
        },
        ports: [{ containerPort: 5432 }]
      });

      resources.databaseService = simple.Service({
        name: `${schema.spec.name}-db-service`,
        selector: { app: `${schema.spec.name}-db` },
        ports: [{ port: 5432, targetPort: 5432 }]
      });
    }

    // Conditional Redis
    if (schema.spec.features.redis) {
      resources.redis = simple.Deployment({
        name: `${schema.spec.name}-redis`,
        image: 'redis:7',
        ports: [{ containerPort: 6379 }]
      });

      resources.redisService = simple.Service({
        name: `${schema.spec.name}-redis-service`,
        selector: { app: `${schema.spec.name}-redis` },
        ports: [{ port: 6379, targetPort: 6379 }]
      });
    }

    return resources;
  },
  
  // Status builder with comprehensive JavaScript expressions
  // All of these are automatically converted to CEL expressions
  (schema, resources) => ({
    // ✅ Simple boolean expressions
    ready: resources.webapp.status.readyReplicas > 0 && 
           (!schema.spec.features.database || resources.database?.status.readyReplicas > 0) &&
           (!schema.spec.features.redis || resources.redis?.status.readyReplicas > 0),
           
    healthy: resources.webapp.status.readyReplicas === schema.spec.replicas,

    // ✅ Template literals with interpolation
    url: resources.webappService.status?.loadBalancer?.ingress?.[0]?.ip
      ? `https://${resources.webappService.status.loadBalancer.ingress[0].ip}`
      : resources.webappService.status?.clusterIP
        ? `http://${resources.webappService.status.clusterIP}`
        : 'pending',

    // ✅ Complex conditional expressions
    phase: resources.webapp.status.readyReplicas === 0 
      ? 'stopped'
      : resources.webapp.status.readyReplicas < schema.spec.replicas
        ? 'scaling'
        : resources.webapp.status.readyReplicas === schema.spec.replicas
          ? 'ready'
          : 'overscaled',

    // ✅ Direct resource references
    replicas: resources.webapp.status.readyReplicas,

    // ✅ Arithmetic expressions
    utilizationPercent: (resources.webapp.status.readyReplicas / schema.spec.replicas) * 100,

    // ✅ Complex nested objects with JavaScript expressions
    components: {
      webapp: resources.webapp.status.readyReplicas > 0,
      database: schema.spec.features.database 
        ? resources.database?.status.readyReplicas > 0 
        : true,
      redis: schema.spec.features.redis 
        ? resources.redis?.status.readyReplicas > 0 
        : true,
      loadBalancer: resources.webappService.status?.loadBalancer?.ingress?.length > 0
    },

    // ✅ Array expressions (for simple cases)
    endpoints: [
      resources.webappService.status?.loadBalancer?.ingress?.[0]?.ip || 'pending'
    ],

    // ✅ Direct schema references (no conversion needed)
    environment: schema.spec.environment,

    // ✅ Complex health object with nested expressions
    health: {
      // Conditional string expressions
      overall: resources.webapp.status.readyReplicas > 0 && 
               (!schema.spec.features.database || resources.database?.status.readyReplicas > 0) &&
               (!schema.spec.features.redis || resources.redis?.status.readyReplicas > 0)
        ? 'healthy' 
        : 'unhealthy',

      // Optional chaining with fallbacks
      database: schema.spec.features.database
        ? resources.database?.status.conditions?.find(c => c.type === 'Available')?.status === 'True'
          ? 'connected'
          : 'disconnected'
        : 'disabled',

      redis: schema.spec.features.redis
        ? resources.redis?.status.readyReplicas > 0 ? 'connected' : 'disconnected'
        : 'disabled',

      // Template with complex logic
      uptime: resources.webapp.metadata?.creationTimestamp
        ? `Running since ${resources.webapp.metadata.creationTimestamp}`
        : 'Not started'
    }
  })
);
```

## Key JavaScript Patterns Demonstrated

### 1. Template Literals
```typescript
// ✅ Automatic conversion to CEL templates
APP_NAME: `${schema.spec.name}-${schema.spec.environment}`,
DATABASE_URL: `postgres://user:pass@${resources.database?.status.podIP}:5432/${schema.spec.name}`,
url: `https://${resources.webappService.status.loadBalancer.ingress[0].ip}`
```

### 2. Conditional Expressions
```typescript
// ✅ Ternary operators converted to CEL conditionals
LOG_LEVEL: schema.spec.environment === 'production' ? 'warn' : 'debug',
type: schema.spec.environment === 'production' ? 'LoadBalancer' : 'ClusterIP',

// ✅ Complex nested conditionals
phase: resources.webapp.status.readyReplicas === 0 
  ? 'stopped'
  : resources.webapp.status.readyReplicas < schema.spec.replicas
    ? 'scaling'
    : 'ready'
```

### 3. Boolean Logic
```typescript
// ✅ Logical operators converted to CEL
ready: resources.webapp.status.readyReplicas > 0 && 
       (!schema.spec.features.database || resources.database?.status.readyReplicas > 0),

healthy: resources.webapp.status.readyReplicas === schema.spec.replicas
```

### 4. Optional Chaining
```typescript
// ✅ Optional chaining converted to Kro's ? operator
url: resources.webappService.status?.loadBalancer?.ingress?.[0]?.ip,
database: resources.database?.status.conditions?.find(c => c.type === 'Available')?.status === 'True'
```

### 5. Arithmetic Operations
```typescript
// ✅ Math expressions converted to CEL
MAX_CONNECTIONS: schema.spec.scaling.maxReplicas * 10,
utilizationPercent: (resources.webapp.status.readyReplicas / schema.spec.replicas) * 100,
WORKER_THREADS: schema.spec.replicas > 4 ? 4 : schema.spec.replicas
```

### 6. Logical Fallbacks
```typescript
// ✅ Fallback operators converted to CEL conditionals
REDIS_URL: resources.redis?.status.podIP || 'localhost',
endpoints: resources.webappService.status?.loadBalancer?.ingress?.[0]?.ip || 'pending'
```

## Usage Examples

### Direct Factory Pattern
```typescript
// JavaScript expressions evaluated with resolved dependencies
const directFactory = await fullStackApp.factory('direct', { namespace: 'production' });
await directFactory.deploy({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3,
  environment: 'production',
  features: { database: true, redis: true, monitoring: false },
  scaling: { minReplicas: 1, maxReplicas: 10, targetCPU: 70 }
});
```

### Kro Factory Pattern
```typescript
// JavaScript expressions converted to CEL for runtime evaluation
const kroFactory = await fullStackApp.factory('kro', { namespace: 'production' });
const yaml = await kroFactory.toYaml({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3,
  environment: 'production',
  features: { database: true, redis: true, monitoring: false },
  scaling: { minReplicas: 1, maxReplicas: 10, targetCPU: 70 }
});
```

## Advanced Patterns

### Mixing JavaScript and Explicit CEL

For complex operations that can't be expressed in JavaScript, use explicit CEL:

```typescript
export const advancedExample = toResourceGraph(
  {
    name: 'advanced-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'AdvancedApp',
    spec: type({ name: 'string', replicas: 'number' }),
    status: type({ 
      ready: 'boolean', 
      podNames: 'string[]',
      healthyPods: 'number',
      summary: 'string'
    }),
  },
  (schema) => ({
    deployment: simple.Deployment({
      name: schema.spec.name,
      image: 'nginx:latest',
      replicas: schema.spec.replicas,
      ports: [{ containerPort: 80 }]
    })
  }),
  (schema, resources) => ({
    // ✅ JavaScript expressions for simple cases
    ready: resources.deployment.status.readyReplicas > 0,

    // ✅ Use explicit CEL for complex list operations
    podNames: Cel.map(
      resources.deployment.status.pods,
      'item.metadata.name'
    ),

    // ✅ Complex list operations still require explicit CEL (escape hatch)
    healthyPods: Cel.expr(
      'size(resources.deployment.status.pods.filter(p, p.status.phase == "Running"))'
    ),

    // ✅ Mix JavaScript and CEL as needed
    summary: `${schema.spec.name} has ${resources.deployment.status.readyReplicas} ready pods`
  })
);
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

- **[JavaScript to CEL Guide](../guide/javascript-to-cel.md)** - Complete conversion documentation
- **[Explicit CEL Expressions](../guide/cel-expressions.md)** - Advanced CEL patterns
- **[Magic Proxy System](../guide/magic-proxy.md)** - Understanding the underlying system
- **[Status Hydration](../guide/status-hydration.md)** - How expressions are evaluated