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
      name: Cel.expr(schema.spec.name, '-service'),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    })
  }),
  (schema, resources) => ({
    serviceEndpoint: Cel.template('http://%s:80', resources.service.spec.clusterIP)
  })
  }),
  
  // Status builder - defines how to compute status
  (schema, resources) => ({
    url: Cel.template('http://%s', resources.service.status.loadBalancer.ingress[0].ip),
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
      name: Cel.expr(schema.spec.name, '-db'),
      image: 'postgres:15',
      env: {
        POSTGRES_DB: schema.spec.database.name,
        POSTGRES_USER: schema.spec.database.user,
        POSTGRES_PASSWORD: schema.spec.database.password
      },
      ports: [{ containerPort: 5432 }]
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
      name: Cel.expr(schema.spec.name, '-service'),
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
    ? Cel.template('https://%s', resources.service.status.loadBalancer.ingress[0].hostname)
    : Cel.template('http://%s', resources.service.spec.clusterIP),
    
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
    name: Cel.expr(schema.spec.name, '-service'),
    selector: { app: schema.spec.name },
    ports: [{ port: 80, targetPort: 3000 }]
  })
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
  database: simpleDeployment({ name: Cel.expr(schema.spec.name, '-db') }),
  databaseService: simpleService({ name: Cel.expr(schema.spec.name, '-db-service') }),
  app: simpleDeployment({ name: schema.spec.name }),
  appService: simpleService({ name: Cel.expr(schema.spec.name, '-service') })
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
  serviceEndpoint: Cel.template('http://%s:80', resources.service.spec.clusterIP),
  
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