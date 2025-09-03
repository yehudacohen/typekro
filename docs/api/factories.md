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
import { Deployment, Service, Ingress, ConfigMap, Secret, Job, CronJob, Hpa, Pvc, StatefulSet, DaemonSet, NetworkPolicy } from 'typekro/simple';

// Deployment with minimal configuration
const app = Deployment({
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
const dataJob = Job({
  name: 'data-processor',
  image: 'data-processor:v1.0',
  command: ['process-data'],
  env: {
    INPUT_PATH: '/data/input',
    OUTPUT_PATH: '/data/output'
  }
});

// StatefulSet for databases
const database = StatefulSet({
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
const backup = CronJob({
  name: 'daily-backup',
  image: 'backup-tool:latest',
  schedule: '0 2 * * *',  // Daily at 2 AM
  command: ['backup-database']
});
```

### Networking

Create networking resources with simplified configuration:

```typescript
import { Deployment, Service, Ingress, ConfigMap, Secret, Job, CronJob, Hpa, Pvc, StatefulSet, DaemonSet, NetworkPolicy } from 'typekro/simple';

// Service for load balancing
// In a resource graph context where you have a deployment:
const webService = Service({
  name: 'web-service',
  selector: resources.webDeployment.spec.selector.matchLabels,  // Reference deployment labels
  ports: [{ port: 80, targetPort: 8080 }],
  type: 'ClusterIP'
});

// Ingress for external access
const webIngress = Ingress({
  name: 'web-ingress',
  host: 'app.example.com',
  serviceName: 'web-service',
  servicePort: 80,
  path: '/',
  ingressClassName: 'nginx'
});

// Network policy for security
const appPolicy = NetworkPolicy({
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
import { simple } from 'typekro';

// ConfigMap for application configuration
const appConfig = simple({
  name: 'app-config',
  data: {
    apiUrl: 'https://api.example.com',
    logLevel: 'info',
    timeout: '30s'
  }
});

// Secret for sensitive data
const appSecrets = Secret({
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
import { simple } from 'typekro';

// Persistent Volume Claim
const appStorage = Pvc({
  name: 'app-storage',
  accessModes: ['ReadWriteOnce'],
  size: '10Gi',
  storageClass: 'fast-ssd'
});
```

### Autoscaling

Create autoscaling resources:

```typescript
import { simple } from 'typekro';

// Horizontal Pod Autoscaler
const appAutoscaler = Hpa({
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

### YAML Integration

Integrate existing YAML manifests into TypeKro compositions:

```typescript
import { yamlFile, yamlDirectory } from 'typekro';

// Deploy single YAML file
const fluxSystem = yamlFile({
  name: 'flux-system',
  path: 'https://github.com/fluxcd/flux2/releases/latest/download/install.yaml',
  deploymentStrategy: 'skipIfExists'
});

// Deploy YAML directory with filtering
const appManifests = yamlDirectory({
  name: 'legacy-manifests',
  path: './k8s-manifests',
  recursive: true,
  include: ['*.yaml', '*.yml'],
  exclude: ['*-test.yaml'],
  namespace: 'production'
});

// Use in compositions alongside Enhanced resources
const composition = kubernetesComposition(definition, (spec) => {
  // YAML deployment closures
  const externalConfig = yamlFile({
    name: 'external-config',
    path: './manifests/config.yaml'
  });

  // Enhanced resources
  const app = Deployment({
    name: spec.name,
    image: spec.image
  });

  return {
    // ✨ JavaScript expressions automatically converted to CEL
    ready: app.status.readyReplicas > 0,
    // YAML files don't have status - use static values
    configDeployed: true
  };
});
```

**Configuration Options:**

- **`path`**: Local file/directory path or Git URL (`git:github.com/org/repo/path@ref`)
- **`deploymentStrategy`**: `'replace'` (default), `'skipIfExists'`, or `'fail'`
- **`namespace`**: Target namespace for all resources
- **`recursive`**: Search subdirectories (yamlDirectory only)
- **`include`/`exclude`**: Glob patterns for file filtering (yamlDirectory only)

## Using Factory Functions in Resource Graphs

Factory functions are designed to work seamlessly with `kubernetesComposition({)`:

```typescript
import { type } from 'arktype';
import { kubernetesComposition, Cel, simple, Cel } from 'typekro';

const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: 'string'
});

const webapp = kubernetesComposition({
  {
    name: 'full-webapp',
    apiVersion: 'example.com/v1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: type({ ready: 'boolean', url: 'string' })
  },
  (schema) => ({
    // Configuration first
    config: ConfigMap({
      name: `${schema.spec.name}-config`,
      data: {
        environment: schema.spec.environment,
        logLevel: schema.spec.environment === 'production' ? 'warn' : 'info', // ✨ Natural JavaScript conditional
          'debug'
        )
      }
    }),
    
    // Application deployment
    deployment: Deployment({
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
    service: Service({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 8080 }]
    })
  }),
  (schema, resources) => ({
    // ✨ JavaScript expressions automatically converted to CEL
    ready: resources.deployment.status.readyReplicas >= schema.spec.replicas,
    url: `http://${resources.service.spec.clusterIP}`
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
const microservices = kubernetesComposition({
  {
    name: 'microservices',
    apiVersion: 'platform.example.com/v1',
    kind: 'Microservices',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Database configuration
    dbConfig: simple({
      name: 'db-config',
      data: {
        host: 'postgres',
        port: '5432',
        database: schema.spec.name
      }
    }),
    
    // Database deployment
    database: Deployment({
      name: 'postgres',
      image: 'postgres:13',
      labels: { app: 'postgres', component: 'database' },  // Labels for service selector
      env: {
        POSTGRES_DB: schema.spec.name,  // Schema reference
        POSTGRES_USER: 'app'
      }
    }),
    
    // Database service
    dbService: Service({
      name: 'postgres',
      selector: resources.database.spec.selector.matchLabels,  // Reference database deployment labels
      ports: [{ port: 5432, targetPort: 5432 }]
    }),
    
    // API server that references database
    api: Deployment({
      name: 'api',
      image: 'myapp/api:latest',
      labels: { app: 'api', component: 'backend' },  // Labels for service selector
      env: {
        // ✨ Reference to database service using JavaScript template literals
        DATABASE_URL: `postgres://app@${resources.dbService.metadata.name}:5432/${schema.spec.name}`
      }
    }),
    
    // API service
    apiService: Service({
      name: 'api',
      selector: resources.api.spec.selector.matchLabels,  // Reference API deployment labels
      ports: [{ port: 8080, targetPort: 8080 }]
    })
  }),
  (schema, resources) => ({
    // ✨ JavaScript expressions automatically converted to CEL
    ready: resources.database.status.readyReplicas > 0 && 
           resources.api.status.readyReplicas > 0
  })
);
```

## Function Categories

### Core Workloads
- `Deployment()` - Stateless applications
- `DaemonSet()` - Node-level services
- `StatefulSet()` - Stateful applications
- `Job()` - Batch processing
- `CronJob()` - Scheduled tasks

### Networking
- `Service()` - Load balancing and service discovery
- `Ingress()` - External HTTP/HTTPS access
- `NetworkPolicy()` - Network security policies

### Configuration & Storage
- `ConfigMap()` - Configuration data
- `Secret()` - Sensitive data
- `Pvc()` - Persistent storage
- `PersistentVolume()` - Storage volumes

### Autoscaling
- `Hpa()` - Horizontal Pod Autoscaler

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
const app = Deployment({
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
  deployment: Deployment({
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
  database: StatefulSet({ /* ... */ }),
  dbService: Service({ /* ... */ }),
  
  // Application layer
  api: Deployment({ /* ... */ }),
  apiService: Service({ /* ... */ }),
  
  // Ingress layer
  ingress: Ingress({ /* ... */ })
})
```

### 4. Use Meaningful Names

Choose descriptive names that reflect the resource's purpose:

```typescript
// Good
const userApiDeployment = Deployment({
  name: 'user-api',
  image: 'myapp/user-api:v1.0'
});

const userApiService = Service({
  name: 'user-api-service',
  selector: { app: 'user-api' }
});

// Avoid
const deploy1 = Deployment({ /* ... */ });
const svc = Service({ /* ... */ });
```

## Type Safety

All factory functions provide full TypeScript type safety:

```typescript
// TypeScript will validate all parameters
const deployment = Deployment({
  name: 'my-app',           // ✅ string
  image: 'nginx:latest',    // ✅ string
  replicas: 3,              // ✅ number
  ports: [80, 443],         // ✅ number[]
  invalid: 'parameter'      // ❌ Type error
});

// Schema references are also type-safe
(schema) => ({
  deployment: Deployment({
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