# Imperative Composition Pattern Requirements

## Introduction

This feature will enable TypeKro to provide an imperative, context-aware composition API where developers write natural JavaScript functions that return status objects directly, while factory functions automatically register themselves with the current composition context. This eliminates the need for explicit resource builders and status builders, creating a more intuitive development experience.

**Note**: This spec focuses solely on the imperative composition pattern and context-aware resource registration.

## Requirements

### Requirement 1: Imperative Composition Function

**User Story:** As a developer, I want to write a simple function that takes a spec and returns status directly, so that I can focus on business logic rather than framework mechanics.

#### Acceptance Criteria

1. WHEN I call `kubernetesComposition(definition, compositionFn)` THEN I SHALL get a TypedResourceGraph directly
2. WHEN I define compositionFn THEN it SHALL accept only the spec object as parameter
3. WHEN compositionFn executes THEN it SHALL return the status object directly  
4. WHEN I use TypeScript THEN the spec and status SHALL be fully typed from ArkType schemas
5. WHEN compositionFn returns THEN the status SHALL match the status schema exactly

### Requirement 2: Context-Aware Resource Registration

**User Story:** As a developer, I want factory functions to automatically detect when they're in a composition context and register themselves, so that I don't need to explicitly manage resource collections.

#### Acceptance Criteria

1. WHEN I call a factory function inside compositionFn THEN it SHALL automatically register with the current context
2. WHEN I call the same factory function outside compositionFn THEN it SHALL work normally without registration
3. WHEN multiple resources are created THEN each SHALL get a unique identifier automatically
4. WHEN resources reference each other THEN the system SHALL track dependencies automatically
5. WHEN compositionFn completes THEN all created resources SHALL be captured in the resource graph

### Requirement 3: Literal Status Object Return

**User Story:** As a developer, I want to return status objects with literal values from my composition function, so that I can focus on the logical structure without complex expressions.

#### Acceptance Criteria

1. WHEN I return a status object THEN it SHALL be properly typed against the status schema
2. WHEN I use literal values (strings, numbers, booleans) THEN they SHALL be handled correctly
3. WHEN I use simple resource field references THEN they SHALL be converted to CEL expressions
4. WHEN I use complex expressions THEN the system SHALL provide clear guidance to use CEL expressions directly
5. WHEN status validation fails THEN error messages SHALL be clear and actionable

### Requirement 4: CEL Library Expression Support

**User Story:** As a developer, I want to use existing CEL library expressions in my composition function, so that I can leverage the full power of CEL when needed.

#### Acceptance Criteria

1. WHEN I use `Cel.expr()` expressions THEN they SHALL be passed through unchanged
2. WHEN I use `Cel.template()` expressions THEN they SHALL be passed through unchanged
3. WHEN I mix CEL expressions with literal values THEN both SHALL work correctly
4. WHEN I use CEL expressions with resource references THEN dependencies SHALL be tracked automatically
5. WHEN CEL expressions are invalid THEN clear error messages SHALL be provided

### Requirement 5: Zero Factory Function Modifications

**User Story:** As a developer, I want existing factory functions to work with the new composition pattern without any modifications, so that I can adopt the new pattern gradually.

#### Acceptance Criteria

1. WHEN I use existing factory functions THEN they SHALL work in composition context without changes
2. WHEN new factory functions are added THEN they SHALL automatically support composition context
3. WHEN I use factory functions outside composition THEN they SHALL work exactly as before
4. WHEN factory functions are called THEN performance SHALL not be significantly impacted
5. WHEN debugging factory functions THEN behavior SHALL be predictable and transparent

### Requirement 6: Synchronous Context Management

**User Story:** As a developer, I want the composition context to work reliably during synchronous composition execution, so that I can write simple, predictable composition functions.

#### Acceptance Criteria

1. WHEN I write synchronous compositionFn THEN context SHALL be preserved throughout execution
2. WHEN I call factory functions synchronously THEN they SHALL register with context immediately
3. WHEN multiple compositions run THEN each SHALL have isolated context
4. WHEN context is not available THEN factory functions SHALL work normally without registration
5. WHEN errors occur THEN context cleanup SHALL happen automatically

### Requirement 7: Seamless toResourceGraph Integration

**User Story:** As a developer, I want the imperative composition to generate the same output as toResourceGraph, so that I can migrate between patterns without breaking existing functionality.

#### Acceptance Criteria

1. WHEN I use the composition result THEN it SHALL be a TypedResourceGraph identical to toResourceGraph output
2. WHEN I use the result with existing tooling THEN all features SHALL work (Alchemy, YAML generation, etc.)
3. WHEN I serialize to YAML THEN output SHALL be valid Kro ResourceGraphDefinition
4. WHEN I use factory methods THEN they SHALL work exactly like toResourceGraph factories
5. WHEN I deploy resources THEN behavior SHALL be identical to toResourceGraph approach

### Requirement 8: Type Safety and IDE Support

**User Story:** As a developer, I want full TypeScript type safety and IDE autocomplete throughout the composition function, so that I can catch errors early and have a great development experience.

#### Acceptance Criteria

1. WHEN I access spec fields THEN TypeScript SHALL provide autocomplete and type checking
2. WHEN I access resource status fields THEN TypeScript SHALL know the exact types
3. WHEN I return status object THEN TypeScript SHALL validate against status schema
4. WHEN I make type errors THEN TypeScript compiler SHALL catch them
5. WHEN I refactor schemas THEN TypeScript SHALL highlight affected code

### Requirement 9: Debugging and Error Handling

**User Story:** As a developer, I want clear error messages and debugging capabilities when composition fails, so that I can quickly identify and fix issues.

#### Acceptance Criteria

1. WHEN compositionFn throws an error THEN the system SHALL provide context about which resource caused it
2. WHEN status object validation fails THEN the error SHALL include field-level details with clear guidance
3. WHEN resource registration fails THEN the error SHALL identify the specific factory function
4. WHEN schema validation fails THEN the error SHALL include field-level details
5. WHEN debugging THEN I SHALL be able to inspect the captured resources and status object structure
6. WHEN CEL expressions fail at runtime THEN error messages SHALL be clear and actionable
7. WHEN performance issues occur THEN profiling information SHALL be available for composition execution

### Requirement 10: Generic Deployment Closure Support

**User Story:** As a developer, I want to use any deployment closure (current and future) in my composition functions, so that I can deploy external resources alongside my generated resources without modifying the composition system.

#### Acceptance Criteria

1. WHEN I call any function that returns a DeploymentClosure inside compositionFn THEN it SHALL be automatically captured
2. WHEN new deployment closure factories are added THEN they SHALL work automatically without system changes
3. WHEN deployment closures are used THEN they SHALL be available to all factory modes (kro, direct)
4. WHEN deployment closures have dependencies on resources THEN the system SHALL resolve them during deployment
5. WHEN deployment closures are deployed THEN they SHALL execute in correct dependency order

### Requirement 11: Composition of Compositions with Direct API

**User Story:** As a developer, I want to compose kubernetes compositions made up of other kubernetes compositions with a direct API, so that I can build complex systems from reusable components without extra method calls.

#### Acceptance Criteria

1. WHEN I call `kubernetesComposition()` THEN it SHALL return a TypedResourceGraph directly (not a factory)
2. WHEN I use another composition inside compositionFn THEN its resources SHALL be automatically merged
3. WHEN I reference another composition's status THEN it SHALL be available as typed properties
4. WHEN compositions are nested THEN the composition context SHALL transparently pass through
5. WHEN multiple compositions are composed THEN all resources and closures SHALL have unique identifiers



## Success Criteria

- Developers can write simple, imperative composition functions without framework knowledge
- Factory functions automatically work with composition context without modification
- Full TypeScript type safety throughout the composition process
- Seamless integration with existing toResourceGraph functionality
- Performance suitable for typical infrastructure deployment scenarios
- Clear debugging and error reporting for failed compositions

## Example Usage

```typescript
// Define schemas
const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  hostname: 'string'
});

const WebAppStatusSchema = type({
  ready: 'boolean',
  url: 'string', 
  readyReplicas: 'number'
});

// Create imperative composition
const webAppComposition = kubernetesComposition(
  {
    name: 'web-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema
  },
  (spec) => {
    // Resources automatically register themselves
    const deployment = simpleDeployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas
    });
    
    const service = simpleService({
      name: `${spec.name}-service`,
      selector: { app: spec.name }
    });
    
    const ingress = simpleIngress({
      name: `${spec.name}-ingress`,
      hostname: spec.hostname,
      serviceName: `${spec.name}-service`
    });

    // Return the status object with CEL expressions and resource references
    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
      url: Cel.template('https://%s', spec.hostname), // Use Cel.template for string interpolation
      readyReplicas: deployment.status.readyReplicas
    };
  }
);

// Use directly as TypedResourceGraph
const yaml = webAppComposition.toYaml();
const factory = await webAppComposition.factory('kro');
```

## Non-Functional Requirements

- **Performance**: Composition execution should add minimal overhead to factory function calls
- **Type Safety**: Complete TypeScript type checking throughout composition process
- **Usability**: API should feel natural to JavaScript/TypeScript developers
- **Compatibility**: Must work seamlessly with all existing TypeKro features
- **Reliability**: Context management should work reliably during synchronous execution
- **Debugging**: Clear error messages and stack traces for composition failures