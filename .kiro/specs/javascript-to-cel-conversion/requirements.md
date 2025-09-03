# JavaScript to CEL Expression Conversion Requirements

## Introduction

This feature will enable TypeKro to automatically convert natural JavaScript expressions to CEL expressions throughout the system. The key insight is that TypeKro's magic proxy system (SchemaProxy and ResourcesProxy) returns KubernetesRef objects at runtime when developers access fields like `schema.spec.name` or `resources.database.status.podIP`. When these KubernetesRef objects are used in JavaScript expressions, the system needs to detect them and convert the entire expression to appropriate CEL expressions.

This includes expressions in resource builders (when they contain KubernetesRef objects), status builders, and any other context where CEL expressions are used. The goal is to allow developers to write familiar JavaScript syntax while automatically generating the appropriate CEL expressions for Kubernetes resource orchestration, without needing to understand the underlying KubernetesRef system.

Additionally, this feature must address critical infrastructure issues that are blocking the JavaScript-to-CEL conversion functionality:

1. **TypeScript Compilation Consistency**: The IDE is catching type errors that the build process typecheck commands are not catching, leading to runtime failures that should be caught at compile time.

2. **Nested Composition Function Resolution**: The `kubernetesComposition` function is being treated as a ProxyObject instead of a callable function when used in nested composition scenarios, causing runtime errors like "createDatabase is not a function".

## Requirements

### Requirement 1: Documentation and Examples Cleanup (PRIORITY)

**User Story:** As a developer learning TypeKro, I want all documentation and examples to show natural JavaScript expressions instead of explicit CEL expressions, so that I can learn the modern TypeKro syntax without being confused by legacy patterns.

#### Acceptance Criteria

1. WHEN I read TypeKro documentation THEN all examples SHALL use natural JavaScript expressions instead of explicit `Cel.expr`, `Cel.template`, or `Cel.conditional` calls
2. WHEN I look at example files THEN they SHALL demonstrate the JavaScript-to-CEL conversion feature rather than manual CEL expressions
3. WHEN I follow tutorials THEN they SHALL teach the natural JavaScript syntax as the primary approach
4. WHEN explicit CEL expressions are necessary THEN they SHALL be clearly marked as advanced/escape-hatch usage with explanations of when to use them
5. WHEN migration examples are shown THEN they SHALL demonstrate the before/after transformation from CEL to JavaScript

### Requirement 2: Comprehensive KubernetesRef Detection and Expression Analysis (IMPLEMENTED)

**User Story:** As a developer, I want to write natural JavaScript expressions anywhere in TypeKro that gets converted to CEL, so that I can use familiar syntax without learning CEL or understanding KubernetesRef objects.

#### Acceptance Criteria

1. ✅ WHEN I write JavaScript expressions containing KubernetesRef objects in status builders THEN they SHALL be automatically converted to CEL
2. ✅ WHEN I write JavaScript expressions containing KubernetesRef objects in resource builders THEN they SHALL be converted to CEL
3. ✅ WHEN I use expressions containing KubernetesRef objects in any context that requires CEL THEN the conversion SHALL be automatic
4. ✅ WHEN expressions are analyzed THEN the system SHALL preserve type safety throughout KubernetesRef detection and conversion
5. ✅ WHEN conversion is not possible THEN clear error messages SHALL explain why and reference the original JavaScript expression

### Requirement 3: Basic Expression Support with KubernetesRef Integration (IMPLEMENTED)

**User Story:** As a developer, I want support for common JavaScript expression patterns with KubernetesRef objects, so that I can write natural code for most use cases.

#### Acceptance Criteria

1. ✅ WHEN I write binary expressions with KubernetesRef objects (`kubernetesRef > 0`, `kubernetesRef == value`) THEN they SHALL convert to CEL operators
2. ✅ WHEN KubernetesRef objects represent field access THEN they SHALL convert to proper CEL field access
3. ✅ WHEN I write array access with KubernetesRef objects (`kubernetesRefArray[0]`) THEN they SHALL convert to CEL array operations
4. ✅ WHEN I write literal values (strings, numbers, booleans) without KubernetesRef objects THEN they SHALL be preserved correctly without conversion
5. ✅ WHEN I write template literals containing KubernetesRef objects THEN they SHALL convert to CEL template expressions

### Requirement 4: Advanced Expression Support with KubernetesRef Objects (IMPLEMENTED)

**User Story:** As a developer, I want support for modern JavaScript syntax including optional chaining and fallbacks with KubernetesRef objects, so that I can write robust expressions that handle missing data gracefully.

#### Acceptance Criteria

1. ✅ WHEN I use optional chaining with KubernetesRef objects (`kubernetesRef?.prop?.field`) THEN it SHALL convert to Kro's conditional CEL expressions with `?` operator
2. ✅ WHEN I use logical OR fallbacks with KubernetesRef objects (`kubernetesRef || defaultValue`) THEN it SHALL convert to appropriate CEL conditionals
3. ✅ WHEN I use nullish coalescing with KubernetesRef objects (`kubernetesRef ?? defaultValue`) THEN it SHALL convert to CEL null-checking expressions
4. ✅ WHEN I write conditional expressions containing KubernetesRef objects (`kubernetesRef ? true : false`) THEN they SHALL convert to CEL ternary operators
5. ✅ WHEN I use complex nested expressions with KubernetesRef objects THEN they SHALL maintain proper precedence and evaluation order

### Requirement 2: Documentation Structure and Organization

**User Story:** As a developer, I want TypeKro documentation to be well-organized with clear sections for JavaScript expressions, so that I can easily find information about the modern syntax.

#### Acceptance Criteria

1. WHEN I visit the documentation THEN there SHALL be a dedicated page explaining JavaScript-to-CEL conversion with comprehensive examples
2. WHEN I look for migration guidance THEN there SHALL be clear before/after examples showing the transformation from CEL to JavaScript
3. WHEN I need to understand limitations THEN there SHALL be documented edge cases and workarounds for JavaScript-to-CEL conversion
4. WHEN I need explicit CEL control THEN there SHALL be documented escape hatches for advanced CEL usage
5. WHEN I'm learning TypeKro THEN the getting started guide SHALL use JavaScript expressions as the primary teaching approach

### Requirement 5: Resource Reference Integration (IMPLEMENTED)

**User Story:** As a developer, I want JavaScript expressions that reference other resources to automatically work with TypeKro's reference system, so that dependencies are tracked correctly.

#### Acceptance Criteria

1. ✅ WHEN I reference resource fields in expressions THEN dependencies SHALL be tracked automatically
2. ✅ WHEN I use resource references in complex expressions THEN the reference resolution SHALL work correctly
3. ✅ WHEN resources are not available THEN expressions SHALL handle the missing references gracefully
4. ✅ WHEN circular dependencies are created THEN the system SHALL detect and report them
5. ✅ WHEN resource types change THEN expression validation SHALL catch type mismatches

### Requirement 6: Factory Pattern Integration (IMPLEMENTED)

**User Story:** As a developer, I want JavaScript expressions to work seamlessly with both direct and Kro factory patterns, so that I can use the same expression syntax regardless of deployment strategy.

#### Acceptance Criteria

1. ✅ WHEN using direct factory pattern THEN JavaScript expressions SHALL be evaluated at deployment time with resolved dependencies
2. ✅ WHEN using Kro factory pattern THEN JavaScript expressions SHALL be converted to CEL expressions for runtime evaluation
3. ✅ WHEN switching between factory patterns THEN the same JavaScript expressions SHALL work without modification
4. ✅ WHEN expressions depend on resource references THEN the appropriate resolution strategy SHALL be used based on factory type
5. ✅ WHEN factory patterns are mixed THEN expression evaluation SHALL be consistent across all resources

### Requirement 7: Magic Proxy System Integration (IMPLEMENTED)

**User Story:** As a developer, I want JavaScript expressions to work seamlessly with TypeKro's magic proxy system (SchemaProxy and ResourcesProxy), so that I can write natural expressions that reference schema fields and resource status without understanding the underlying KubernetesRef system.

#### Acceptance Criteria

1. ✅ WHEN I write expressions using schema references (schema.spec.field) THEN the system SHALL detect the KubernetesRef objects and convert them appropriately
2. ✅ WHEN I write expressions using resource references (resources.name.status.field) THEN the system SHALL detect the KubernetesRef objects and convert them appropriately
3. ✅ WHEN expressions contain KubernetesRef objects THEN they SHALL be automatically identified as requiring conversion
4. ✅ WHEN expressions contain only static values THEN they SHALL be left unchanged for performance
5. ✅ WHEN KubernetesRef objects are nested in complex expressions THEN the entire expression SHALL be analyzed and converted

### Requirement 8: MagicAssignable Type Integration (IMPLEMENTED)

**User Story:** As a developer, I want JavaScript expressions to work with MagicAssignable and MagicAssignableShape types, so that I can use natural expressions anywhere these types are accepted.

#### Acceptance Criteria

1. ✅ WHEN MagicAssignable types contain KubernetesRef objects THEN they SHALL be automatically converted to appropriate CEL expressions
2. ✅ WHEN MagicAssignableShape types contain KubernetesRef objects THEN all expressions SHALL be analyzed and converted consistently
3. ✅ WHEN expressions are used in MagicAssignable contexts THEN type safety SHALL be preserved throughout the conversion
4. ✅ WHEN MagicAssignable types are serialized THEN expressions with KubernetesRef objects SHALL be properly converted to CEL for Kro compatibility
5. ✅ WHEN MagicAssignable types are used in direct deployment THEN expressions SHALL be evaluated with resolved dependencies

### Requirement 9: Field Hydration Strategy Integration (IMPLEMENTED)

**User Story:** As a developer, I want JavaScript expressions to integrate seamlessly with TypeKro's field hydration strategy, so that status fields are properly populated regardless of expression complexity.

#### Acceptance Criteria

1. ✅ WHEN status builders use JavaScript expressions with KubernetesRef objects THEN field hydration SHALL work correctly with converted CEL expressions
2. ✅ WHEN expressions reference resource status fields through KubernetesRef objects THEN hydration SHALL occur in the correct dependency order
3. ✅ WHEN field hydration fails THEN JavaScript expressions SHALL handle missing or null values gracefully
4. ✅ WHEN using optional chaining with KubernetesRef objects THEN field hydration SHALL respect the conditional evaluation
5. ✅ WHEN expressions are complex THEN field hydration performance SHALL remain acceptable

### Requirement 10: Enhanced Type Optionality Support (IMPLEMENTED)

**User Story:** As a developer, I want JavaScript expressions to handle the reality that Enhanced type fields might be undefined at runtime despite appearing non-optional at compile time, so that my expressions work correctly during field hydration.

#### Acceptance Criteria

1. ✅ WHEN Enhanced types use NonOptional<TStatus> but fields are undefined at runtime THEN expressions SHALL handle the undefined values gracefully
2. ✅ WHEN KubernetesRef objects resolve to undefined values during field hydration THEN CEL expressions SHALL use appropriate null-safe operators
3. ✅ WHEN optional chaining is used with Enhanced type fields THEN it SHALL work correctly even though TypeScript shows them as non-optional
4. ✅ WHEN expressions access potentially undefined Enhanced fields THEN the system SHALL automatically add null-safety to generated CEL expressions
5. ✅ WHEN field hydration completes THEN expressions SHALL work with the actual populated values

### Requirement 11: Context-Aware Conversion (IMPLEMENTED)

**User Story:** As a developer, I want the JavaScript-to-CEL conversion to work appropriately in different contexts, so that the same expression syntax works everywhere it's needed.

#### Acceptance Criteria

1. ✅ WHEN expressions are used in status builders THEN they SHALL convert to status CEL expressions
2. ✅ WHEN expressions are used in resource builders with references THEN they SHALL convert to resource CEL expressions
3. ✅ WHEN expressions are used in conditional resource inclusion THEN they SHALL convert to condition CEL expressions
4. ✅ WHEN expressions are used in different contexts THEN type checking SHALL be context-appropriate
5. ✅ WHEN context cannot be determined THEN clear error messages SHALL guide the developer

### Requirement 12: Error Handling and Debugging (IMPLEMENTED)

**User Story:** As a developer, I want clear error messages and debugging capabilities when JavaScript-to-CEL conversion fails, so that I can quickly identify and fix issues.

#### Acceptance Criteria

1. ✅ WHEN JavaScript parsing fails THEN error messages SHALL include line and column information
2. ✅ WHEN CEL conversion fails THEN the error SHALL include the original JavaScript expression
3. ✅ WHEN unsupported expressions are used THEN alternatives SHALL be suggested
4. ✅ WHEN runtime CEL errors occur THEN they SHALL map back to original JavaScript source locations
5. ✅ WHEN debugging THEN I SHALL be able to inspect both JavaScript and generated CEL expressions

### Requirement 13: Performance and Caching (IMPLEMENTED)

**User Story:** As a developer, I want JavaScript-to-CEL conversion to be fast and not impact build performance, so that I can use it extensively without performance concerns.

#### Acceptance Criteria

1. ✅ WHEN expressions are analyzed THEN parsing SHALL be cached for repeated expressions
2. ✅ WHEN large numbers of expressions are converted THEN performance SHALL remain acceptable
3. ✅ WHEN expressions are simple THEN conversion overhead SHALL be minimal
4. ✅ WHEN expressions are complex THEN conversion time SHALL be reasonable
5. ✅ WHEN memory usage grows THEN caches SHALL be managed appropriately

### Requirement 14: Type Safety Integration (IMPLEMENTED)

**User Story:** As a developer, I want full TypeScript type safety throughout JavaScript expressions, so that I can catch errors at compile time.

#### Acceptance Criteria

1. ✅ WHEN I write expressions THEN TypeScript SHALL provide autocomplete for available fields
2. ✅ WHEN I make type errors THEN TypeScript compiler SHALL catch them before CEL conversion
3. ✅ WHEN I refactor types THEN TypeScript SHALL highlight affected expressions
4. ✅ WHEN expressions reference resources THEN types SHALL be inferred from resource schemas
5. ✅ WHEN CEL conversion changes types THEN TypeScript SHALL reflect the correct result types

### Requirement 15: TypeScript Compilation Consistency (IMPLEMENTED)

**User Story:** As a developer, I want the TypeScript compilation process to catch the same errors that my IDE catches, so that I can rely on the build process to validate my code before runtime and prevent JavaScript-to-CEL conversion issues.

#### Acceptance Criteria

1. ✅ WHEN the IDE shows a TypeScript error THEN the `bun run typecheck` commands SHALL also catch and report the same error
2. ✅ WHEN I run `bun run typecheck:tests` THEN it SHALL catch type errors in test files that the IDE identifies
3. ✅ WHEN I run `bun run typecheck:lib` THEN it SHALL catch type errors in library files that the IDE identifies
4. ✅ WHEN there are type errors THEN the build process SHALL fail before attempting JavaScript-to-CEL conversion
5. ✅ WHEN TypeScript configuration changes THEN both IDE and build process SHALL use the same configuration for JavaScript-to-CEL validation

### Requirement 16: Nested Composition Function Resolution (IMPLEMENTED)

**User Story:** As a developer, I want to use kubernetesComposition functions within other kubernetesComposition functions with JavaScript expressions, so that I can create reusable composition patterns with natural JavaScript syntax that gets converted to CEL.

#### Acceptance Criteria

1. ✅ WHEN I define a kubernetesComposition function THEN it SHALL be callable from within other composition functions without proxy interference
2. ✅ WHEN I call a nested composition function THEN it SHALL execute as a normal function, not as a ProxyObject
3. ✅ WHEN nested compositions use JavaScript expressions THEN they SHALL be converted to CEL correctly
4. ✅ WHEN nested compositions reference each other with JavaScript expressions THEN the cross-references SHALL resolve and convert to CEL properly
5. ✅ WHEN nested compositions are serialized THEN JavaScript expressions SHALL be converted to valid CEL in the resulting YAML

### Requirement 17: Composition Function Type Safety with JavaScript Expressions (IMPLEMENTED)

**User Story:** As a developer, I want full type safety when using nested compositions with JavaScript expressions, so that I can catch errors at compile time and have proper IntelliSense support for JavaScript-to-CEL conversion.

#### Acceptance Criteria

1. ✅ WHEN I call a nested composition function with JavaScript expressions THEN TypeScript SHALL provide proper type checking for parameters
2. ✅ WHEN I access properties on nested composition results in JavaScript expressions THEN TypeScript SHALL provide autocomplete and type validation
3. ✅ WHEN there are type mismatches in nested compositions with JavaScript expressions THEN TypeScript SHALL report clear error messages
4. ✅ WHEN I refactor composition interfaces THEN TypeScript SHALL catch all affected nested usages with JavaScript expressions
5. ✅ WHEN composition functions with JavaScript expressions are used incorrectly THEN the error messages SHALL be actionable and specific

### Requirement 18: Proxy System Integration with Nested Compositions (IMPLEMENTED)

**User Story:** As a developer, I want the magic proxy system to work correctly with nested compositions and JavaScript expressions, so that resource references and schema access work seamlessly across composition boundaries with automatic CEL conversion.

#### Acceptance Criteria

1. ✅ WHEN nested compositions use schema references in JavaScript expressions THEN the proxy system SHALL resolve them correctly and convert to CEL
2. ✅ WHEN nested compositions reference resources from parent compositions in JavaScript expressions THEN the references SHALL work correctly and convert to CEL
3. ✅ WHEN the proxy system encounters composition functions THEN it SHALL not interfere with their execution or JavaScript expression analysis
4. ✅ WHEN composition functions with JavaScript expressions are serialized THEN proxy objects SHALL not interfere with the CEL conversion process
5. ✅ WHEN debugging composition issues with JavaScript expressions THEN proxy behavior SHALL be transparent and not confusing

## Success Criteria

### Core Functionality (IMPLEMENTED ✅)
- ✅ Developers can write natural JavaScript expressions throughout TypeKro without understanding KubernetesRef objects
- ✅ **Magic proxy integration**: Automatic detection and conversion of expressions containing KubernetesRef objects from SchemaProxy and ResourcesProxy
- ✅ **Factory pattern integration**: Same JavaScript expressions work seamlessly with both direct and Kro factory patterns through different KubernetesRef handling strategies
- ✅ **MagicAssignable integration**: JavaScript expressions work naturally with MagicAssignable and MagicAssignableShape types through KubernetesRef detection
- ✅ **Field hydration integration**: JavaScript expressions integrate properly with TypeKro's field hydration strategy by tracking KubernetesRef dependencies
- ✅ **Performance optimization**: Static values (no KubernetesRef objects) are left unchanged for optimal performance
- ✅ **TypeScript compilation consistency**: IDE and build process TypeScript error reporting is consistent for JavaScript expressions
- ✅ **Nested composition support**: Nested composition functions work correctly with JavaScript expressions without proxy interference
- ✅ **Composition type safety**: Complex composition patterns with JavaScript expressions can be built and tested reliably with full type safety
- ✅ Error messages are clear and actionable, mapping back to original JavaScript expressions
- ✅ Full TypeScript type safety is maintained throughout the magic proxy system
- ✅ Integration with existing TypeKro features is seamless

### Documentation and Examples (PRIORITY 🎯)
- 📝 All documentation examples use natural JavaScript expressions instead of explicit CEL
- 📝 Tutorial carousel demonstrates JavaScript-to-CEL conversion as the primary approach
- 📝 Getting started guide teaches JavaScript expressions first, CEL as advanced topic
- 📝 Migration guide shows clear before/after transformations from CEL to JavaScript
- 📝 Comprehensive documentation page explaining JavaScript-to-CEL conversion
- 📝 Clear documentation of limitations and escape hatches for explicit CEL usage
- 📝 All example files demonstrate modern JavaScript syntax patterns
- 📝 API documentation shows JavaScript expressions as primary examples with CEL as alternatives

## Documentation Transformation Examples

### Status Builder Documentation Update
```typescript
// OLD DOCUMENTATION (needs updating):
const webapp = toResourceGraph(
  definition,
  (schema) => ({ /* resources */ }),
  (schema, resources) => ({
    ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
    url: Cel.template('http://%s', resources.service.status.loadBalancer.ingress[0].ip)
  })
);

// NEW DOCUMENTATION (modern approach):
const webapp = toResourceGraph(
  definition,
  (schema) => ({ /* resources */ }),
  (schema, resources) => ({
    // ✨ Natural JavaScript - automatically converted to CEL
    ready: resources.deployment.status.readyReplicas > 0,
    url: `http://${resources.service.status.loadBalancer.ingress[0].ip}`
  })
);
```

### Resource Builder Documentation Update
```typescript
// OLD DOCUMENTATION (needs updating):
const app = simpleDeployment({
  name: 'api',
  image: 'node',
  env: {
    DATABASE_URL: Cel.template('postgres://user:pass@%s:5432/mydb', database.status.podIP)
  }
});

// NEW DOCUMENTATION (modern approach):
const app = simpleDeployment({
  name: 'api',
  image: 'node',
  env: {
    // ✨ Natural JavaScript - automatically converted to CEL when needed
    DATABASE_URL: `postgres://user:pass@${database.status.podIP}:5432/mydb`
  }
});
```

### Files That Need Documentation Updates

Based on the search results, these files contain explicit CEL expressions that should be updated:

**Documentation Files:**
- `docs/examples/multi-environment.md` - 25+ Cel.expr/template calls
- `docs/examples/basic-patterns.md` - 10+ Cel.expr/template calls  
- `docs/api/types.md` - 3 Cel.expr/template examples
- `docs/examples/monitoring.md` - 5+ Cel.expr calls
- `docs/api/cel.md` - Entire page focused on explicit CEL (needs restructuring)

**Example Files:**
- `examples/imperative-composition.ts` - 8+ Cel.expr/template calls
- `examples/complete-webapp.ts` - 15+ Cel.expr/template calls
- `examples/comprehensive-k8s-resources.ts` - 2 Cel.expr calls
- `examples/hero-example.ts` - 1 Cel.expr call
- `examples/basic-webapp.ts` - 2 Cel.expr/template calls
- `examples/javascript-expressions.ts` - Mixed old/new patterns (needs cleanup)
- `examples/helm-integration.ts` - 10+ Cel.expr/template calls

### Factory Pattern Integration
```typescript
// Same JavaScript expressions work with both factory patterns
const graph = toResourceGraph(definition, resourceBuilder, statusBuilder);

// Direct factory - expressions evaluated at deployment time
const directFactory = await graph.factory('direct', { namespace: 'prod' });
await directFactory.deploy(); // JavaScript expressions evaluated with resolved dependencies

// Kro factory - expressions converted to CEL for runtime evaluation
const kroFactory = await graph.factory('kro', { namespace: 'prod' });
await kroFactory.deploy(); // JavaScript expressions converted to CEL expressions
```

### Magic Proxy System Integration
```typescript
// The magic proxy system makes schema.spec.name and resources.database.status.podIP 
// return KubernetesRef objects at runtime, which the analyzer detects and converts

const deployment = simpleDeployment({
  name: schema.spec.name, // KubernetesRef { resourceId: '__schema__', fieldPath: 'spec.name' }
  replicas: schema.spec.replicas > 10 ? 10 : schema.spec.replicas, // Contains KubernetesRef - auto-converted
  env: {
    NODE_ENV: 'production', // Static string - no conversion needed
    DATABASE_URL: `postgres://user:pass@${database.status.podIP}:5432/mydb`, // Contains KubernetesRef - auto-converted
    REDIS_URL: redis.status?.ready ? `redis://${redis.status.podIP}:6379` : 'redis://localhost:6379' // Contains KubernetesRef - auto-converted
  }
});

// The analyzer detects KubernetesRef objects in expressions and converts them:
// - For Kro factory: Converts to CEL expressions like ${resources.database.status.podIP}
// - For direct factory: Resolves KubernetesRef to actual values before evaluating expression
```

### Field Hydration Integration
```typescript
// Status builders with complex expressions and field hydration
const webapp = toResourceGraph(
  definition,
  (schema) => ({ deployment, service, ingress }),
  (schema, resources) => ({
    // The resources proxy returns KubernetesRef objects that the analyzer detects
    ready: resources.deployment.status?.readyReplicas > 0 && 
           resources.service.status?.ready &&
           resources.ingress.status?.loadBalancer?.ingress?.length > 0,
    // Dependencies detected: ['deployment', 'service', 'ingress']
    
    // Optional chaining with KubernetesRef objects
    url: resources.ingress.status?.loadBalancer?.ingress?.[0]?.ip 
         ? `https://${resources.ingress.status.loadBalancer.ingress[0].ip}`
         : 'pending',
    // Dependencies detected: ['ingress']
    
    // Complex expressions with KubernetesRef objects maintain dependency tracking
    health: {
      deployment: resources.deployment.status?.conditions?.find(c => c.type === 'Available')?.status === 'True',
      service: resources.service.status?.ready ?? false,
      ingress: resources.ingress.status?.loadBalancer?.ingress?.length > 0
    }
    // Dependencies detected: ['deployment', 'service', 'ingress']
  })
);

// The field hydration system uses the detected dependencies to ensure proper ordering
```

### Advanced Expression Support
```typescript
// Complex expressions with optional chaining and fallbacks
const status = {
  ready: deployment.status?.readyReplicas > 0 && service.status?.ready,
  url: service.status?.loadBalancer?.ingress?.[0]?.ip || 'pending',
  replicas: deployment.status?.readyReplicas ?? 0,
  phase: deployment.status?.conditions?.find(c => c.type === 'Available')?.status === 'True' ? 'Ready' : 'Pending'
};
```

### Nested Composition with JavaScript Expressions
```typescript
// Before: Complex manual CEL expressions in nested compositions
const createDatabase = kubernetesComposition(
  {
    name: 'database',
    apiVersion: 'example.com/v1',
    kind: 'Database',
    spec: type({ name: 'string', storage: 'string' }),
    status: type({ ready: 'boolean', host: 'string', connectionString: 'string' })
  },
  (spec) => {
    const db = simple.Deployment({ name: `${spec.name}-db`, image: 'postgres:13' });
    const service = simple.Service({ name: `${spec.name}-db`, ports: [{ port: 5432 }] });
    return {
      ready: Cel.expr<boolean>(db.status.readyReplicas, ' > 0'),
      host: service.status.clusterIP,
      connectionString: Cel.template('postgres://user:pass@%s:5432/%s', service.status.clusterIP, spec.name)
    };
  }
);

// After: Natural JavaScript expressions that get converted to CEL
const createDatabase = kubernetesComposition(
  {
    name: 'database',
    apiVersion: 'example.com/v1',
    kind: 'Database',
    spec: type({ name: 'string', storage: 'string' }),
    status: type({ ready: 'boolean', host: 'string', connectionString: 'string' })
  },
  (spec) => {
    const db = simple.Deployment({ name: `${spec.name}-db`, image: 'postgres:13' });
    const service = simple.Service({ name: `${spec.name}-db`, ports: [{ port: 5432 }] });
    return {
      // JavaScript expressions automatically converted to CEL
      ready: db.status.readyReplicas > 0,
      host: service.status.clusterIP,
      connectionString: `postgres://user:pass@${service.status.clusterIP}:5432/${spec.name}`
    };
  }
);

// Nested composition usage with JavaScript expressions
const createApp = kubernetesComposition(
  {
    name: 'app-with-db',
    apiVersion: 'example.com/v1',
    kind: 'AppWithDB',
    spec: type({ name: 'string', dbStorage: 'string' }),
    status: type({ ready: 'boolean', url: 'string', database: { ready: 'boolean' } })
  },
  (spec) => {
    // This should work - createDatabase should be callable, not a ProxyObject
    const database = createDatabase({ name: spec.name, storage: spec.dbStorage });
    
    const app = simple.Deployment({
      name: spec.name,
      image: 'node:16',
      env: {
        // JavaScript expressions with nested composition references
        DATABASE_URL: database.connectionString,
        DATABASE_READY: database.ready ? 'true' : 'false',
        DATABASE_HOST: database.host
      }
    });
    
    return {
      // JavaScript expressions automatically converted to CEL
      ready: app.status.readyReplicas > 0 && database.ready,
      url: `http://${app.status.podIP}:3000`,
      database: { ready: database.ready }
    };
  }
);
```

### TypeScript Compilation Consistency
```typescript
// These type errors should be caught by both IDE and build process
const problematicCall = someFunction(stringValue); // Should fail: Argument of type 'string' is not assignable to parameter of type 'never'

// Build process should catch this before JavaScript-to-CEL conversion
const invalidExpression = resources.nonexistent.status.ready; // Should fail: Property 'nonexistent' does not exist
```

## Non-Functional Requirements

- **Performance**: Expression analysis should add minimal overhead to build times
- **Type Safety**: Complete TypeScript integration with proper type inference
- **Usability**: Error messages should be clear and suggest solutions
- **Compatibility**: Must work with all existing TypeKro features and patterns
- **Reliability**: Conversion should be deterministic and consistent
- **Debugging**: Clear mapping between JavaScript source and generated CEL expressions

## Integration Points

This feature integrates with:
- **SchemaProxy system** - detects KubernetesRef objects from `schema.spec.field` and `schema.status.field` access
- **ResourcesProxy system** - detects KubernetesRef objects from `resources.name.status.field` access in status builders
- **Status builders** in `toResourceGraph` - analyzes expressions containing KubernetesRef objects for both direct and Kro factory patterns
- **Resource builders** - analyzes expressions containing KubernetesRef objects from schema or resource references
- **MagicAssignable and MagicAssignableShape types** - detects KubernetesRef objects throughout the TypeKro API
- **Field hydration strategy** - tracks KubernetesRef dependencies for proper status field population order
- **Direct factory pattern** - resolves KubernetesRef objects to actual values before expression evaluation
- **Kro factory pattern** - converts KubernetesRef objects to CEL expressions for runtime evaluation
- **Conditional resource inclusion** (`includeWhen` expressions) - handles KubernetesRef objects in conditions
- **Resource readiness checks** (`readyWhen` expressions) - handles KubernetesRef objects in readiness expressions
- **TypeScript Configuration** - `tsconfig.json`, `tsconfig.test.json`, `tsconfig.examples.json` for consistent compilation
- **Build Scripts** - `package.json` scripts for typecheck commands that must catch the same errors as IDE
- **Composition System** - `kubernetesComposition` function and nested composition patterns with JavaScript expressions
- **Serialization System** - Resource graph serialization and YAML generation with CEL conversion
- **Test Framework** - Integration test execution and validation of JavaScript-to-CEL conversion
- **CI/CD Pipeline** - Build and test validation processes that must catch type errors consistently
- **Any other context** where KubernetesRef objects from magic proxy system are used

## Scope Limitations

This spec does **not** include:
- Changes to the core magic proxy system (SchemaProxy, ResourcesProxy, KubernetesRef)
- Modifications to CEL evaluation engine
- Changes to the factory pattern system architecture
- New TypeKro APIs (only enhances existing ones)
- Performance optimizations (focus is on correctness)

This spec **does** include:
- Fixing TypeScript compilation consistency issues that block JavaScript-to-CEL conversion
- Resolving nested composition proxy issues that prevent JavaScript expressions from working
- Ensuring the build process catches the same type errors as the IDE
- Making nested composition functions callable instead of being treated as ProxyObjects

The focus is on detecting KubernetesRef objects in JavaScript expressions, converting them to appropriate CEL expressions for the target deployment strategy, and fixing the infrastructure issues that prevent this conversion from working correctly.