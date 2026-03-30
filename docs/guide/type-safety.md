---
title: Type Safety Patterns
description: Working with TypeKro's type system in compositions
---

# Type Safety Patterns

TypeKro uses strict TypeScript (`exactOptionalPropertyTypes: true`) to catch configuration errors at compile time. This page covers patterns for working with the type system in compositions.

## The Composable&lt;T&gt; Utility Type

When writing compositions, you pass values from the spec proxy to factory functions. Optional spec fields return `T | undefined`, but factory interfaces use strict `T?` (which doesn't accept `undefined` with `exactOptionalPropertyTypes`).

`Composable<T>` bridges this gap:

```typescript
import type { Composable } from 'typekro';

// Factory interface stays clean and strict
interface ClusterConfig {
  name: string;           // required — must be provided
  namespace?: string;     // optional — can be omitted
  spec: {
    instances?: number;   // optional — can be omitted
    storage: {
      size: string;       // required — must be provided
    };
  };
}

// Factory function accepts the composable version
function cluster(config: Composable<ClusterConfig>) { ... }
```

### What Composable does

| Field type | Before | After `Composable<T>` |
|-----------|--------|----------------------|
| `name: string` (required) | Must be `string` | Still must be `string` |
| `namespace?: string` (optional) | Can be absent, but if present must be `string` | Can be absent, OR present with `string \| undefined` |
| `spec: { ... }` (required object) | Must be present | Still must be present, recurses into children |
| `string[]` (array) | Stays as-is | Stays as-is (no recursion into arrays) |

### Why it's needed

In a `kubernetesComposition`, the spec is a magic proxy. Accessing an optional field returns `T | undefined`:

```typescript
const myComposition = kubernetesComposition({ ... }, (spec) => {
  // spec.database.instances is number | undefined (optional field)
  // spec.database.storageSize is string (required field)

  // Without Composable — TYPE ERROR:
  // cluster({ spec: { instances: spec.database.instances } })
  //                               ^^^^^^^^^^^^^^^^^^^^^^
  //   Type 'number | undefined' not assignable to 'number'

  // With Composable — works:
  cluster({
    name: `${spec.name}-db`,
    spec: {
      instances: spec.database.instances,  // number | undefined — OK
      storage: { size: spec.database.storageSize },  // string — OK
    },
  });
});
```

### For integration authors

When building a TypeKro integration, apply `Composable<T>` to your factory function parameter:

```typescript
import type { Composable, Enhanced } from 'typekro';
import type { MyConfig, MyStatus } from './types.js';

function createMyResource(
  config: Composable<MyConfig>  // ← accepts proxy values
): Enhanced<MyConfig['spec'], MyStatus> {
  // ...
}
```

The interface definition (`MyConfig`) stays clean — `Composable` is only applied at the call boundary.

### Nested compositions

When calling one composition from inside another (nested composition), the called composition's spec type comes from its ArkType schema and doesn't use `Composable`. For optional fields in nested composition calls, use conditional inclusion:

```typescript
// Inside a composition
const _inngest = inngestBootstrap(Object.assign(
  {
    name: `${spec.name}-inngest`,
    inngest: { eventKey: spec.eventKey, signingKey: spec.signingKey },
  },
  // Only include replicaCount if it has a value
  spec.replicas !== undefined && { replicaCount: spec.replicas },
));
```

This is a known limitation — tracked for improvement in the core `kubernetesComposition` API.
