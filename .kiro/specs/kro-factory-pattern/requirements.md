# Kro Factory Pattern Requirements

## Introduction

This feature will enable TypeKro to create reusable, composable resource factories with typed input/output schemas. Developers will be able to define resource templates as factories that accept typed inputs and return typed outputs, enabling powerful composition patterns for complex infrastructure.

## Requirements

### Requirement 1: Typed Resource Factory Creation

**User Story:** As a developer, I want to create reusable resource factories with typed input and output schemas, so that I can build composable infrastructure components.

#### Acceptance Criteria

1. WHEN I call `getKroFactory<TInput, TOutput>(resourceGraph)` THEN I SHALL get a typed factory function
2. WHEN I define input schema THEN the factory SHALL only accept inputs matching that schema
3. WHEN I define output schema THEN the factory SHALL return outputs matching that schema
4. WHEN I use the factory THEN TypeScript SHALL provide full type safety and autocomplete
5. IF input doesn't match schema THEN the system SHALL provide clear validation errors

### Requirement 2: Factory Input Schema Validation

**User Story:** As a developer, I want my factory inputs to be validated against a schema, so that I can catch configuration errors early.

#### Acceptance Criteria

1. WHEN I define an input schema using Arktype THEN the factory SHALL validate inputs at runtime
2. WHEN input validation fails THEN the system SHALL provide detailed error messages
3. WHEN I pass valid inputs THEN the factory SHALL proceed without errors
4. WHEN I use TypeScript THEN input types SHALL be inferred from the schema
5. WHEN I use IDE features THEN autocomplete SHALL work for input properties

### Requirement 3: Factory Output Schema Definition

**User Story:** As a developer, I want to define what outputs my factory provides, so that other factories can depend on them with type safety.

#### Acceptance Criteria

1. WHEN I define an output schema THEN the factory SHALL return values matching that schema
2. WHEN I access factory outputs THEN TypeScript SHALL know the exact types
3. WHEN I use outputs in other factories THEN type checking SHALL work correctly
4. WHEN outputs are not ready THEN the system SHALL handle pending states appropriately
5. WHEN I serialize outputs THEN they SHALL be properly represented in Kro YAML

### Requirement 4: Async Factory Application

**User Story:** As a developer, I want to apply factories asynchronously, so that I can handle resource creation timing and dependencies properly.

#### Acceptance Criteria

1. WHEN I call `factory.apply(inputs)` THEN I SHALL get a Promise of typed outputs
2. WHEN factory application succeeds THEN the Promise SHALL resolve with typed outputs
3. WHEN factory application fails THEN the Promise SHALL reject with detailed error information
4. WHEN I await factory results THEN I SHALL get properly typed output objects
5. WHEN multiple factories are applied THEN they SHALL be able to run in parallel or sequence

### Requirement 5: Factory Composition and Dependencies

**User Story:** As a developer, I want to compose factories together using outputs from one as inputs to another, so that I can build complex infrastructure from simple components.

#### Acceptance Criteria

1. WHEN I use one factory's output as another's input THEN the system SHALL handle the dependency
2. WHEN I compose factories THEN TypeScript SHALL validate that output types match input types
3. WHEN dependencies exist THEN the system SHALL ensure proper execution order
4. WHEN I create dependency chains THEN the system SHALL detect and prevent cycles
5. WHEN I serialize composed factories THEN the Kro YAML SHALL represent all dependencies

### Requirement 6: Resource Graph Integration

**User Story:** As a developer, I want my factories to work with existing TypeKro resource graphs, so that I can leverage all existing functionality.

#### Acceptance Criteria

1. WHEN I create a factory from a resource graph THEN it SHALL support all existing TypeKro features
2. WHEN I use CEL expressions in factory resources THEN they SHALL work correctly
3. WHEN I use cross-resource references THEN they SHALL be properly handled
4. WHEN I serialize factory output THEN it SHALL produce valid Kro ResourceGraphDefinition YAML
5. WHEN I validate factory resources THEN existing validation SHALL work

### Requirement 7: Type-Safe Factory Chaining

**User Story:** As a developer, I want to chain factories together in a type-safe way, so that I can build complex infrastructure with confidence.

#### Acceptance Criteria

1. WHEN I chain factories THEN TypeScript SHALL validate that types match at compile time
2. WHEN output types don't match input types THEN the compiler SHALL show clear errors
3. WHEN I use chained factories THEN IDE autocomplete SHALL work throughout the chain
4. WHEN I refactor factory schemas THEN TypeScript SHALL catch breaking changes
5. WHEN I use factory outputs THEN I SHALL get full type information

## Success Criteria

- Developers can create reusable infrastructure components as typed factories
- Factory composition enables building complex systems from simple parts
- Full TypeScript type safety throughout the factory system
- Seamless integration with existing TypeKro features
- Clear error messages for schema validation and type mismatches
- Performance suitable for typical infrastructure deployment scenarios

## Example Usage

```typescript
// Define schemas
const dbInputSchema = type({
  name: "string",
  storage: "string"
});

const dbOutputSchema = type({
  connectionString: "string",
  host: "string",
  port: "number"
});

const webInputSchema = type({
  name: "string", 
  dbConnectionString: "string"
});

const webOutputSchema = type({
  url: "string",
  replicas: "number"
});

// Create factories
const dbFactory = getKroFactory<dbInputSchema.infer, dbOutputSchema.infer>(postgresGraph);
const webappFactory = getKroFactory<webInputSchema.infer, webOutputSchema.infer>(webappGraph);

// Compose them together
const db = await dbFactory.apply({ name: "mydb", storage: "10Gi" });
const webapp = await webappFactory.apply({ 
  name: "myapp", 
  dbConnectionString: db.connectionString 
});

console.log(`App deployed at: ${webapp.url}`);
```

## Non-Functional Requirements

- **Performance**: Factory application should complete within reasonable time for typical resource graphs
- **Type Safety**: Full TypeScript type checking throughout the factory system
- **Usability**: API should feel natural and intuitive to TypeScript developers
- **Compatibility**: Must integrate seamlessly with existing TypeKro features
- **Reliability**: Schema validation should catch errors early and provide helpful messages