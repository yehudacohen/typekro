# Schema Definition with Arktype

TypeKro uses [Arktype](https://arktype.io) for runtime-safe TypeScript schemas that provide both compile-time type safety and runtime validation. This guide covers how to define and use schemas in TypeKro resource graphs.

## What is Arktype?

**Arktype** is a TypeScript schema validation library that provides:

- **Runtime-safe types** - Validate data at runtime, not just compile time
- **TypeScript-first syntax** - Define schemas using familiar TypeScript syntax
- **Zero dependencies** - Lightweight and fast runtime validation
- **Inference support** - Full TypeScript type inference from schema definitions

## Basic Schema Definition

### Simple Types

Define basic types using Arktype's intuitive syntax:

```typescript
import { type } from 'arktype';

// Basic primitive types
const StringSchema = type('string');
const NumberSchema = type('number');  
const BooleanSchema = type('boolean');

// String with constraints
const NonEmptyString = type('string>0');        // Non-empty string
const EmailString = type('string.email');       // Valid email format
const UrlString = type('string.url');           // Valid URL format

// Number with constraints  
const PositiveNumber = type('number>0');        // Positive numbers
const IntegerRange = type('1<=integer<=100');   // Integers from 1-100
const Port = type('1<=integer<=65535');         // Valid port numbers
```

### Object Schemas

Create complex object schemas for TypeKro specs:

```typescript
import { type } from 'arktype';

// Application specification schema
const AppSpec = type({
  name: 'string>0',                    // Required non-empty string
  image: 'string>0',                   // Required non-empty string
  replicas: 'number>=1',               // At least 1 replica
  environment: '"development" | "staging" | "production"',  // Literal union
  ports: 'number[]',                   // Array of numbers
  'resources?': {                      // Optional nested object
    'cpu?': 'string',
    'memory?': 'string'
  }
});

// Database specification schema
const DatabaseSpec = type({
  name: 'string>0',
  engine: '"postgres" | "mysql" | "mongodb"',
  version: 'string',
  storage: {
    size: 'string',
    class: 'string',
    backup: 'boolean'
  },
  replicas: 'number>=1',
  'resources?': {
    cpu: 'string',
    memory: 'string'
  }
});

// Status schema
const AppStatus = type({
  ready: 'boolean',
  phase: '"pending" | "running" | "failed" | "succeeded"',
  replicas: 'number',
  url: 'string',
  'lastUpdate?': 'Date'
});
```

### Using Schemas in Resource Graphs

Integrate Arktype schemas with TypeKro resource graphs:

```typescript
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService, Cel } from 'typekro';

const WebAppSpec = type({
  name: 'string>0',
  image: 'string>0', 
  replicas: '1<=integer<=50',          // Constrain replica count
  domain: 'string.url',                // Must be valid URL
  environment: '"dev" | "staging" | "prod"'
});

const WebAppStatus = type({
  ready: 'boolean',
  url: 'string.url',
  healthStatus: '"healthy" | "degraded" | "unhealthy"',
  activeReplicas: 'number>=0'
});

const webapp = toResourceGraph(
  {
    name: 'webapp-with-validation',
    apiVersion: 'apps.example.com/v1',
    kind: 'ValidatedWebApp',
    spec: WebAppSpec,           // Arktype schema for validation
    status: WebAppStatus        // Arktype schema for status
  },
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [8080],
      env: {
        ENVIRONMENT: schema.spec.environment,
        DOMAIN: schema.spec.domain
      }
    }),
    
    service: simpleService({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 8080 }]
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.deployment.status.readyReplicas, ' >= ', schema.spec.replicas),
    url: schema.spec.domain,
    healthStatus: Cel.conditional(
      Cel.expr(resources.deployment.status.readyReplicas, ' >= ', schema.spec.replicas),
      'healthy',
      'degraded'
    ),
    activeReplicas: resources.deployment.status.readyReplicas
  })
);

// Deploy with validation
const factory = webapp.factory('direct', { namespace: 'default' });

// ✅ Valid input - passes Arktype validation
await factory.deploy({
  name: 'my-webapp',
  image: 'nginx:1.21',
  replicas: 3,
  domain: 'https://myapp.example.com',
  environment: 'staging'
});

// ❌ Invalid input - Arktype catches errors
try {
  await factory.deploy({
    name: '',                           // Invalid: empty string
    image: 'nginx:1.21',
    replicas: 0,                        // Invalid: must be >= 1
    domain: 'not-a-url',               // Invalid: not a valid URL
    environment: 'invalid'              // Invalid: not in allowed values
  });
} catch (error) {
  console.log('Validation failed:', error.summary);
}
```

## Advanced Schema Patterns

### Conditional Schemas

Create schemas with conditional validation based on other fields:

```typescript
const DatabaseConfigSpec = type({
  engine: '"postgres" | "mysql" | "mongodb"',
  version: 'string',
  
  // Conditional configuration based on engine
  config: {
    // PostgreSQL specific
    'maxConnections?': 'number>0',
    'sharedBuffers?': 'string',
    
    // MySQL specific  
    'innodbBufferPoolSize?': 'string',
    'maxAllowedPacket?': 'string',
    
    // MongoDB specific
    'wiredTigerCacheSizeGB?': 'number>0',
    'maxIncomingConnections?': 'number>0'
  }
});

// Use with environment-specific defaults
const environmentalDatabase = toResourceGraph(
  {
    name: 'environmental-database',
    apiVersion: 'data.example.com/v1', 
    kind: 'EnvironmentalDatabase',
    spec: DatabaseConfigSpec,
    status: type({ ready: 'boolean', endpoint: 'string' })
  },
  (schema) => ({
    database: simpleStatefulSet({
      name: schema.spec.engine,
      image: Cel.template('%s:%s', schema.spec.engine, schema.spec.version),
      env: {
        // Engine-specific environment variables
        ...(schema.spec.engine === 'postgres' ? {
          POSTGRES_DB: 'myapp',
          POSTGRES_MAX_CONNECTIONS: schema.spec.config.maxConnections?.toString() || '100'
        } : {}),
        
        ...(schema.spec.engine === 'mysql' ? {
          MYSQL_DATABASE: 'myapp',
          MYSQL_MAX_ALLOWED_PACKET: schema.spec.config.maxAllowedPacket || '16M'
        } : {}),
        
        ...(schema.spec.engine === 'mongodb' ? {
          MONGO_INITDB_DATABASE: 'myapp'
        } : {})
      }
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.database.status.readyReplicas, ' > 0'),
    endpoint: Cel.template('%s:5432', resources.database.spec.clusterIP)
  })
);
```

### Nested Complex Schemas

Handle deeply nested configuration schemas:

```typescript
const MicroserviceArchitectureSpec = type({
  name: 'string>0',
  services: {
    frontend: {
      image: 'string>0',
      replicas: '1<=integer<=10',
      resources: {
        cpu: 'string',
        memory: 'string'
      },
      'ingress?': {
        host: 'string.url',
        tls: 'boolean'
      }
    },
    backend: {
      image: 'string>0', 
      replicas: '1<=integer<=20',
      database: {
        type: '"postgres" | "mysql"',
        host: 'string>0',
        port: '1<=integer<=65535',
        credentials: {
          username: 'string>0',
          'passwordSecret?': 'string>0'
        }
      }
    },
    'worker?': {
      image: 'string>0',
      replicas: '1<=integer<=50',
      'schedule?': 'string'
    }
  }
});

const microserviceApp = toResourceGraph(
  {
    name: 'microservice-architecture',
    apiVersion: 'platform.example.com/v1',
    kind: 'MicroserviceArchitecture', 
    spec: MicroserviceArchitectureSpec,
    status: type({
      ready: 'boolean',
      services: {
        frontend: 'boolean',
        backend: 'boolean',
        'worker?': 'boolean'
      }
    })
  },
  (schema) => ({
    // Frontend deployment
    frontend: simpleDeployment({
      name: 'frontend',
      image: schema.spec.services.frontend.image,
      replicas: schema.spec.services.frontend.replicas,
      ports: [3000],
      resources: {
        requests: {
          cpu: schema.spec.services.frontend.resources.cpu,
          memory: schema.spec.services.frontend.resources.memory
        }
      }
    }),
    
    // Backend deployment
    backend: simpleDeployment({
      name: 'backend',
      image: schema.spec.services.backend.image,
      replicas: schema.spec.services.backend.replicas,
      ports: [8080],
      env: {
        DB_TYPE: schema.spec.services.backend.database.type,
        DB_HOST: schema.spec.services.backend.database.host,
        DB_PORT: schema.spec.services.backend.database.port.toString(),
        DB_USER: schema.spec.services.backend.database.credentials.username
      }
    }),
    
    // Optional worker
    ...(schema.spec.services.worker && {
      worker: schema.spec.services.worker.schedule ? 
        simpleCronJob({
          name: 'worker',
          image: schema.spec.services.worker.image,
          schedule: schema.spec.services.worker.schedule
        }) :
        simpleDeployment({
          name: 'worker',
          image: schema.spec.services.worker.image,
          replicas: schema.spec.services.worker.replicas
        })
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.frontend.status.readyReplicas, ' > 0 && ',
      resources.backend.status.readyReplicas, ' > 0',
      schema.spec.services.worker ? 
        ' && ' + (resources.worker?.status?.readyReplicas || 0) + ' > 0' : ''
    ),
    services: {
      frontend: Cel.expr(resources.frontend.status.readyReplicas, ' > 0'),
      backend: Cel.expr(resources.backend.status.readyReplicas, ' > 0'),
      ...(schema.spec.services.worker && {
        worker: Cel.expr((resources.worker?.status?.readyReplicas || 0), ' > 0')
      })
    }
  })
);
```

### Array and Collection Schemas

Define schemas for arrays and collections:

```typescript
const ClusterSpec = type({
  name: 'string>0',
  
  // Array of services with validation
  services: {
    name: 'string>0',
    image: 'string>0',
    port: '1<=integer<=65535',
    'replicas?': '1<=integer<=100'
  }[],
  
  // Configuration per environment
  environments: {
    name: '"dev" | "staging" | "prod"',
    namespace: 'string>0',
    resources: {
      'cpu?': 'string',
      'memory?': 'string'
    },
    'secrets?': 'string[]'
  }[],
  
  // Optional configuration
  'monitoring?': {
    enabled: 'boolean',
    'retention?': 'string'
  }
});

const cluster = toResourceGraph(
  {
    name: 'service-cluster',
    apiVersion: 'cluster.example.com/v1',
    kind: 'ServiceCluster',
    spec: ClusterSpec,
    status: type({
      ready: 'boolean',
      serviceCount: 'number',
      environmentsReady: 'string[]'
    })
  },
  (schema) => ({
    // Create deployments for each service
    services: schema.spec.services.map(service =>
      simpleDeployment({
        name: service.name,
        image: service.image,
        replicas: service.replicas || 1,
        ports: [service.port]
      })
    ),
    
    // Create services for each deployment
    serviceEndpoints: schema.spec.services.map(service =>
      simpleService({
        name: Cel.expr(service.name, '-service'),
        selector: { app: service.name },
        ports: [{ port: 80, targetPort: service.port }]
      })
    )
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.services.map(svc => 
        Cel.expr(svc.status.readyReplicas, ' > 0')
      ).join(' && ')
    ),
    serviceCount: schema.spec.services.length,
    environmentsReady: schema.spec.environments.map(env => env.name)
  })
);
```

## Schema Validation and Error Handling

### Runtime Validation

Arktype provides runtime validation with detailed error messages:

```typescript
// Define schema with validation
const StrictAppSpec = type({
  name: 'string>0',
  version: 'string.semver',           // Semantic version format
  replicas: '1<=integer<=100',        // Constrained integer
  resources: {
    cpu: 'string.format.cpu',         // CPU format (e.g., "100m", "1")
    memory: 'string.format.memory'    // Memory format (e.g., "128Mi", "1Gi")
  }
});

// Validate input before deployment
function validateAndDeploy(input: unknown) {
  const result = StrictAppSpec(input);
  
  if (result instanceof type.errors) {
    // Handle validation errors
    console.error('Schema validation failed:');
    result.forEach(error => {
      console.error(Cel.template('- %s: %s', error.path, error.message));
    });
    throw new Error('Invalid input schema');
  }
  
  // Input is valid - proceed with deployment
  return result;
}

// Usage
try {
  const validInput = validateAndDeploy({
    name: 'my-app',
    version: '1.2.3',
    replicas: 5,
    resources: {
      cpu: '500m',
      memory: '1Gi'
    }
  });
  
  // Deploy with validated input
  await factory.deploy(validInput);
} catch (error) {
  console.error('Deployment failed:', error.message);
}
```

### Custom Validation Rules

Create custom validation rules with Arktype:

```typescript
// Custom validation functions
const isValidKubernetesName = (value: string): boolean => {
  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value);
};

const isValidDockerImage = (value: string): boolean => {
  return /^[\w.\-_/]+:[\w.\-_]+$/.test(value);
};

// Schema with custom validation
const CustomValidatedSpec = type({
  name: ['string>0', ':', isValidKubernetesName],
  image: ['string>0', ':', isValidDockerImage],
  replicas: 'number>=1',
  'labels?': ['Record<string, string>', ':', (labels) => 
    Object.keys(labels).every(key => isValidKubernetesName(key))
  ]
});

// Use in resource graph
const customApp = toResourceGraph(
  {
    name: 'custom-validated-app',
    apiVersion: 'custom.example.com/v1',
    kind: 'CustomValidatedApp',
    spec: CustomValidatedSpec,
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      labels: schema.spec.labels
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, ' > 0')
  })
);
```

## Schema Evolution and Versioning

### Versioned Schemas

Handle schema evolution with versioning:

```typescript
// Version 1 schema
const AppSpecV1 = type({
  name: 'string>0',
  image: 'string>0',
  replicas: 'number>=1'
});

// Version 2 schema (adds environment)
const AppSpecV2 = type({
  name: 'string>0',
  image: 'string>0', 
  replicas: 'number>=1',
  environment: '"dev" | "staging" | "prod"'  // New field
});

// Version 3 schema (adds resources, makes environment optional)
const AppSpecV3 = type({
  name: 'string>0',
  image: 'string>0',
  replicas: 'number>=1',
  'environment?': '"dev" | "staging" | "prod"',  // Now optional
  'resources?': {                                // New optional field
    cpu: 'string',
    memory: 'string'
  }
});

// Migrate between schema versions
function migrateToV3(input: any): any {
  // Add default environment if missing
  if (!input.environment) {
    input.environment = 'dev';
  }
  
  // Add default resources if missing
  if (!input.resources) {
    input.resources = {
      cpu: '100m',
      memory: '128Mi'
    };
  }
  
  return input;
}

// Use latest schema version
const modernApp = toResourceGraph(
  {
    name: 'modern-app',
    apiVersion: 'apps.example.com/v3',  // Version in API version
    kind: 'ModernApp',
    spec: AppSpecV3,                    // Latest schema
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      env: {
        ENVIRONMENT: schema.spec.environment || 'dev'
      },
      resources: schema.spec.resources
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, ' > 0')
  })
);
```

## Best Practices

### 1. Use Descriptive Constraints

Make schemas self-documenting with meaningful constraints:

```typescript
// Good: Descriptive constraints
const ServerSpec = type({
  name: 'string>0',                    // Must be non-empty
  port: '1024<=integer<=65535',        // Valid unprivileged port range
  replicas: '1<=integer<=50',          // Reasonable replica range
  memory: 'string.format.memory'       // Kubernetes memory format
});

// Avoid: Vague constraints
const ServerSpec = type({
  name: 'string',
  port: 'number',
  replicas: 'number',
  memory: 'string'
});
```

### 2. Validate Early and Often

Validate input as early as possible:

```typescript
async function deployApplication(input: unknown) {
  // Validate immediately
  const spec = AppSpec(input);
  if (spec instanceof type.errors) {
    throw new Error(Cel.template('Invalid spec: %s', spec.summary));
  }
  
  // Proceed with validated data
  const factory = app.factory('direct', { namespace: 'default' });
  return factory.deploy(spec);
}
```

### 3. Use Optional Fields Judiciously

Make fields optional only when they have sensible defaults:

```typescript
// Good: Optional with defaults
const AppSpec = type({
  name: 'string>0',
  image: 'string>0',
  'replicas?': 'number>=1',    // Default: 1
  'resources?': {              // Default: no limits
    cpu: 'string',
    memory: 'string'
  }
});

// In resource builder, provide defaults
replicas: schema.spec.replicas || 1
```

### 4. Group Related Fields

Organize schema fields logically:

```typescript
const DatabaseSpec = type({
  // Identity
  name: 'string>0',
  engine: '"postgres" | "mysql"',
  
  // Configuration
  config: {
    version: 'string',
    port: 'number>0',
    'maxConnections?': 'number>0'
  },
  
  // Resources
  resources: {
    cpu: 'string',
    memory: 'string',
    storage: 'string'
  },
  
  // High availability
  'ha?': {
    replicas: 'number>=2',
    'backup?': {
      enabled: 'boolean',
      schedule: 'string'
    }
  }
});
```

### 5. Document Schema Constraints

Include comments explaining validation rules:

```typescript
const ApiServerSpec = type({
  // Application identity (lowercase DNS-compatible)
  name: 'string>0',
  
  // Container image (must include tag)
  image: 'string.format.dockerImage',
  
  // Replica count (1-100 for resource limits)
  replicas: '1<=integer<=100',
  
  // Network port (unprivileged ports only)
  port: '1024<=integer<=65535',
  
  // Environment (affects configuration and resources)
  environment: '"development" | "staging" | "production"'
});
```

## Related Topics

- [Resource Graphs Guide](./resource-graphs.md) - Using schemas in resource graphs
- [toResourceGraph API](../api/to-resource-graph.md) - Complete API reference
- [Type Safety Guide](./type-safety.md) - Advanced TypeScript patterns
- [CEL Expressions](./cel-expressions.md) - Dynamic schema references