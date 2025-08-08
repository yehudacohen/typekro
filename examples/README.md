# TypeKro Examples

This directory contains examples demonstrating the TypeKro kro-less deployment features.

## Current Status

The examples in this directory demonstrate the intended API design for the new factory pattern. However, due to TypeScript configuration issues and the complexity of the magic proxy system, these examples may not compile correctly in the current development environment.

## Key Features Demonstrated

### 1. Basic toResourceGraph API (`kro-less-deployment-simple.ts`)

```typescript
import { type } from 'arktype';
import { simpleDeployment, simpleService, toResourceGraph } from '../src/index.js';

// Define ArkType schemas
const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: '"development" | "staging" | "production"',
});

const WebAppStatusSchema = type({
  url: 'string',
  readyReplicas: 'number',
  phase: '"pending" | "running" | "failed"',
});

// Create typed resource graph
const webappGraph = toResourceGraph(
  'webapp-stack',
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      id: 'webapp-deployment',
    }),
    service: simpleService({
      name: 'webapp-service',
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      id: 'webapp-service',
    }),
  }),
  {
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  }
);

// Generate YAML
const yaml = webappGraph.toYaml();

// Create factories
const directFactory = await webappGraph.factory('direct');
const kroFactory = await webappGraph.factory('kro');
```

### 2. Factory Pattern Features

- **Direct Mode**: Uses TypeKro dependency resolution
- **Kro Mode**: Deploys ResourceGraphDefinition, uses Kro dependency resolution
- **Type Safety**: Full TypeScript support with ArkType schemas
- **Schema Proxy**: Type-safe access to spec and status fields

### 3. Comprehensive Example (`kro-less-deployment-cohesive.ts`)

The comprehensive example demonstrates:

- ArkType schema integration with type inference
- Factory pattern with direct and Kro modes
- Type-safe instance creation and management
- Alchemy integration concepts (commented out due to import issues)
- External references with full type safety
- CEL expressions for computed values

## Implementation Status

### ✅ Completed (Task 3.1)
- `toResourceGraph` API with ArkType integration
- TypedResourceGraph interface
- YAML generation for ResourceGraphDefinition
- Schema proxy integration
- Unit tests for new API

### 🚧 In Progress
- Factory creation methods (tasks 3.5 and 3.6)
- Direct deployment engine integration
- Kro deployment mode implementation

### 📋 Planned
- Alchemy integration
- Static resource graph support
- Enhanced error handling
- Performance optimizations

## Running Examples

Due to current TypeScript configuration issues, the examples may not compile directly. However, they demonstrate the intended API design and can be used as reference for the implementation.

To test the core functionality:

```bash
# Run unit tests for the new API
bun test test/core/to-resource-graph.test.ts
bun test test/core/factory-pattern.test.ts

# Run all tests to verify implementation
bun test
```

## Key Design Principles

1. **Type Safety First**: All APIs are designed to be type-safe without requiring `as any` casts
2. **ArkType Integration**: Schemas are defined using ArkType for runtime validation
3. **Factory Pattern**: Clean separation between resource definition and deployment strategy
4. **Backward Compatibility**: New APIs work alongside existing TypeKro functionality
5. **Developer Experience**: IntelliSense and compile-time error checking throughout

## Next Steps

1. Complete factory implementation (tasks 3.5 and 3.6)
2. Resolve TypeScript configuration issues for examples
3. Add alchemy integration
4. Implement static resource graph support
5. Add comprehensive error handling and validation