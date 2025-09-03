# Resource Graph Transpilation and Hydration System

## Overview

TypeKro's resource graph system involves a sophisticated transpilation and hydration process that transforms TypeScript code into Kubernetes manifests with CEL expressions. This document explains the complete pipeline from developer code to deployed resources.

## Core Architecture: Multi-Stage Transformation

The TypeKro system operates through several distinct stages:

1. **Development Time**: TypeScript with magic proxies and type safety
2. **Composition Time**: Resource creation with reference tracking
3. **Analysis Time**: JavaScript to CEL expression conversion
4. **Serialization Time**: YAML generation with CEL expressions
5. **Runtime**: Kro controller evaluation and resource hydration

## Stage 1: Magic Proxy System (Development Time)

### Static vs Runtime Type Duality

The magic proxy system creates a fundamental distinction between **static types** (what TypeScript sees) and **runtime types** (what actually exists during execution).

#### Schema Proxy Behavior

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
3. **CEL expressions**: `name: Cel.expr('prefix-', schema.spec.name)` (CelExpression)
4. **Resource references**: `name: deployment.metadata.name` (runtime KubernetesRef)

#### The processValue Function

Runtime type handling in composition functions:

```typescript
function processValue<T>(value: RefOrValue<T> | undefined, fallback: T): T {
  if (value === undefined || isKubernetesRef(value)) return fallback;
  return value as T;
}
```

**Key insight**: `KubernetesRef` objects return fallback values during composition because actual resolution happens during serialization.

## Stage 2: Composition Context (Composition Time)

### Resource Registration

During composition execution:
- Resources are registered in a composition context
- Each resource gets a unique ID for cross-referencing
- Resource references are tracked for dependency resolution
- Status expressions are captured for later analysis

### Imperative vs Declarative Patterns

**Imperative Pattern** (`kubernetesComposition`):
```typescript
kubernetesComposition(definition, (spec) => {
  const deployment = simpleDeployment({ name: spec.name, image: spec.image });
  const service = simpleService({ name: spec.name, selector: deployment });
  
  return {
    ready: deployment.status.readyReplicas === deployment.spec.replicas,
    url: `http://${service.status.loadBalancer.ingress[0].ip}`
  };
});
```

**Declarative Pattern** (`toResourceGraph`):
```typescript
toResourceGraph(definition, 
  (schema) => ({ /* resources */ }),
  (schema, resources) => ({ /* status */ })
);
```

## Stage 3: JavaScript to CEL Analysis (Analysis Time)

### Imperative Analyzer

The imperative analyzer (`src/core/expressions/imperative-analyzer.ts`) performs AST analysis on JavaScript functions:

1. **Parse Function Source**: Uses Acorn to parse JavaScript into AST
2. **Find Return Statement**: Locates the status object return
3. **Recursive Property Analysis**: Processes nested objects individually
4. **Resource Reference Detection**: Identifies patterns like `resource.status.field`
5. **CEL Expression Generation**: Converts JavaScript expressions to CEL

#### Nested Object Handling

The analyzer now properly handles nested status objects:

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

### Status Builder Analyzer

For declarative patterns, the status builder analyzer handles:
- Function body analysis
- CEL expression detection
- Type inference from expressions
- Validation of status field mappings

## Stage 4: Serialization (Serialization Time)

### YAML Generation

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

### Validation and Optimization

During serialization:
- CEL expressions are validated for syntax
- Resource references are verified to exist
- Circular dependencies are detected
- Performance optimizations are applied

## Stage 5: Runtime Hydration (Kro Controller)

### Kro Controller Processing

The Kro controller receives the ResourceGraphDefinition and:

1. **Creates Resources**: Deploys Kubernetes manifests in dependency order
2. **Evaluates CEL**: Processes CEL expressions against live resource state
3. **Updates Status**: Hydrates status fields with computed values
4. **Watches Changes**: Re-evaluates expressions when resources change

### CEL Evaluation Context

The Kro controller provides CEL evaluation context:
- `schema`: The instance spec values
- `resources`: Live Kubernetes resource state
- Built-in CEL functions for common operations

## Development Guidelines

### Understanding the Pipeline

When working with TypeKro, understand which stage you're affecting:

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

**Don't Bypass the Analysis System**:
```typescript
// BAD - Manual CEL construction in imperative compositions
return {
  ready: Cel.expr('deployment.status.ready') // Let the analyzer handle this
};
```

**Don't Assume Static Evaluation**:
```typescript
// BAD - This won't work as expected
const staticValue = schema.spec.name; // This is a KubernetesRef at runtime
return { name: staticValue.toUpperCase() }; // Will fail
```

### Debugging the Pipeline

#### Development Time Issues
- Check TypeScript types and IntelliSense
- Verify magic proxy behavior with logging
- Ensure RefOrValue types are used correctly

#### Analysis Time Issues
- Enable composition debugging: `enableCompositionDebugging()`
- Check imperative analyzer logs
- Verify AST parsing of complex expressions

#### Serialization Time Issues
- Examine generated YAML output
- Check CEL expression syntax
- Verify resource reference resolution

#### Runtime Issues
- Check Kro controller logs
- Verify CEL evaluation context
- Ensure resource dependencies are correct

## Key Takeaways

1. **The system is designed for transparency** - developers write natural TypeScript, the system handles the complexity
2. **Each stage has a specific purpose** - don't try to solve problems at the wrong stage
3. **Trust the existing systems** - RefOrValue, magic proxies, and analysis work correctly
4. **Validation belongs in serialization** - not in composition functions
5. **The pipeline is optimized for developer experience** - maintain that priority when making changes

## Migration and Compatibility

When updating the transpilation system:

1. **Preserve the developer API** - changes should be transparent to users
2. **Maintain backward compatibility** - existing compositions should continue working
3. **Test the entire pipeline** - changes can affect multiple stages
4. **Document breaking changes** - if the developer experience changes
5. **Consider performance impact** - the pipeline processes every composition

This system enables TypeKro's core value proposition: write natural TypeScript code that becomes robust, type-safe Kubernetes deployments with dynamic behavior.