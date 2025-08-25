# Factories

Factory functions are the building blocks of TypeKro. They provide type-safe, pre-configured ways to create common Kubernetes resources with sensible defaults and full TypeScript support. This guide covers both the built-in factories and how to create your own custom ones.

## Built-in Factory Functions

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
const deployment = simple.Deployment({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3,
  ports: [{ containerPort: 80 }]
});
```

## Core Factory Functions

### Workloads

#### `simple.Deployment`
Creates a Kubernetes Deployment with sensible defaults.

```typescript
import { simple } from 'typekro';

const deployment = simple.Deployment({
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

#### `simple.StatefulSet`
Creates a StatefulSet for stateful applications.

```typescript
const database = simple.StatefulSet({
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

#### `simple.Job`
Creates a Kubernetes Job for batch processing.

```typescript
const migrationJob = simple.Job({
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

#### `simple.Service`
Creates a Kubernetes Service to expose applications.

```typescript
const service = simple.Service({
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

#### `simple.Ingress`
Creates an Ingress resource for HTTP routing.

```typescript
const ingress = simple.Ingress({
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

#### `simple`
Creates a ConfigMap for application configuration.

```typescript
const config = simple({
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

#### `simple.Secret`
Creates a Secret for sensitive data.

```typescript
const secret = simple.Secret({
  name: 'app-secrets',
  data: {
    'database-password': 'c3VwZXJzZWNyZXQ=',  // base64 encoded
    'api-key': 'YWJjZGVmZ2hpams='
  },
  type: 'Opaque'
});

// Or use stringData for automatic base64 encoding
const secretFromStrings = simple.Secret({
  name: 'app-secrets',
  stringData: {
    'database-password': 'supersecret',
    'api-key': 'abcdefghijk'
  }
});
```

### Storage

#### `simple.Pvc`
Creates a PersistentVolumeClaim for storage.

```typescript
const storage = simple.Pvc({
  name: 'app-storage',
  size: '10Gi',
  storageClass: 'fast-ssd',
  accessModes: ['ReadWriteOnce']
});
```

## Advanced Built-in Factory Usage

### Cross-Resource References

Factory functions can reference other resources. For a complete example showing database and application integration, see [Database + Application Pattern](../examples/database-app.md).

Key cross-reference patterns:
- **Service Discovery**: Services reference deployment labels via selectors
- **Environment Variables**: Applications reference other resources' runtime values
- **Configuration**: ConfigMaps and Secrets referenced by multiple deployments

### Conditional Configuration

Use TypeScript's conditional logic:

```typescript
const deployment = simple.Deployment({
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
const deployment = simple.Deployment({
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

## Built-in Factory Patterns

### Environment-Specific Factories

Create environment-specific factory functions:

```typescript
function productionDeployment(config: DeploymentConfig) {
  return simple.Deployment({
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

Combine multiple factory functions to create application stacks. For complete examples:
- **[Basic WebApp Pattern](../examples/basic-webapp.md)** - Simple app with deployment + service
- **[Database + Application](../examples/database-app.md)** - Full stack with database integration  
- **[Microservices Architecture](../examples/microservices.md)** - Multi-service composition

Key composition techniques:
- **Resource Dependencies**: ConfigMaps/Secrets created before deployments that use them
- **Cross-Resource References**: Services reference deployment selectors
- **Volume Mounting**: ConfigMaps and Secrets mounted into deployments

## Creating Custom Factory Functions

While TypeKro provides comprehensive built-in factory functions, you can create custom factories for organization-specific patterns, complex resources, or specialized workflows.

### Understanding Custom Factories

Factory functions in TypeKro are functions that return Enhanced Kubernetes resources with:

- **Type safety** - Full TypeScript validation
- **Cross-resource references** - Ability to reference other resources
- **Status tracking** - Runtime status information
- **Consistent patterns** - Standardized configuration interfaces

```typescript
// Basic factory function signature
function customFactory(config: ConfigType): Enhanced<SpecType, StatusType> {
  return createResource({
    // Kubernetes resource definition
  });
}
```

### Basic Custom Factory

```typescript
import { createResource, Cel } from 'typekro';
import type { V1Deployment, V1DeploymentStatus } from '@kubernetes/client-node';

interface CustomDeploymentConfig {
  name: string;
  image: string;
  replicas?: number;
  environment: 'development' | 'staging' | 'production';
  team: string;
  monitoring?: boolean;
}

export function customDeployment(
  config: CustomDeploymentConfig
): Enhanced<V1Deployment, V1DeploymentStatus> {
  const {
    name,
    image,
    replicas = 1,
    environment,
    team,
    monitoring = false
  } = config;

  return createResource({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      labels: {
        app: name,
        team,
        environment,
        'managed-by': 'typekro',
        ...(monitoring && { 'monitoring.enabled': 'true' })
      },
      annotations: {
        'typekro.io/created-by': 'custom-deployment-factory',
        'typekro.io/team': team,
        'typekro.io/environment': environment
      }
    },
    spec: {
      replicas,
      selector: {
        matchLabels: { app: name }
      },
      template: {
        metadata: {
          labels: {
            app: name,
            team,
            environment
          }
        },
        spec: {
          containers: [{
            name,
            image,
            ports: [{ containerPort: 3000 }],
            
            // Environment-specific configuration
            resources: getResourcesByEnvironment(environment),
            
            // Standard environment variables
            env: [
              { name: 'NODE_ENV', value: environment },
              { name: 'TEAM', value: team },
              { name: 'APP_NAME', value: name }
            ],
            
            // Standard health checks
            livenessProbe: {
              httpGet: { path: '/health', port: 3000 },
              initialDelaySeconds: 30,
              periodSeconds: 10
            },
            readinessProbe: {
              httpGet: { path: '/ready', port: 3000 },
              initialDelaySeconds: 5,
              periodSeconds: 5
            },
            
            // Security context
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true
            }
          }],
          
          // Pod security context
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            fsGroup: 1000
          }
        }
      }
    }
  });
}

// Helper function for environment-specific resources
function getResourcesByEnvironment(environment: string) {
  const resourceConfigs = {
    development: {
      requests: { cpu: '100m', memory: '256Mi' },
      limits: { cpu: '200m', memory: '512Mi' }
    },
    staging: {
      requests: { cpu: '200m', memory: '512Mi' },
      limits: { cpu: '500m', memory: '1Gi' }
    },
    production: {
      requests: { cpu: '500m', memory: '1Gi' },
      limits: { cpu: '1000m', memory: '2Gi' }
    }
  };
  
  return resourceConfigs[environment] || resourceConfigs.development;
}
```

### Multi-Resource Custom Factory

Create factories that generate multiple related resources. For complete examples:
- **[Database + Application Stack](../examples/database-app.md)** - Full stack with optional database
- **[Microservices Platform](../examples/microservices.md)** - Complex multi-service architecture

Key patterns for multi-resource factories:
  const { name, image, replicas, environment, team, database, ingress } = config;
  
  // Configuration ConfigMap
  const configMap = createResource({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: Cel.expr(name, '-config'),
      labels: { app: name, team, environment }
    },
    data: {
      'app.properties': `
        app.name=${name}
        app.environment=${environment}
        app.team=${team}
        logging.level=${environment === 'production' ? 'INFO' : 'DEBUG'}
      `,
      'features.json': JSON.stringify({
        database: database?.enabled || false,
        monitoring: environment === 'production',
        debugging: environment !== 'production'
      })
    }
  });

  // Main application deployment
  const deployment = createResource({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      labels: { app: name, team, environment }
    },
    spec: {
      replicas,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name, team, environment } },
        spec: {
          containers: [{
            name,
            image,
            ports: [{ containerPort: 3000 }],
            env: [
              { name: 'CONFIG_PATH', value: '/etc/config' },
              ...(database?.enabled ? [
                { name: 'DATABASE_HOST', value: Cel.expr(name, '-database-service') },
                { name: 'DATABASE_PORT', value: '5432' }
              ] : [])
            ],
            volumeMounts: [{
              name: 'config',
              mountPath: '/etc/config'
            }],
            resources: getResourcesByEnvironment(environment)
          }],
          volumes: [{
            name: 'config',
            configMap: { name: configMap.metadata.name }
          }]
        }
      }
    }
  });

  // Service for the application
  const service = createResource({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: Cel.expr(name, '-service'),
      labels: { app: name, team, environment }
    },
    spec: {
      selector: { app: name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: 'ClusterIP'
    }
  });

  const resources: WebApplicationResources = {
    deployment,
    service,
    configMap
  };

  // Optional database
  if (database?.enabled) {
    // Optional database resources would be created here
    // See database-app.md example for complete implementation
    
    resources.database = databaseDeployment;
    resources.databaseService = databaseService; 
    resources.storage = storage;
  }

  return resources;
}
```

## Custom Factory Patterns

### Composition Pattern
Create base factories with common functionality, then extend them for specific use cases. This promotes code reuse and consistency.

### Builder Pattern  
Use fluent interfaces to create complex factories with optional features. See examples in the [Microservices Pattern](../examples/microservices.md).

## Type Safety Features

### Compile-Time Validation

Factory functions provide full TypeScript validation:

```typescript
// ✅ This works
const deployment = simple.Deployment({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3
});

// ❌ TypeScript errors
const badDeployment = simple.Deployment({
  name: 123,           // Error: number not assignable to string
  image: 'nginx:latest',
  replicas: '3',       // Error: string not assignable to number
  invalidField: true   // Error: object literal may only specify known properties
});
```

### IDE Support

Get full autocomplete and documentation:

```typescript
const deployment = simple.Deployment({
  name: 'my-app',
  image: 'nginx:latest',
  // IDE shows all available options with documentation
  resources: {
    // Autocomplete for cpu, memory, etc.
  },
  // Hover for parameter documentation
});
```

## Testing Custom Factories

Test your custom factories to ensure they generate the expected Kubernetes resources:
- **Unit tests** for factory logic and resource generation
- **Integration tests** for cross-resource references
- **Schema validation** for input parameters

## Best Practices

### 1. Use Descriptive Names
```typescript
// ✅ Good
const userApiDeployment = simple.Deployment({ name: 'user-api' });
const userApiService = simple.Service({ name: 'user-api-service' });

// ❌ Avoid
const d1 = simple.Deployment({ name: 'app' });
const s1 = simple.Service({ name: 'svc' });
```

### 2. Group Related Resources
```typescript
const userService = {
  deployment: simple.Deployment({ /* ... */ }),
  service: simple.Service({ /* ... */ }),
  configMap: simple({ /* ... */ })
};
```

### 3. Use Environment Variables for Configuration
```typescript
const deployment = simple.Deployment({
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
    throw new Error(Cel.template('Invalid config: %s', validConfig.summary));
  }
  
  return simple.Deployment(validConfig);
}
```

### 5. Use TypeScript Strictly

```typescript
// ✅ Define strict interfaces
interface StrictConfig {
  name: string;
  image: string;
  replicas: number;
  environment: 'dev' | 'staging' | 'prod';
}

// ✅ Use generic types
function typedFactory<T extends BaseConfig>(
  config: T
): Enhanced<V1Deployment, V1DeploymentStatus> {
  // Implementation
}
```

### 6. Provide Sensible Defaults

```typescript
// ✅ Merge with defaults
function factoryWithDefaults(config: Config) {
  const defaults = {
    replicas: 1,
    resources: { cpu: '100m', memory: '256Mi' },
    healthChecks: true
  };
  
  const finalConfig = { ...defaults, ...config };
  // Use finalConfig
}
```

### 7. Document Thoroughly

```typescript
/**
 * Creates a production-ready web application deployment
 * 
 * @param config - Application configuration
 * @param config.name - Application name (3-63 characters, DNS-1123 compliant)
 * @param config.image - Container image with tag
 * @param config.replicas - Number of replicas (1-100)
 * @param config.environment - Deployment environment
 * @returns Enhanced deployment resource with typed status
 * 
 * @example
 * ```typescript
 * const app = webApplication({
 *   name: 'user-service',
 *   image: 'myregistry/user-service:v1.0.0',
 *   replicas: 3,
 *   environment: 'production'
 * });
 * ```
 */
export function webApplication(config: WebApplicationConfig) {
  // Implementation
}
```

## Publishing Custom Factories

### Package Structure

```
my-typekro-factories/
├── src/
│   ├── factories/
│   │   ├── web-application.ts
│   │   ├── monitoring-stack.ts
│   │   └── index.ts
│   └── types/
│       └── index.ts
├── __tests__/
│   ├── web-application.test.ts
│   └── monitoring-stack.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

### Package Configuration

```json
// package.json
{
  "name": "@myorg/typekro-factories",
  "version": "1.0.0",
  "description": "Custom TypeKro factory functions for MyOrg",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": [
    "dist/**/*"
  ],
  "scripts": {
    "build": "tsc",
    "test": "bun test",
    "prepublishOnly": "bun run build && bun run test"
  },
  "peerDependencies": {
    "typekro": "^1.0.0",
    "@kubernetes/client-node": "^0.20.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0"
  },
  "keywords": [
    "typekro",
    "kubernetes",
    "infrastructure-as-code",
    "typescript"
  ]
}
```

## Next Steps

- **[Schemas & Types](./schemas-and-types.md)** - Master TypeKro's type system
- **[Runtime Behavior](./runtime-behavior.md)** - Understand status, references, and external dependencies  
- **[CEL Expressions](./cel-expressions.md)** - Add dynamic runtime logic
- **[API Reference](../api/factories/)** - Complete factory function reference
- **[Examples](../examples/)** - See factories in real applications