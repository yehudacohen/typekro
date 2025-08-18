# toResourceGraph

The primary function for creating typed resource graphs in TypeKro.

## Signature

```typescript
function toResourceGraph<TSpec, TStatus>(
  name: string,
  builder: (schema: SchemaProxy<TSpec, TStatus>) => Record<string, Enhanced<any, any>>,
  schema: SchemaDefinition<TSpec, TStatus>
): TypedResourceGraph<TSpec, TStatus>
```

## Parameters

### `name: string`
The name of the resource graph. This becomes the name of the ResourceGraphDefinition when deployed via Kro.

### `builder: (schema) => Record<string, Enhanced<any, any>>`
A function that receives a schema proxy and returns an object containing all the resources in your graph.

**Parameters:**
- `schema: SchemaProxy<TSpec, TStatus>` - Provides type-safe access to spec and status fields

**Returns:**
- `Record<string, Enhanced<any, any>>` - Object with resource names as keys and Enhanced resources as values

### `schema: SchemaDefinition<TSpec, TStatus>`
Schema definition containing API version, kind, and type definitions.

**Properties:**
- `apiVersion: string` - API version for the custom resource
- `kind: string` - Kind name for the custom resource
- `spec: Type<TSpec>` - ArkType schema for the spec
- `status?: Type<TStatus>` - ArkType schema for the status (optional)
- `statusMappings?: Record<string, any>` - Mapping of status fields to values or expressions

## Return Value

Returns a `TypedResourceGraph<TSpec, TStatus>` with the following methods:

### `factory(mode, options?)`
Creates a factory for deploying the resource graph.

```typescript
const factory = await graph.factory('direct', {
  namespace: 'production',
  timeout: 300000
});
```

### `toYaml(spec?)`
Generates YAML for the resource graph.

```typescript
// Generate ResourceGraphDefinition
const rgdYaml = graph.toYaml();

// Generate instance YAML
const instanceYaml = graph.toYaml({
  name: 'my-app',
  image: 'nginx:latest'
});
```

## Examples

### Basic Usage

```typescript
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService } from 'typekro';

const AppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number'
});

const AppStatus = type({
  phase: 'string',
  readyReplicas: 'number'
});

const webApp = toResourceGraph(
  'webapp',
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas
    }),
    
    service: simpleService({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    })
  }),
  {
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: AppSpec,
    status: AppStatus,
    statusMappings: {
      phase: deployment.status.phase,
      readyReplicas: deployment.status.readyReplicas
    }
  }
);
```

### With Cross-Resource References

```typescript
const fullStack = toResourceGraph(
  'fullstack-app',
  (schema) => ({
    database: simpleDeployment({
      name: `${schema.spec.name}-db`,
      image: 'postgres:15'
    }),
    
    app: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      env: {
        // Cross-resource reference
        DATABASE_HOST: database.status.podIP
      }
    }),
    
    service: simpleService({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    })
  }),
  {
    apiVersion: 'example.com/v1alpha1',
    kind: 'FullStackApp',
    spec: FullStackSpec,
    status: FullStackStatus
  }
);
```

### With CEL Expressions

```typescript
import { Cel } from 'typekro';

const smartApp = toResourceGraph(
  'smart-app',
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas
    }),
    
    service: simpleService({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    })
  }),
  {
    apiVersion: 'example.com/v1alpha1',
    kind: 'SmartApp',
    spec: SmartAppSpec,
    status: SmartAppStatus,
    statusMappings: {
      // CEL expressions for dynamic status
      ready: Cel.expr(deployment.status.readyReplicas, '> 0'),
      url: Cel.template('http://%s', service.status.loadBalancer.ingress[0].ip),
      healthScore: Cel.expr(
        `(${deployment.status.readyReplicas} * 100) / ${deployment.spec.replicas}`
      )
    }
  }
);
```

### Conditional Resources

```typescript
const conditionalApp = toResourceGraph(
  'conditional-app',
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image
    }),
    
    service: simpleService({
      name: `${schema.spec.name}-service`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    }),
    
    // Conditional ingress only in production
    ...(schema.spec.environment === 'production' && {
      ingress: simpleIngress({
        name: `${schema.spec.name}-ingress`,
        rules: [{
          host: `${schema.spec.name}.example.com`,
          http: {
            paths: [{
              path: '/',
              backend: {
                service: {
                  name: service.metadata.name,
                  port: { number: 80 }
                }
              }
            }]
          }
        }]
      })
    })
  }),
  schemaDefinition
);
```

## Schema Proxy

The schema proxy provides type-safe access to spec and status fields:

### Spec Access

```typescript
const builder = (schema) => ({
  deployment: simpleDeployment({
    name: schema.spec.name,        // Type-safe access to spec.name
    image: schema.spec.image,      // Type-safe access to spec.image
    replicas: schema.spec.replicas // Type-safe access to spec.replicas
  })
});
```

### Status Access (for statusMappings)

```typescript
const schemaDefinition = {
  // ...
  statusMappings: {
    // Access status fields (these become CEL expressions)
    currentPhase: deployment.status.phase,
    readyCount: deployment.status.readyReplicas
  }
};
```

## Schema Definition

### Required Fields

```typescript
interface SchemaDefinition<TSpec, TStatus> {
  apiVersion: string;  // e.g., 'example.com/v1alpha1'
  kind: string;        // e.g., 'WebApp'
  spec: Type<TSpec>;   // ArkType schema for spec
}
```

### Optional Fields

```typescript
interface SchemaDefinition<TSpec, TStatus> {
  status?: Type<TStatus>;                    // ArkType schema for status
  statusMappings?: Record<string, any>;      // Status field mappings
  metadata?: {
    labels?: Record<string, string>;         // Default labels
    annotations?: Record<string, string>;    // Default annotations
  };
}
```

## Type Safety

### Spec Type Safety

The schema proxy ensures spec fields are properly typed:

```typescript
const AppSpec = type({
  name: 'string',
  replicas: 'number',
  environment: '"dev" | "staging" | "prod"'
});

const graph = toResourceGraph('app', (schema) => ({
  deployment: simpleDeployment({
    name: schema.spec.name,        // ✅ string
    replicas: schema.spec.replicas, // ✅ number
    // environment: schema.spec.env // ❌ TypeScript error - 'env' doesn't exist
  })
}), { spec: AppSpec, /* ... */ });
```

### Status Type Safety

Status mappings are validated against the status schema:

```typescript
const AppStatus = type({
  phase: 'string',
  readyReplicas: 'number',
  url: 'string'
});

const graph = toResourceGraph('app', builder, {
  spec: AppSpec,
  status: AppStatus,
  statusMappings: {
    phase: deployment.status.phase,        // ✅ string
    readyReplicas: deployment.status.readyReplicas, // ✅ number
    url: service.status.loadBalancer.ingress[0].ip, // ✅ string
    // invalidField: 'value' // ❌ TypeScript error - not in status schema
  }
});
```

## Error Handling

### Schema Validation Errors

```typescript
try {
  const factory = await graph.factory('direct');
  await factory.deploy(invalidSpec);
} catch (error) {
  if (error instanceof SchemaValidationError) {
    console.error('Invalid spec:', error.errors);
  }
}
```

### Resource Creation Errors

```typescript
try {
  const graph = toResourceGraph('app', (schema) => ({
    deployment: simpleDeployment({
      // Missing required fields will cause TypeScript errors
      name: schema.spec.name
      // image: schema.spec.image // Required but missing
    })
  }), schemaDefinition);
} catch (error) {
  console.error('Resource creation failed:', error);
}
```

## Best Practices

### 1. Use Descriptive Names

```typescript
// ✅ Clear and descriptive
const webApplicationStack = toResourceGraph('web-application-stack', ...);

// ❌ Too generic
const app = toResourceGraph('app', ...);
```

### 2. Group Related Resources

```typescript
const microserviceStack = toResourceGraph('microservice', (schema) => ({
  // Core application
  api: simpleDeployment({ /* ... */ }),
  apiService: simpleService({ /* ... */ }),
  
  // Database
  database: simpleDeployment({ /* ... */ }),
  databaseService: simpleService({ /* ... */ }),
  
  // Configuration
  config: simpleConfigMap({ /* ... */ }),
  secrets: simpleSecret({ /* ... */ })
}), schemaDefinition);
```

### 3. Use Environment-Specific Logic

```typescript
const adaptiveApp = toResourceGraph('adaptive-app', (schema) => ({
  deployment: simpleDeployment({
    name: schema.spec.name,
    image: schema.spec.image,
    replicas: schema.spec.environment === 'production' ? 5 : 2,
    resources: schema.spec.environment === 'production'
      ? { cpu: '1000m', memory: '2Gi' }
      : { cpu: '100m', memory: '256Mi' }
  })
}), schemaDefinition);
```

### 4. Validate Input Schemas

```typescript
const StrictAppSpec = type({
  name: 'string>2',           // At least 3 characters
  image: 'string',
  replicas: 'number>0',       // At least 1
  environment: '"dev" | "staging" | "prod"'  // Enum validation
});
```

## See Also

- [Factory Functions](./factories.md) - Available factory functions
- [CEL Expressions](../guide/cel-expressions.md) - CEL expression guide
- [Cross-Resource References](../guide/cross-references.md) - Connect resources dynamically
- [Examples](../examples/) - Real-world usage examples