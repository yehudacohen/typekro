# Runtime Behavior

TypeKro's runtime behavior encompasses three interconnected features: status hydration, cross-resource references, and external references. Together, these features enable dynamic, interconnected infrastructure that responds to real cluster state and can be composed across resource boundaries.

## Status Hydration

Status hydration is the process by which TypeKro populates the status fields of your resource graphs with live data from the Kubernetes cluster. This enables real-time monitoring, dynamic cross-resource references, and intelligent orchestration based on actual cluster state.

### Understanding Status Hydration

Status hydration transforms static status mappings into dynamic, live data by:

1. **Querying cluster state** - Reading actual resource status from Kubernetes
2. **Evaluating CEL expressions** - Computing dynamic values based on runtime data  
3. **Resolving cross-references** - Following resource relationships at runtime
4. **Updating status fields** - Populating your resource graph's status with live data

```typescript
// Status mapping definition (static)
const statusMappings = {
  url: Cel.template('http://%s', loadBalancer.status.ingress[0].ip),
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

For complete status hydration examples, see [Basic WebApp Pattern](../examples/basic-webapp.md).

Status hydration patterns:
```typescript
// Status builder function - maps resource status to application status
(schema, resources) => ({
  // Direct field mapping
  phase: resources.deployment.status.phase,
  readyReplicas: resources.deployment.status.readyReplicas,
  
  // CEL expressions for conditional logic
  url: Cel.expr<string>(
    resources.service.status.loadBalancer.ingress,
    '.size() > 0 ? "http://" + ',
    resources.service.status.loadBalancer.ingress[0].ip,
    ': "pending"'
  ),
  
  // Complex status computation
  healthy: Cel.expr<boolean>(
    resources.deployment.status.readyReplicas,
    ' == ',
    resources.deployment.spec.replicas,
      '&& ',
      resources.service.status.loadBalancer.ingress,
      '.size() > 0'
    )
  })
);
```

### Status Hydration Process

#### 1. Resource Deployment

When resources are deployed, TypeKro tracks their metadata and references:

```typescript
const factory = webApp.factory('direct');
await factory.deploy({
  name: 'my-webapp',
  image: 'nginx:latest',
  replicas: 3
});
```

#### 2. Status Querying

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

#### 3. CEL Expression Evaluation

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

#### 4. Status Population

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

### Status Mapping Patterns

#### Simple Field Mapping

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

#### Conditional Status Logic

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
  healthy: Cel.expr(
    resources.app.status.readyReplicas, '> 0 && ',
    resources.database.status.readyReplicas, '> 0 && ',
    resources.service.status.loadBalancer.ingress, '.size() > 0'
  )
});
```

#### Aggregated Status

Combine information from multiple resources:

```typescript
const microservicesStatus = (schema, resources) => ({
  // Count ready services
  readyServices: Cel.expr(
    '(',
    resources.userService.status.readyReplicas, '> 0 ? 1 : 0) + (',
    resources.orderService.status.readyReplicas, '> 0 ? 1 : 0) + (',
    resources.paymentService.status.readyReplicas, '> 0 ? 1 : 0)'
  ),
  
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
  systemHealth: Cel.expr(
    resources.userService.status.readyReplicas, '> 0 && ',
    resources.orderService.status.readyReplicas, '> 0 && ',
    resources.paymentService.status.readyReplicas, '> 0 ? "healthy" : "degraded"'
  )
});
```

## Cross-Resource References

One of TypeKro's most powerful features is the ability to create dynamic references between resources. This enables truly interconnected infrastructure where resources can reference each other's runtime properties.

### Basic Cross-References

#### Simple Field References

Reference another resource's fields directly:

```typescript
const database = simpleDeployment({
  name: 'postgres',
  image: 'postgres:15',
  ports: [{ containerPort: 5432 }]
});

const app = simpleDeployment({
  name: 'web-app',
  image: 'myapp:latest',
  env: {
    // Reference the database's pod IP at runtime
    DATABASE_HOST: database.status.podIP,
    DATABASE_PORT: '5432'
  }
});
```

#### Service References

Reference services for stable DNS names:

```typescript
const dbService = simpleService({
  name: 'postgres-service',
  selector: { app: 'postgres' },
  ports: [{ port: 5432, targetPort: 5432 }]
});

const app = simpleDeployment({
  name: 'web-app',
  env: {
    // Use the service's cluster DNS name
    DATABASE_URL: Cel.template(
      'postgresql://postgres:password@%s:5432/myapp',
      dbService.metadata.name
    )
  }
});
```

### Advanced Reference Patterns

#### Conditional References

Use TypeScript's conditional logic with references:

```typescript
const app = simpleDeployment({
  name: 'web-app',
  env: {
    // Different database hosts based on environment
    DATABASE_HOST: schema.spec.environment === 'production'
      ? prodDatabase.status.podIP
      : devDatabase.status.podIP,
      
    // Optional external service reference
    ...(schema.spec.useExternalCache && {
      REDIS_URL: externalRedis.status.endpoint
    })
  }
});
```

#### Nested Field References

Reference deeply nested fields:

```typescript
const ingress = simpleIngress({
  name: 'web-ingress',
  rules: [/* ... */]
});

const app = simpleDeployment({
  name: 'web-app',
  env: {
    // Reference nested ingress status
    PUBLIC_URL: Cel.template(
      'https://%s',
      ingress.status.loadBalancer.ingress[0].hostname
    ),
    
    // Reference array elements with CEL
    FIRST_NODE_IP: Cel.expr(
      cluster.status.nodes,
      '[0].addresses.filter(addr, addr.type == "InternalIP")[0].address'
    )
  }
});
```

### Reference Types

#### Status References

Most common - reference the runtime status of resources:

```typescript
// Pod IP addresses
DATABASE_HOST: database.status.podIP

// Service endpoints
API_ENDPOINT: apiService.status.loadBalancer.ingress[0].ip

// Deployment readiness
READY_REPLICAS: deployment.status.readyReplicas

// Persistent volume claims
STORAGE_PATH: pvc.status.phase
```

#### Metadata References

Reference resource metadata:

```typescript
// Resource names
SERVICE_NAME: service.metadata.name

// Namespaces
NAMESPACE: deployment.metadata.namespace

// Labels
APP_VERSION: deployment.metadata.labels.version

// Annotations
PROMETHEUS_PORT: service.metadata.annotations['prometheus.io/port']
```

#### Spec References

Reference resource specifications:

```typescript
// Replica counts
MAX_CONNECTIONS: Cel.expr(deployment.spec.replicas, '* 100')

// Port numbers
HEALTH_CHECK_PORT: service.spec.ports[0].targetPort

// Image tags with CEL
IMAGE_VERSION: Cel.expr(
  deployment.spec.template.spec.containers[0].image,
  '.split(":")[1]'
)
```

### CEL Expression Integration

Combine references with CEL expressions for complex logic:

```typescript
import { Cel } from 'typekro';

const app = simpleDeployment({
  name: 'web-app',
  env: {
    // Conditional based on replica count
    CLUSTER_MODE: Cel.expr(
      database.status.readyReplicas, 
      '> 1 ? "cluster" : "standalone"'
    ),
    
    // Template with multiple references
    CONNECTION_STRING: Cel.template(
      'postgresql://user:pass@%s:%d/%s',
      database.status.podIP,
      dbService.spec.ports[0].port,
      'myapp'
    ),
    
    // Complex conditional logic
    READY_STATUS: Cel.expr(
      app.status.readyReplicas, '== ', app.spec.replicas, ' && ',
      database.status.readyReplicas, '> 0 ? "ready" : "waiting"'
    )
  }
});
```

### Reference Resolution

#### Runtime Resolution

References are resolved at deployment time:

```typescript
// At build time: creates a reference object
const dbHost = database.status.podIP;

// At deployment time: resolves to actual IP
// DATABASE_HOST=10.244.1.15
```

#### Deployment Modes

Different deployment modes handle references differently:

**Direct Mode**: References are resolved by querying the Kubernetes API:

```typescript
const factory = graph.factory('direct');
// TypeKro queries the cluster to resolve references
await factory.deploy(spec);
```

**KRO Mode**: References become CEL expressions in the ResourceGraphDefinition:

```typescript
const yaml = graph.toYaml(spec);
// Generates: DATABASE_HOST: ${database.status.podIP}
```

## External References

External references allow you to compose ResourceGraphDefinitions together by referencing CRD instances from other deployed graphs. This enables modular architecture where shared infrastructure components can be referenced across multiple applications.

### What are External References?

External references (`externalRef`) enable:

1. **Cross-graph composition** - Reference resources deployed by other ResourceGraphDefinitions
2. **Shared infrastructure** - Common databases, caches, and services used by multiple applications
3. **Modular architecture** - Break complex systems into manageable, reusable components
4. **Status composition** - Aggregate status from external dependencies

```typescript
import { externalRef } from 'typekro';

// Reference an external database instance
const database = externalRef<DatabaseSpec, DatabaseStatus>(
  'database.example.com/v1alpha1',
  'Database',
  'shared-postgres',
  'infrastructure'  // optional namespace
);

// Use in your application
const webapp = simpleDeployment({
  name: 'webapp',
  image: 'nginx',
  env: {
    // Reference external database status
    DATABASE_URL: database.status.connectionString,
    DATABASE_HOST: database.status.host,
    DATABASE_PORT: database.status.port
  }
});
```

### Basic External Reference Usage

#### Simple External Reference

Reference a shared database deployed by another team:

```typescript
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, externalRef } from 'typekro';

// Define expected external database schema
const DatabaseSpec = type({
  name: 'string',
  version: 'string',
  storage: 'string'
});

const DatabaseStatus = type({
  host: 'string',
  port: 'number',
  connectionString: 'string',
  ready: 'boolean'
});

// Reference the external database
const sharedDatabase = externalRef<typeof DatabaseSpec.infer, typeof DatabaseStatus.infer>(
  'database.example.com/v1alpha1',
  'Database',
  'production-postgres',
  'infrastructure'
);

// Use in your application graph
const userService = toResourceGraph(
  {
    name: 'user-service',
    apiVersion: 'example.com/v1alpha1',
    kind: 'UserService',
    spec: type({
      image: 'string',
      replicas: 'number'
    }),
    status: type({
      ready: 'boolean',
      endpoint: 'string'
    })
  },
  (schema) => ({
    deployment: simpleDeployment({
      name: 'user-service',
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      env: {
        // Reference external database
        DATABASE_URL: sharedDatabase.status.connectionString,
        DATABASE_HOST: sharedDatabase.status.host,
        DATABASE_PORT: sharedDatabase.status.port
      }
    }),
    service: simpleService({
      name: 'user-service',
      selector: { app: 'user-service' },
      ports: [{ port: 80, targetPort: 3000 }]
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.deployment.status.readyReplicas, '> 0 && ',
      sharedDatabase.status.ready, '== true'
    ),
    endpoint: Cel.template(
      'http://%s',
      resources.service.status.clusterIP
    )
  })
);
```

#### Cross-Namespace References

Reference resources in different namespaces:

```typescript
// Shared cache in the infrastructure namespace
const redisCache = externalRef<RedisCacheSpec, RedisCacheStatus>(
  'cache.example.com/v1alpha1',
  'RedisCache',
  'shared-redis',
  'infrastructure'  // Different namespace
);

// Monitoring stack in the monitoring namespace
const prometheus = externalRef<PrometheusSpec, PrometheusStatus>(
  'monitoring.coreos.com/v1',
  'Prometheus',
  'main-prometheus',
  'monitoring'
);

// Use in application namespace
const microservice = toResourceGraph(
  { name: 'payment-service', /* ... */ },
  (schema) => ({
    app: simpleDeployment({
      name: 'payment-service',
      env: {
        // Cross-namespace cache reference
        REDIS_URL: redisCache.status.connectionString,
        
        // Monitoring endpoints
        METRICS_ENDPOINT: prometheus.status.endpoint
      }
    })
  })
);
```

### Advanced External Reference Patterns

#### Conditional External Dependencies

Use external references conditionally based on environment:

```typescript
const productionDatabase = externalRef<DatabaseSpec, DatabaseStatus>(
  'database.example.com/v1alpha1',
  'Database',
  'production-postgres',
  'infrastructure'
);

const stagingDatabase = externalRef<DatabaseSpec, DatabaseStatus>(
  'database.example.com/v1alpha1',
  'Database',
  'staging-postgres',
  'staging'
);

const webapp = toResourceGraph(
  { name: 'webapp', /* ... */ },
  (schema) => {
    const database = schema.spec.environment === 'production' 
      ? productionDatabase 
      : stagingDatabase;
    
    return {
      app: simpleDeployment({
        name: 'webapp',
        env: {
          DATABASE_URL: database.status.connectionString,
          ENVIRONMENT: schema.spec.environment
        }
      })
    };
  },
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, '> 0'),
    databaseReady: schema.spec.environment === 'production'
      ? productionDatabase.status.ready
      : stagingDatabase.status.ready
  })
);
```

#### Multiple External Dependencies

Compose multiple external services:

```typescript
// Infrastructure services
const database = externalRef<DatabaseSpec, DatabaseStatus>(
  'database.example.com/v1alpha1', 'Database', 'shared-postgres', 'infra'
);

const cache = externalRef<RedisCacheSpec, RedisCacheStatus>(
  'cache.example.com/v1alpha1', 'RedisCache', 'shared-redis', 'infra'
);

const messageQueue = externalRef<RabbitMQSpec, RabbitMQStatus>(
  'messaging.example.com/v1alpha1', 'RabbitMQ', 'shared-rabbitmq', 'infra'
);

// E-commerce microservice with multiple dependencies
const orderService = toResourceGraph(
  { name: 'order-service', /* ... */ },
  (schema) => ({
    deployment: simpleDeployment({
      name: 'order-service',
      env: {
        // Database connection
        DATABASE_URL: database.status.connectionString,
        
        // Cache connection  
        REDIS_URL: cache.status.connectionString,
        
        // Message queue connection
        RABBITMQ_URL: messageQueue.status.connectionString,
        
        // Service configuration
        SERVICE_NAME: 'order-service',
        NAMESPACE: schema.spec.namespace
      }
    })
  }),
  (schema, resources) => ({
    // Service readiness depends on all external dependencies
    ready: Cel.expr(
      resources.deployment.status.readyReplicas, '> 0 && ',
      database.status.ready, '== true && ',
      cache.status.ready, '== true && ',
      messageQueue.status.ready, '== true'
    ),
    
    // Individual dependency status
    dependencies: {
      database: database.status.ready,
      cache: cache.status.ready,
      messageQueue: messageQueue.status.ready
    },
    
    // Combined health percentage
    healthPercentage: Cel.expr(
      '(',
      database.status.ready, '? 33 : 0) + (',
      cache.status.ready, '? 33 : 0) + (',
      messageQueue.status.ready, '? 34 : 0)'
    )
  })
);
```

#### Hierarchical External References

Reference external services that themselves have external dependencies:

```typescript
// Base infrastructure
const postgres = externalRef<PostgresSpec, PostgresStatus>(
  'postgresql.cnpg.io/v1', 'Cluster', 'main-postgres', 'data'
);

// Mid-level service that uses postgres
const userDatabase = externalRef<UserDatabaseSpec, UserDatabaseStatus>(
  'app.example.com/v1alpha1', 'UserDatabase', 'user-db', 'services'
);

// Application that uses the user database service
const webapp = toResourceGraph(
  { name: 'webapp', /* ... */ },
  (schema) => ({
    app: simpleDeployment({
      name: 'webapp',
      env: {
        // Direct reference to mid-level service
        USER_DATABASE_URL: userDatabase.status.connectionString,
        
        // Can also reference base infrastructure directly if needed
        POSTGRES_HEALTH: postgres.status.ready
      }
    })
  }),
  (schema, resources) => ({
    ready: resources.app.status.readyReplicas,
    
    // Status composition from multiple levels
    infrastructure: {
      postgres: postgres.status.ready,
      userDatabase: userDatabase.status.ready
    },
    
    // Combined readiness across the stack
    stackReady: Cel.expr(
      postgres.status.ready, '== true && ',
      userDatabase.status.ready, '== true && ',
      resources.app.status.readyReplicas, '> 0'
    )
  })
);
```

### External Reference Status Composition

#### Aggregating External Status

Create comprehensive status views by combining external dependencies:

```typescript
const sharedServices = {
  database: externalRef<DatabaseSpec, DatabaseStatus>(
    'database.example.com/v1alpha1', 'Database', 'shared-postgres', 'infra'
  ),
  cache: externalRef<CacheSpec, CacheStatus>(
    'cache.example.com/v1alpha1', 'Redis', 'shared-redis', 'infra'
  ),
  monitoring: externalRef<MonitoringSpec, MonitoringStatus>(
    'monitoring.example.com/v1alpha1', 'Monitoring', 'prometheus', 'monitoring'
  )
};

const applicationPlatform = toResourceGraph(
  { name: 'platform', /* ... */ },
  (schema) => ({
    gateway: simpleDeployment({
      name: 'api-gateway',
      env: {
        DATABASE_URL: sharedServices.database.status.connectionString,
        REDIS_URL: sharedServices.cache.status.connectionString,
        METRICS_URL: sharedServices.monitoring.status.metricsEndpoint
      }
    })
  }),
  (schema, resources) => ({
    // Platform-level status
    ready: Cel.expr(resources.gateway.status.readyReplicas, '> 0'),
    
    // External infrastructure status
    infrastructure: {
      database: {
        ready: sharedServices.database.status.ready,
        host: sharedServices.database.status.host,
        connections: sharedServices.database.status.activeConnections
      },
      cache: {
        ready: sharedServices.cache.status.ready,
        memory: sharedServices.cache.status.memoryUsage,
        hits: sharedServices.cache.status.cacheHits
      },
      monitoring: {
        ready: sharedServices.monitoring.status.ready,
        alerts: sharedServices.monitoring.status.activeAlerts
      }
    },
    
    // Overall system health
    systemHealth: Cel.expr(
      resources.gateway.status.readyReplicas, '> 0 && ',
      sharedServices.database.status.ready, '== true && ',
      sharedServices.cache.status.ready, '== true && ',
      sharedServices.monitoring.status.ready, '== true ? "healthy" : "degraded"'
    ),
    
    // Dependency count and readiness percentage
    dependencies: {
      total: 3,
      ready: Cel.expr(
        '(',
        sharedServices.database.status.ready, '? 1 : 0) + (',
        sharedServices.cache.status.ready, '? 1 : 0) + (',
        sharedServices.monitoring.status.ready, '? 1 : 0)'
      ),
      readiness: Cel.expr(
        '((',
        sharedServices.database.status.ready, '? 1 : 0) + (',
        sharedServices.cache.status.ready, '? 1 : 0) + (',
        sharedServices.monitoring.status.ready, '? 1 : 0)) * 100 / 3'
      )
    }
  })
);
```

### External Reference Error Handling

#### Safe External Reference Access

Handle cases where external references might not be available:

```typescript
// Optional external reference with fallback
const optionalCache = externalRef<CacheSpec, CacheStatus>(
  'cache.example.com/v1alpha1',
  'RedisCache',
  'optional-redis',
  'infrastructure'
);

const resilientApp = toResourceGraph(
  { name: 'resilient-app', /* ... */ },
  (schema) => ({
    app: simpleDeployment({
      name: 'resilient-app',
      env: {
        // Fallback cache URL if external reference unavailable
        CACHE_URL: schema.spec.cacheEnabled 
          ? optionalCache.status.connectionString
          : 'redis://localhost:6379',
          
        // Feature flags based on external availability
        CACHE_ENABLED: schema.spec.cacheEnabled,
      }
    })
  }),
  (schema, resources) => ({
    ready: resources.app.status.readyReplicas,
    
    // Status that handles optional dependencies gracefully
    caching: {
      enabled: schema.spec.cacheEnabled,
      ready: schema.spec.cacheEnabled 
        ? optionalCache.status.ready 
        : true,  // Always ready if not using cache
      mode: schema.spec.cacheEnabled ? 'external' : 'disabled'
    },
    
    // Overall readiness independent of optional cache
    overallReady: Cel.expr(
      resources.app.status.readyReplicas, '> 0 && (',
      '!', schema.spec.cacheEnabled, '|| ',
      optionalCache.status.ready, '== true)'
    )
  })
);
```

#### External Reference Validation

Validate external references at deployment time:

```typescript
const criticalDatabase = externalRef<DatabaseSpec, DatabaseStatus>(
  'database.example.com/v1alpha1',
  'Database',
  'critical-postgres',
  'infrastructure'
);

const businessApp = toResourceGraph(
  { name: 'business-app', /* ... */ },
  (schema) => ({
    app: simpleDeployment({
      name: 'business-app',
      env: {
        DATABASE_URL: criticalDatabase.status.connectionString,
      },
      // Add readiness probe that validates database connection
      readinessProbe: {
        httpGet: {
          path: '/health/database',
          port: 3000
        },
        initialDelaySeconds: 30,
        periodSeconds: 10
      }
    })
  }),
  (schema, resources) => ({
    // Application readiness
    ready: resources.app.status.readyReplicas,
    
    // External dependency validation
    database: {
      ready: criticalDatabase.status.ready,
      validated: Cel.expr(
        criticalDatabase.status.ready, '== true && ',
        resources.app.status.readyReplicas, '> 0'
      ),
      lastCheck: new Date().toISOString()
    },
    
    // Error states
    errors: {
      databaseUnavailable: Cel.expr(
        criticalDatabase.status.ready, '== false'
      ),
      connectionFailed: Cel.expr(
        criticalDatabase.status.ready, '== true && ',
        resources.app.status.readyReplicas, '== 0'
      )
    }
  })
);
```

### External Reference Deployment Integration

#### Using External References with Direct Mode

Deploy applications that use external references:

```typescript
// Deploy the external database first (separate operation)
const databaseFactory = databaseGraph.factory('direct');
await databaseFactory.deploy({ 
  name: 'shared-postgres', 
  storage: '100Gi' 
});

// Then deploy application that references it
const appFactory = appWithExternalDb.factory('direct');
await appFactory.deploy({ 
  name: 'my-app',
  image: 'nginx:latest' 
});

// Status will include external dependency information
const status = await appFactory.getStatus();
console.log(status.database.ready); // true/false from external database
```

#### Using External References with KRO Mode

External references in KRO mode create proper ResourceGraphDefinition dependencies:

```typescript
const yaml = appWithExternalDb.toYaml({
  name: 'my-app',
  image: 'nginx:latest'
});

// Generated YAML includes external reference metadata:
// metadata:
//   annotations:
//     kro.run/external-refs: |
//       - apiVersion: database.example.com/v1alpha1
//         kind: Database
//         name: shared-postgres
//         namespace: infrastructure
```

## Runtime Behavior in Different Deployment Modes

### Direct Mode

In direct mode, TypeKro actively manages runtime behavior:

```typescript
const factory = graph.factory('direct', {
  namespace: 'development',
  statusUpdateInterval: 30000  // Update every 30 seconds
});

await factory.deploy(spec);

// Status is automatically hydrated from cluster
const status = await factory.getStatus();
console.log('Live status:', status);

// Listen for status updates
factory.onStatusUpdate((newStatus) => {
  console.log('Status updated:', newStatus);
});

// Cross-references and external references are resolved by querying Kubernetes API
```

### KRO Mode

In KRO mode, runtime behavior is handled by the KRO controller:

```typescript
// Generated ResourceGraphDefinition includes all runtime behavior as CEL expressions
const yaml = graph.toYaml(spec);
console.log(yaml);
// Output includes:
// status:
//   ready: ${deployment.status.readyReplicas > 0}
//   url: ${service.status.loadBalancer.ingress[0].ip}
//   databaseReady: ${external:database.status.ready}
```

### GitOps Mode

Runtime behavior is available through Kubernetes API after deployment:

```bash
# Deploy via GitOps
kubectl apply -f webapp-definition.yaml
kubectl apply -f webapp-instance.yaml

# Check status (includes cross-references and external reference status)
kubectl get webapp my-webapp -o jsonpath='{.status}'
```

## Performance and Optimization

### Optimizing Runtime Behavior

1. **Selective Status Hydration**: Only hydrate frequently accessed status fields
2. **Reference Caching**: Cache cross-reference resolution results
3. **External Reference Batching**: Batch queries for multiple external references
4. **CEL Expression Optimization**: Use efficient CEL expressions

```typescript
const optimizedStatus = (schema, resources) => ({
  // Critical status (updated frequently)
  ready: Cel.expr(resources.app.status.readyReplicas, '> 0'),
  phase: resources.app.status.phase,
  
  // External status (cached)
  externalDependencies: {
    lastChecked: new Date().toISOString(),
    database: database.status.ready,
    cache: cache.status.ready
  },
  
  // Expensive computations (cached for 5 minutes)
  metrics: {
    uptime: Cel.expr(
      '(now() - timestamp("', resources.app.metadata.creationTimestamp, '")) / duration("1s")'
    )
  }
});
```

### Monitoring Runtime Behavior

```typescript
const factory = graph.factory('direct', {
  statusUpdateInterval: 10000,
  onStatusHydrationError: (error) => {
    console.error('Status hydration failed:', error);
  },
  onCrossReferenceResolution: (reference, value) => {
    console.log(`Resolved ${reference} to ${value}`);
  },
  onExternalReferenceUpdate: (externalRef, status) => {
    console.log(`External reference ${externalRef.name} status:`, status);
  }
});
```

## Best Practices

### 1. Design Meaningful Runtime Behavior

```typescript
// ✅ Provide actionable status information
const meaningfulStatus = (schema, resources) => ({
  // High-level state users care about
  phase: 'Ready' | 'Pending' | 'Failed' | 'Degraded',
  
  // Specific operational metrics
  readyReplicas: resources.app.status.readyReplicas,
  
  // External dependency health
  dependencies: {
    database: database.status.ready,
    cache: cache.status.ready
  },
  
  // User-facing information
  endpoint: resources.service.status.loadBalancer.ingress[0].ip,
  
  // Troubleshooting information
  lastError: null,
  issues: []
});
```

### 2. Use Stable References

```typescript
// ✅ Stable - uses service DNS names
DATABASE_URL: Cel.template(
  'postgresql://%s:5432/app',
  dbService.metadata.name
)

// ❌ Fragile - pod IPs can change
DATABASE_URL: Cel.template(
  'postgresql://%s:5432/app',
  database.status.podIP
)
```

### 3. Handle External Reference Failures

```typescript
// ✅ Graceful degradation for external dependencies
const resilientStatus = (schema, resources) => ({
  ready: resources.app.status.readyReplicas,
  
  // External dependency with fallback
  cacheAvailable: schema.spec.enableCache 
    ? externalCache.status.ready 
    : false,
    
  // Overall health considers optional dependencies
  healthy: Cel.expr(
    resources.app.status.readyReplicas, '> 0 && (',
    '!', schema.spec.enableCache, '|| ',
    externalCache.status.ready, '== true)'
  )
});
```

### 4. Structure External References Logically

```typescript
// ✅ Group related external references
const infrastructure = {
  database: externalRef<DatabaseSpec, DatabaseStatus>(...),
  cache: externalRef<CacheSpec, CacheStatus>(...),
  monitoring: externalRef<MonitoringSpec, MonitoringStatus>(...)
};

// ✅ Use consistent naming patterns
const sharedPostgres = externalRef<PostgresSpec, PostgresStatus>(
  'postgresql.cnpg.io/v1',
  'Cluster', 
  'shared-postgres',  // Clear, consistent naming
  'infrastructure'    // Logical namespace grouping
);
```

## Debugging Runtime Behavior

### Enable Debug Logging

```typescript
import { createLogger } from 'typekro';

const logger = createLogger({
  level: 'debug',
  pretty: true
});

const factory = graph.factory('direct', {
  logger,
  debugStatusHydration: true,
  debugCrossReferences: true,
  debugExternalReferences: true
});
```

### Runtime Behavior Inspection

```typescript
// Get raw resource status
const rawStatus = await factory.getRawResourceStatus();
console.log('Raw Kubernetes resource status:', rawStatus);

// Get cross-reference resolution trace
const crossRefTrace = await factory.getCrossReferenceTrace();
console.log('Cross-reference resolution:', crossRefTrace);

// Get external reference status
const externalRefStatus = await factory.getExternalReferenceStatus();
console.log('External reference status:', externalRefStatus);

// Validate all runtime behavior
const validation = await factory.validateRuntimeBehavior();
console.log('Runtime behavior validation:', validation);
```

## Next Steps

- **[CEL Expressions](./cel-expressions.md)** - Master dynamic expressions for runtime behavior
- **[Deployment Methods](./deployment/)** - Learn how runtime behavior works across deployment strategies
- **[Examples](../examples/)** - See runtime behavior in real applications
- **[API Reference](../api/)** - Detailed API documentation for runtime features