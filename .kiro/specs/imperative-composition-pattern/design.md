# Imperative Composition Pattern Design
**Version**: 1.0
**Last Updated**: 2025-01-21

## 1. Overview

This document outlines the design for the Imperative Composition Pattern, a significant enhancement to TypeKro that provides a more intuitive API for defining Kubernetes resource compositions. The primary goal is to enable developers to write natural, imperative JavaScript functions while automatically generating the same robust, type-safe ResourceGraphDefinitions as the existing `toResourceGraph` API.

The key innovation is **context-aware resource registration**: factory functions automatically detect when they're being called within a composition context and register themselves with the active resource graph, eliminating the need for explicit resource builders.

## 2. Core Concepts

### 2.1. Imperative Composition Function

The new `kubernetesComposition` function provides a simplified API where developers write a single function that:
- Takes a spec object as input (not a schema proxy)
- Returns a status object directly (not CEL expressions)
- Has factory functions automatically register themselves during execution

```typescript
const composition = kubernetesComposition(
  definition,
  (spec) => {
    // Resources auto-register when called
    const deployment = simpleDeployment({ name: spec.name });
    const service = simpleService({ name: spec.name });
    
    // Return status with literal values and CEL expressions
    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
      url: Cel.template('http://%s', service.status.loadBalancer.ingress[0].ip)
    };
  }
);
```

### 2.2. Context-Aware Resource Registration

Using Node.js `AsyncLocalStorage` for synchronous context isolation, factory functions automatically detect composition context:

```typescript
import { AsyncLocalStorage } from 'async_hooks';

interface CompositionContext {
  resources: Record<string, Enhanced<any, any>>;
  resourceCounter: number;
  addResource(id: string, resource: Enhanced<any, any>): void;
  generateResourceId(kind: string, name?: string): string;
}

const COMPOSITION_CONTEXT = new AsyncLocalStorage<CompositionContext>();
```

### 2.3. MagicAssignableShape Status Return

The composition function returns a `MagicAssignableShape<TStatus>` object - the same type used by the existing status builder infrastructure:

```typescript
// Developer uses CEL expressions and resource references (no literal strings for complex expressions):
return {
  ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'), // CEL expression
  url: Cel.template('https://%s', spec.hostname), // CEL template (not string interpolation)
  replicas: deployment.status.readyReplicas, // resource reference
  endpoint: Cel.template('http://%s:%d', service.status.loadBalancer.ingress[0].ip, 8080)
};

// The system leverages existing status processing:
// - CEL expressions are passed through unchanged
// - Resource references use existing magic proxy system
// - No new status object processing needed - reuses toResourceGraph infrastructure
```

## 3. Architecture Components

### 3.1. Core Function Signature

```typescript
export function kubernetesComposition<TSpec, TStatus>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  compositionFn: (spec: TSpec) => MagicAssignableShape<TStatus>
): TypedResourceGraph<TSpec, TStatus>;

interface CompositionFactory<TSpec, TStatus> {
  toResourceGraph(): TypedResourceGraph<TSpec, TStatus>;
}
```

### 3.2. Modified createResource Function

The existing `createResource` function in `shared.ts` is enhanced to support context-aware registration:

```typescript
export function createResource<TSpec extends object, TStatus extends object>(
  resource: KubernetesResource<TSpec, TStatus>
): Enhanced<TSpec, TStatus> {
  // ... existing implementation ...
  
  const enhanced = createGenericProxyResource(resourceId, resource);
  
  // NEW: Auto-register with composition context if active
  const context = getCurrentCompositionContext();
  if (context) {
    context.addResource(resourceId, enhanced);
  }
  
  // ... rest of existing implementation ...
  
  return enhanced;
}

export function getCurrentCompositionContext(): CompositionContext | undefined {
  return COMPOSITION_CONTEXT.getStore();
}
```

### 3.3. Status Object Integration

The imperative composition pattern leverages the existing `MagicAssignableShape<TStatus>` type and status processing infrastructure:

```typescript
// No new status processing needed - composition function returns MagicAssignableShape<TStatus>
// which is exactly what the existing toResourceGraph status builder expects

export function getCurrentCompositionContext(): CompositionContext | undefined {
  return COMPOSITION_CONTEXT.getStore();
}

export function runWithCompositionContext<T>(
  context: CompositionContext,
  fn: () => T
): T {
  return COMPOSITION_CONTEXT.run(context, fn);
}
```

## 4. Implementation Strategy

### 4.1. Phase 1: Context-Aware Registration (Core Foundation)

**File: `src/factories/shared.ts`**

```typescript
// Add context management
import { AsyncLocalStorage } from 'async_hooks';

interface CompositionContext {
  resources: Record<string, Enhanced<any, any>>;
  resourceCounter: number;
  addResource(id: string, resource: Enhanced<any, any>): void;
  generateResourceId(kind: string, name?: string): string;
}

const COMPOSITION_CONTEXT = new AsyncLocalStorage<CompositionContext>();

export function getCurrentCompositionContext(): CompositionContext | undefined {
  return COMPOSITION_CONTEXT.getStore();
}

// Enhance existing createResource function
export function createResource<TSpec extends object, TStatus extends object>(
  resource: KubernetesResource<TSpec, TStatus>
): Enhanced<TSpec, TStatus> {
  // ... existing resourceId generation and proxy creation ...
  
  const enhanced = createGenericProxyResource(resourceId, resource);
  
  // NEW: Auto-register with composition context
  const context = getCurrentCompositionContext();
  if (context) {
    context.addResource(resourceId, enhanced);
  }
  
  // ... existing readiness evaluator and fluent builder setup ...
  
  return enhanced;
}
```

### 4.2. Phase 2: kubernetesComposition Function (Simplified Implementation)

**File: `src/core/composition/imperative.ts`**

```typescript
import { runWithCompositionContext } from '../../factories/shared.js';
import { toResourceGraph } from '../serialization/core.js';
import type { ResourceGraphDefinition, TypedResourceGraph, MagicAssignableShape } from '../types/serialization.js';

export function kubernetesComposition<TSpec, TStatus>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  compositionFn: (spec: TSpec) => MagicAssignableShape<TStatus>
): CompositionFactory<TSpec, TStatus> {
  return {
    toResourceGraph(): TypedResourceGraph<TSpec, TStatus> {
      const context: CompositionContext = {
        resources: {},
        resourceCounter: 0,
        addResource(id: string, resource: Enhanced<any, any>) {
          this.resources[id] = resource;
        },
        generateResourceId(kind: string, name?: string) {
          return name || `${kind.toLowerCase()}-${++this.resourceCounter}`;
        }
      };

      return runWithCompositionContext(context, () => {
        // Execute composition once to capture both resources and status
        let capturedStatus: MagicAssignableShape<TStatus>;
        
        return toResourceGraph(
          definition,
          // Resource builder - execute composition to collect resources
          (schema) => {
            capturedStatus = compositionFn(schema.spec as TSpec);
            return context.resources;
          },
          // Status builder - return captured MagicAssignableShape<TStatus>
          (schema, resources) => {
            return capturedStatus; // No processing needed - already correct type
          }
        );
      });
    }
  };
}

interface CompositionFactory<TSpec, TStatus> {
  toResourceGraph(): TypedResourceGraph<TSpec, TStatus>;
}
```

### 4.3. Phase 3: Integration and Exports (Simplified)

**No Status Processing Needed:**

The imperative composition pattern leverages existing infrastructure by returning `MagicAssignableShape<TStatus>`:

```typescript
// No additional status processing files needed
// The composition function returns the same type as status builders
// Existing toResourceGraph infrastructure handles everything
```

## 5. Integration Points

### 5.1. Exports and API Surface

**File: `src/index.ts`**

```typescript
// Add new exports
export { kubernetesComposition } from './core/composition/imperative.js';
export type { CompositionFactory } from './core/composition/imperative.js';
```

### 5.2. Backward Compatibility

The imperative composition pattern is completely additive:
- Existing `toResourceGraph` API remains unchanged
- All factory functions work exactly as before
- Only new functionality is the automatic context registration

### 5.3. Error Handling

**File: `src/core/errors.ts`**

```typescript
export class CompositionExecutionError extends TypeKroError {
  constructor(
    message: string,
    public readonly compositionName: string,
    public readonly cause?: Error
  ) {
    super(message, 'COMPOSITION_EXECUTION_ERROR', { compositionName, cause });
    this.name = 'CompositionExecutionError';
  }
}

export class ContextRegistrationError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceId: string,
    public readonly factoryName: string,
    public readonly cause?: Error
  ) {
    super(message, 'CONTEXT_REGISTRATION_ERROR', { resourceId, factoryName, cause });
    this.name = 'ContextRegistrationError';
  }
}
```

## 6. Example Usage

### 6.1. Simple Web Application

```typescript
import { type } from 'arktype';
import { kubernetesComposition, simpleDeployment, simpleService } from 'typekro';

const WebAppSpec = type({
  name: 'string',
  image: 'string', 
  replicas: 'number'
});

const WebAppStatus = type({
  ready: 'boolean',
  replicas: 'number',
  url: 'string'
});

const webApp = kubernetesComposition(
  {
    name: 'simple-webapp',
    apiVersion: 'example.com/v1alpha1', 
    kind: 'WebApp',
    spec: WebAppSpec,
    status: WebAppStatus
  },
  (spec) => {
    // Resources auto-register
    const deployment = simpleDeployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas
    });
    
    const service = simpleService({
      name: `${spec.name}-service`,
      selector: { app: spec.name }
    });
    
    // Return MagicAssignableShape<TStatus> with CEL expressions and resource references
    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' == ', spec.replicas),
      replicas: deployment.status.readyReplicas,
      url: Cel.template('http://%s', service.status.loadBalancer.ingress[0].ip)
    };
  }
);

// Compile to KRO https://kro.run resource graph definition yaml:
const factory = webApp.factory('kro');
const yaml = factory.toYaml();
// Or: Deploy to Kubernetes where KRO controller is installed
const instance = await factory.deploy({ name: 'myWebapp', image: 'webapp-image:latest', replicas: 3 })

// Or if you don't want to use the KRO operator for some reason:
const factory = webApp.factory('direct');
// Convert to regular flat YAML if all values are known at build time:
const yaml = factory.toYaml();
// Or deploy to Kubernetes cluster resource by resource, waiting for resources to stabilize before deploying their dependencies
const instance = await factory.deploy({ name: 'myWebapp', image: 'webapp-image:latest', replicas: 3 })

```

### 6.2. Complex Composition with Dependencies

```typescript
const fullStack = kubernetesComposition(
  {
    name: 'full-stack',
    apiVersion: 'example.com/v1alpha1',
    kind: 'FullStack', 
    spec: FullStackSpec,
    status: FullStackStatus
  },
  (spec) => {
    // Database resources
    const postgres = simpleDeployment({
      name: 'postgres',
      image: 'postgres:13',
      env: { POSTGRES_DB: spec.dbName }
    });
    
    const postgresService = simpleService({
      name: 'postgres-service',
      selector: { app: 'postgres' }
    });
    
    // Application resources  
    const app = simpleDeployment({
      name: spec.appName,
      image: spec.appImage,
      env: {
        DATABASE_URL: `postgres://user:pass@${postgresService.metadata.name}:5432/${spec.dbName}`
      }
    });
    
    const appService = simpleService({
      name: 'app-service', 
      selector: { app: spec.appName }
    });
    
    const ingress = simpleIngress({
      name: 'app-ingress',
      hostname: spec.hostname,
      serviceName: 'app-service'
    });
    
    // Return MagicAssignableShape<TStatus> with CEL expressions and resource references
    return {
      phase: Cel.expr<string>(postgres.status.readyReplicas, ' > 0 && ', app.status.readyReplicas, ' > 0 ? "Ready" : "Pending"'),
      databaseReady: Cel.expr<boolean>(postgres.status.readyReplicas, ' > 0'),
      applicationReady: Cel.expr<boolean>(app.status.readyReplicas, ' == ', spec.replicas),
      url: Cel.template('https://%s', spec.hostname), // Use Cel.template, not string interpolation
      totalReplicas: Cel.expr<number>(postgres.status.readyReplicas, ' + ', app.status.readyReplicas)
    };
  }
);
```

## 7. Migration Path

### 7.1. From toResourceGraph to kubernetesComposition

Existing `toResourceGraph` usage:
```typescript
const webapp = toResourceGraph(
  definition,
  (schema) => ({
    deployment: simpleDeployment({ name: schema.spec.name }),
    service: simpleService({ name: schema.spec.name })
  }),
  (schema, resources) => ({
    ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
    url: Cel.template('http://%s', resources.service.status.loadBalancer.ingress[0].ip)
  })
);
```

Equivalent imperative composition:
```typescript
const webapp = kubernetesComposition(
  definition,
  (spec) => {
    const deployment = simpleDeployment({ name: spec.name });
    const service = simpleService({ name: spec.name });
    
    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
      url: Cel.template('http://%s', service.status.loadBalancer.ingress[0].ip)
    };
  }
);
```

### 7.2. Gradual Adoption Strategy

1. **Phase 1**: Add `kubernetesComposition` alongside existing API
2. **Phase 2**: Update documentation and examples to show both patterns
3. **Phase 3**: Recommend imperative pattern for new projects
4. **Phase 4**: Consider deprecation timeline for `toResourceGraph` (optional)

## 8. Testing Strategy

### 8.1. Unit Tests

**File: `test/core/imperative-composition.test.ts`**

```typescript
describe('Imperative Composition Pattern', () => {
  test('should capture resources automatically', () => {
    const composition = kubernetesComposition(definition, (spec) => {
      const deployment = simpleDeployment({ name: spec.name });
      return { ready: true };
    });
    
    const resourceGraph = composition.toResourceGraph();
    expect(Object.keys(resourceGraph.resources)).toContain('deployment');
  });
  
  test('should process status objects correctly', () => {
    // Test status object processing and validation
  });
  
  test('should preserve context during synchronous execution', () => {
    // Test synchronous context behavior
  });
});
```

### 8.2. Integration Tests

**File: `test/integration/imperative-e2e.test.ts`**

```typescript
describe('Imperative Composition E2E', () => {
  test('should generate valid Kro YAML', () => {
    const composition = kubernetesComposition(definition, compositionFn);
    const yaml = composition.toResourceGraph().toYaml();
    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
  });
  
  test('should work with factory methods', async () => {
    const composition = kubernetesComposition(definition, compositionFn);
    // Note: Only deployment is async, composition itself is synchronous
    const factory = await composition.toResourceGraph().factory('kro');
    expect(factory).toBeDefined();
  });
});
```

## 9. Performance Considerations

### 9.1. Context Overhead
- `AsyncLocalStorage` has minimal performance impact for typical usage
- Context objects are lightweight and short-lived
- No global state or memory leaks

### 9.2. Status Processing
- Status object processing has minimal overhead
- Validation and basic processing performed once during `toResourceGraph()` call
- Processing complexity scales with the size of the status object

### 9.3. Resource Registration
- HashMap operations for resource storage: O(1) insertion
- No impact on factory function performance outside composition context
- Minimal memory overhead per registered resource

## 10. Design Considerations

### 10.1. Enhanced Type Optionality

**Question**: Should the Enhanced<> proxy types preserve TypeScript optionality from the original Kubernetes resource definitions?

**Current Behavior**: Enhanced types may remove optionality, making `deployment.status.readyReplicas` always appear as `number` instead of `number | undefined`.

**Options**:
1. **Preserve Optionality**: Keep original TypeScript optional types, requiring developers to handle undefined cases
2. **Remove Optionality**: Current behavior - assume fields exist, handle missing values at runtime via CEL
3. **Hybrid Approach**: Preserve optionality but provide automatic fallback conversion

**Recommendation**: Evaluate during implementation based on:
- Integration with Kro's conditional CEL expressions (`?` operator)
- Developer experience with optional chaining vs explicit null checks
- Consistency with existing TypeKro behavior

**Implementation Task**: Task 4.4 will evaluate this decision and Task 4.5 will implement Kro optionality integration if needed.

### 10.2. Status Object Complexity

**Considerations for Status Objects**:
```typescript
// Simple status objects with literal values work immediately
return {
  ready: true,
  replicas: 3,
  url: 'http://example.com'
};

// Complex expressions require explicit CEL expressions
return {
  ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
  url: Cel.expr<string>(service.status.loadBalancer.ingress[0].ip, ' || "pending"')
};
```

**Strategy**: Support literal values and require explicit CEL expressions for complex logic, maintaining clear separation of concerns.

## 11. Advanced Composition Patterns

### 11.1. Deployment Closure Support

The imperative composition pattern supports deployment closures (like `yamlFile()` and `yamlDirectory()`) alongside Enhanced resources.

#### 11.1.1. Design Approach

```typescript
const webAppComposition = kubernetesComposition(
  definition,
  (spec) => {
    // Regular Enhanced resources
    const deployment = simpleDeployment({
      name: spec.name,
      image: spec.image
    });
    
    // Deployment closures - executed during deployment phase
    const crds = yamlFile({
      name: 'custom-crds',
      path: 'git:github.com/example/crds/manifests@main'
    });
    
    const configs = yamlDirectory({
      name: 'config-files',
      path: './k8s-configs',
      recursive: true
    });
    
    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
      configsApplied: true // Literal value for closure status
    };
  }
);
```

#### 11.1.2. Implementation Strategy

The key insight is that we need a **generic deployment closure registration mechanism** that works for any function returning a `DeploymentClosure<T>`, not just specific factories like `yamlFile()` and `yamlDirectory()`.

```typescript
// Enhanced CompositionContext to capture both resources and closures
interface CompositionContext {
  resources: Record<string, Enhanced<any, any>>;
  closures: Record<string, DeploymentClosure>; // Generic closure support
  resourceCounter: number;
  
  addResource(id: string, resource: Enhanced<any, any>): void;
  addClosure(id: string, closure: DeploymentClosure): void;
  generateResourceId(kind: string, name?: string): string;
}

// Generic closure registration wrapper
export function registerDeploymentClosure<T>(
  closureFactory: () => DeploymentClosure<T>,
  name?: string
): DeploymentClosure<T> {
  const context = getCurrentCompositionContext();
  
  if (context) {
    const closure = closureFactory();
    const closureId = context.generateResourceId('closure', name);
    context.addClosure(closureId, closure);
    return closure;
  }
  
  // Outside composition context - return closure as-is
  return closureFactory();
}

// Modify existing deployment closure factories to use registration
export function yamlFile(config: YamlFileConfig): DeploymentClosure<AppliedResource[]> {
  return registerDeploymentClosure(
    () => async (deploymentContext: DeploymentContext) => {
      // ... existing yamlFile implementation
    },
    config.name
  );
}

export function yamlDirectory(config: YamlDirectoryConfig): DeploymentClosure<AppliedResource[]> {
  return registerDeploymentClosure(
    () => async (deploymentContext: DeploymentContext) => {
      // ... existing yamlDirectory implementation  
    },
    config.name
  );
}
```

This approach ensures that:
1. **Any deployment closure** automatically registers with composition context
2. **Future deployment closures** work without modification
3. **Existing deployment closures** work with minimal changes
4. **No composition context** means closures work normally

### 11.2. Direct API and Composition of Compositions

The imperative composition pattern uses a direct API where `kubernetesComposition` returns a `TypedResourceGraph` directly, enabling seamless composition of compositions.

#### 11.2.1. Direct API Design

```typescript
// Direct API - no .toResourceGraph() method needed
const webAppComposition: TypedResourceGraph<WebAppSpec, WebAppStatus> = kubernetesComposition(
  definition,
  (spec) => {
    const deployment = simpleDeployment({ name: spec.name });
    return { ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0') };
  }
);

// Use directly
const factory = await webAppComposition.factory('kro');
const yaml = webAppComposition.toYaml();
```

#### 11.2.2. Composition of Compositions

```typescript
// Individual compositions
const databaseComposition = kubernetesComposition(dbDefinition, (spec) => {
  const postgres = simpleDeployment({ name: 'postgres' });
  return { ready: Cel.expr<boolean>(postgres.status.readyReplicas, ' > 0') };
});

// Composed composition - context transparently passes through
const fullStackComposition = kubernetesComposition(
  fullStackDefinition,
  (spec) => {
    // Use compositions directly - resources are automatically merged
    const db = databaseComposition; // No .toResourceGraph() needed
    
    return {
      databaseReady: db.status.ready,
      overallReady: Cel.expr<boolean>(db.status.ready, ' && true')
    };
  }
);
```

#### 11.2.3. Transparent Context Passing

When a composition is used within another composition:

1. **Context Merging**: The nested composition's context is merged with the parent context
2. **Resource Merging**: All resources and closures are merged with unique identifiers
3. **Status Access**: Nested composition status is available as typed properties
4. **No API Changes**: Compositions work the same whether used standalone or nested

## 12. Future Enhancements

### 12.1. Enhanced Expression Support
- Support for more complex JavaScript expressions
- Better error messages with source code locations
- IDE integration for real-time CEL preview

### 12.2. Debugging Tools
- Composition debugger that shows resource registration flow
- CEL expression inspector
- Performance profiling for complex compositions

### 12.3. Advanced Patterns
- Enhanced synchronous composition patterns
- Resource lifecycle hooks
- Conditional resource creation patterns