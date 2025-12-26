---
title: ArkType Schemas
description: Write ArkType schemas for TypeKro spec and status definitions
---

# ArkType Schemas

ArkType provides TypeKro's schema system - compile-time TypeScript types that become runtime validators and OpenAPI schemas.

## Quick Example

```typescript
import { type } from 'arktype';

const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  'environment?': '"dev" | "staging" | "prod"'
});

// TypeScript infers: { name: string; image: string; replicas: number; environment?: "dev" | "staging" | "prod" }
```

## Primitive Types

```typescript
const BasicTypes = type({
  name: 'string',           // String values
  count: 'number',          // Numeric values (float)
  replicas: 'number%1',     // Integer (divisible by 1)
  enabled: 'boolean',       // Boolean values
});
```

## Objects and Nesting

```typescript
const AppSpec = type({
  name: 'string',
  database: {
    host: 'string',
    port: 'number%1',
    credentials: {
      username: 'string',
      password: 'string'
    }
  }
});
```

## Arrays

```typescript
const ArraySpec = type({
  tags: 'string[]',           // Array of strings
  ports: 'number[]',          // Array of numbers
  containers: [{              // Array of objects
    name: 'string',
    image: 'string'
  }]
});
```

## Optional Fields

```typescript
const FlexibleSpec = type({
  name: 'string',                      // Required
  'namespace?': 'string',              // Optional string
  'replicas?': 'number%1',             // Optional integer
  'config?': {                         // Optional nested object
    'timeout?': 'number%1'
  }
});
```

## Union Types (Enums)

```typescript
const EnvSpec = type({
  environment: '"development" | "staging" | "production"',
  logLevel: '"debug" | "info" | "warn" | "error"'
});
```

## Record Types

```typescript
const ConfigSpec = type({
  labels: 'Record<string, string>',
  env: 'Record<string, string>'
});
```

## Type Mappings

| ArkType | Kro Simple Schema |
|---------|-------------------|
| `'string'` | `string` |
| `'number'` | `integer` |
| `'number%1'` | `integer` |
| `'boolean'` | `boolean` |
| `'string[]'` | `[]string` |
| `'"a" \| "b"'` | `string \| enum="a,b"` |

## Real-World Example

```typescript
const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1',
  'port?': 'number%1',
  'environment?': '"development" | "staging" | "production"',
  'resources?': {
    'cpu?': 'string',
    'memory?': 'string'
  },
  'env?': 'Record<string, string>'
});

const WebAppStatus = type({
  ready: 'boolean',
  url: 'string',
  replicas: 'number%1',
  'message?': 'string'
});
```

## Validation

ArkType validates specs at runtime:

```typescript
// Valid - passes validation
await factory.deploy({ name: 'my-app', replicas: 3 });

// Invalid - ArkType throws validation error
await factory.deploy({ name: 'my-app', replicas: 'three' });
// Error: replicas must be a number (was string)
```

## Best Practices

```typescript
// ✅ Keep schemas focused
const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1'
});

// ✅ Use descriptive field names
const Config = type({
  databaseHost: 'string',
  apiTimeout: 'number%1'
});

// ✅ Group related fields
const AppSpec = type({
  metadata: { name: 'string', version: 'string' },
  deployment: { replicas: 'number%1', image: 'string' }
});
```

## Troubleshooting

**"Type is not assignable to KroCompatibleType"**
- Check all fields use supported basic types
- Ensure nested objects don't exceed 10 levels
- Verify union types use string literals only

**"Missing properties from MagicAssignableShape"**
- Ensure composition returns all status fields defined in schema

## Next Steps

- [kubernetesComposition](/api/kubernetes-composition) - Use schemas in compositions
- [Custom Integrations](/advanced/custom-integrations) - Build custom factories
