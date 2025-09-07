# Architecture Guide

## System Overview

TypeKro is a sophisticated system that transforms TypeScript code into Kubernetes manifests with dynamic behavior through CEL expressions. The architecture consists of multiple transformation stages that enable developers to write natural TypeScript code while producing robust, type-safe Kubernetes deployments.

This architecture supports the [Development Standards](development-standards.md) philosophy of production-quality code and is validated through comprehensive [Testing Guidelines](testing-guidelines.md).

### Core Value Proposition

TypeKro enables developers to write natural TypeScript code that becomes robust, type-safe Kubernetes deployments with dynamic behavior. The system is designed for transparency - developers write familiar code while the system handles the complexity of Kubernetes resource management and cross-resource references.

## Multi-Stage Transformation Pipeline

The TypeKro system operates through five distinct stages, each with a specific purpose:

1. **Development Time**: TypeScript with magic proxies and type safety
2. **Composition Time**: Resource creation with reference tracking
3. **Analysis Time**: JavaScript to CEL expression conversion
4. **Serialization Time**: YAML generation with CEL expressions
5. **Runtime**: Kro controller evaluation and resource hydration

### Stage 1: Magic Proxy System (Development Time)

#### Static vs Runtime Type Duality

The magic proxy system creates a fundamental distinction between **static types** (what TypeScript sees) and **runtime types** (what actually exists during execution).

**Schema Proxy Behavior:**

When you access `schema.spec.name` in a composition function:

**At Compile Time (Static):**
- TypeScript sees this as the actual type from your interface (e.g., `string`)
- Provides full IntelliSense and type checking
- Developer experience is seamless - looks like normal property access

**At Runtime (Dynamic):**
- The schema proxy **always** returns a `KubernetesRef<T>` object
- This happens for **every** property access, regardless of the static type
- The `KubernetesRef` contains metadata: `{ __brand: 'KubernetesRef', resourceId: '__schema__', fieldPath: 'spec.name' }`

#### RefOrValue Type System

Composition functions accept `RefOrValue<T>` to handle multiple input types:

```typescript
type RefOrValue<T> = T | KubernetesRef<NonNullable<T>> | CelExpression<T>;
```

This enables:
1. **Direct values**: `name: 'my-app'` (static string)
2. **Schema references**: `name: schema.spec.name` (runtime KubernetesRef)
3. **JavaScript expressions**: `name: \`prefix-${schema.spec.name}\`` (automatically converted to CEL)
4. **Resource references**: `name: deployment.metadata.name` (runtime KubernetesRef)

#### Runtime Type Handling

The `processFactoryValue` function handles runtime type resolution in factory functions:

```typescript
function processFactoryValue<T>(
  value: MagicAssignable<T>,
  context: FactoryExpressionContext,
  fieldPath: string
): T {
  // Handle KubernetesRef objects - preserve for runtime resolution
  if (isKubernetesRef(value)) {
    return value as T; // Preserved for serialization system
  }

  // Handle CelExpression objects - preserve for serialization
  if (isCelExpression(value)) {
    return value as T; // Serialization converts to ${expression} format
  }

  // Return static values as-is
  return value as T;
}
```

**Key insight**: `KubernetesRef` and `CelExpression` objects are preserved as-is during factory processing. The serialization system handles their conversion to CEL expressions for runtime evaluation.

### Stage 2: Composition Context (Composition Time)

#### Resource Registration

During composition execution:
- Resources are registered in a composition context
- Each resource gets a unique ID for cross-referencing
- Resource references are tracked for dependency resolution
- Status expressions are captured for later analysis

#### Composition Patterns

**Imperative Pattern** (`kubernetesComposition`):
```typescript
kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  (spec) => {
    const deployment = simple.Deployment({ 
      name: spec.name, 
      image: spec.image,
      id: 'deployment'
    });
    const service = simple.Service({ 
      name: spec.name, 
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      id: 'service'
    });
    
    return {
      ready: deployment.status.readyReplicas === deployment.spec.replicas,
      url: `http://${service.status.loadBalancer.ingress[0].ip}`
    };
  }
);
```

**Declarative Pattern** (`toResourceGraph`):
```typescript
toResourceGraph(
  {
    name: 'webapp',
    apiVersion: 'example.com/v1alpha1', 
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  (schema) => ({
    deployment: simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      id: 'deployment'
    }),
  }),
  (_schema, resources) => ({
    ready: resources.deployment.status.readyReplicas >= 1,
  })
);
```

### Stage 3: JavaScript to CEL Analysis (Analysis Time)

#### Imperative Analyzer

The imperative analyzer (`src/core/expressions/imperative-analyzer.ts`) performs AST analysis on JavaScript functions:

1. **Parse Function Source**: Uses Acorn to parse JavaScript into AST
2. **Find Return Statement**: Locates the status object return
3. **Recursive Property Analysis**: Processes nested objects individually
4. **Resource Reference Detection**: Identifies patterns like `resource.status.field`
5. **CEL Expression Generation**: Converts JavaScript expressions to CEL

#### Nested Object Handling

The analyzer properly handles nested status objects:

```typescript
// JavaScript input:
return {
  phase: deployment.status.phase,
  components: {
    database: db.status.ready,
    api: api.status.readyReplicas > 0
  }
};

// CEL output:
status:
  phase: ${deployment.status.phase}
  components:
    database: ${db.status.ready}
    api: ${api.status.readyReplicas > 0}
```

#### Resource Reference Conversion

JavaScript patterns are converted to CEL format:
- `deployment.status.readyReplicas` → `deployment.status.readyReplicas`
- `service.metadata?.name` → `service.metadata.name`
- Complex expressions preserved: `a === b ? c : d`

#### Status Builder Analyzer

For declarative patterns, the status builder analyzer handles:
- Function body analysis
- CEL expression detection
- Type inference from expressions
- Validation of status field mappings

### Stage 4: Serialization (Serialization Time)

#### YAML Generation

The serialization system (`src/core/serialization/`) converts the analyzed structure to Kro ResourceGraphDefinition YAML:

1. **Schema Generation**: Creates OpenAPI-compatible schema from ArkType definitions
2. **Resource Templates**: Serializes Enhanced resources to Kubernetes manifests
3. **Status Mapping**: Converts analyzed expressions to CEL format
4. **Dependency Resolution**: Orders resources based on references

#### CEL Expression Serialization

Different expression types are serialized appropriately:
- **Simple references**: `${resource.field}`
- **Complex expressions**: `${resource.status.ready && other.status.phase === "Ready"}`
- **Nested objects**: Individual fields get their own CEL expressions
- **Static values**: Serialized as literals

#### Validation and Optimization

During serialization:
- CEL expressions are validated for syntax
- Resource references are verified to exist
- Circular dependencies are detected
- Performance optimizations are applied

### Stage 5: Runtime Hydration (Kro Controller)

#### Kro Controller Processing

The Kro controller receives the ResourceGraphDefinition and:

1. **Creates Resources**: Deploys Kubernetes manifests in dependency order
2. **Evaluates CEL**: Processes CEL expressions against live resource state
3. **Updates Status**: Hydrates status fields with computed values
4. **Watches Changes**: Re-evaluates expressions when resources change

#### CEL Evaluation Context

The Kro controller provides CEL evaluation context:
- `schema`: The instance spec values
- `resources`: Live Kubernetes resource state
- Built-in CEL functions for common operations

## Codebase Structure

### Core Architecture (`src/core/`)

The core directory contains the fundamental TypeKro functionality organized by domain:

```
src/core/
├── composition/          # Simple resource builders (simpleDeployment, etc.)
├── dependencies/         # Dependency resolution and graph management
├── deployment/          # Direct deployment engine and readiness checking
├── references/          # Cross-resource references, CEL, and schema proxy
├── serialization/       # YAML generation and Kro schema creation
├── types/              # Domain-specific type definitions
└── errors.ts           # Core error classes
```

#### Key Modules:

- **`composition/`**: High-level composition functions that provide simple APIs for creating common resource patterns
- **`dependencies/`**: `DependencyResolver` and `DependencyGraph` for managing resource dependencies
- **`deployment/`**: `DirectDeploymentEngine` for deploying resources directly to Kubernetes without Kro controller
- **`references/`**: Reference resolution system including `ReferenceResolver`, CEL evaluation, and schema proxy
- **`serialization/`**: YAML generation and validation for Kro ResourceGraphDefinitions
- **`types/`**: Organized type definitions by domain (kubernetes, references, deployment, etc.)

### Factory Functions (`src/factories/`)

Factory functions are organized by ecosystem and resource type:

```
src/factories/
├── shared.ts                    # Shared utilities (createResource, processPodSpec)
├── index.ts                     # Main factory exports
└── kubernetes/                  # Kubernetes ecosystem
    ├── types.ts                 # Kubernetes type definitions
    ├── index.ts                 # Kubernetes factory exports
    ├── workloads/              # Deployment, Job, StatefulSet, etc.
    ├── networking/             # Service, Ingress, NetworkPolicy, etc.
    ├── storage/                # PVC, PV, StorageClass, etc.
    ├── config/                 # ConfigMap, Secret
    ├── rbac/                   # Role, RoleBinding, ServiceAccount, etc.
    ├── policy/                 # PodDisruptionBudget, ResourceQuota, etc.
    ├── core/                   # Pod, Namespace, Node, etc.
    ├── autoscaling/            # HorizontalPodAutoscaler
    ├── certificates/           # CertificateSigningRequest
    ├── coordination/           # Lease
    ├── admission/              # Webhook configurations
    ├── extensions/             # CustomResourceDefinition, customResource
    └── scheduling/             # PriorityClass, RuntimeClass
```

#### Factory Organization Principles:

- **Single Responsibility**: Each file contains factories for a specific resource type
- **Consistent Patterns**: All factories follow the same pattern using `createResource` from `shared.ts`
- **Type Safety**: Full TypeScript support with proper Enhanced<> types
- **Backward Compatibility**: Old imports continue to work through re-exports

### Additional Components

#### Utilities (`src/utils/`)
```
src/utils/
├── index.ts           # Main utility exports
├── helpers.ts         # General helper functions
└── type-guards.ts     # Type guard functions
```

#### Alchemy Integration (`src/alchemy/`)
```
src/alchemy/
├── index.ts           # Alchemy exports
├── integration.ts     # Core alchemy integration logic
└── kubernetes-api.ts  # Kubernetes API utilities for alchemy
```

## API Evolution and Current State

### Primary APIs: `kubernetesComposition` and `toResourceGraph`

TypeKro provides two primary APIs for creating typed resource graphs:

#### Imperative API: `kubernetesComposition`

The imperative API uses a single composition function where resources are auto-captured:

```typescript
import { type } from 'arktype';
import { kubernetesComposition, simple } from 'typekro';

const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1',
});

const WebAppStatusSchema = type({
  url: 'string',
  ready: 'boolean',
});

const webApp = kubernetesComposition(
  {
    name: 'webapp-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  (spec) => {
    // Resources are automatically captured
    const deployment = simple.Deployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
      id: 'webappDeployment', // Required for cross-resource references
    });

    // Return status - JavaScript expressions automatically converted to CEL
    return {
      url: `https://${spec.name}.example.com`,
      ready: deployment.status.readyReplicas >= spec.replicas,
    };
  }
);
```

#### Declarative API: `toResourceGraph`

The declarative API uses separate resource and status builder functions:

```typescript
import { type } from 'arktype';
import { toResourceGraph, simple } from 'typekro';

const graph = toResourceGraph(
  {
    name: 'webapp-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema,
  },
  (schema) => ({
    deployment: simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      id: 'webappDeployment', // Required for cross-resource references
    }),
  }),
  (_schema, resources) => ({
    url: 'https://example.com',
    ready: resources.deployment.status.readyReplicas >= 1,
  })
);

// Create factories for different deployment strategies (synchronous)
const directFactory = graph.factory('direct', { namespace: 'production' });
const kroFactory = graph.factory('kro', { namespace: 'production' });

// Deploy instances (asynchronous)
const instance = await directFactory.deploy({ name: 'my-app', image: 'nginx', replicas: 3 });
const kroInstance = await kroFactory.deploy({ name: 'my-app', image: 'nginx', replicas: 3 });
```

### Factory Pattern Implementation

The factory pattern provides two deployment strategies:

1. **Direct Factory**: TypeKro resolves dependencies and deploys individual Kubernetes manifests directly to the cluster
2. **Kro Factory**: Deploys ResourceGraphDefinitions and lets the Kro controller handle resource creation and lifecycle

Both factories implement the same interface and provide methods like:
- `deploy(spec)`: Deploy an instance with the given specification
- `toYaml()`: Generate YAML representation of the resource graph
- `delete(name)`: Remove a deployed instance

### API Comparison

TypeKro provides two complementary APIs:

| Feature | `kubernetesComposition` | `toResourceGraph` |
|---------|------------------------|-------------------|
| **Style** | Imperative | Declarative |
| **Functions** | Single composition function | Separate resource and status builders |
| **Resource Capture** | Automatic | Manual return |
| **JavaScript Expressions** | Auto-converted to CEL | Limited support |
| **Use Case** | Complex logic, natural JavaScript | Clean separation, explicit control |

### Legacy API Removal

The `toKroResourceGraph` function has been **completely removed** from the codebase. All examples and tests now use:
- `kubernetesComposition` for imperative compositions with auto-capture
- `toResourceGraph` for declarative compositions with explicit builders
- `serializeResourceGraphToYaml` for direct YAML generation from static resources

## Key Architectural Decisions

### 1. Eliminated Circular Dependencies

- **Problem**: Circular dependency between `kubernetes.ts` → `references.ts` → `deployment.ts`
- **Solution**: Moved `ResolutionContext` from `references.ts` to `deployment.ts`
- **Result**: Clean dependency graph with no circular references

### 2. Centralized Type Definitions

- **Core Types**: Located in `src/core/types/` organized by domain
- **Factory Types**: Re-export from core types to maintain compatibility
- **Consistent Imports**: All type imports follow consistent patterns

### 3. Organized Factory Structure

- **Ecosystem-Based**: Organized by target platform (kubernetes, future: helm, crossplane)
- **Resource-Type Grouping**: Related resources grouped together (workloads, networking, etc.)
- **Shared Utilities**: Common functionality in `shared.ts` to avoid duplication

### 4. Import Pattern Standards

- **External Libraries First**: `@kubernetes/client-node`, `js-yaml`, etc.
- **Internal Modules Second**: Relative imports to other modules
- **Types Last**: `import type` statements grouped separately
- **No Circular Dependencies**: Enforced through tooling and structure

## Development Guidelines

### Understanding the Pipeline

When working with TypeKro, understand which stage you're affecting. This aligns with the [Development Standards](development-standards.md) approach of context-first investigation:

1. **Magic Proxy Issues**: Usually in composition functions or type definitions
2. **Reference Problems**: Often in the analysis stage
3. **Serialization Issues**: CEL expression generation or YAML formatting
4. **Runtime Problems**: Kro controller evaluation or resource state

### Common Patterns and Anti-Patterns

#### ✅ Correct Approaches

**Respect the RefOrValue System**:
```typescript
// Composition functions already handle all cases
function myFactory(config: { name: RefOrValue<string> }) {
  // Don't modify this - it works correctly
}
```

**Trust the Analysis Pipeline**:
```typescript
// JavaScript expressions are automatically converted
return {
  ready: deployment.status.readyReplicas === deployment.spec.replicas
};
// Becomes: ready: ${deployment.status.readyReplicas === deployment.spec.replicas}
```

**Use Nested Objects Properly**:
```typescript
// This now works correctly with individual CEL expressions
return {
  components: {
    database: db.status.ready,
    api: api.status.phase === 'Ready'
  }
};
```

#### ❌ Anti-Patterns

**Don't Modify Composition Signatures**:
```typescript
// BAD - Breaking the RefOrValue system
function myFactory(config: { name: string }) { /* ... */ }
```

**Use Natural JavaScript Expressions**:
```typescript
// GOOD - Natural JavaScript expressions (automatically converted to CEL)
return {
  ready: deployment.status.readyReplicas > 0,
  url: `https://${service.status.clusterIP}/api`,
  replicas: deployment.status.readyReplicas || 0
};
```

**Don't Assume Static Evaluation**:
```typescript
// BAD - This won't work as expected
const staticValue = schema.spec.name; // This is a KubernetesRef at runtime
return { name: staticValue.toUpperCase() }; // Will fail
```

### Adding New Factory Functions

1. **Determine Category**: Place in appropriate `src/factories/kubernetes/[category]/`
2. **Follow Pattern**: Use `createResource` from `shared.ts`
3. **Export Properly**: Add to category `index.ts` and main `kubernetes/index.ts`
4. **Type Definitions**: Add types to `kubernetes/types.ts` if needed

### Adding New Core Functionality

1. **Choose Domain**: Place in appropriate `src/core/[domain]/`
2. **Type Definitions**: Add types to `src/core/types/[domain].ts`
3. **Export Structure**: Update domain `index.ts` and main `core/index.ts`
4. **Avoid Circular Dependencies**: Check with `bunx madge --circular --extensions ts src/`

### Import Guidelines

#### Standard Import Patterns

```typescript
// Core APIs
import { kubernetesComposition, toResourceGraph, simple } from 'typekro';

// Simple factories (alternative import)
import { Deployment, Service, Ingress } from 'typekro/simple';

// Schema definitions
import { type } from 'arktype';

// Type-only imports
import type { Enhanced, KubernetesRef } from 'typekro';
```

#### Simple Factory Namespace

The `simple` namespace provides convenient access to all simple factory functions:

```typescript
import { simple } from 'typekro';

// All simple factories available under namespace
const deployment = simple.Deployment({ /* config */ });
const service = simple.Service({ /* config */ });
const ingress = simple.Ingress({ /* config */ });
const configMap = simple.ConfigMap({ /* config */ });
```

#### Import Best Practices

1. **Use Consistent Patterns**: Follow the established import organization
2. **Type-Only Imports**: Use `import type` for type-only imports
3. **Prefer Simple Namespace**: Use `simple.Deployment` over individual imports
4. **Index Files**: Import from index files when available

## Debugging Guidelines

### Development Time Issues
- Check TypeScript types and IntelliSense
- Verify magic proxy behavior with logging
- Ensure RefOrValue types are used correctly

### Analysis Time Issues
- Enable composition debugging: `enableCompositionDebugging()`
- Check imperative analyzer logs
- Verify AST parsing of complex expressions

### Serialization Time Issues
- Examine generated YAML output
- Check CEL expression syntax
- Verify resource reference resolution

### Runtime Issues
- Check Kro controller logs
- Verify CEL evaluation context
- Ensure resource dependencies are correct

## Testing Structure

Tests are organized to mirror the source structure:

```
test/
├── core/              # Tests for core functionality
├── factory/           # Tests for factory functions
└── integration/       # End-to-end integration tests
```

## Build and Development

- **Package Manager**: Use `bun` for all operations (see [Tooling Requirements](tooling-requirements.md))
- **Type Checking**: `bun run typecheck` validates all TypeScript
- **Testing**: `bun run test` runs the full test suite (see [Testing Guidelines](testing-guidelines.md))
- **Linting**: `bun run lint` checks code quality
- **Import Organization**: `./scripts/organize-imports.sh` organizes imports

## Migration and Compatibility

### From Old Structure

- **Factory Imports**: Old imports like `import { deployment } from './core/factory'` still work
- **Type Imports**: Types are now centralized but re-exported for compatibility
- **Core Functionality**: All core functions available through `src/core.ts` and `src/index.ts`

### Breaking Changes

- **None**: The refactoring maintained full backward compatibility
- **Internal Structure**: Only internal organization changed, public API unchanged

### When Updating the Transpilation System

1. **Preserve the developer API** - changes should be transparent to users
2. **Maintain backward compatibility** - existing compositions should continue working
3. **Test the entire pipeline** - changes can affect multiple stages (see [Testing Guidelines](testing-guidelines.md))
4. **Document breaking changes** - if the developer experience changes
5. **Consider performance impact** - the pipeline processes every composition

Follow the [Development Standards](development-standards.md) for context-first investigation when making changes to this complex system.

## Future Considerations

### Planned Expansions

- **Additional Ecosystems**: `src/factories/helm/`, `src/factories/crossplane/`
- **Enhanced Composition**: More sophisticated composition functions
- **Performance Optimizations**: Bundle size and runtime performance improvements

### Maintenance

- **Regular Dependency Checks**: Use `bunx madge --circular` to prevent circular dependencies
- **Import Organization**: Run import organization script regularly
- **Type Safety**: Maintain strict TypeScript configuration

## Key Takeaways

1. **The system is designed for transparency** - developers write natural TypeScript, the system handles the complexity
2. **Each stage has a specific purpose** - don't try to solve problems at the wrong stage
3. **Trust the existing systems** - RefOrValue, magic proxies, and analysis work correctly
4. **Validation belongs in serialization** - not in composition functions
5. **The pipeline is optimized for developer experience** - maintain that priority when making changes

This architecture enables TypeKro's core value proposition: write natural TypeScript code that becomes robust, type-safe Kubernetes deployments with dynamic behavior.