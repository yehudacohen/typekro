# Factory Functions API

Factory functions are the building blocks of TypeKro resource graphs. They create type-safe Kubernetes resources with simplified configuration, intelligent defaults, and built-in readiness evaluation.

## Overview

TypeKro provides two categories of factory functions:

1. **Simple Factories** (`simple*`) - Simplified configuration with sensible defaults
2. **Full Factories** - Complete Kubernetes resource specifications for advanced use cases

All factory functions return `Enhanced<TSpec, TStatus>` objects that can be used in resource graphs and reference other resources through the magic proxy system.

## Simple Factory Functions

Simple factories provide streamlined configuration for common Kubernetes resources:

### Workloads

Create application workloads with simplified configuration:

```typescript
import { simpleDeployment, simpleJob, simpleStatefulSet, simpleCronJob } from 'typekro';

// Deployment with minimal configuration
const app = simpleDeployment({
  name: 'web-app',
  image: 'nginx:1.21',
  replicas: 3,
  ports: [80],
  env: {
    NODE_ENV: 'production',
    PORT: '80'
  }
});

// Job for batch processing
const dataJob = simpleJob({
  name: 'data-processor',
  image: 'data-processor:v1.0',
  command: ['process-data'],
  env: {
    INPUT_PATH: '/data/input',
    OUTPUT_PATH: '/data/output'
  }
});

// StatefulSet for databases
const database = simpleStatefulSet({
  name: 'postgres',
  image: 'postgres:13',
  replicas: 3,
  serviceName: 'postgres-headless',
  ports: [5432],
  env: {
    POSTGRES_DB: 'myapp',
    POSTGRES_USER: 'app'
  }
});

// CronJob for scheduled tasks
const backup = simpleCronJob({
  name: 'daily-backup',
  image: 'backup-tool:latest',
  schedule: '0 2 * * *',  // Daily at 2 AM
  command: ['backup-database']
});
```

### Networking

Create networking resources with simplified configuration:

```typescript
import { simpleService, simpleIngress, simpleNetworkPolicy } from 'typekro';

// Service for load balancing
const webService = simpleService({
  name: 'web-service',
  selector: { app: 'web' },
  ports: [{ port: 80, targetPort: 8080 }],
  type: 'ClusterIP'
});

// Ingress for external access
const webIngress = simpleIngress({
  name: 'web-ingress',
  host: 'app.example.com',
  serviceName: 'web-service',
  servicePort: 80,
  path: '/',
  ingressClassName: 'nginx'
});

// Network policy for security
const appPolicy = simpleNetworkPolicy({
  name: 'app-network-policy',
  podSelector: { matchLabels: { app: 'web' } },
  policyTypes: ['Ingress'],
  ingress: [{
    from: [{ podSelector: { matchLabels: { tier: 'frontend' } } }],
    ports: [{ protocol: 'TCP', port: 8080 }]
  }]
});
```

### Configuration

Create configuration resources:

```typescript
import { simpleConfigMap, simpleSecret } from 'typekro';

// ConfigMap for application configuration
const appConfig = simpleConfigMap({
  name: 'app-config',
  data: {
    apiUrl: 'https://api.example.com',
    logLevel: 'info',
    timeout: '30s'
  }
});

// Secret for sensitive data
const appSecrets = simpleSecret({
  name: 'app-secrets',
  data: {
    dbPassword: 'encoded-password',
    apiKey: 'encoded-api-key'
  }
});
```

### Storage

Create storage resources:

```typescript
import { simplePvc } from 'typekro';

// Persistent Volume Claim
const appStorage = simplePvc({
  name: 'app-storage',
  accessModes: ['ReadWriteOnce'],
  size: '10Gi',
  storageClass: 'fast-ssd'
});
```

### Autoscaling

Create autoscaling resources:

```typescript
import { simpleHpa } from 'typekro';

// Horizontal Pod Autoscaler
const appAutoscaler = simpleHpa({
  name: 'app-hpa',
  targetRef: {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    name: 'web-app'
  },
  minReplicas: 2,
  maxReplicas: 10,
  targetCPUUtilizationPercentage: 70
});
```

## Using Factory Functions in Resource Graphs

Factory functions are designed to work seamlessly with `toResourceGraph()`:

```typescript
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService, simpleConfigMap, Cel } from 'typekro';

const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: 'string'
});

const webapp = toResourceGraph(
  {
    name: 'full-webapp',
    apiVersion: 'example.com/v1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: type({ ready: 'boolean', url: 'string' })
  },
  (schema) => ({
    // Configuration first
    config: simpleConfigMap({
      name: Cel.template('%s-config', schema.spec.name),
      data: {
        environment: schema.spec.environment,
        logLevel: Cel.conditional(
          schema.spec.environment === 'production',
          'warn',
          'debug'
        )
      }
    }),
    
    // Application deployment
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [8080],
      env: {
        NODE_ENV: schema.spec.environment,
        LOG_LEVEL: 'info'  // Could reference config.data.logLevel
      }
    }),
    
    // Service for the deployment
    service: simpleService({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 8080 }]
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.deployment.status.readyReplicas, ' >= ', schema.spec.replicas),
    url: Cel.template('http://%s', resources.service.spec.clusterIP)
  })
);
```

## Advanced Factory Functions

For scenarios requiring complete control, TypeKro also provides full factory functions that accept complete Kubernetes resource specifications:

```typescript
import { deployment, service, configMap, secret } from 'typekro';

// Full deployment specification
const advancedDeployment = deployment({
  metadata: {
    name: 'advanced-app',
    labels: { app: 'advanced', tier: 'backend' },
    annotations: { 'deployment.kubernetes.io/revision': '1' }
  },
  spec: {
    replicas: 3,
    strategy: {
      type: 'RollingUpdate',
      rollingUpdate: {
        maxSurge: 1,
        maxUnavailable: 1
      }
    },
    selector: {
      matchLabels: { app: 'advanced' }
    },
    template: {
      metadata: {
        labels: { app: 'advanced', tier: 'backend' }
      },
      spec: {
        containers: [{
          name: 'app',
          image: 'myapp:v1.0',
          ports: [{ containerPort: 8080 }],
          resources: {
            requests: { cpu: '100m', memory: '128Mi' },
            limits: { cpu: '500m', memory: '512Mi' }
          },
          livenessProbe: {
            httpGet: { path: '/health', port: 8080 },
            initialDelaySeconds: 30,
            periodSeconds: 10
          },
          readinessProbe: {
            httpGet: { path: '/ready', port: 8080 },
            initialDelaySeconds: 5,
            periodSeconds: 5
          }
        }]
      }
    }
  }
});
```

## Cross-Resource References

Factory functions support cross-resource references through the magic proxy system:

```typescript
const microservices = toResourceGraph(
  {
    name: 'microservices',
    apiVersion: 'platform.example.com/v1',
    kind: 'Microservices',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Database configuration
    dbConfig: simpleConfigMap({
      name: 'db-config',
      data: {
        host: 'postgres',
        port: '5432',
        database: schema.spec.name
      }
    }),
    
    // Database deployment
    database: simpleDeployment({
      name: 'postgres',
      image: 'postgres:13',
      env: {
        POSTGRES_DB: schema.spec.name,  // Schema reference
        POSTGRES_USER: 'app'
      }
    }),
    
    // Database service
    dbService: simpleService({
      name: 'postgres',
      selector: { app: 'postgres' },
      ports: [{ port: 5432, targetPort: 5432 }]
    }),
    
    // API server that references database
    api: simpleDeployment({
      name: 'api',
      image: 'myapp/api:latest',
      env: {
        // Reference to database service (runtime resolution)
        DATABASE_URL: Cel.template(
          'postgres://app@%s:5432/%s',
          'postgres',  // References dbService.spec.clusterIP at runtime
          schema.spec.name
        )
      }
    }),
    
    // API service
    apiService: simpleService({
      name: 'api',
      selector: { app: 'api' },
      ports: [{ port: 8080, targetPort: 8080 }]
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.database.status.readyReplicas, ' > 0 && ',
      resources.api.status.readyReplicas, ' > 0'
    )
  })
);
```

## Function Categories

### Core Workloads
- `simpleDeployment()` - Stateless applications
- `simpleStatefulSet()` - Stateful applications
- `simpleJob()` - Batch processing
- `simpleCronJob()` - Scheduled tasks

### Networking
- `simpleService()` - Load balancing and service discovery
- `simpleIngress()` - External HTTP/HTTPS access
- `simpleNetworkPolicy()` - Network security policies

### Configuration & Storage
- `simpleConfigMap()` - Configuration data
- `simpleSecret()` - Sensitive data
- `simplePvc()` - Persistent storage

### Autoscaling
- `simpleHpa()` - Horizontal Pod Autoscaler

### Advanced Resources
- `deployment()`, `job()`, `statefulSet()`, etc. - Full Kubernetes specifications
- `customResource()` - Custom Resource Definitions
- `helmRelease()` - Helm chart deployments
- `yamlFile()`, `yamlDirectory()` - External YAML integration

## Best Practices

### 1. Start with Simple Functions

Begin with simple factory functions and only use full factories when you need advanced configuration:

```typescript
// Good: Start simple
const app = simpleDeployment({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3
});

// Only when you need advanced features
const advancedApp = deployment({
  metadata: { /* ... */ },
  spec: { /* complex configuration */ }
});
```

### 2. Use Schema References

Leverage schema references for dynamic configuration:

```typescript
(schema) => ({
  deployment: simpleDeployment({
    name: schema.spec.name,           // Dynamic from input
    image: schema.spec.image,         // Dynamic from input
    replicas: schema.spec.replicas,   // Dynamic from input
    env: {
      ENVIRONMENT: schema.spec.environment  // Schema reference
    }
  })
})
```

### 3. Group Related Resources

Organize related resources together in your resource builder:

```typescript
(schema) => ({
  // Storage layer
  database: simpleStatefulSet({ /* ... */ }),
  dbService: simpleService({ /* ... */ }),
  
  // Application layer
  api: simpleDeployment({ /* ... */ }),
  apiService: simpleService({ /* ... */ }),
  
  // Ingress layer
  ingress: simpleIngress({ /* ... */ })
})
```

### 4. Use Meaningful Names

Choose descriptive names that reflect the resource's purpose:

```typescript
// Good
const userApiDeployment = simpleDeployment({
  name: 'user-api',
  image: 'myapp/user-api:v1.0'
});

const userApiService = simpleService({
  name: 'user-api-service',
  selector: { app: 'user-api' }
});

// Avoid
const deploy1 = simpleDeployment({ /* ... */ });
const svc = simpleService({ /* ... */ });
```

## Type Safety

All factory functions provide full TypeScript type safety:

```typescript
// TypeScript will validate all parameters
const deployment = simpleDeployment({
  name: 'my-app',           // ✅ string
  image: 'nginx:latest',    // ✅ string
  replicas: 3,              // ✅ number
  ports: [80, 443],         // ✅ number[]
  invalid: 'parameter'      // ❌ Type error
});

// Schema references are also type-safe
(schema) => ({
  deployment: simpleDeployment({
    name: schema.spec.name,     // ✅ Type: string
    replicas: schema.spec.count // ❌ Type error if 'count' doesn't exist
  })
})
```

## Related APIs

- [Workloads API](/api/factories/workloads) - Detailed workload factory documentation
- [Networking API](/api/factories/networking) - Detailed networking factory documentation  
- [toResourceGraph API](/api/to-resource-graph) - Resource graph creation
- [CEL Expressions API](/api/cel) - Dynamic value computation
- [Types API](/api/types) - TypeScript type definitions