# Cross-Resource References

One of TypeKro's most powerful features is the ability to create dynamic references between resources. This enables truly interconnected infrastructure where resources can reference each other's runtime properties.

## Basic Cross-References

### Simple Field References

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

### Service References

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
    DATABASE_URL: `postgresql://postgres:password@${dbService.metadata.name}:5432/myapp`
  }
});
```

## Advanced Reference Patterns

### Conditional References

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

### Nested Field References

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
    PUBLIC_URL: `https://${ingress.status.loadBalancer.ingress[0].hostname}`,
    
    // Reference array elements
    FIRST_NODE_IP: cluster.status.nodes[0].addresses.find(addr => addr.type === 'InternalIP').address
  }
});
```

## Reference Types

### Status References

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

### Metadata References

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

### Spec References

Reference resource specifications:

```typescript
// Replica counts
MAX_CONNECTIONS: deployment.spec.replicas * 100

// Port numbers
HEALTH_CHECK_PORT: service.spec.ports[0].targetPort

// Image tags
IMAGE_VERSION: deployment.spec.template.spec.containers[0].image.split(':')[1]
```

## CEL Expression Integration

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
      `${app.status.readyReplicas} == ${app.spec.replicas} && ${database.status.readyReplicas} > 0`,
      '? "ready" : "waiting"'
    )
  }
});
```

## Reference Resolution

### Runtime Resolution

References are resolved at deployment time:

```typescript
// At build time: creates a reference object
const dbHost = database.status.podIP;

// At deployment time: resolves to actual IP
// DATABASE_HOST=10.244.1.15
```

### Deployment Modes

Different deployment modes handle references differently:

#### Direct Mode
References are resolved by querying the Kubernetes API:

```typescript
const factory = await graph.factory('direct');
// TypeKro queries the cluster to resolve references
await factory.deploy(spec);
```

#### Kro Mode
References become CEL expressions in the ResourceGraphDefinition:

```typescript
const yaml = graph.toYaml(spec);
// Generates: DATABASE_HOST: ${database.status.podIP}
```

## Error Handling

### Reference Validation

TypeKro validates references at build time:

```typescript
// ✅ Valid reference
const validRef = database.status.podIP;

// ❌ Invalid reference (TypeScript error)
const invalidRef = database.status.nonExistentField;
```

### Runtime Errors

Handle reference resolution failures:

```typescript
try {
  await factory.deploy(spec);
} catch (error) {
  if (error instanceof ReferenceResolutionError) {
    console.error('Failed to resolve reference:', error.reference);
    console.error('Target resource:', error.targetResource);
  }
}
```

## Best Practices

### 1. Use Service References for Stability

```typescript
// ✅ Stable - uses service DNS
DATABASE_URL: `postgresql://${dbService.metadata.name}:5432/app`

// ❌ Fragile - pod IPs can change
DATABASE_URL: `postgresql://${database.status.podIP}:5432/app`
```

### 2. Provide Fallbacks

```typescript
const app = simpleDeployment({
  env: {
    // Fallback to default if external service unavailable
    CACHE_URL: externalCache?.status?.endpoint || 'redis://localhost:6379'
  }
});
```

### 3. Use Descriptive Variable Names

```typescript
// ✅ Clear intent
const userDatabaseHost = userDb.status.podIP;
const sessionCacheEndpoint = redisService.status.loadBalancer.ingress[0].ip;

// ❌ Unclear
const host1 = db1.status.podIP;
const endpoint = svc.status.loadBalancer.ingress[0].ip;
```

### 4. Group Related References

```typescript
const databaseConfig = {
  host: database.status.podIP,
  port: dbService.spec.ports[0].port,
  name: 'myapp',
  user: 'postgres'
};

const app = simpleDeployment({
  env: {
    DATABASE_URL: `postgresql://${databaseConfig.user}@${databaseConfig.host}:${databaseConfig.port}/${databaseConfig.name}`
  }
});
```

## Common Patterns

### Service Discovery

```typescript
const services = {
  api: simpleService({ name: 'api-service' }),
  cache: simpleService({ name: 'cache-service' }),
  database: simpleService({ name: 'db-service' })
};

const frontend = simpleDeployment({
  name: 'frontend',
  env: {
    API_URL: Cel.template("http://%s", [reference]):${services.api.spec.ports[0].port}`,
    CACHE_URL: `redis://${services.cache.metadata.name}:${services.cache.spec.ports[0].port}`,
    DB_URL: `postgresql://${services.database.metadata.name}:${services.database.spec.ports[0].port}/app`
  }
});
```

### Load Balancer Integration

```typescript
const webService = simpleService({
  name: 'web-service',
  type: 'LoadBalancer'
});

const app = simpleDeployment({
  name: 'web-app',
  env: {
    // Reference the external load balancer IP
    PUBLIC_URL: `https://${webService.status.loadBalancer.ingress[0].ip}`,
    
    // Or hostname for cloud providers
    PUBLIC_HOSTNAME: webService.status.loadBalancer.ingress[0].hostname
  }
});
```

### Configuration Propagation

```typescript
const config = simpleConfigMap({
  name: 'app-config',
  data: {
    'database.host': database.status.podIP,
    'cache.endpoint': cache.status.podIP,
    'api.version': 'v1.2.3'
  }
});

const app = simpleDeployment({
  name: 'web-app',
  volumeMounts: [{
    name: 'config',
    mountPath: '/etc/config'
  }],
  volumes: [{
    name: 'config',
    configMap: { name: config.metadata.name }
  }]
});
```

## Troubleshooting

### Common Issues

**Reference not found:**
```typescript
// Make sure the referenced resource exists in the same graph
const graph = toResourceGraph(
  {
    name: 'my-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'MyApp',
    spec: MyAppSpec,
    status: MyAppStatus,
  },
  (schema) => ({
  database: simpleDeployment({ name: 'db' }),
  app: simpleDeployment({
    env: {
      DB_HOST: database.status.podIP  // ✅ database is defined above
    }
  })
}));
```

**Circular references:**
```typescript
// ❌ Avoid circular references
const serviceA = simpleService({
  selector: { app: serviceB.metadata.labels.app }  // References B
});

const serviceB = simpleService({
  selector: { app: serviceA.metadata.labels.app }  // References A
});
```

**Type errors:**
```typescript
// ✅ Ensure types match
const port: number = service.spec.ports[0].port;

// ❌ Type mismatch
const port: string = service.spec.ports[0].port;  // number not assignable to string
```

## Next Steps

- **[CEL Expressions](./cel-expressions.md)** - Add runtime logic to references
- **[Status Hydration](./status-hydration.md)** - Understand how status is populated
- **[Examples](../examples/)** - See cross-references in real applications