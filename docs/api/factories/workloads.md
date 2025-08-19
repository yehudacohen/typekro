# Workloads API

TypeKro provides simple factory functions for creating Kubernetes workload resources with built-in type safety and sensible defaults. These functions simplify resource creation while maintaining full TypeScript support.

## Overview

TypeKro workload factories provide:
- **Simplified configuration** with sensible defaults
- **Type-safe resource creation** with full TypeScript support
- **Intelligent readiness evaluation** for each workload type
- **Cross-resource references** via the magic proxy system

All workload factories return `Enhanced<TSpec, TStatus>` objects that can be used in resource graphs and reference other resources.

## Core Workload Types

### `simpleDeployment()`

Creates a Kubernetes Deployment with simplified configuration.

```typescript
function simpleDeployment(config: SimpleDeploymentConfig): Enhanced<V1DeploymentSpec, V1DeploymentStatus>
```

#### Parameters

- **`config`**: Simplified deployment configuration with required fields and sensible defaults

```typescript
interface SimpleDeploymentConfig {
  name: string;
  image: string;
  replicas?: number;
  env?: Record<string, string | RefOrValue<string>>;
  ports?: number[];
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
}
```

#### Returns

Enhanced Deployment with automatic readiness evaluation.

#### Example

```typescript
import { toResourceGraph, simpleDeployment, type } from 'typekro';

const WebAppSpec = type({
  name: 'string',
  image: 'string', 
  replicas: 'number'
});

const webApp = toResourceGraph(
  {
    name: 'web-app',
    apiVersion: 'example.com/v1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Simple deployment with schema references
    app: simpleDeployment({
      name: schema.spec.name,        // Type-safe schema reference
      image: schema.spec.image,      // Full IDE autocomplete  
      replicas: schema.spec.replicas,
      ports: [80],
      env: {
        NODE_ENV: 'production',
        PORT: '80'
      },
      resources: {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '512Mi' }
      }
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, ' > 0')
  })
);
```

#### Readiness Logic

- **Ready**: All desired replicas are ready and available
- **Handles**: Rolling updates, scaling events, replica failures
- **Status Details**: Includes replica counts and update progress

### `simpleJob()`

Creates a Kubernetes Job with simplified configuration for batch/one-time workloads.

```typescript
function simpleJob(config: SimpleJobConfig): Enhanced<V1JobSpec, V1JobStatus>
```

#### Parameters

- **`config`**: Simplified job configuration

```typescript
interface SimpleJobConfig {
  name: string;
  image: string;
  command?: string[];
  env?: Record<string, string | RefOrValue<string>>;
  completions?: number;
  parallelism?: number;
  backoffLimit?: number;
}
```

#### Returns

Enhanced Job with automatic readiness evaluation.

#### Example

```typescript
import { toResourceGraph, simpleJob, simpleConfigMap, type } from 'typekro';

const BatchSpec = type({
  name: 'string',
  inputPath: 'string',
  outputPath: 'string'
});

const dataProcessing = toResourceGraph(
  {
    name: 'data-processing',
    apiVersion: 'batch.example.com/v1',
    kind: 'BatchJob',
    spec: BatchSpec,
    status: type({ completed: 'boolean' })
  },
  (schema) => ({
    config: simpleConfigMap({
      name: 'job-config',
      data: {
        inputPath: schema.spec.inputPath,
        outputPath: schema.spec.outputPath
      }
    }),

    job: simpleJob({
      name: schema.spec.name,
      image: 'data-processor:v1.0',
      command: ['process-data'],
      env: {
        INPUT_PATH: schema.spec.inputPath,    // Schema reference
        OUTPUT_PATH: schema.spec.outputPath   // Schema reference
      },
      completions: 1,
      parallelism: 1,
      backoffLimit: 3
    })
  }),
  (schema, resources) => ({
    completed: Cel.expr(resources.job.status.succeeded, ' >= 1')
  })
);
```

#### Readiness Logic

- **Ready**: Job succeeds with expected completions
- **Failed**: Failed attempts exceed backoff limit
- **Status Details**: Includes active, succeeded, and failed pod counts

### `simpleStatefulSet()`

Creates a Kubernetes StatefulSet with simplified configuration for stateful applications.

```typescript
function simpleStatefulSet(config: SimpleStatefulSetConfig): Enhanced<V1StatefulSetSpec, V1StatefulSetStatus>
```

#### Parameters

- **`config`**: Simplified StatefulSet configuration

```typescript
interface SimpleStatefulSetConfig {
  name: string;
  image: string;
  replicas?: number;
  env?: Record<string, string | RefOrValue<string>>;
  ports?: number[];
  serviceName?: string;
  volumeClaimTemplates?: any[];
}
```

#### Returns

Enhanced StatefulSet with automatic readiness evaluation.

#### Example

```typescript
import { toResourceGraph, simpleStatefulSet, simpleService, type } from 'typekro';

const DatabaseSpec = type({
  name: 'string',
  replicas: 'number',
  storageSize: 'string'
});

const database = toResourceGraph(
  {
    name: 'database',
    apiVersion: 'data.example.com/v1',
    kind: 'Database',
    spec: DatabaseSpec,
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    statefulSet: simpleStatefulSet({
      name: schema.spec.name,
      image: 'postgres:13',
      replicas: schema.spec.replicas,
      serviceName: 'postgres-headless',
      ports: [5432],
      env: {
        POSTGRES_DB: 'myapp',
        POSTGRES_USER: 'dbuser',
        POSTGRES_PASSWORD: 'dbpass'
      }
    }),

    service: simpleService({
      name: 'postgres-headless',
      selector: { app: schema.spec.name },
      ports: [{ port: 5432, targetPort: 5432 }],
      clusterIP: 'None'  // Headless service
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.statefulSet.status.readyReplicas, ' >= ', schema.spec.replicas)
  })
);
```

#### Readiness Logic

- **Ready**: All replicas are ready and updated according to update strategy
- **Status Details**: Includes update strategy and replica state

### `simpleCronJob()`

Creates a Kubernetes CronJob with simplified configuration for scheduled workloads.

```typescript
function simpleCronJob(config: SimpleCronJobConfig): Enhanced<V1CronJobSpec, V1CronJobStatus>
```

#### Parameters

- **`config`**: Simplified CronJob configuration

```typescript
interface SimpleCronJobConfig {
  name: string;
  image: string;
  schedule: string;
  command?: string[];
  env?: Record<string, string | RefOrValue<string>>;
  suspend?: boolean;
}
```

#### Returns

Enhanced CronJob with automatic readiness evaluation.

#### Example

```typescript
import { toResourceGraph, simpleCronJob, simpleSecret, type } from 'typekro';

const BackupSpec = type({
  name: 'string',
  schedule: 'string',
  awsAccessKey: 'string',
  awsSecretKey: 'string'
});

const backupSystem = toResourceGraph(
  {
    name: 'backup-system',
    apiVersion: 'backup.example.com/v1',
    kind: 'BackupJob',
    spec: BackupSpec,
    status: type({ lastBackup: 'string' })
  },
  (schema) => ({
    credentials: simpleSecret({
      name: 'backup-creds',
      data: {
        awsAccessKey: schema.spec.awsAccessKey,
        awsSecretKey: schema.spec.awsSecretKey
      }
    }),

    cronJob: simpleCronJob({
      name: schema.spec.name,
      image: 'backup-tool:latest',
      schedule: schema.spec.schedule,  // e.g., '0 2 * * *' for daily at 2 AM
      command: ['backup-database'],
      env: {
        AWS_ACCESS_KEY_ID: schema.spec.awsAccessKey,
        AWS_SECRET_ACCESS_KEY: schema.spec.awsSecretKey
      }
    })
  }),
  (schema, resources) => ({
    lastBackup: Cel.expr('string(', resources.cronJob.status.lastScheduleTime, ')')
  })
);
```

#### Readiness Logic

- **Ready**: CronJob is scheduled or suspended
- **Status Details**: Includes active job count and schedule state

## Additional Workload Functions

TypeKro also provides access to lower-level factory functions for complex scenarios. These require full Kubernetes resource specifications but offer complete control:

- `deployment()` - Full V1Deployment specification
- `job()` - Full V1Job specification  
- `statefulSet()` - Full V1StatefulSet specification
- `cronJob()` - Full V1CronJob specification
- `daemonSet()` - Full V1DaemonSet specification

Use these when you need advanced configuration beyond what the simple* functions provide.

## Advanced Patterns

### Cross-Resource Dependencies

Workloads can reference other resources for configuration and networking:

```typescript
import { deployment, service, configMap, secret } from 'typekro';

const fullStackApp = createResourceGraph('full-stack', (schema) => {
  // Configuration
  const appConfig = configMap({
    metadata: { name: 'app-config' },
    data: {
      apiUrl: 'https://api.example.com',
      logLevel: 'info'
    }
  });

  const appSecrets = secret({
    metadata: { name: 'app-secrets' },
    stringData: {
      dbPassword: 'secret-password',
      apiKey: 'secret-api-key'
    }
  });

  // Backend deployment
  const backend = deployment({
    metadata: { name: 'backend' },
    spec: {
      replicas: 3,
      selector: { matchLabels: { app: 'backend' } },
      template: {
        metadata: { labels: { app: 'backend' } },
        spec: {
          containers: [{
            name: 'backend',
            image: 'myapp/backend:v1.0',
            env: [
              {
                name: 'API_URL',
                value: appConfig.data.apiUrl
              },
              {
                name: 'LOG_LEVEL',
                value: appConfig.data.logLevel
              },
              {
                name: 'DB_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: appSecrets.metadata.name,
                    key: 'dbPassword'
                  }
                }
              }
            ]
          }]
        }
      }
    }
  });

  // Service for backend
  const backendService = service({
    metadata: { name: 'backend-service' },
    spec: {
      selector: { app: 'backend' },
      ports: [{ port: 8080, targetPort: 8080 }]
    }
  });

  return { 
    config: appConfig, 
    secrets: appSecrets, 
    backend, 
    service: backendService 
  };
});
```

### Resource Status Computation

Use workload status in CEL expressions for computed values:

```typescript
import { deployment, Cel } from 'typekro';

const scalableApp = createResourceGraph('scalable-app', (schema) => {
  const app = deployment({
    metadata: { name: 'app' },
    spec: {
      replicas: 3,
      selector: { matchLabels: { app: 'web' } },
      template: {
        metadata: { labels: { app: 'web' } },
        spec: {
          containers: [{
            name: 'web',
            image: 'nginx:1.21'
          }]
        }
      }
    }
  });

  return {
    deployment: app,
    status: {
      // Computed health status
      health: Cel.conditional(
        Cel.expr(app.status.readyReplicas, ' >= ', app.spec.replicas),
        'healthy',
        'degraded'
      ),
      
      // Availability percentage
      availability: Cel.expr(
        '(', app.status.readyReplicas, ' * 100) / ', app.spec.replicas
      ),
      
      // Status summary
      summary: Cel.template(
        'Deployment %{name}: %{ready}/%{desired} replicas ready (%{percent}%)',
        {
          name: app.metadata.name,
          ready: app.status.readyReplicas,
          desired: app.spec.replicas,
          percent: Cel.expr('(', app.status.readyReplicas, ' * 100) / ', app.spec.replicas)
        }
      )
    }
  };
});
```

### Custom Readiness Evaluation

Override default readiness logic for specific requirements:

```typescript
import { deployment } from 'typekro';

const customApp = deployment({
  metadata: { name: 'custom-app' },
  spec: { /* deployment spec */ }
})
.withReadinessEvaluator((resource) => {
  const ready = resource.status?.readyReplicas === resource.spec?.replicas;
  const healthy = resource.status?.conditions?.some(
    condition => condition.type === 'Available' && condition.status === 'True'
  );
  
  return {
    ready: ready && healthy,
    reason: ready && healthy ? 'DeploymentReady' : 'WaitingForConditions',
    message: ready && healthy 
      ? 'Deployment is ready with all conditions met'
      : 'Waiting for deployment conditions to be satisfied',
    details: {
      readyReplicas: resource.status?.readyReplicas,
      desiredReplicas: resource.spec?.replicas,
      conditions: resource.status?.conditions
    }
  };
});
```

## Type Definitions

### Input Types

Each factory accepts the corresponding Kubernetes API type:

```typescript
// From @kubernetes/client-node
import type {
  V1Deployment,
  V1Job,
  V1StatefulSet,
  V1CronJob,
  V1DaemonSet
} from '@kubernetes/client-node';
```

### Enhanced Output Types

All factories return enhanced versions with TypeKro functionality:

```typescript
import type { Enhanced } from 'typekro';

// Deployment
type EnhancedDeployment = Enhanced<V1DeploymentSpec, V1DeploymentStatus>;

// Job  
type EnhancedJob = Enhanced<V1JobSpec, V1JobStatus>;

// StatefulSet
type EnhancedStatefulSet = Enhanced<V1StatefulSetSpec, V1StatefulSetStatus>;

// CronJob
type EnhancedCronJob = Enhanced<V1CronJobSpec, V1CronJobStatus>;

// DaemonSet  
type EnhancedDaemonSet = Enhanced<V1DaemonSetSpec, V1DaemonSetStatus>;
```

## Best Practices

### 1. Use Appropriate Workload Types

Choose the right workload type for your use case:

- **Deployment**: Stateless applications, web servers, APIs
- **StatefulSet**: Databases, stateful services requiring stable identities
- **Job**: One-time batch processing, data migration
- **CronJob**: Scheduled tasks, backups, periodic maintenance
- **DaemonSet**: Node-level services, monitoring agents, log collectors

### 2. Configure Resource Requirements

Always specify resource requests and limits:

```typescript
const webApp = deployment({
  spec: {
    template: {
      spec: {
        containers: [{
          name: 'web',
          image: 'nginx:1.21',
          resources: {
            requests: {
              cpu: '100m',
              memory: '128Mi'
            },
            limits: {
              cpu: '500m',
              memory: '512Mi'
            }
          }
        }]
      }
    }
  }
});
```

### 3. Use Health Checks

Configure liveness and readiness probes:

```typescript
const apiServer = deployment({
  spec: {
    template: {
      spec: {
        containers: [{
          name: 'api',
          image: 'myapp/api:v1.0',
          ports: [{ containerPort: 8080 }],
          livenessProbe: {
            httpGet: {
              path: '/health',
              port: 8080
            },
            initialDelaySeconds: 30,
            periodSeconds: 10
          },
          readinessProbe: {
            httpGet: {
              path: '/ready',
              port: 8080
            },
            initialDelaySeconds: 5,
            periodSeconds: 5
          }
        }]
      }
    }
  }
});
```

### 4. Leverage Dependencies

Use resource references to create proper dependency chains:

```typescript
const microservice = createResourceGraph('microservice', (schema) => {
  const config = configMap({ /* config */ });
  const secrets = secret({ /* secrets */ });
  
  const deploy = deployment({
    spec: {
      template: {
        spec: {
          containers: [{
            name: 'app',
            image: 'myapp:v1.0',
            env: [
              { name: 'CONFIG_VALUE', value: config.data.value },
              { 
                name: 'SECRET_VALUE', 
                valueFrom: { 
                  secretKeyRef: { 
                    name: secrets.metadata.name, 
                    key: 'secret' 
                  } 
                } 
              }
            ]
          }]
        }
      }
    }
  });

  return { config, secrets, deployment: deploy };
});
```

## Related APIs

- [Networking API](/api/factories/networking) - Services, Ingress, NetworkPolicy
- [Configuration API](/api/factories/config) - ConfigMaps and Secrets
- [Storage API](/api/factories/storage) - Persistent Volumes and Claims
- [Types API](/api/types) - TypeScript type definitions
- [Resource Graphs Guide](/guide/resource-graphs) - Building complex applications