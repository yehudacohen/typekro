# Factory Functions

Pre-built, type-safe functions for creating common Kubernetes resources.

## Overview

Factory functions provide a clean, typed API for creating Kubernetes resources with sensible defaults and full TypeScript support.

```typescript
import { 
  simpleDeployment, 
  simpleService, 
  simpleConfigMap 
} from 'typekro';
```

## Core Factory Functions

### Workloads

#### `simpleDeployment`

Creates a Kubernetes Deployment with sensible defaults.

```typescript
function simpleDeployment(config: SimpleDeploymentConfig): Enhanced<V1Deployment, V1DeploymentStatus>
```

**Configuration:**
```typescript
interface SimpleDeploymentConfig {
  name: string;
  image: string;
  replicas?: number;
  ports?: Array<{ containerPort: number; protocol?: string }>;
  env?: Record<string, string | KubernetesRef<string>>;
  resources?: {
    cpu?: string;
    memory?: string;
  };
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  volumeMounts?: Array<{
    name: string;
    mountPath: string;
    readOnly?: boolean;
  }>;
  volumes?: Array<k8s.V1Volume>;
  livenessProbe?: k8s.V1Probe;
  readinessProbe?: k8s.V1Probe;
}
```

**Example:**
```typescript
const deployment = simpleDeployment({
  name: 'web-app',
  image: 'nginx:latest',
  replicas: 3,
  ports: [{ containerPort: 80 }],
  env: {
    NODE_ENV: 'production',
    DATABASE_URL: database.status.podIP
  },
  resources: {
    cpu: '500m',
    memory: '1Gi'
  },
  livenessProbe: {
    httpGet: { path: '/health', port: 80 },
    initialDelaySeconds: 30
  }
});
```

#### `simpleStatefulSet`

Creates a Kubernetes StatefulSet for stateful applications.

```typescript
function simpleStatefulSet(config: SimpleStatefulSetConfig): Enhanced<V1StatefulSet, V1StatefulSetStatus>
```

**Example:**
```typescript
const database = simpleStatefulSet({
  name: 'postgres',
  image: 'postgres:15',
  replicas: 1,
  ports: [{ containerPort: 5432 }],
  env: {
    POSTGRES_DB: 'myapp',
    POSTGRES_USER: 'user',
    POSTGRES_PASSWORD: 'password'
  },
  volumeClaimTemplates: [{
    name: 'data',
    size: '10Gi',
    storageClass: 'fast-ssd'
  }],
  volumeMounts: [{
    name: 'data',
    mountPath: '/var/lib/postgresql/data'
  }]
});
```

#### `simpleJob`

Creates a Kubernetes Job for batch processing.

```typescript
function simpleJob(config: SimpleJobConfig): Enhanced<V1Job, V1JobStatus>
```

**Example:**
```typescript
const migrationJob = simpleJob({
  name: 'db-migration',
  image: 'myapp/migrations:latest',
  env: {
    DATABASE_URL: database.status.podIP
  },
  restartPolicy: 'OnFailure',
  backoffLimit: 3,
  activeDeadlineSeconds: 3600
});
```

#### `simpleCronJob`

Creates a Kubernetes CronJob for scheduled tasks.

```typescript
function simpleCronJob(config: SimpleCronJobConfig): Enhanced<V1CronJob, V1CronJobStatus>
```

**Example:**
```typescript
const backupJob = simpleCronJob({
  name: 'daily-backup',
  schedule: '0 2 * * *',  // Daily at 2 AM
  image: 'backup-tool:latest',
  env: {
    BACKUP_TARGET: 's3://my-backups/',
    DATABASE_URL: database.status.podIP
  },
  successfulJobsHistoryLimit: 3,
  failedJobsHistoryLimit: 1
});
```

### Networking

#### `simpleService`

Creates a Kubernetes Service to expose applications.

```typescript
function simpleService(config: SimpleServiceConfig): Enhanced<V1Service, V1ServiceStatus>
```

**Configuration:**
```typescript
interface SimpleServiceConfig {
  name: string;
  selector: Record<string, string>;
  ports: Array<{
    port: number;
    targetPort?: number | string;
    protocol?: string;
    name?: string;
  }>;
  type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'ExternalName';
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}
```

**Example:**
```typescript
const service = simpleService({
  name: 'web-service',
  selector: { app: 'web-app' },
  ports: [
    { port: 80, targetPort: 8080 },
    { port: 443, targetPort: 8443, name: 'https' }
  ],
  type: 'LoadBalancer',
  annotations: {
    'service.beta.kubernetes.io/aws-load-balancer-type': 'nlb'
  }
});
```

#### `simpleIngress`

Creates an Ingress resource for HTTP routing.

```typescript
function simpleIngress(config: SimpleIngressConfig): Enhanced<V1Ingress, V1IngressStatus>
```

**Example:**
```typescript
const ingress = simpleIngress({
  name: 'web-ingress',
  ingressClassName: 'nginx',
  rules: [{
    host: 'myapp.example.com',
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
    secretName: 'web-tls',
    hosts: ['myapp.example.com']
  }]
});
```

### Configuration

#### `simpleConfigMap`

Creates a ConfigMap for application configuration.

```typescript
function simpleConfigMap(config: SimpleConfigMapConfig): Enhanced<V1ConfigMap, {}>
```

**Configuration:**
```typescript
interface SimpleConfigMapConfig {
  name: string;
  data?: Record<string, string>;
  binaryData?: Record<string, string>;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}
```

**Example:**
```typescript
const config = simpleConfigMap({
  name: 'app-config',
  data: {
    'app.properties': `
      server.port=8080
      database.url=jdbc:postgresql://postgres:5432/myapp
      logging.level=INFO
    `,
    'nginx.conf': `
      server {
        listen 80;
        location / {
          proxy_pass http://backend:8080;
        }
      }
    `,
    'LOG_LEVEL': 'info',
    'FEATURE_FLAGS': 'auth,metrics,logging'
  }
});
```

#### `simpleSecret`

Creates a Secret for sensitive data.

```typescript
function simpleSecret(config: SimpleSecretConfig): Enhanced<V1Secret, {}>
```

**Configuration:**
```typescript
interface SimpleSecretConfig {
  name: string;
  data?: Record<string, string>;      // Base64 encoded values
  stringData?: Record<string, string>; // Plain text values (auto-encoded)
  type?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}
```

**Example:**
```typescript
// Using stringData (recommended)
const secret = simpleSecret({
  name: 'app-secrets',
  type: 'Opaque',
  stringData: {
    'database-password': 'supersecret',
    'api-key': 'abcdefghijk',
    'jwt-secret': 'my-jwt-signing-secret'
  }
});

// Using pre-encoded data
const encodedSecret = simpleSecret({
  name: 'app-secrets-encoded',
  data: {
    'database-password': 'c3VwZXJzZWNyZXQ=',  // base64 encoded
    'api-key': 'YWJjZGVmZ2hpams='
  }
});
```

### Storage

#### `simplePvc`

Creates a PersistentVolumeClaim for storage.

```typescript
function simplePvc(config: SimplePvcConfig): Enhanced<V1PersistentVolumeClaim, V1PersistentVolumeClaimStatus>
```

**Configuration:**
```typescript
interface SimplePvcConfig {
  name: string;
  size: string;
  storageClass?: string;
  accessModes?: string[];
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}
```

**Example:**
```typescript
const storage = simplePvc({
  name: 'app-storage',
  size: '10Gi',
  storageClass: 'fast-ssd',
  accessModes: ['ReadWriteOnce'],
  labels: {
    app: 'web-app',
    tier: 'storage'
  }
});
```

### RBAC

#### `simpleServiceAccount`

Creates a ServiceAccount for pod identity.

```typescript
function simpleServiceAccount(config: SimpleServiceAccountConfig): Enhanced<V1ServiceAccount, {}>
```

**Example:**
```typescript
const serviceAccount = simpleServiceAccount({
  name: 'app-service-account',
  labels: {
    app: 'web-app'
  },
  annotations: {
    'eks.amazonaws.com/role-arn': 'arn:aws:iam::123456789012:role/MyRole'
  }
});
```

#### `simpleRole`

Creates a Role for namespace-scoped permissions.

```typescript
function simpleRole(config: SimpleRoleConfig): Enhanced<V1Role, {}>
```

**Example:**
```typescript
const role = simpleRole({
  name: 'app-role',
  rules: [
    {
      apiGroups: [''],
      resources: ['pods', 'services'],
      verbs: ['get', 'list', 'watch']
    },
    {
      apiGroups: ['apps'],
      resources: ['deployments'],
      verbs: ['get', 'list', 'watch', 'create', 'update', 'patch']
    }
  ]
});
```

#### `simpleRoleBinding`

Creates a RoleBinding to bind roles to subjects.

```typescript
function simpleRoleBinding(config: SimpleRoleBindingConfig): Enhanced<V1RoleBinding, {}>
```

**Example:**
```typescript
const roleBinding = simpleRoleBinding({
  name: 'app-role-binding',
  roleRef: {
    apiGroup: 'rbac.authorization.k8s.io',
    kind: 'Role',
    name: role.metadata.name
  },
  subjects: [{
    kind: 'ServiceAccount',
    name: serviceAccount.metadata.name,
    namespace: 'default'
  }]
});
```

## Advanced Usage

### Cross-Resource References

Factory functions can reference other resources:

```typescript
const database = simpleDeployment({
  name: 'postgres',
  image: 'postgres:15'
});

const app = simpleDeployment({
  name: 'web-app',
  image: 'myapp:latest',
  env: {
    DATABASE_HOST: database.status.podIP,
    DATABASE_PORT: '5432'
  }
});

const service = simpleService({
  name: 'web-service',
  selector: { app: app.metadata.labels.app },
  ports: [{ port: 80, targetPort: 3000 }]
});
```

### Environment-Specific Configuration

```typescript
const deployment = simpleDeployment({
  name: schema.spec.name,
  image: schema.spec.image,
  replicas: schema.spec.environment === 'production' ? 5 : 2,
  resources: schema.spec.environment === 'production' 
    ? { cpu: '1000m', memory: '2Gi' }
    : { cpu: '100m', memory: '256Mi' },
  env: {
    NODE_ENV: schema.spec.environment,
    LOG_LEVEL: schema.spec.environment === 'production' ? 'info' : 'debug'
  }
});
```

### Volume Mounting

```typescript
const config = simpleConfigMap({
  name: 'app-config',
  data: { 'app.conf': 'server.port=8080' }
});

const secret = simpleSecret({
  name: 'app-secrets',
  stringData: { 'api-key': 'secret-key' }
});

const deployment = simpleDeployment({
  name: 'web-app',
  image: 'myapp:latest',
  volumeMounts: [
    { name: 'config', mountPath: '/etc/config' },
    { name: 'secrets', mountPath: '/etc/secrets', readOnly: true }
  ],
  volumes: [
    { name: 'config', configMap: { name: config.metadata.name } },
    { name: 'secrets', secret: { secretName: secret.metadata.name } }
  ]
});
```

## Type Safety Features

### Compile-Time Validation

```typescript
// ✅ This works
const deployment = simpleDeployment({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3
});

// ❌ TypeScript errors
const badDeployment = simpleDeployment({
  name: 123,           // Error: number not assignable to string
  image: 'nginx:latest',
  replicas: '3',       // Error: string not assignable to number
  invalidField: true   // Error: object literal may only specify known properties
});
```

### IDE Support

Factory functions provide full autocomplete and documentation in your IDE:

- Parameter suggestions with descriptions
- Type checking for all configuration options
- Hover documentation for each field
- Error highlighting for invalid configurations

## Custom Factory Functions

Create your own factory functions for common patterns:

```typescript
import { createResource } from 'typekro';

export function customWebApp(config: CustomWebAppConfig) {
  return createResource({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: config.name,
      labels: {
        app: config.name,
        tier: 'web',
        version: config.version
      }
    },
    spec: {
      replicas: config.replicas,
      selector: {
        matchLabels: { app: config.name }
      },
      template: {
        metadata: {
          labels: { app: config.name }
        },
        spec: {
          containers: [{
            name: config.name,
            image: config.image,
            ports: config.ports,
            env: Object.entries(config.env || {}).map(([name, value]) => ({
              name,
              value: String(value)
            })),
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              allowPrivilegeEscalation: false
            }
          }]
        }
      }
    }
  });
}
```

## Best Practices

### 1. Use Descriptive Names

```typescript
// ✅ Good
const userApiDeployment = simpleDeployment({ name: 'user-api' });
const userApiService = simpleService({ name: 'user-api-service' });

// ❌ Avoid
const d1 = simpleDeployment({ name: 'app' });
const s1 = simpleService({ name: 'svc' });
```

### 2. Group Related Resources

```typescript
const userService = {
  deployment: simpleDeployment({ /* ... */ }),
  service: simpleService({ /* ... */ }),
  configMap: simpleConfigMap({ /* ... */ }),
  secret: simpleSecret({ /* ... */ })
};
```

### 3. Use Environment Variables for Configuration

```typescript
const deployment = simpleDeployment({
  name: 'api',
  image: process.env.API_IMAGE || 'api:latest',
  replicas: parseInt(process.env.API_REPLICAS || '3'),
  env: {
    NODE_ENV: process.env.NODE_ENV || 'production',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info'
  }
});
```

### 4. Validate Configuration

```typescript
import { type } from 'arktype';

const DeploymentConfig = type({
  name: 'string>2',
  image: 'string',
  replicas: 'number>0',
  environment: '"dev" | "staging" | "prod"'
});

function createDeployment(config: unknown) {
  const validConfig = DeploymentConfig(config);
  if (validConfig instanceof type.errors) {
    throw new Error(`Invalid config: ${validConfig.summary}`);
  }
  
  return simpleDeployment(validConfig);
}
```

## See Also

- [Cross-Resource References](../guide/cross-references.md) - Connect resources dynamically
- [CEL Expressions](../guide/cel-expressions.md) - Add runtime logic to your resources
- [Examples](../examples/) - Real-world usage examples