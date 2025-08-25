# Type Safety Patterns

TypeKro leverages TypeScript's powerful type system to provide compile-time validation, IDE autocomplete, and runtime safety for your Kubernetes infrastructure. This guide covers advanced type safety patterns and best practices.

## TypeKro's Type System

TypeKro provides several layers of type safety:

- **Schema validation** with arktype for runtime checking
- **Enhanced resources** with typed status and references
- **Cross-resource references** with compile-time validation
- **Factory functions** with typed configuration interfaces
- **CEL expressions** with type-safe evaluation

```typescript
import { type } from 'arktype';
import { toResourceGraph, simple } from 'typekro';

// 1. Schema validation
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
    ready: resources.deployment.status.readyReplicas > 0  // ✅ Number comparison
  })
);
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

### Reference Validation

```typescript
// Validate references at compile time
type ValidReference<T, K extends keyof T> = T[K] extends string | number | boolean
  ? ResourceReference<T[K]>
  : never;

// Type-safe reference builder
class ReferenceBuilder<T> {
  constructor(private resource: T) {}
  
  field<K extends keyof T>(field: K): ValidReference<T, K> {
    return createReference(this.resource, field);
  }
}

function ref<T>(resource: T): ReferenceBuilder<T> {
  return new ReferenceBuilder(resource);
}

// Usage
const database = simple.Deployment({
  name: 'db',
  image: 'postgres:15'
});

const app = simple.Deployment({
  name: 'app',
  image: 'myapp:latest',
  env: {
    DATABASE_HOST: ref(database).field('status').field('podIP'),  // ✅ Type-safe
    DATABASE_NAME: ref(database).field('metadata').field('name')  // ✅ Type-safe
  }
});
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

### Complex Type-Safe Expressions

```typescript
// Type-safe template builder
class CelTemplateBuilder {
  private parts: string[] = [];
  
  add(value: string): CelTemplateBuilder {
    this.parts.push(value);
    return this;
  }
  
  addRef<T>(ref: T, formatter?: (value: T) => string): CelTemplateBuilder {
    const formattedRef = formatter ? formatter(ref) : String(ref);
    this.parts.push(`%s`);
    return this;
  }
  
  build(): CelExpression<string> {
    return Cel.template(this.parts.join(''), ...this.getReferences());
  }
  
  private getReferences(): any[] {
    // Implementation to extract references
    return [];
  }
}

// Type-safe URL builder
function buildUrl(
  protocol: 'http' | 'https',
  host: string | ResourceReference<string>,
  port?: number | ResourceReference<number>,
  path?: string
): CelExpression<string> {
  const builder = new CelTemplateBuilder()
    .add(protocol)
    .add('://')
    .addRef(host);
    
  if (port) {
    builder.add(':').addRef(port);
  }
  
  if (path) {
    builder.add(path);
  }
  
  return builder.build();
}

// Usage
const appUrl = buildUrl(
  'https',
  service.status.loadBalancer.ingress[0].hostname,
  80,
  '/api'
);
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

### Dynamic Schema Updates

```typescript
// Schema versioning for backward compatibility
const AppSpecV1 = type({
  name: 'string',
  image: 'string',
  replicas: 'number'
});

const AppSpecV2 = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  resources: {
    cpu: 'string',
    memory: 'string'
  }
});

const AppSpecV3 = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  resources: {
    cpu: 'string',
    memory: 'string'
  },
  healthChecks: {
    enabled: 'boolean',
    'path?': 'string'
  }
});

// Migration pipeline
function migrateAppSpec(input: unknown, targetVersion: number = 3) {
  // Try latest version first
  if (targetVersion >= 3) {
    try {
      return { version: 3, spec: AppSpecV3(input) };
    } catch {}
  }
  
  // Fall back to v2
  if (targetVersion >= 2) {
    try {
      const v2Spec = AppSpecV2(input);
      if (targetVersion === 3) {
        // Migrate v2 to v3
        return {
          version: 3,
          spec: {
            ...v2Spec,
            healthChecks: { enabled: true }
          }
        };
      }
      return { version: 2, spec: v2Spec };
    } catch {}
  }
  
  // Fall back to v1
  const v1Spec = AppSpecV1(input);
  if (targetVersion >= 2) {
    // Migrate v1 to higher version
    const migratedSpec = {
      ...v1Spec,
      resources: { cpu: '100m', memory: '256Mi' }
    };
    
    if (targetVersion >= 3) {
      return {
        version: 3,
        spec: {
          ...migratedSpec,
          healthChecks: { enabled: false }
        }
      };
    }
    
    return { version: 2, spec: migratedSpec };
  }
  
  return { version: 1, spec: v1Spec };
}
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

### 3. Provide Clear Error Messages

```typescript
// ✅ Descriptive validation
const AppSpec = type({
  name: 'string>2',  // "must be a string with more than 2 characters"
  replicas: 'number>0',  // "must be a number greater than 0"
  environment: '"dev" | "staging" | "prod"'  // Clear enum values
});
```

### 4. Use Type Guards

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

## Next Steps

- **[Performance](./performance.md)** - Optimize type checking performance
- **[Custom Factories](./custom-factories.md)** - Build type-safe custom factories
- **[Troubleshooting](./troubleshooting.md)** - Debug type-related issues
- **[Examples](../examples/)** - See type safety in action