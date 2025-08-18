# Factory Functions

Factory functions are the building blocks of TypeKro. They provide type-safe, pre-configured ways to create common Kubernetes resources with sensible defaults and full TypeScript support.

## Overview

Instead of writing verbose Kubernetes YAML, factory functions let you create resources with clean, typed APIs:

```typescript
// Instead of this YAML...
/*
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  labels:
    app: my-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: my-app
        image: nginx:latest
        ports:
        - containerPort: 80
*/

// Write this TypeScript
const deployment = simpleDeployment({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3,
  ports: [{ containerPort: 80 }]
});
```

## Core Factory Functions

### Workloads

#### `simpleDeployment`
Creates a Kubernetes Deployment with sensible defaults.

```typescript
import { simpleDeployment } from 'typekro';

const deployment = simpleDeployment({
  name: 'web-app',
  image: 'nginx:latest',
  replicas: 3,
  ports: [{ containerPort: 80 }],
  env: {
    NODE_ENV: 'production',
    API_URL: 'https://api.example.com'
  },
  resources: {
    cpu: '500m',
    memory: '1Gi'
  }
});
```

**Key Features:**
- Automatic label generation (`app: name`)
- Health check configuration
- Resource limits and requests
- Environment variable support
- Volume mounting

#### `simpleStatefulSet`
Creates a StatefulSet for stateful applications.

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
const migrationJob = simpleJob({
  name: 'db-migration',
  image: 'myapp/migrations:latest',
  env: {
    DATABASE_URL: database.status.podIP
  },
  restartPolicy: 'OnFailure',
  backoffLimit: 3
});
```

### Networking

#### `simpleService`
Creates a Kubernetes Service to expose applications.

```typescript
const service = simpleService({
  name: 'web-service',
  selector: { app: 'web-app' },
  ports: [
    { port: 80, targetPort: 8080 },
    { port: 443, targetPort: 8443, name: 'https' }
  ],
  type: 'LoadBalancer'
});
```

**Service Types:**
- `ClusterIP` (default) - Internal cluster access
- `NodePort` - Access via node ports
- `LoadBalancer` - External load balancer
- `ExternalName` - DNS CNAME record

#### `simpleIngress`
Creates an Ingress resource for HTTP routing.

```typescript
const ingress = simpleIngress({
  name: 'web-ingress',
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
    `
  }
});
```

#### `simpleSecret`
Creates a Secret for sensitive data.

```typescript
const secret = simpleSecret({
  name: 'app-secrets',
  data: {
    'database-password': 'c3VwZXJzZWNyZXQ=',  // base64 encoded
    'api-key': 'YWJjZGVmZ2hpams='
  },
  type: 'Opaque'
});

// Or use stringData for automatic base64 encoding
const secretFromStrings = simpleSecret({
  name: 'app-secrets',
  stringData: {
    'database-password': 'supersecret',
    'api-key': 'abcdefghijk'
  }
});
```

### Storage

#### `simplePvc`
Creates a PersistentVolumeClaim for storage.

```typescript
const storage = simplePvc({
  name: 'app-storage',
  size: '10Gi',
  storageClass: 'fast-ssd',
  accessModes: ['ReadWriteOnce']
});
```

## Advanced Factory Usage

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
    // Reference the database's pod IP
    DATABASE_HOST: database.status.podIP,
    DATABASE_PORT: '5432'
  }
});

const service = simpleService({
  name: 'web-service',
  // Reference the app's labels
  selector: { app: app.metadata.labels.app },
  ports: [{ port: 80, targetPort: 3000 }]
});
```

### Conditional Configuration

Use TypeScript's conditional logic:

```typescript
const deployment = simpleDeployment({
  name: schema.spec.name,
  image: schema.spec.image,
  replicas: schema.spec.environment === 'production' ? 5 : 2,
  
  // Production gets more resources
  resources: schema.spec.environment === 'production' 
    ? { cpu: '1000m', memory: '2Gi' }
    : { cpu: '100m', memory: '256Mi' },
    
  // Enable health checks in production
  ...(schema.spec.environment === 'production' && {
    livenessProbe: {
      httpGet: { path: '/health', port: 3000 },
      initialDelaySeconds: 30
    },
    readinessProbe: {
      httpGet: { path: '/ready', port: 3000 },
      initialDelaySeconds: 5
    }
  })
});
```

### Custom Labels and Annotations

```typescript
const deployment = simpleDeployment({
  name: 'my-app',
  image: 'nginx:latest',
  
  // Custom labels (merged with defaults)
  labels: {
    version: 'v1.2.3',
    team: 'platform',
    environment: 'production'
  },
  
  // Custom annotations
  annotations: {
    'deployment.kubernetes.io/revision': '1',
    'prometheus.io/scrape': 'true',
    'prometheus.io/port': '9090'
  }
});
```

## Factory Function Patterns

### Environment-Specific Factories

Create environment-specific factory functions:

```typescript
function productionDeployment(config: DeploymentConfig) {
  return simpleDeployment({
    ...config,
    replicas: Math.max(config.replicas, 3),  // Minimum 3 replicas
    resources: {
      cpu: '500m',
      memory: '1Gi',
      ...config.resources
    },
    livenessProbe: {
      httpGet: { path: '/health', port: config.port || 3000 },
      initialDelaySeconds: 30,
      periodSeconds: 10
    },
    readinessProbe: {
      httpGet: { path: '/ready', port: config.port || 3000 },
      initialDelaySeconds: 5,
      periodSeconds: 5
    }
  });
}
```

### Composition Patterns

Combine multiple factory functions:

```typescript
function webAppStack(config: WebAppConfig) {
  const configMap = simpleConfigMap({
    name: `${config.name}-config`,
    data: config.configData
  });

  const secret = simpleSecret({
    name: `${config.name}-secrets`,
    stringData: config.secrets
  });

  const deployment = simpleDeployment({
    name: config.name,
    image: config.image,
    replicas: config.replicas,
    env: {
      ...config.env,
      CONFIG_PATH: '/etc/config'
    },
    volumeMounts: [
      { name: 'config', mountPath: '/etc/config' },
      { name: 'secrets', mountPath: '/etc/secrets' }
    ],
    volumes: [
      { name: 'config', configMap: { name: configMap.metadata.name } },
      { name: 'secrets', secret: { secretName: secret.metadata.name } }
    ]
  });

  const service = simpleService({
    name: `${config.name}-service`,
    selector: { app: config.name },
    ports: config.ports
  });

  return { configMap, secret, deployment, service };
}
```

## Type Safety Features

### Compile-Time Validation

Factory functions provide full TypeScript validation:

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

Get full autocomplete and documentation:

```typescript
const deployment = simpleDeployment({
  name: 'my-app',
  image: 'nginx:latest',
  // IDE shows all available options with documentation
  resources: {
    // Autocomplete for cpu, memory, etc.
  },
  // Hover for parameter documentation
});
```

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
            // Custom logic here
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
  configMap: simpleConfigMap({ /* ... */ })
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
  name: 'string>2',  // At least 3 characters
  image: 'string',
  replicas: 'number>0',  // At least 1
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

## Next Steps

- **[Cross-Resource References](./cross-references.md)** - Connect resources dynamically
- **[CEL Expressions](./cel-expressions.md)** - Add runtime logic
- **[Custom Factory Functions](./custom-factories.md)** - Build your own factories
- **[API Reference](../api/factories.md)** - Complete factory function reference