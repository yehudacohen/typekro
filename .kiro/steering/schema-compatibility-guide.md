# Schema Compatibility Guide

## Overview

This document describes what ArkType schema structures are compatible with TypeKro's `KroCompatibleType` constraint and provides examples of supported patterns.

## KroCompatibleType Constraint

The `KroCompatibleType` constraint ensures that schemas can be serialized to Kro's Simple Schema format. It supports:

### Basic Types
- `string`
- `number` 
- `boolean`

### Array Types
- `string[]`, `number[]`, `boolean[]`
- Nested arrays: `string[][]`, `number[][]`, `boolean[][]`

### Record Types
- `Record<string, string>`, `Record<string, number>`, `Record<string, boolean>`
- Records of arrays: `Record<string, string[]>`, `Record<string, number[]>`, `Record<string, boolean[]>`
- Arrays of records: `Record<string, string>[]`, `Record<string, number>[]`, `Record<string, boolean>[]`
- Nested records: `Record<string, Record<string, string>>`, etc.

### Nested Objects
- Recursive nesting up to 10 levels deep
- Each nested object must follow the same constraints

## Supported ArkType Schema Patterns

### ✅ Simple Nested Objects
```typescript
const StatusSchema = type({
  ready: 'boolean',
  endpoints: {
    api: 'string',
    ui: 'string',
  },
  metrics: {
    replicas: 'number',
    availability: 'number',
  },
});
```

### ✅ Deeply Nested Objects
```typescript
const DeepStatusSchema = type({
  application: {
    frontend: {
      status: 'string',
      url: 'string',
    },
    backend: {
      status: 'string',
      replicas: 'number',
    },
  },
  infrastructure: {
    database: {
      ready: 'boolean',
      connections: 'number',
    },
  },
});
```

### ✅ Optional Fields
```typescript
const SpecSchema = type({
  name: 'string',
  'namespace?': 'string', // Optional string
  config: {
    'enabled?': 'boolean', // Optional nested field
    'replicas?': 'number',
  },
});
```

### ✅ Union Types (Enums)
```typescript
const ConfigSchema = type({
  mode: '"development" | "production" | "test"',
  level: '"info" | "warn" | "error"',
});
```

### ❌ Unsupported Patterns

#### Complex Union Types
```typescript
// BAD - Complex unions not supported
const BadSchema = type({
  config: 'string | { nested: boolean }', // Not supported
});
```

#### Functions or Methods
```typescript
// BAD - Functions not supported
const BadSchema = type({
  callback: 'Function', // Not supported
});
```

#### Arbitrary Objects
```typescript
// BAD - Arbitrary objects without structure
const BadSchema = type({
  data: 'object', // Too generic, not supported
});
```

## Best Practices

### 1. Keep Nesting Reasonable
- Limit nesting to 3-4 levels for readability
- Use flat structures when possible

### 2. Use Descriptive Field Names
```typescript
// GOOD
const ConfigSchema = type({
  databaseUrl: 'string',
  apiTimeout: 'number',
});

// AVOID
const ConfigSchema = type({
  db: 'string',
  to: 'number',
});
```

### 3. Group Related Fields
```typescript
// GOOD - Logical grouping
const AppSchema = type({
  metadata: {
    name: 'string',
    version: 'string',
  },
  networking: {
    port: 'number',
    host: 'string',
  },
});
```

### 4. Use Optional Fields Appropriately
```typescript
const ConfigSchema = type({
  // Required core fields
  name: 'string',
  image: 'string',
  
  // Optional configuration
  'namespace?': 'string',
  'replicas?': 'number',
  
  // Optional nested configuration
  'security?': {
    'enabled?': 'boolean',
    'type?': '"basic" | "advanced"',
  },
});
```

## Validation

To validate that your schema is compatible:

1. **TypeScript Compilation**: The schema should compile without errors when used with `kubernetesComposition` or `toResourceGraph`
2. **Runtime Testing**: Create test cases that instantiate the schema with real data
3. **Serialization Testing**: Verify that the schema serializes to valid Kro YAML

## Examples from TypeKro Codebase

See these files for working examples:
- `test/core/imperative-composition.test.ts` - Nested status objects
- `test/core/new-api-comprehensive.test.ts` - Complex nested structures
- `src/factories/cilium/compositions/cilium-bootstrap.ts` - Real-world usage

## Status Expression Behavior

### Static vs Dynamic Fields

TypeKro distinguishes between static and dynamic status fields:

**Static Fields** (hydrated by TypeKro):
- Fields with literal values: `ready: true`
- Fields with spec references only: `version: spec.version`
- Fields with static expressions: `url: 'https://example.com'`

**Dynamic Fields** (sent to Kro as CEL expressions):
- Fields referencing resource status: `ready: deployment.status.readyReplicas > 0`
- Fields with resource-dependent expressions: `phase: deployment.status.phase === 'Ready' ? 'Ready' : 'Pending'`

### YAML Output Behavior

Only dynamic fields appear in the generated Kro YAML:
```yaml
# This appears in Kro YAML (dynamic)
status:
  ready: ${deployment.status.readyReplicas > 0}
  
# This does NOT appear in Kro YAML (static)
# version: "1.0.0"  # Hydrated directly by TypeKro
```

## Troubleshooting

### "Type is not assignable to KroCompatibleType"
- Check that all fields use supported basic types
- Ensure nested objects don't exceed reasonable depth
- Verify union types use string literals only

### "Missing properties from MagicAssignableShape"
- Ensure the composition function returns all fields defined in the status schema
- Check that nested objects in the return match the schema structure exactly

### "Argument not assignable to parameter type"
- Verify the spec parameter matches the expected interface
- Check for missing required fields in nested objects

### "Status fields not appearing in YAML"
- This is normal for static fields - they're hydrated by TypeKro
- Only fields referencing Kubernetes resources appear in Kro YAML
- Check logs for "Static fields will be hydrated directly" messages