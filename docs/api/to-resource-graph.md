# toResourceGraph API

The `toResourceGraph()` function is the core of TypeKro's type-safe infrastructure definition system. It creates a typed resource graph with schema validation, cross-resource references, and multiple deployment strategies.

## Overview

`toResourceGraph()` enables you to:
- Define infrastructure with compile-time type safety
- Create cross-resource references that resolve at runtime
- Use the same code for multiple deployment strategies
- Build complex applications with dependency management

## Function Signature

```typescript
function toResourceGraph<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
  TResources extends Record<string, Enhanced<any, any> | DeploymentClosure>
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  resourceBuilder: (schema: SchemaProxy<TSpec, TStatus>) => TResources,
  statusBuilder: (schema: SchemaProxy<TSpec, TStatus>, resources: TResources) => MagicAssignableShape<TStatus>,
  options?: SerializationOptions
): TypedResourceGraph<TSpec, TStatus>
```

## Parameters

### `definition`

Resource graph definition with metadata and schema information.

```typescript
interface ResourceGraphDefinition<TSpec, TStatus> {
  name: string;
  apiVersion: string;
  kind: string;
  spec: Type<TSpec>;     // Arktype schema for spec
  status: Type<TStatus>; // Arktype schema for status
}
```

#### Properties

- **`name`**: Unique identifier for the resource graph
- **`apiVersion`**: Kubernetes-style API version (e.g., "example.com/v1")
- **`kind`**: Resource type name (e.g., "WebApp", "Database")
- **`spec`**: Arktype schema defining the input specification
- **`status`**: Arktype schema defining the computed status

### `resourceBuilder`

Function that creates the actual Kubernetes resources using the schema proxy.

```typescript
type ResourceBuilder<TSpec, TStatus, TResources> = (
  schema: SchemaProxy<TSpec, TStatus>
) => TResources
```

#### Parameters

- **`schema`**: Magic proxy providing type-safe access to spec and status fields
- **Returns**: Object containing Enhanced resources or deployment closures

### `statusBuilder`

Function that computes dynamic status values based on resource state.

```typescript
type StatusBuilder<TSpec, TStatus, TResources> = (
  schema: SchemaProxy<TSpec, TStatus>, 
  resources: TResources
) => MagicAssignableShape<TStatus>
```

#### Parameters

- **`schema`**: Same schema proxy as resource builder
- **`resources`**: The resources created by the resource builder
- **Returns**: Object matching the status schema shape

### `options` (Optional)

Serialization and behavior options.

```typescript
interface SerializationOptions {
  namespace?: string;
  optimizeCel?: boolean;
  validateSchema?: boolean;
}
```

## Returns

A `TypedResourceGraph` object with factory methods for different deployment strategies.

```typescript
interface TypedResourceGraph<TSpec, TStatus> {
  factory(mode: 'direct' | 'kro', options?: FactoryOptions): Promise<ResourceFactory>;
  definition: ResourceGraphDefinition<TSpec, TStatus>;
}
```

## Basic Example

```typescript
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService, Cel } from 'typekro';

// Define the schema using arktype
const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  host: 'string'
});

const WebAppStatus = type({
  ready: 'boolean',
  url: 'string',
  replicas: 'number'
});

// Create the resource graph
const webapp = toResourceGraph(
  {
    name: 'simple-webapp',
    apiVersion: 'example.com/v1',
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus
  },
  // Resource builder - creates the actual Kubernetes resources
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,        // Type-safe schema reference
      image: schema.spec.image,      // Full IDE autocomplete
      replicas: schema.spec.replicas,
      ports: [80]
    }),
    
    service: simpleService({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 80 }]
    }),
    
    ingress: simpleIngress({
      name: schema.spec.name,
      host: schema.spec.host,        // Schema reference
      serviceName: schema.spec.name, // References service above
      servicePort: 80
    })
  }),
  // Status builder - computes dynamic status
  (schema, resources) => ({
    ready: Cel.expr(resources.deployment.status.readyReplicas, ' >= ', schema.spec.replicas),
    url: Cel.template('https://%s', schema.spec.host),
    replicas: resources.deployment.status.readyReplicas
  })
);
```

## Advanced Patterns

### Cross-Resource References

Resources can reference each other using the magic proxy system:

```typescript
const microservices = toResourceGraph(
  {
    name: 'microservices',
    apiVersion: 'platform.example.com/v1',
    kind: 'Microservices',
    spec: type({ name: 'string', environment: 'string' }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Database
    database: simpleDeployment({
      name: Cel.template('%s-db', schema.spec.name),
      image: 'postgres:13',
      env: {
        POSTGRES_DB: schema.spec.name,
        POSTGRES_USER: 'app',
        POSTGRES_PASSWORD: 'secret'
      }
    }),
    
    dbService: simpleService({
      name: Cel.template('%s-db', schema.spec.name),
      selector: { app: Cel.template('%s-db', schema.spec.name) },
      ports: [{ port: 5432, targetPort: 5432 }]
    }),
    
    // API server that references database
    api: simpleDeployment({
      name: Cel.template('%s-api', schema.spec.name),
      image: 'myapp/api:latest',
      env: {
        // Reference to database service (runtime resolution)
        DATABASE_URL: Cel.template(
          'postgres://app:secret@%s:5432/%s',
          schema.spec.name,  // References dbService.spec.clusterIP at runtime
          schema.spec.name
        ),
        ENVIRONMENT: schema.spec.environment
      }
    }),
    
    apiService: simpleService({
      name: Cel.template('%s-api', schema.spec.name),
      selector: { app: Cel.template('%s-api', schema.spec.name) },
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

### Environment-Specific Configuration

Use schema references to create environment-specific deployments:

```typescript
const app = toResourceGraph(
  {
    name: 'configurable-app',
    apiVersion: 'config.example.com/v1',
    kind: 'ConfigurableApp',
    spec: type({
      name: 'string',
      environment: '"development" | "staging" | "production"',
      replicas: 'number',
      image: 'string',
      logLevel: '"debug" | "info" | "warn" | "error"'
    }),
    status: type({ 
      ready: 'boolean',
      environment: 'string' 
    })
  },
  (schema) => ({
    config: simpleConfigMap({
      name: Cel.template('%s-config', schema.spec.name),
      data: {
        ENVIRONMENT: schema.spec.environment,
        LOG_LEVEL: schema.spec.logLevel,
        // Environment-specific values using CEL
        DEBUG: Cel.conditional(
          schema.spec.environment === 'development',
          'true',
          'false'
        ),
        API_TIMEOUT: Cel.conditional(
          schema.spec.environment === 'production',
          '30000',
          '10000'
        )
      }
    }),
    
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      env: {
        ENVIRONMENT: schema.spec.environment,
        LOG_LEVEL: schema.spec.logLevel
      }
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.deployment.status.readyReplicas, ' >= ', schema.spec.replicas),
    environment: schema.spec.environment
  })
);
```

### Complex Status Computation

Status builders can perform complex calculations using CEL expressions:

```typescript
const cluster = toResourceGraph(
  {
    name: 'app-cluster',
    apiVersion: 'cluster.example.com/v1',
    kind: 'AppCluster',
    spec: type({
      name: 'string',
      services: 'string[]',
      minReplicas: 'number'
    }),
    status: type({
      totalReplicas: 'number',
      readyReplicas: 'number',
      healthStatus: '"healthy" | "degraded" | "unhealthy"',
      serviceStatuses: 'Record<string, boolean>'
    })
  },
  (schema) => ({
    // Create services dynamically based on spec
    services: schema.spec.services.map(serviceName => 
      simpleDeployment({
        name: serviceName,
        image: `myapp/${serviceName}:latest`,
        replicas: schema.spec.minReplicas
      })
    )
  }),
  (schema, resources) => ({
    // Sum total replicas across all services
    totalReplicas: Cel.expr(
      resources.services.map(svc => svc.spec.replicas).join(' + ')
    ),
    
    // Sum ready replicas across all services  
    readyReplicas: Cel.expr(
      resources.services.map(svc => svc.status.readyReplicas).join(' + ')
    ),
    
    // Compute overall health status
    healthStatus: Cel.conditional(
      Cel.expr(
        resources.services.map(svc => 
          `${svc.status.readyReplicas} >= ${svc.spec.replicas}`
        ).join(' && ')
      ),
      'healthy',
      Cel.conditional(
        Cel.expr(
          resources.services.map(svc => svc.status.readyReplicas).join(' + '),
          ' > 0'
        ),
        'degraded',
        'unhealthy'
      )
    ),
    
    // Individual service statuses
    serviceStatuses: Object.fromEntries(
      resources.services.map((svc, i) => [
        schema.spec.services[i],
        Cel.expr(svc.status.readyReplicas, ' >= ', svc.spec.replicas)
      ])
    )
  })
);
```

## Deployment Strategies

Once you have a resource graph, you can deploy it using different strategies:

### Direct Deployment

Deploy immediately to your cluster:

```typescript
const factory = await webapp.factory('direct', { namespace: 'development' });
await factory.deploy({
  name: 'my-webapp',
  image: 'nginx:latest',
  replicas: 2,
  host: 'dev.example.com'
});
```

### KRO Deployment

Deploy using Kubernetes Resource Orchestrator for advanced runtime features:

```typescript
const factory = await webapp.factory('kro', { namespace: 'production' });
await factory.deploy({
  name: 'webapp-prod',
  image: 'nginx:1.21',
  replicas: 3,
  host: 'prod.example.com'
});
```

### YAML Generation

Generate deterministic YAML for GitOps workflows:

```typescript
const factory = await webapp.factory('kro', { namespace: 'staging' });
const yaml = factory.toYaml();

// Write to file for GitOps deployment
writeFileSync('k8s/webapp-staging.yaml', yaml);
```

## Type Safety Features

### Schema Validation

Arktype schemas provide runtime validation:

```typescript
const spec = {
  name: 'my-app',
  image: 'nginx:latest',
  replicas: '3',  // ❌ Type error: expected number, got string
  host: 'example.com'
};

// TypeScript will catch this at compile time
// Arktype will catch this at runtime
```

### Reference Type Safety

Schema references are fully type-safe:

```typescript
(schema) => ({
  deployment: simpleDeployment({
    name: schema.spec.name,        // ✅ Type: string
    replicas: schema.spec.count,   // ❌ Type error: 'count' doesn't exist
    image: schema.spec.image       // ✅ Type: string
  })
})
```

### Status Type Safety

Status builders must match the defined schema:

```typescript
(schema, resources) => ({
  ready: resources.deployment.status.readyReplicas > 0,  // ✅ Type: boolean
  url: `https://${schema.spec.host}`,                    // ✅ Type: string
  invalid: 'not-in-schema'                               // ❌ Type error
})
```

## Best Practices

### 1. Use Descriptive Names

Choose clear, descriptive names for your resource graphs:

```typescript
// Good
const webApplicationWithDatabase = toResourceGraph({
  name: 'web-app-with-db',
  apiVersion: 'platform.example.com/v1',
  kind: 'WebApplicationWithDatabase',
  // ...
});

// Avoid
const app = toResourceGraph({
  name: 'app',
  apiVersion: 'v1',
  kind: 'App',
  // ...
});
```

### 2. Organize Related Resources

Group related resources logically in the resource builder:

```typescript
(schema) => ({
  // Data layer
  database: simpleDeployment({ /* ... */ }),
  dbService: simpleService({ /* ... */ }),
  
  // Application layer  
  api: simpleDeployment({ /* ... */ }),
  apiService: simpleService({ /* ... */ }),
  
  // Presentation layer
  frontend: simpleDeployment({ /* ... */ }),
  frontendService: simpleService({ /* ... */ }),
  
  // Infrastructure
  ingress: simpleIngress({ /* ... */ })
})
```

### 3. Use CEL Expressions Judiciously

Use CEL for dynamic values, but prefer static values when possible:

```typescript
// Good: Use CEL for dynamic computation
env: {
  SERVICE_URL: Cel.template('http://%s:8080', schema.spec.name),
  DEBUG: Cel.conditional(schema.spec.environment === 'development', 'true', 'false')
}

// Good: Use static values when known
env: {
  PORT: '8080',
  NODE_ENV: 'production'
}
```

### 4. Validate Schemas Thoroughly

Use arktype's validation features to catch errors early:

```typescript
const WebAppSpec = type({
  name: 'string>0',           // Non-empty string
  replicas: 'number>=1',      // At least 1 replica
  image: 'string>0',          // Non-empty string
  environment: '"dev" | "staging" | "production"'  // Specific values
});
```

## Related APIs

- [Factory Functions](/api/factories) - Simple resource creation functions
- [CEL Expressions](/api/cel) - Dynamic value computation
- [Types](/api/types) - TypeScript type definitions
- [Resource Graphs Guide](/guide/resource-graphs) - Conceptual overview