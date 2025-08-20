# Status Hydration

Status hydration is the process by which TypeKro populates the status fields of your resource graphs with live data from the Kubernetes cluster. This enables real-time monitoring, dynamic cross-resource references, and intelligent orchestration based on actual cluster state.

## Understanding Status Hydration

### What is Status Hydration?

Status hydration transforms static status mappings into dynamic, live data by:

1. **Querying cluster state** - Reading actual resource status from Kubernetes
2. **Evaluating CEL expressions** - Computing dynamic values based on runtime data  
3. **Resolving cross-references** - Following resource relationships at runtime
4. **Updating status fields** - Populating your resource graph's status with live data

```typescript
// Status mapping definition (static)
const statusMappings = {
  url: Cel.template('http://%s', service.status.loadBalancer.ingress[0].ip),
  ready: Cel.expr(deployment.status.readyReplicas, '> 0'),
  phase: deployment.status.phase
};

// After hydration (live data)
const hydratedStatus = {
  url: "http://203.0.113.15",      // Actual load balancer IP
  ready: true,                     // Computed from actual replica count
  phase: "Running"                 // Actual deployment phase
};
```

### How Status Hydration Works

```typescript
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService, Cel } from 'typekro';

const WebAppStatus = type({
  url: 'string',
  phase: 'string',
  readyReplicas: 'number',
  healthy: 'boolean'
});

const webApp = toResourceGraph(
  { name: 'webapp', schema: { spec: WebAppSpec, status: WebAppStatus } },
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas
    }),
    service: simpleService({
      name: Cel.template('%s-service', schema.spec.name),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'LoadBalancer'
    })
  }),
  // Status builder - defines how to hydrate status
  (schema, resources) => ({
    // Direct field mapping
    phase: resources.deployment.status.phase,
    readyReplicas: resources.deployment.status.readyReplicas,
    
    // Conditional logic with CEL
    url: Cel.expr(
      resources.service.status.loadBalancer.ingress,
      '.size() > 0 ? "http://" + ',
      resources.service.status.loadBalancer.ingress[0].ip,
      ': "pending"'
    ),
    
    // Complex health computation
    healthy: Cel.expr(
      resources.deployment.status.readyReplicas,
      '== ',
      resources.deployment.spec.replicas,
      '&& ',
      resources.service.status.loadBalancer.ingress,
      '.size() > 0'
    )
  })
);
```

## Status Hydration Process

### 1. Resource Deployment

When resources are deployed, TypeKro tracks their metadata and references:

```typescript
const factory = await webApp.factory('direct');
await factory.deploy({
  name: 'my-webapp',
  image: 'nginx:latest',
  replicas: 3
});
```

### 2. Status Querying

TypeKro periodically queries Kubernetes for resource status:

```typescript
// TypeKro internally executes queries like:
const deployment = await k8sApi.readNamespacedDeployment('my-webapp', 'default');
const service = await k8sApi.readNamespacedService('my-webapp-service', 'default');

// Extracts status information:
const deploymentStatus = {
  phase: deployment.status.phase,
  readyReplicas: deployment.status.readyReplicas,
  replicas: deployment.status.replicas
};
```

### 3. CEL Expression Evaluation

Dynamic expressions are evaluated against live data:

```typescript
// CEL expression: resources.deployment.status.readyReplicas > 0
const celEvaluator = new CelEvaluator();
const result = celEvaluator.evaluate(
  'readyReplicas > 0',
  { readyReplicas: 3 }  // Live data from cluster
);
// Result: true
```

### 4. Status Population

The final status object is assembled and made available:

```typescript
const status = await factory.getStatus();
console.log(status);
// Output:
// {
//   url: "http://203.0.113.15",
//   phase: "Running", 
//   readyReplicas: 3,
//   healthy: true
// }
```

## Status Mapping Patterns

### Simple Field Mapping

Direct mapping from resource status to graph status:

```typescript
const statusBuilder = (schema, resources) => ({
  // Direct field access
  deploymentPhase: resources.deployment.status.phase,
  serviceType: resources.service.spec.type,
  readyReplicas: resources.deployment.status.readyReplicas,
  
  // Nested field access
  clusterIP: resources.service.status.clusterIP,
  loadBalancerIP: resources.service.status.loadBalancer?.ingress?.[0]?.ip,
  
  // Resource metadata
  createdAt: resources.deployment.metadata.creationTimestamp,
  labels: resources.deployment.metadata.labels
});
```

### Conditional Status Logic

Use CEL expressions for dynamic status computation:

```typescript
const statusBuilder = (schema, resources) => ({
  // Simple boolean logic
  ready: Cel.expr(resources.deployment.status.readyReplicas, '> 0'),
  
  // Complex conditionals
  phase: Cel.expr(
    resources.deployment.status.readyReplicas,
    '== 0 ? "Stopped" : ',
    resources.deployment.status.readyReplicas,
    '< ',
    resources.deployment.spec.replicas,
    '? "Scaling" : "Running"'
  ),
  
  // Multi-resource health check
  healthy: Cel.expr<boolean>(
    resources.app.status.readyReplicas, ' > 0 && ',
    resources.database.status.readyReplicas, ' > 0 && ',
    resources.service.status.loadBalancer.ingress, '.size() > 0'
  ),
  
  // Environment-based logic
  accessMode: Cel.expr<string>(
    'schema.spec.environment == "production" ? "external" : "internal"'
  )
});
```

### Aggregated Status

Combine information from multiple resources:

```typescript
const microservicesStatus = (schema, resources) => ({
  // Count ready services
  readyServices: Cel.expr<number>(`
    (resources.userService.status.readyReplicas > 0 ? 1 : 0) + 
    (resources.orderService.status.readyReplicas > 0 ? 1 : 0) + 
    (resources.paymentService.status.readyReplicas > 0 ? 1 : 0)
  `),
  
  // Total resource count
  totalResources: Object.keys(resources).length,
  
  // Service endpoints
  endpoints: {
    users: Cel.template(
      'http://%s:3001/users',
      resources.userService.status.clusterIP
    ),
    orders: Cel.template(
      'http://%s:3002/orders', 
      resources.orderService.status.clusterIP
    ),
    payments: Cel.template(
      'http://%s:3003/payments',
      resources.paymentService.status.clusterIP
    )
  },
  
  // Overall system health
  systemHealth: Cel.expr<'healthy' | 'degraded'>(`
    resources.userService.status.readyReplicas > 0 && 
    resources.orderService.status.readyReplicas > 0 && 
    resources.paymentService.status.readyReplicas > 0 ? "healthy" : "degraded"
  `)
});
```

### Time-Based Status

Include temporal information in status:

```typescript
const statusBuilder = (schema, resources) => ({
  // Uptime calculation
  uptimeSeconds: Cel.expr<number>(`
    (now() - timestamp("resources.deployment.metadata.creationTimestamp")) / duration("1s")
  `),
  
  // Age in human-readable format
  age: Cel.expr<string>(`
    duration(now() - timestamp("resources.deployment.metadata.creationTimestamp")).getHours() > 24 ? 
    string(duration(now() - timestamp("resources.deployment.metadata.creationTimestamp")).getHours() / 24) + " days" : 
    string(duration(now() - timestamp("resources.deployment.metadata.creationTimestamp")).getHours()) + " hours"
  `),
  
  // Last update timestamp
  lastUpdated: new Date().toISOString(),
  
  // Status since creation
  stabilityPeriod: Cel.expr<'stable' | 'initializing'>(`
    now() - timestamp("resources.deployment.metadata.creationTimestamp") > duration("5m") ? "stable" : "initializing"
  `)
});
```

## Advanced Status Hydration

### Cross-Graph Status References

Reference status from other deployed graphs:

```typescript
// Shared database graph
const databaseGraph = toResourceGraph(
  { name: 'shared-database', schema: { spec: DatabaseSpec, status: DatabaseStatus } },
  (schema) => ({
    database: simpleDeployment({
      name: schema.spec.name,
      image: 'postgres:15'
    })
  }),
  (schema, resources) => ({
    host: resources.database.status.podIP,
    ready: Cel.expr(resources.database.status.readyReplicas, '> 0'),
    version: '15.0'
  })
);

// Application that references shared database status
const appGraph = toResourceGraph(
  { name: 'app-with-shared-db', schema: { spec: AppSpec, status: AppStatus } },
  (schema) => ({
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      env: {
        DATABASE_HOST: schema.spec.database.host  // External reference
      }
    })
  }),
  (schema, resources) => ({
    appReady: Cel.expr(resources.app.status.readyReplicas, '> 0'),
    
    // Reference external database status
    databaseConnected: schema.spec.database.ready,  // From external graph
    
    // Combined readiness
    fullyReady: Cel.expr<boolean>(`
      resources.app.status.readyReplicas > 0 && schema.spec.database.ready == true
    `)
  })
);
```

### Custom Status Evaluators

Create reusable status evaluation functions:

```typescript
// Reusable health evaluator
function createHealthEvaluator(resources: any[]) {
  return {
    allHealthy: Cel.expr<boolean>(`
      ${resources.map(r => `${r.status.readyReplicas} > 0`).join(' && ')}
    `),
    
    healthyCount: Cel.expr<number>(`
      ${resources.map(r => `(${r.status.readyReplicas} > 0 ? 1 : 0)`).join(' + ')}
    `),
    
    healthPercentage: Cel.expr<number>(`
      (${resources.map(r => `(${r.status.readyReplicas} > 0 ? 1 : 0)`).join(' + ')}) * 100 / ${resources.length}
    `)
  };
}

// Use in status builder
const statusBuilder = (schema, resources) => {
  const services = [resources.userService, resources.orderService, resources.paymentService];
  const health = createHealthEvaluator(services);
  
  return {
    ...health,
    phase: Cel.expr<'Ready' | 'Degraded' | 'Failed'>(`
      health.healthPercentage >= 100 ? "Ready" : health.healthPercentage >= 50 ? "Degraded" : "Failed"
    `)
  };
};
```

### Hierarchical Status

Build nested status structures:

```typescript
const complexStatus = (schema, resources) => ({
  // Top-level status
  phase: Cel.expr(
    resources.app.status.readyReplicas, '> 0 && ',
    resources.database.status.readyReplicas, '> 0 ? "Running" : "Pending"'
  ),
  
  // Component status
  components: {
    application: {
      ready: Cel.expr(resources.app.status.readyReplicas, '> 0'),
      replicas: {
        desired: resources.app.spec.replicas,
        ready: resources.app.status.readyReplicas,
        available: resources.app.status.availableReplicas
      },
      endpoints: {
        internal: Cel.template('http://%s:80', resources.appService.status.clusterIP),
        external: Cel.template(
          'http://%s',
          resources.appService.status.loadBalancer.ingress[0].ip
        )
      }
    },
    
    database: {
      ready: Cel.expr(resources.database.status.readyReplicas, '> 0'),
      host: resources.databaseService.spec.clusterIP,
      port: 5432,
      connections: {
        current: Cel.expr(resources.database.status.readyReplicas, '* 100'),  // Mock calculation
        max: Cel.expr(resources.database.status.readyReplicas, '* 200')
      }
    }
  },
  
  // Operational metrics
  metrics: {
    uptime: Cel.expr<number>(`
      (now() - timestamp("resources.app.metadata.creationTimestamp")) / duration("1s")
    `),
    
    resourceUtilization: {
      cpu: Cel.expr(resources.app.status.readyReplicas, '* 0.1'),  // Mock calculation
      memory: Cel.expr(resources.app.status.readyReplicas, '* 0.2')
    }
  }
});
```

## Status Hydration in Different Deployment Modes

### Direct Mode Hydration

In direct mode, TypeKro actively queries the cluster:

```typescript
const factory = await graph.factory('direct', {
  namespace: 'development',
  statusUpdateInterval: 30000  // Update every 30 seconds
});

await factory.deploy(spec);

// Status is automatically hydrated
const status = await factory.getStatus();
console.log('Live status:', status);

// Listen for status updates
factory.onStatusUpdate((newStatus) => {
  console.log('Status updated:', newStatus);
});
```

### KRO Mode Hydration

In KRO mode, status hydration is handled by the KRO controller:

```typescript
// Generated ResourceGraphDefinition includes status mappings as CEL expressions
const yaml = graph.toYaml(spec);
console.log(yaml);
// Output includes:
// status:
//   url: ${service.status.loadBalancer.ingress[0].ip}
//   ready: ${deployment.status.readyReplicas > 0}
```

### GitOps Mode Hydration

Status is available through Kubernetes API after deployment:

```bash
# Deploy via GitOps
kubectl apply -f webapp-definition.yaml
kubectl apply -f webapp-instance.yaml

# Check status
kubectl get webapp my-webapp -o jsonpath='{.status}'
```

## Status Hydration Performance

### Optimization Strategies

1. **Selective Hydration**: Only hydrate frequently accessed status fields
2. **Caching**: Cache status data to reduce API calls
3. **Batching**: Batch multiple resource queries
4. **Incremental Updates**: Only update changed fields

```typescript
const optimizedStatus = (schema, resources) => ({
  // Critical status (updated frequently)
  ready: Cel.expr(resources.app.status.readyReplicas, '> 0'),
  phase: resources.app.status.phase,
  
  // Detailed status (cached)
  details: {
    lastUpdated: new Date().toISOString(),
    
    // Expensive computation (cached for 5 minutes)
    performanceMetrics: Cel.expr(
      `"cached_until_" + string(now() + duration("5m"))`
    )
  }
});
```

### Monitoring Status Hydration

```typescript
const factory = await graph.factory('direct', {
  statusUpdateInterval: 10000,
  onStatusHydrationError: (error) => {
    console.error('Status hydration failed:', error);
  },
  onStatusHydrationComplete: (duration) => {
    console.log(`Status hydration completed in ${duration}ms`);
  }
});
```

## Error Handling

### Status Hydration Failures

```typescript
const robustStatus = (schema, resources) => ({
  // Safe field access with fallbacks
  phase: resources.deployment.status?.phase || 'Unknown',
  
  // Safe CEL expressions with error handling
  ready: Cel.expr(
    resources.deployment.status?.readyReplicas || 0,
    '> 0'
  ),
  
  // Conditional status based on resource availability
  url: Cel.expr(
    resources.service.status?.loadBalancer?.ingress,
    '.size() > 0 ? "http://" + ',
    resources.service.status?.loadBalancer?.ingress?.[0]?.ip || '"unavailable"',
    ': "pending"'
  ),
  
  // Error tracking
  lastError: null,
  lastSuccessfulUpdate: new Date().toISOString()
});
```

### Retry Logic

```typescript
const factory = await graph.factory('direct', {
  statusUpdateRetries: 3,
  statusUpdateBackoff: 'exponential',
  statusUpdateTimeout: 30000
});
```

## Debugging Status Hydration

### Enable Debug Logging

```typescript
import { createLogger } from 'typekro';

const logger = createLogger({
  level: 'debug',
  pretty: true
});

const factory = await graph.factory('direct', {
  logger,
  debugStatusHydration: true
});
```

### Status Hydration Inspection

```typescript
// Get raw resource status
const rawStatus = await factory.getRawResourceStatus();
console.log('Raw Kubernetes resource status:', rawStatus);

// Get status evaluation trace
const trace = await factory.getStatusEvaluationTrace();
console.log('CEL evaluation trace:', trace);

// Validate status mappings
const validation = await factory.validateStatusMappings();
console.log('Status mapping validation:', validation);
```

## Best Practices

### 1. Design Meaningful Status

```typescript
// ✅ Provide actionable status information
const meaningfulStatus = (schema, resources) => ({
  // High-level state
  phase: 'Running' | 'Pending' | 'Failed' | 'Scaling',
  
  // Specific metrics
  readyReplicas: resources.app.status.readyReplicas,
  desiredReplicas: resources.app.spec.replicas,
  
  // User-facing information
  accessUrl: 'http://example.com',
  
  // Operational data
  lastDeployment: '2024-01-15T10:30:00Z',
  
  // Health indicators
  healthy: true,
  issues: []
});
```

### 2. Handle Transient States

```typescript
// ✅ Account for resource lifecycle states
const robustStatus = (schema, resources) => ({
  phase: Cel.expr(
    // Handle initialization phase
    resources.deployment.status.readyReplicas,
    '== 0 && ',
    resources.deployment.status.replicas,
    '== 0 ? "Initializing" : ',
    
    // Handle scaling phases
    resources.deployment.status.readyReplicas,
    '< ',
    resources.deployment.spec.replicas,
    '? "Scaling" : "Ready"'
  )
});
```

### 3. Provide Rollback Information

```typescript
const statusWithHistory = (schema, resources) => ({
  current: {
    version: resources.deployment.metadata.labels?.version,
    replicas: resources.deployment.status.readyReplicas
  },
  
  previous: {
    version: resources.deployment.metadata.annotations?.['previous-version'],
    rollbackAvailable: Cel.expr(
      `"${resources.deployment.metadata.annotations?.['previous-version']}" != ""`
    )
  }
});
```

## Next Steps

- **[CEL Expressions](./cel-expressions.md)** - Master dynamic status computation
- **[Cross-Resource References](./cross-references.md)** - Build interconnected status
- **[Direct Deployment](./deployment/direct.md)** - Deploy with live status hydration
- **[KRO Integration](./deployment/kro.md)** - Use KRO for advanced status orchestration