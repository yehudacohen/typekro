# Schemas & Types

TypeKro leverages both **ArkType** for runtime-safe schema validation and **TypeScript**'s powerful type system to provide comprehensive type safety. This guide covers how to define schemas, implement type safety patterns, and build robust, validated infrastructure configurations.

## Introduction to TypeKro's Type System

TypeKro provides multiple layers of type safety:

- **Schema validation** with ArkType for runtime checking
- **Enhanced resources** with typed status and references
- **Cross-resource references** with compile-time validation
- **Factory functions** with typed configuration interfaces
- **CEL expressions** with type-safe evaluation

```typescript
import { type } from 'arktype';
import { toResourceGraph, Cel, simple } from 'typekro';

// 1. Schema validation with ArkType
const AppSpec = type({
  name: 'string>2',           // String with minimum length
  replicas: 'number>0',       // Positive number
  environment: '"dev" | "staging" | "prod"'  // Enum validation
});

// 2. Type-safe resource graph
const app = toResourceGraph(
  { name: 'typed-app', schema: { spec: AppSpec } },
  (schema) => ({
    // 3. Typed factory functions
    deployment: simple.Deployment({
      name: schema.spec.name,           // ✅ Typed access
      replicas: schema.spec.replicas    // ✅ Number type enforced
    })
  }),
  (schema, resources) => ({
    // 4. Typed status mapping
    ready: Cel.expr(resources.deployment.status.readyReplicas, '> 0')
  })
);
```

## Schema Definition with ArkType

### What is ArkType?

**ArkType** is a TypeScript schema validation library that provides:

- **Runtime-safe types** - Validate data at runtime, not just compile time
- **TypeScript-first syntax** - Define schemas using familiar TypeScript syntax
- **Zero dependencies** - Lightweight and fast runtime validation
- **Inference support** - Full TypeScript type inference from schema definitions

### Basic Schema Definition

Define basic types using ArkType's intuitive syntax:

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

For complete schema integration examples, see [Basic WebApp Pattern](../examples/basic-webapp.md).

Key schema integration concepts:
- **Validation**: ArkType validates input at deploy time
- **Type Safety**: TypeScript enforces schema contracts
- **Runtime Checks**: Invalid inputs caught before deployment  
- **Status Mapping**: Schema defines expected status structure

```typescript
// Schema with validation constraints
const WebAppSpec = type({
  name: 'string>0',                    // Non-empty string
  replicas: '1<=integer<=50',          // Constrained range
  environment: '"dev" | "staging" | "prod"'  // Union types
});

// Schema validation catches errors
try {
  await factory.deploy({
    name: '',           // ❌ Invalid: empty string
    replicas: 0,        // ❌ Invalid: below minimum  
    environment: 'invalid'  // ❌ Invalid: not in union
  });
} catch (error) {
  console.log('Validation failed:', error.summary);
}
```

## Advanced Schema Patterns

### Complex Type Definitions

```typescript
import { type } from 'arktype';

// Nested object validation
const DatabaseConfig = type({
  host: 'string',
  port: 'number>=1024&<=65535',  // Port range validation
  credentials: {
    username: 'string>2',
    password: 'string>=8'         // Minimum password length
  },
  ssl: {
    enabled: 'boolean',
    'certificatePath?': 'string'  // Optional field
  },
  'connectionPool?': {            // Optional nested object
    minSize: 'number>=1',
    maxSize: 'number<=100',
    'timeout?': 'number>0'
  }
});

// Array validation with constraints
const ServiceConfig = type({
  name: 'string',
  ports: 'number[]>=1',          // Non-empty array of numbers
  environments: '"dev" | "staging" | "prod"[]',  // Array of enums
  features: {
    auth: 'boolean',
    metrics: 'boolean',
    'logging?': 'boolean'
  }
});

// Union types for flexibility
const StorageConfig = type({
  type: '"pvc" | "hostPath" | "emptyDir"',
  size: 'string',
  'storageClass?': 'string',
  'hostPath?': {
    path: 'string',
    type: '"Directory" | "File"'
  }
});

// Complete application specification
const ComplexAppSpec = type({
  metadata: {
    name: 'string>2&<=63',       // Kubernetes name constraints
    team: 'string',
    environment: '"dev" | "staging" | "prod"'
  },
  deployment: {
    image: 'string',
    replicas: 'number>0&<=100',  // Replica constraints
    resources: {
      cpu: 'string',             // e.g., "100m", "1000m"
      memory: 'string'           // e.g., "256Mi", "1Gi"
    }
  },
  database: DatabaseConfig,
  services: ServiceConfig[],      // Array of services
  storage: StorageConfig,
  'monitoring?': {               // Optional monitoring config
    enabled: 'boolean',
    'retention?': 'string'
  }
});
```

### Dynamic Type Generation

```typescript
// Generate types based on environment
function createEnvironmentSpec(environments: string[]) {
  const envUnion = environments.map(env => `"${env}"`).join(' | ');
  
  return type({
    name: 'string',
    environment: envUnion,        // Dynamic enum
    replicas: 'number>0'
  });
}

const DevProdSpec = createEnvironmentSpec(['development', 'production']);
const AllEnvSpec = createEnvironmentSpec(['dev', 'staging', 'prod', 'test']);

// Conditional types based on environment
const ConditionalSpec = type({
  name: 'string',
  environment: '"dev" | "prod"',
  // Production requires more configuration
  'monitoring?': 'boolean',
  'highAvailability?': 'boolean'
}).pipe((input) => {
  if (input.environment === 'prod') {
    if (!input.monitoring) {
      return type.errors(['Monitoring is required in production']);
    }
    if (!input.highAvailability) {
      return type.errors(['High availability is required in production']);
    }
  }
  return input;
});
```

### Schema Composition

```typescript
// Base schemas for reuse
const BaseMetadata = type({
  name: 'string>2',
  team: 'string',
  environment: '"dev" | "staging" | "prod"'
});

const BaseResources = type({
  cpu: 'string',
  memory: 'string'
});

const BaseDeployment = type({
  image: 'string',
  replicas: 'number>0',
  resources: BaseResources
});

// Compose complex schemas
const WebAppSpec = type({
  metadata: BaseMetadata,
  deployment: BaseDeployment.and({
    ports: 'number[]>=1'
  }),
  service: {
    type: '"ClusterIP" | "LoadBalancer"',
    'annotations?': 'string.record'
  }
});

const ApiServiceSpec = type({
  metadata: BaseMetadata,
  deployment: BaseDeployment.and({
    healthCheck: {
      path: 'string',
      port: 'number>0'
    }
  }),
  monitoring: {
    enabled: 'boolean',
    'scrapeInterval?': 'string'
  }
});
```

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
    database: simple.StatefulSet({
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
    ready: Cel.expr(resources.database.status.readyReplicas, '> 0'),
    endpoint: Cel.template('%s:5432', resources.database.spec.clusterIP)
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
      simple.Deployment({
        name: service.name,
        image: service.image,
        replicas: service.replicas || 1,
        ports: [service.port]
      })
    ),
    
    // Create services for each deployment
    serviceEndpoints: schema.spec.services.map(service =>
      simple.Service({
        name: Cel.expr(service.name, '-service'),
        selector: { app: service.name },
        ports: [{ port: 80, targetPort: service.port }]
      })
    )
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.services.map(svc => 
        svc.status.readyReplicas
      ).join(' + '),
      '== ',
      resources.services.length
    ),
    serviceCount: schema.spec.services.length,
    environmentsReady: schema.spec.environments.map(env => env.name)
  })
);
```

## Type-Safe Factory Functions

### Generic Factory Functions

```typescript
import type { Enhanced } from 'typekro';

// Generic configuration interface
interface BaseFactoryConfig<T = {}> {
  name: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  namespace?: string;
}

// Type-safe factory with constraints
function createTypedDeployment<
  TConfig extends BaseFactoryConfig & {
    image: string;
    replicas: number;
  }
>(config: TConfig): Enhanced<V1Deployment, V1DeploymentStatus> {
  return createResource({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: config.name,
      labels: {
        app: config.name,
        ...config.labels
      },
      annotations: config.annotations,
      ...(config.namespace && { namespace: config.namespace })
    },
    spec: {
      replicas: config.replicas,
      selector: { matchLabels: { app: config.name } },
      template: {
        metadata: { labels: { app: config.name, ...config.labels } },
        spec: {
          containers: [{
            name: config.name,
            image: config.image,
            ports: [{ containerPort: 3000 }]
          }]
        }
      }
    }
  });
}

// Usage with type checking
const deployment = createTypedDeployment({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3,           // ✅ Number required
  labels: {
    version: 'v1.0.0'
  }
});

// TypeScript error examples
const invalidDeployment = createTypedDeployment({
  name: 'my-app',
  image: 'nginx:latest'
  // ❌ Error: replicas is required
});
```

### Conditional Factory Types

```typescript
// Factory with conditional configuration
interface ConditionalDeploymentConfig {
  name: string;
  image: string;
  environment: 'development' | 'staging' | 'production';
  
  // Production-specific requirements
  ...(environment extends 'production' ? {
    replicas: number;        // Required in production
    resources: {
      cpu: string;
      memory: string;
    };
    monitoring: true;        // Must be enabled
  } : {
    replicas?: number;       // Optional in non-prod
    resources?: {
      cpu?: string;
      memory?: string;
    };
    monitoring?: boolean;    // Optional
  })
}

// Type-safe implementation
function conditionalDeployment<T extends ConditionalDeploymentConfig>(
  config: T
): Enhanced<V1Deployment, V1DeploymentStatus> {
  // Production validation
  if (config.environment === 'production') {
    if (!config.replicas || config.replicas < 2) {
      throw new Error('Production requires at least 2 replicas');
    }
    if (!config.resources?.cpu || !config.resources?.memory) {
      throw new Error('Production requires resource limits');
    }
  }
  
  return createTypedDeployment({
    name: config.name,
    image: config.image,
    replicas: config.replicas || 1,
    resources: config.resources
  });
}
```

### Factory with Branded Types

```typescript
// Branded types for stronger validation
type KubernetesName = string & { __brand: 'KubernetesName' };
type ImageTag = string & { __brand: 'ImageTag' };
type ResourceQuantity = string & { __brand: 'ResourceQuantity' };

// Validation functions
function validateKubernetesName(name: string): KubernetesName {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
    throw new Error('Invalid Kubernetes name format');
  }
  if (name.length > 63) {
    throw new Error('Kubernetes name too long');
  }
  return name as KubernetesName;
}

function validateImageTag(image: string): ImageTag {
  if (!/^[a-zA-Z0-9._/-]+:[a-zA-Z0-9._-]+$/.test(image)) {
    throw new Error('Invalid image tag format');
  }
  return image as ImageTag;
}

function validateResourceQuantity(quantity: string): ResourceQuantity {
  if (!/^\d+(\.\d+)?(m|Mi|Gi|Ki)?$/.test(quantity)) {
    throw new Error('Invalid resource quantity format');
  }
  return quantity as ResourceQuantity;
}

// Type-safe factory with branded types
interface BrandedDeploymentConfig {
  name: KubernetesName;
  image: ImageTag;
  replicas: number;
  resources: {
    cpu: ResourceQuantity;
    memory: ResourceQuantity;
  };
}

function brandedDeployment(config: BrandedDeploymentConfig) {
  return createTypedDeployment(config);
}

// Usage with validation
const validatedDeployment = brandedDeployment({
  name: validateKubernetesName('my-app'),
  image: validateImageTag('nginx:1.20'),
  replicas: 3,
  resources: {
    cpu: validateResourceQuantity('500m'),
    memory: validateResourceQuantity('1Gi')
  }
});
```

## Type-Safe Cross-Resource References

### Typed Resource References

```typescript
// Enhanced resource with typed status
interface TypedResource<TSpec, TStatus> {
  metadata: V1ObjectMeta;
  spec: TSpec;
  status: TStatus;
}

// Type-safe reference interface
interface ResourceReference<T> {
  readonly resource: T;
  readonly field: keyof T;
}

// Create typed references
function createReference<T, K extends keyof T>(
  resource: T,
  field: K
): ResourceReference<T[K]> {
  return {
    resource,
    field
  } as any;
}

// Usage in resource graphs
const typedGraph = toResourceGraph(
  { name: 'typed-references', schema: { spec: AppSpec } },
  (schema) => {
    const database = simple.Deployment({
      name: Cel.expr(schema.spec.name, "-db"),
      image: 'postgres:15'
    });
    
    const app = simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      env: {
        // Type-safe reference
        DATABASE_HOST: database.status.podIP,  // ✅ Typed as string
        DATABASE_PORT: '5432'
      }
    });
    
    return { database, app };
  },
  statusBuilder
);
```

## Type-Safe CEL Expressions

### Typed CEL Builders

```typescript
// Type-safe CEL expression builder
class CelBuilder<T> {
  constructor(private value: T) {}
  
  // Numeric operations
  greaterThan(other: T extends number ? number : never): CelExpression<boolean> {
    return Cel.expr(this.value, '>', other);
  }
  
  lessThan(other: T extends number ? number : never): CelExpression<boolean> {
    return Cel.expr(this.value, '<', other);
  }
  
  equals(other: T): CelExpression<boolean> {
    return Cel.expr(this.value, '==', other);
  }
  
  // String operations
  contains(substring: T extends string ? string : never): CelExpression<boolean> {
    return Cel.expr(this.value, '.contains("', substring, '")');
  }
  
  // Array operations
  size(): T extends any[] ? CelExpression<number> : never {
    return Cel.expr(this.value, '.size()') as any;
  }
}

function cel<T>(value: T): CelBuilder<T> {
  return new CelBuilder(value);
}

// Usage with type safety
const statusMappings = {
  // ✅ Type-safe numeric comparison
  ready: cel(deployment.status.readyReplicas).greaterThan(0),
  
  // ✅ Type-safe equality
  allReady: cel(deployment.status.readyReplicas).equals(deployment.spec.replicas),
  
  // ✅ Type-safe string operations
  hasLoadBalancer: cel(service.spec.type).equals('LoadBalancer'),
  
  // ✅ Type-safe array operations
  hasIngress: cel(service.status.loadBalancer.ingress).size().greaterThan(0)
};
```

## Runtime Type Validation

### Schema Validation Pipeline

```typescript
// Create validation pipeline
function createValidationPipeline<T>(schema: Type<T>) {
  return {
    validate(input: unknown): T {
      const result = schema(input);
      if (result instanceof type.errors) {
        throw new ValidationError(`Validation failed: ${result.summary}`, result);
      }
      return result;
    },
    
    validatePartial(input: unknown): Partial<T> {
      // Implement partial validation
      return {} as Partial<T>;
    },
    
    validateAsync(input: unknown): Promise<T> {
      return Promise.resolve(this.validate(input));
    }
  };
}

// Custom validation error
class ValidationError extends Error {
  constructor(message: string, public errors: type.errors) {
    super(message);
    this.name = 'ValidationError';
  }
}

// Usage in deployment pipeline
const appValidator = createValidationPipeline(AppSpec);

async function deployApplication(input: unknown) {
  try {
    const validatedSpec = appValidator.validate(input);
    
    const factory = graph.factory('direct');
    return await factory.deploy(validatedSpec);
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error('Invalid application specification:');
      error.errors.forEach(err => console.error(`  - ${err}`));
    }
    throw error;
  }
}
```

### Custom Validation Rules

Create custom validation rules with ArkType:

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
    app: simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      labels: schema.spec.labels
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, '> 0')
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
    app: simple.Deployment({
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
    ready: Cel.expr(resources.app.status.readyReplicas, '> 0')
  })
);
```

## Testing Type Safety

### Type-Level Testing

```typescript
// Type assertion helpers
type Expect<T extends true> = T;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

// Test type inference
type TestAppSpecType = Expect<Equal<
  ReturnType<typeof AppSpec>,
  {
    name: string;
    image: string;
    replicas: number;
  }
>>;

// Test factory return types
type TestFactoryType = Expect<Equal<
  ReturnType<typeof simple.Deployment>,
  Enhanced<V1Deployment, V1DeploymentStatus>
>>;

// Test reference types
type TestReferenceType = Expect<Equal<
  typeof database.status.podIP,
  string
>>;
```

### Runtime Type Testing

```typescript
// Test schema validation
describe('AppSpec validation', () => {
  it('should validate correct specification', () => {
    const validSpec = {
      name: 'test-app',
      image: 'nginx:latest',
      replicas: 3
    };
    
    const result = AppSpec(validSpec);
    expect(result).toEqual(validSpec);
  });
  
  it('should reject invalid specification', () => {
    const invalidSpec = {
      name: 'test-app',
      image: 'nginx:latest',
      replicas: '3'  // String instead of number
    };
    
    const result = AppSpec(invalidSpec);
    expect(result).toBeInstanceOf(type.errors);
  });
  
  it('should validate constraints', () => {
    const invalidName = {
      name: 'a',  // Too short
      image: 'nginx:latest',
      replicas: 3
    };
    
    const result = AppSpec(invalidName);
    expect(result).toBeInstanceOf(type.errors);
  });
});
```

## Performance Considerations

### Type-Safe Caching

```typescript
// Cache validated specifications
const specCache = new Map<string, any>();

function getCachedSpec<T>(
  key: string,
  input: unknown,
  validator: (input: unknown) => T
): T {
  const cacheKey = `${key}:${JSON.stringify(input)}`;
  
  if (specCache.has(cacheKey)) {
    return specCache.get(cacheKey);
  }
  
  const validated = validator(input);
  specCache.set(cacheKey, validated);
  
  return validated;
}

// Usage
const validatedSpec = getCachedSpec(
  'AppSpec',
  input,
  (input) => AppSpec(input)
);
```

### Lazy Type Validation

```typescript
// Defer validation until needed
class LazyValidatedSpec<T> {
  private _validated?: T;
  private _errors?: type.errors;
  
  constructor(
    private input: unknown,
    private validator: Type<T>
  ) {}
  
  get validated(): T {
    if (this._validated) {
      return this._validated;
    }
    
    if (this._errors) {
      throw new ValidationError('Validation failed', this._errors);
    }
    
    const result = this.validator(this.input);
    if (result instanceof type.errors) {
      this._errors = result;
      throw new ValidationError('Validation failed', result);
    }
    
    this._validated = result;
    return result;
  }
  
  get isValid(): boolean {
    try {
      this.validated;
      return true;
    } catch {
      return false;
    }
  }
}

// Usage
const lazySpec = new LazyValidatedSpec(input, AppSpec);

// Validation only happens when accessed
if (lazySpec.isValid) {
  const spec = lazySpec.validated;
  // Use spec
}
```

## Best Practices

### 1. Use Strict Types

```typescript
// ✅ Use specific types
interface SpecificConfig {
  name: string;
  port: number;
  environment: 'dev' | 'staging' | 'prod';
}

// ❌ Avoid any
interface LooseConfig {
  [key: string]: any;
}
```

### 2. Validate Early

```typescript
// ✅ Validate at the boundary
function deployApp(input: unknown) {
  const spec = AppSpec(input);  // Validate immediately
  if (spec instanceof type.errors) {
    throw new ValidationError('Invalid spec', spec);
  }
  
  // Now use typed spec
  return createDeployment(spec);
}
```

### 3. Use Descriptive Constraints

Make schemas self-documenting with meaningful constraints:

```typescript
// ✅ Good: Descriptive constraints
const ServerSpec = type({
  name: 'string>0',                    // Must be non-empty
  port: '1024<=integer<=65535',        // Valid unprivileged port range
  replicas: '1<=integer<=50',          // Reasonable replica range
  memory: 'string.format.memory'       // Kubernetes memory format
});

// ❌ Avoid: Vague constraints
const ServerSpec = type({
  name: 'string',
  port: 'number',
  replicas: 'number',
  memory: 'string'
});
```

### 4. Provide Clear Error Messages

```typescript
// ✅ Descriptive validation
const AppSpec = type({
  name: 'string>2',  // "must be a string with more than 2 characters"
  replicas: 'number>0',  // "must be a number greater than 0"
  environment: '"dev" | "staging" | "prod"'  // Clear enum values
});
```

### 5. Use Type Guards

```typescript
// ✅ Type guard functions
function isValidConfig(input: unknown): input is AppConfig {
  return AppSpec(input) instanceof type.errors === false;
}

function assertValidConfig(input: unknown): asserts input is AppConfig {
  if (!isValidConfig(input)) {
    throw new Error('Invalid configuration');
  }
}
```

### 6. Group Related Fields

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

### 7. Document Schema Constraints

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

## Next Steps

- **[Runtime Behavior](./runtime-behavior.md)** - Understand status, references, and external dependencies
- **[CEL Expressions](./cel-expressions.md)** - Add dynamic runtime logic to schemas
- **[Factories](./factories.md)** - Build type-safe factory functions
- **[Examples](../examples/)** - See schemas and types in action
- **[API Reference](../api/)** - Complete API documentation