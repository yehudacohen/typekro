# Resource Graphs

Resource graphs are the fundamental building blocks of TypeKro. They define collections of related Kubernetes resources with type-safe schemas and runtime dependencies. This guide covers everything you need to know about creating, composing, and deploying resource graphs.

## What is a Resource Graph?

A resource graph is a typed collection of Kubernetes resources that can reference each other's properties at runtime. Think of it as a blueprint for infrastructure that includes:

- **Resource definitions** - The actual Kubernetes resources (Deployments, Services, etc.)
- **Cross-resource references** - Dynamic connections between resources
- **Type-safe schema** - Input/output contracts with validation
- **Status mapping** - How runtime state is exposed to users

```typescript
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService } from 'typekro';

const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number'
});

const WebAppStatus = type({
  url: 'string',
  phase: 'string'
});

const webApp = toResourceGraph(
  // Graph definition
  { name: 'webapp', schema: { spec: WebAppSpec, status: WebAppStatus } },
  
  // Resource builder - defines what resources to create
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas
    }),
    service: simpleService({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    })
  }),
  
  // Status builder - defines how to compute status
  (schema, resources) => ({
    url: `http://${resources.service.status.loadBalancer.ingress[0].ip}`,
    phase: resources.deployment.status.phase
  })
);
```

## Resource Graph Components

### 1. Graph Definition

The first parameter defines the resource graph metadata:

```typescript
const definition = {
  name: 'my-application',           // Must be a valid Kubernetes resource name
  schema: {
    spec: MyAppSpec,                // Input schema (required)
    status: MyAppStatus             // Output schema (optional)
  }
};
```

### 2. Resource Builder

The resource builder function creates the actual Kubernetes resources:

```typescript
const resourceBuilder = (schema) => ({
  // Each key becomes a resource ID
  database: simpleDeployment({
    name: `${schema.spec.name}-db`,
    image: 'postgres:15',
    env: {
      POSTGRES_DB: schema.spec.database.name,
      POSTGRES_USER: schema.spec.database.user
    }
  }),
  
  app: simpleDeployment({
    name: schema.spec.name,
    image: schema.spec.image,
    env: {
      // Cross-resource reference
      DATABASE_HOST: database.status.podIP
    }
  }),
  
  service: simpleService({
    name: `${schema.spec.name}-service`,
    selector: { app: schema.spec.name },
    ports: [{ port: 80, targetPort: 3000 }]
  })
});
```

### 3. Status Builder

The status builder computes dynamic status based on resource state:

```typescript
const statusBuilder = (schema, resources) => ({
  // Simple field mapping
  phase: resources.app.status.phase,
  readyReplicas: resources.app.status.readyReplicas,
  
  // Computed values
  url: schema.spec.environment === 'production'
    ? `https://${resources.service.status.loadBalancer.ingress[0].hostname}`
    : `http://${resources.service.spec.clusterIP}`,
    
  // Complex logic with CEL expressions
  ready: Cel.expr(
    resources.app.status.readyReplicas, 
    '> 0 && ',
    resources.database.status.readyReplicas,
    '> 0'
  )
});
```

## Resource Graph Patterns

### Basic Application Stack

```typescript
const basicStack = toResourceGraph(
  { name: 'basic-stack', schema: { spec: BasicStackSpec } },
  (schema) => ({
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas
    }),
    
    service: simpleService({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    })
  }),
  (schema, resources) => ({
    serviceEndpoint: `http://${resources.service.spec.clusterIP}:80`
  })
);
```

### Database Integration

```typescript
const databaseStack = toResourceGraph(
  { name: 'database-stack', schema: { spec: DatabaseStackSpec } },
  (schema) => ({
    database: simpleDeployment({
      name: `${schema.spec.name}-db`,
      image: 'postgres:15',
      env: {
        POSTGRES_DB: schema.spec.database.name,
        POSTGRES_USER: schema.spec.database.user,
        POSTGRES_PASSWORD: schema.spec.database.password
      },
      ports: [{ containerPort: 5432 }]
    }),
    
    dbService: simpleService({
      name: `${schema.spec.name}-db-service`,
      selector: { app: `${schema.spec.name}-db` },
      ports: [{ port: 5432, targetPort: 5432 }]
    }),
    
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      env: {
        DATABASE_URL: `postgresql://${schema.spec.database.user}:${schema.spec.database.password}@${dbService.metadata.name}:5432/${schema.spec.database.name}`
      }
    }),
    
    appService: simpleService({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    })
  }),
  (schema, resources) => ({
    appUrl: `http://${resources.appService.spec.clusterIP}`,
    databaseHost: resources.dbService.spec.clusterIP,
    ready: Cel.expr(
      resources.app.status.readyReplicas, '> 0 && ',
      resources.database.status.readyReplicas, '> 0'
    )
  })
);
```

### Microservices Architecture

```typescript
const microservicesStack = toResourceGraph(
  { name: 'microservices', schema: { spec: MicroservicesSpec } },
  (schema) => ({
    // API Gateway
    gateway: simpleDeployment({
      name: `${schema.spec.name}-gateway`,
      image: schema.spec.gateway.image,
      ports: [{ containerPort: 8080 }],
      env: {
        USER_SERVICE_URL: `http://user-service:3000`,
        ORDER_SERVICE_URL: `http://order-service:3000`
      }
    }),
    
    gatewayService: simpleService({
      name: 'gateway-service',
      selector: { app: `${schema.spec.name}-gateway` },
      ports: [{ port: 80, targetPort: 8080 }],
      type: 'LoadBalancer'
    }),
    
    // User Service
    userService: simpleDeployment({
      name: 'user-service',
      image: schema.spec.services.user.image,
      replicas: schema.spec.services.user.replicas,
      ports: [{ containerPort: 3000 }]
    }),
    
    userServiceSvc: simpleService({
      name: 'user-service',
      selector: { app: 'user-service' },
      ports: [{ port: 3000, targetPort: 3000 }]
    }),
    
    // Order Service
    orderService: simpleDeployment({
      name: 'order-service',
      image: schema.spec.services.order.image,
      replicas: schema.spec.services.order.replicas,
      ports: [{ containerPort: 3000 }],
      env: {
        USER_SERVICE_URL: `http://user-service:3000`
      }
    }),
    
    orderServiceSvc: simpleService({
      name: 'order-service',
      selector: { app: 'order-service' },
      ports: [{ port: 3000, targetPort: 3000 }]
    })
  }),
  (schema, resources) => ({
    gatewayUrl: `http://${resources.gatewayService.status.loadBalancer.ingress[0].ip}`,
    servicesReady: Cel.expr(
      resources.userService.status.readyReplicas, '> 0 && ',
      resources.orderService.status.readyReplicas, '> 0'
    )
  })
);
```

## Environment-Specific Configuration

### Conditional Resources

```typescript
const adaptiveStack = toResourceGraph(
  { name: 'adaptive-stack', schema: { spec: AdaptiveStackSpec } },
  (schema) => ({
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.environment === 'production' ? 5 : 2,
      resources: schema.spec.environment === 'production'
        ? { cpu: '1000m', memory: '2Gi' }
        : { cpu: '100m', memory: '256Mi' }
    }),
    
    service: simpleService({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: schema.spec.environment === 'production' ? 'LoadBalancer' : 'ClusterIP'
    }),
    
    // Only create ingress in production
    ...(schema.spec.environment === 'production' && {
      ingress: simpleIngress({
        name: `${schema.spec.name}-ingress`,
        rules: [{
          host: `${schema.spec.name}.${schema.spec.domain}`,
          http: {
            paths: [{
              path: '/',
              pathType: 'Prefix',
              backend: {
                service: {
                  name: service.metadata.name,
                  port: { number: 80 }
                }
              }
            }]
          }
        }],
        tls: [{
          secretName: `${schema.spec.name}-tls`,
          hosts: [`${schema.spec.name}.${schema.spec.domain}`]
        }]
      })
    })
  }),
  (schema, resources) => ({
    url: schema.spec.environment === 'production'
      ? `https://${schema.spec.name}.${schema.spec.domain}`
      : `http://${resources.service.spec.clusterIP}`,
    environment: schema.spec.environment,
    replicas: resources.app.status.readyReplicas
  })
);
```

### Configuration Management

```typescript
const configuredStack = toResourceGraph(
  { name: 'configured-stack', schema: { spec: ConfiguredStackSpec } },
  (schema) => ({
    config: simpleConfigMap({
      name: `${schema.spec.name}-config`,
      data: {
        'app.properties': `
          environment=${schema.spec.environment}
          log.level=${schema.spec.environment === 'production' ? 'info' : 'debug'}
          features.auth=${schema.spec.features.auth}
          features.metrics=${schema.spec.features.metrics}
        `,
        'database.conf': `
          host=${schema.spec.database.host}
          port=${schema.spec.database.port}
          name=${schema.spec.database.name}
        `
      }
    }),
    
    secrets: simpleSecret({
      name: `${schema.spec.name}-secrets`,
      stringData: {
        'database-password': schema.spec.database.password,
        'jwt-secret': schema.spec.security.jwtSecret,
        'api-key': schema.spec.security.apiKey
      }
    }),
    
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      env: {
        CONFIG_PATH: '/etc/config',
        SECRETS_PATH: '/etc/secrets'
      },
      volumeMounts: [
        { name: 'config', mountPath: '/etc/config' },
        { name: 'secrets', mountPath: '/etc/secrets', readOnly: true }
      ],
      volumes: [
        { name: 'config', configMap: { name: config.metadata.name } },
        { name: 'secrets', secret: { secretName: secrets.metadata.name } }
      ]
    })
  }),
  (schema, resources) => ({
    configurationReady: Cel.expr(
      `"${resources.config.metadata.name}" != "" && "${resources.secrets.metadata.name}" != ""`
    )
  })
);
```

## Advanced Resource Graph Features

### Cross-Graph References

```typescript
// Shared database graph
const sharedDatabase = toResourceGraph(
  { name: 'shared-database', schema: { spec: DatabaseSpec } },
  (schema) => ({
    database: simpleDeployment({
      name: schema.spec.name,
      image: 'postgres:15'
    }),
    service: simpleService({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 5432, targetPort: 5432 }]
    })
  }),
  (schema, resources) => ({
    host: resources.service.spec.clusterIP,
    port: 5432,
    ready: Cel.expr(resources.database.status.readyReplicas, '> 0')
  })
);

// Application that uses shared database
const appWithSharedDb = toResourceGraph(
  { name: 'app-with-shared-db', schema: { spec: AppSpec } },
  (schema) => ({
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      env: {
        // Reference external database
        DATABASE_URL: `postgresql://user:pass@${schema.spec.database.host}:${schema.spec.database.port}/myapp`
      }
    })
  }),
  (schema, resources) => ({
    phase: resources.app.status.phase
  })
);
```

### Dynamic Resource Creation

```typescript
const dynamicStack = toResourceGraph(
  { name: 'dynamic-stack', schema: { spec: DynamicStackSpec } },
  (schema) => {
    const resources: Record<string, any> = {};
    
    // Create multiple worker deployments
    for (let i = 0; i < schema.spec.workers.count; i++) {
      resources[`worker-${i}`] = simpleDeployment({
        name: `${schema.spec.name}-worker-${i}`,
        image: schema.spec.workers.image,
        env: {
          WORKER_ID: i.toString(),
          TOTAL_WORKERS: schema.spec.workers.count.toString()
        }
      });
    }
    
    // Main application
    resources.app = simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      env: {
        WORKER_COUNT: schema.spec.workers.count.toString()
      }
    });
    
    return resources;
  },
  (schema, resources) => ({
    workerCount: schema.spec.workers.count,
    readyWorkers: Object.keys(resources)
      .filter(key => key.startsWith('worker-'))
      .reduce((sum, key) => sum + (resources[key].status.readyReplicas || 0), 0)
  })
);
```

## Resource Graph Validation

### Schema Validation

```typescript
import { type } from 'arktype';

const StrictAppSpec = type({
  name: 'string>2',  // At least 3 characters
  image: 'string',
  replicas: 'number>0',  // At least 1
  environment: '"development" | "staging" | "production"',
  resources: {
    cpu: 'string',
    memory: 'string'
  }
});

// Validation happens automatically
const validatedApp = toResourceGraph(
  { name: 'validated-app', schema: { spec: StrictAppSpec } },
  resourceBuilder,
  statusBuilder
);
```

### Runtime Validation

```typescript
try {
  const factory = await graph.factory('direct');
  await factory.deploy(spec);
} catch (error) {
  if (error instanceof SchemaValidationError) {
    console.error('Invalid spec:', error.errors);
  }
}
```

## Deployment Strategies

### Direct Deployment

```typescript
const factory = await graph.factory('direct', {
  namespace: 'development',
  timeout: 300000
});

const instance = await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3
});
```

### YAML Generation

```typescript
// Generate ResourceGraphDefinition
const rgdYaml = graph.toYaml();

// Generate instance YAML
const instanceYaml = graph.toYaml({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3
});
```

### KRO Integration

```typescript
const kroFactory = await graph.factory('kro', {
  namespace: 'production'
});

await kroFactory.deploy(spec);
```

## Best Practices

### 1. Resource Naming

```typescript
// ✅ Use consistent naming patterns
const resources = {
  database: simpleDeployment({ name: `${schema.spec.name}-db` }),
  databaseService: simpleService({ name: `${schema.spec.name}-db-service` }),
  app: simpleDeployment({ name: schema.spec.name }),
  appService: simpleService({ name: `${schema.spec.name}-service` })
};

// ❌ Avoid inconsistent naming
const badResources = {
  db: simpleDeployment({ name: 'database' }),
  dbSvc: simpleService({ name: 'db-service' }),
  application: simpleDeployment({ name: 'app' }),
  service: simpleService({ name: 'svc' })
};
```

### 2. Environment Configuration

```typescript
// ✅ Use environment-specific logic
const getConfig = (env: string) => ({
  development: { replicas: 1, resources: { cpu: '100m', memory: '256Mi' } },
  staging: { replicas: 2, resources: { cpu: '200m', memory: '512Mi' } },
  production: { replicas: 5, resources: { cpu: '500m', memory: '1Gi' } }
}[env] || { replicas: 1, resources: { cpu: '100m', memory: '256Mi' } });
```

### 3. Resource Organization

```typescript
// ✅ Group related resources logically
const resources = {
  // Database tier
  database: simpleDeployment({ /* ... */ }),
  databaseService: simpleService({ /* ... */ }),
  
  // Application tier
  app: simpleDeployment({ /* ... */ }),
  appService: simpleService({ /* ... */ }),
  
  // Configuration
  config: simpleConfigMap({ /* ... */ }),
  secrets: simpleSecret({ /* ... */ })
};
```

### 4. Status Design

```typescript
// ✅ Provide meaningful status
const statusBuilder = (schema, resources) => ({
  // Deployment state
  phase: resources.app.status.phase,
  readyReplicas: resources.app.status.readyReplicas,
  totalReplicas: resources.app.spec.replicas,
  
  // Service information
  serviceEndpoint: `http://${resources.service.spec.clusterIP}:80`,
  
  // Overall health
  healthy: Cel.expr(
    resources.app.status.readyReplicas, 
    '== ', 
    resources.app.spec.replicas
  ),
  
  // Timestamp
  lastUpdated: new Date().toISOString()
});
```

## Troubleshooting

### Common Issues

**Schema validation errors:**
```typescript
// Check your type definitions
const AppSpec = type({
  name: 'string',
  replicas: 'number'  // Make sure types match usage
});
```

**Resource reference errors:**
```typescript
// Ensure referenced resources exist in the same graph
const resources = {
  database: simpleDeployment({ name: 'db' }),
  app: simpleDeployment({
    env: {
      DB_HOST: database.status.podIP  // 'database' must be defined above
    }
  })
};
```

**Circular dependencies:**
```typescript
// ❌ Avoid circular references
const serviceA = simpleService({
  selector: { app: serviceB.metadata.labels.app }  // References B
});
const serviceB = simpleService({
  selector: { app: serviceA.metadata.labels.app }  // References A
});
```

## Next Steps

- **[Status Hydration](./status-hydration.md)** - Learn how status is computed and updated
- **[Cross-Resource References](./cross-references.md)** - Deep dive into resource interconnection
- **[CEL Expressions](./cel-expressions.md)** - Add runtime logic to your graphs
- **[Direct Deployment](./direct-deployment.md)** - Deploy graphs directly to Kubernetes