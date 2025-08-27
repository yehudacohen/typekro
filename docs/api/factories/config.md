# Configuration API

Configuration factory functions create Kubernetes configuration resources with type safety and cross-resource references. These functions handle ConfigMaps, Secrets, and configuration patterns for applications.

## Overview

TypeKro configuration factories provide:
- **Type-safe configuration management** with ConfigMaps and Secrets
- **Schema reference integration** for dynamic configuration values  
- **Cross-resource configuration sharing** between applications
- **Environment-specific configuration patterns**

## Core Configuration Types

### `simple()`

Creates a Kubernetes ConfigMap with simplified configuration.

```typescript
function ConfigMap(config: SimpleConfigMapConfig): Enhanced<V1ConfigMapData, unknown>
```

#### Parameters

- **`config`**: Simplified ConfigMap configuration

```typescript
interface SimpleConfigMapConfig {
  name: string;
  namespace?: string;
  data: Record<string, string | RefOrValue<string>>;
}
```

#### Returns

Enhanced ConfigMap with automatic readiness evaluation.

#### Example: Basic Configuration

```typescript
import { kubernetesComposition, Cel, type } from 'typekro';
import { Deployment, Ingress, Secret } from 'typekro/simple';

const AppSpec = type({
  name: 'string',
  environment: '"development" | "staging" | "production"',
  apiUrl: 'string',
  logLevel: '"debug" | "info" | "warn" | "error"'
});

const configuredApp = kubernetesComposition({
  {
    name: 'configured-app',
    apiVersion: 'config.example.com/v1',
    kind: 'ConfiguredApp',
    spec: AppSpec,
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Configuration from schema
    config: simple({
      name: Cel.template('%s-config', schema.spec.name),
      data: {
        // Direct schema references
        ENVIRONMENT: schema.spec.environment,
        API_URL: schema.spec.apiUrl,
        LOG_LEVEL: schema.spec.logLevel,
        
        // Computed configuration values
        DEBUG_MODE: Cel.conditional(
          schema.spec.environment === 'development',
          'true',
          'false'
        ),
        
        // Environment-specific timeouts
        API_TIMEOUT: Cel.conditional(
          schema.spec.environment === 'production',
          '30000',
          '10000'
        )
      }
    }),
    
    // Application using the configuration
    app: Deployment({
      name: schema.spec.name,
      image: 'myapp:latest',
      ports: [8080],
      env: {
        // Reference config values
        ENVIRONMENT: schema.spec.environment,
        LOG_LEVEL: schema.spec.logLevel
      }
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, ' > 0')
  })
);
```

### `Secret()`

Creates a Kubernetes Secret with simplified configuration.

```typescript
function Secret(config: SimpleSecretConfig): Enhanced<V1SecretData, unknown>
```

#### Parameters

- **`config`**: Simplified Secret configuration

```typescript
interface SimpleSecretConfig {
  name: string;
  namespace?: string;
  data?: Record<string, string>;           // Base64 encoded values
  stringData?: Record<string, string>;     // Plain text values (auto-encoded)
  type?: string;
}
```

#### Returns

Enhanced Secret with automatic readiness evaluation.

#### Example: Database Credentials

```typescript
import { kubernetesComposition, Cel, simple, type } from 'typekro';

const DatabaseAppSpec = type({
  name: 'string',
  dbUser: 'string',
  dbPassword: 'string',
  dbHost: 'string'
});

const databaseApp = kubernetesComposition({
  {
    name: 'database-app',
    apiVersion: 'db.example.com/v1',
    kind: 'DatabaseApp',
    spec: DatabaseAppSpec,
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Sensitive database credentials
    dbSecret: Secret({
      name: Cel.template('%s-db-creds', schema.spec.name),
      stringData: {
        username: schema.spec.dbUser,
        password: schema.spec.dbPassword,
        host: schema.spec.dbHost,
        // Generated connection string
        connectionString: Cel.template(
          'postgres://%s:%s@%s:5432/%s',
          schema.spec.dbUser,
          schema.spec.dbPassword,
          schema.spec.dbHost,
          schema.spec.name
        )
      }
    }),
    
    // Application using the secrets
    app: Deployment({
      name: schema.spec.name,
      image: 'myapp:latest',
      ports: [8080],
      env: {
        // Reference secret values
        DB_USERNAME: {
          valueFrom: {
            secretKeyRef: {
              name: schema.spec.name + '-db-creds',
              key: 'username'
            }
          }
        },
        DB_PASSWORD: {
          valueFrom: {
            secretKeyRef: {
              name: schema.spec.name + '-db-creds', 
              key: 'password'
            }
          }
        },
        DATABASE_URL: {
          valueFrom: {
            secretKeyRef: {
              name: schema.spec.name + '-db-creds',
              key: 'connectionString'
            }
          }
        }
      }
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, ' > 0')
  })
);
```

## Advanced Configuration Patterns

### Environment-Specific Configuration

Create configuration that adapts to different environments:

```typescript
const multiEnvConfig = kubernetesComposition({
  {
    name: 'multi-env-config',
    apiVersion: 'config.example.com/v1',
    kind: 'MultiEnvConfig',
    spec: type({
      name: 'string',
      environment: '"development" | "staging" | "production"'
    }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Environment-specific application config
    appConfig: simple({
      name: 'app-config',
      data: {
        // Static values
        APP_NAME: schema.spec.name,
        
        // Environment-specific database settings
        DB_POOL_SIZE: Cel.conditional(
          schema.spec.environment === 'production',
          '20',
          Cel.conditional(schema.spec.environment === 'staging', '10', '5')
        ),
        
        // Environment-specific cache settings
        CACHE_TTL: Cel.conditional(
          schema.spec.environment === 'production',
          '3600',
          '300'
        ),
        
        // Feature flags
        FEATURE_NEW_UI: Cel.conditional(
          schema.spec.environment !== 'development',
          'true',
          'false'
        ),
        
        // Logging configuration
        LOG_FORMAT: Cel.conditional(
          schema.spec.environment === 'production',
          'json',
          'text'
        )
      }
    }),
    
    // Environment-specific secrets
    secrets: Secret({
      name: 'app-secrets',
      stringData: {
        // Different API keys per environment
        API_KEY: Cel.conditional(
          schema.spec.environment === 'production',
          'prod-api-key-12345',
          Cel.conditional(
            schema.spec.environment === 'staging',
            'staging-api-key-67890', 
            'dev-api-key-abcde'
          )
        ),
        
        // Database URLs per environment  
        DATABASE_URL: Cel.template(
          'postgres://app:secret@%s-db:5432/%s',
          schema.spec.environment,
          schema.spec.name
        )
      }
    }),
    
    app: Deployment({
      name: schema.spec.name,
      image: 'myapp:latest',
      replicas: Cel.conditional(
        schema.spec.environment === 'production',
        5,
        Cel.conditional(schema.spec.environment === 'staging', 3, 1)
      ),
      env: {
        ENVIRONMENT: schema.spec.environment
      }
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, ' > 0')
  })
);
```

### Shared Configuration Pattern

Share configuration between multiple applications:

```typescript
const sharedConfigPlatform = kubernetesComposition({
  {
    name: 'shared-config-platform',
    apiVersion: 'platform.example.com/v1',
    kind: 'ConfigPlatform',
    spec: type({
      platformName: 'string',
      region: 'string',
      environment: 'string'
    }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Shared platform configuration
    platformConfig: simple({
      name: 'platform-config',
      data: {
        PLATFORM_NAME: schema.spec.platformName,
        REGION: schema.spec.region,
        ENVIRONMENT: schema.spec.environment,
        
        // Computed platform URLs
        PLATFORM_API_URL: Cel.template(
          'https://api.%s.%s.example.com',
          schema.spec.environment,
          schema.spec.region
        ),
        
        MONITORING_URL: Cel.template(
          'https://monitoring.%s.example.com',
          schema.spec.region
        )
      }
    }),
    
    // Shared platform secrets
    platformSecrets: Secret({
      name: 'platform-secrets',
      stringData: {
        JWT_SECRET: 'shared-jwt-secret-key',
        ENCRYPTION_KEY: 'shared-encryption-key',
        MONITORING_TOKEN: 'shared-monitoring-token'
      }
    }),
    
    // Frontend application
    frontend: Deployment({
      name: 'frontend',
      image: 'frontend:latest',
      ports: [3000],
      env: {
        // Uses shared config
        PLATFORM_NAME: schema.spec.platformName,
        API_URL: Cel.template(
          'https://api.%s.%s.example.com',
          schema.spec.environment,
          schema.spec.region
        )
      }
    }),
    
    // Backend API
    backend: Deployment({
      name: 'backend-api',
      image: 'backend:latest', 
      ports: [8080],
      env: {
        // Uses shared config and secrets
        PLATFORM_NAME: schema.spec.platformName,
        REGION: schema.spec.region,
        JWT_SECRET: {
          valueFrom: {
            secretKeyRef: {
              name: 'platform-secrets',
              key: 'JWT_SECRET'
            }
          }
        }
      }
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.frontend.status.readyReplicas, ' > 0 && ',
      resources.backend.status.readyReplicas, ' > 0'
    )
  })
);
```

### Configuration with File Mounts

Mount configuration files into containers:

```typescript
const fileBasedConfig = kubernetesComposition({
  {
    name: 'file-based-config',
    apiVersion: 'config.example.com/v1',
    kind: 'FileBasedConfig',
    spec: type({
      name: 'string',
      logLevel: 'string'
    }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Configuration files
    appConfig: simple({
      name: 'app-file-config',
      data: {
        // JSON configuration file
        'config.json': Cel.template(
          `{
  "app": {
    "name": "%s",
    "logLevel": "%s",
    "server": {
      "port": 8080,
      "timeout": 30
    }
  }
}`,
          schema.spec.name,
          schema.spec.logLevel
        ),
        
        // Properties file
        'application.properties': Cel.template(
          `app.name=%s
app.log.level=%s
server.port=8080
server.timeout=30000`,
          schema.spec.name,
          schema.spec.logLevel
        ),
        
        // NGINX configuration
        'nginx.conf': `
server {
    listen 80;
    server_name localhost;
    
    location / {
        proxy_pass http://backend:8080;
        proxy_set_header Host $host;
    }
}`
      }
    }),
    
    // Application with mounted config files
    app: Deployment({
      name: schema.spec.name,
      image: 'myapp:latest',
      ports: [8080],
      volumeMounts: [{
        name: 'config-volume',
        mountPath: '/etc/config'
      }],
      volumes: [{
        name: 'config-volume',
        configMap: {
          name: 'app-file-config'
        }
      }]
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, ' > 0')
  })
);
```

### TLS Certificate Management

Manage TLS certificates with Secrets:

```typescript
const tlsApp = kubernetesComposition({
  {
    name: 'tls-app',
    apiVersion: 'security.example.com/v1',
    kind: 'TLSApp',
    spec: type({
      name: 'string',
      domain: 'string'
    }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // TLS certificate secret
    tlsCert: Secret({
      name: 'tls-certificate',
      type: 'kubernetes.io/tls',
      stringData: {
        'tls.crt': '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----',
        'tls.key': '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'
      }
    }),
    
    // Application 
    app: Deployment({
      name: schema.spec.name,
      image: 'nginx:1.21',
      ports: [443, 80],
      volumeMounts: [{
        name: 'tls-certs',
        mountPath: '/etc/nginx/certs'
      }],
      volumes: [{
        name: 'tls-certs',
        secret: {
          secretName: 'tls-certificate'
        }
      }]
    }),
    
    // Ingress with TLS
    ingress: Ingress({
      name: schema.spec.name,
      host: schema.spec.domain,
      serviceName: schema.spec.name,
      servicePort: 80,
      tls: true,
      tlsSecretName: 'tls-certificate'
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, ' > 0')
  })
);
```

## Full Factory Functions

For complete control, use the full factory functions:

### `configMap()`

```typescript
function configMap(resource: V1ConfigMap): Enhanced<V1ConfigMapData, unknown>
```

### `secret()`

```typescript
function secret(resource: V1Secret): Enhanced<V1SecretData, unknown>
```

#### Example: Complete Secret Configuration

```typescript
import { secret } from 'typekro';

const advancedSecret = secret({
  metadata: {
    name: 'app-credentials',
    labels: { app: 'myapp', component: 'auth' },
    annotations: { 'secret.example.com/rotation': 'monthly' }
  },
  type: 'Opaque',
  data: {
    username: btoa('admin'),           // Base64 encoded
    password: btoa('super-secret'),    // Base64 encoded
    config: btoa('{"role": "admin"}')  // Base64 encoded JSON
  }
});
```

## Type Definitions

### Input Types

```typescript
interface SimpleConfigMapConfig {
  name: string;
  namespace?: string;
  data: Record<string, string | RefOrValue<string>>;
}

interface SimpleSecretConfig {
  name: string;
  namespace?: string;
  data?: Record<string, string>;
  stringData?: Record<string, string>;
  type?: string;
}
```

### Enhanced Output Types

```typescript
import type { Enhanced } from 'typekro';

type EnhancedConfigMap = Enhanced<V1ConfigMapData, unknown>;
type EnhancedSecret = Enhanced<V1SecretData, unknown>;
```

## Configuration Best Practices

### 1. Separate Configuration from Code

Keep configuration external to container images:

```typescript
// Good: External configuration
config: simple({
  name: 'app-config',
  data: {
    API_URL: schema.spec.apiUrl,
    LOG_LEVEL: schema.spec.logLevel
  }
})

// Avoid: Hardcoded in image
```

### 2. Use Secrets for Sensitive Data

Never put sensitive data in ConfigMaps:

```typescript
// Good: Sensitive data in Secret
secret: Secret({
  name: 'db-creds',
  stringData: {
    password: schema.spec.dbPassword,
    apiKey: schema.spec.apiKey
  }
})

// Bad: Sensitive data in ConfigMap
config: simple({
  data: {
    password: 'secret-password'  // ❌ Visible in plain text
  }
})
```

### 3. Use Environment-Specific Values

Leverage schema references for environment-specific configuration:

```typescript
data: {
  TIMEOUT: Cel.conditional(
    schema.spec.environment === 'production',
    '30000',
    '5000'
  )
}
```

### 4. Organize Configuration Logically

Group related configuration together:

```typescript
// Database configuration
dbConfig: simple({
  name: 'database-config',
  data: {
    DB_HOST: schema.spec.database.host,
    DB_PORT: '5432',
    DB_NAME: schema.spec.database.name
  }
}),

// Application configuration  
appConfig: simple({
  name: 'app-config',
  data: {
    LOG_LEVEL: schema.spec.logLevel,
    FEATURE_FLAGS: schema.spec.features
  }
})
```

### 5. Use Descriptive Names

Choose clear, descriptive names for configuration resources:

```typescript
// Good
userServiceConfig: simple({
  name: 'user-service-config',
  data: { /* ... */ }
})

// Avoid
config: simple({
  name: 'config',
  data: { /* ... */ }  
})
```

## Related APIs

- [Workloads API](/api/factories/workloads) - Using configuration in deployments
- [Storage API](/api/factories/storage) - Persistent configuration storage
- [Types API](/api/types) - TypeScript type definitions
- [Database Example](/examples/database) - Real-world configuration patterns