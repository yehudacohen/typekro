/**
 * Schema-related types extracted to break the circular dependency
 * between deployment.ts and serialization.ts.
 *
 * These types define schema inference, Kro-compatible type constraints,
 * and the schema proxy type used by both deployment and serialization modules.
 */

import type { Type } from 'arktype';
import type { SchemaMagicProxy } from './references.js';

// Re-export alchemy Scope type for compatibility
export type { Scope } from 'alchemy';

// =============================================================================
// ARKTYPE TYPE EXTRACTION
// =============================================================================

/**
 * Extracts the inferred TypeScript type from an ArkType Type<T>.
 * This is critical for proper type inference in kubernetesComposition.
 *
 * @example
 * const MySchema = type({ name: 'string', age: 'number' });
 * type Extracted = InferType<typeof MySchema>; // { name: string; age: number }
 */
export type InferType<T> = T extends Type<infer U> ? U : T;

// =============================================================================
// KRO COMPATIBLE TYPE CONSTRAINTS
// =============================================================================

/**
 * Helper type to decrement depth counter for recursive type depth limiting
 */
export type Prev<T extends number> = T extends 10
  ? 9
  : T extends 9
    ? 8
    : T extends 8
      ? 7
      : T extends 7
        ? 6
        : T extends 6
          ? 5
          : T extends 5
            ? 4
            : T extends 4
              ? 3
              : T extends 3
                ? 2
                : T extends 2
                  ? 1
                  : T extends 1
                    ? 0
                    : never;

/**
 * Base type for values that are compatible with Kro schemas
 */
export type KroCompatibleValue<Depth extends number = 10> = Depth extends 0
  ? never
  :
      | string
      | number
      | boolean
      | string[]
      | number[]
      | boolean[]
      | string[][] // Nested arrays
      | number[][]
      | boolean[][]
      | Record<string, string> // Maps of basic types
      | Record<string, number>
      | Record<string, boolean>
      | Record<string, string[]> // Maps of arrays
      | Record<string, number[]>
      | Record<string, boolean[]>
      | Record<string, string>[] // Arrays of maps
      | Record<string, number>[]
      | Record<string, boolean>[]
      | Record<string, Record<string, string>> // Nested maps
      | Record<string, Record<string, number>>
      | Record<string, Record<string, boolean>>
      | KroCompatibleType<Prev<Depth>>; // Nested objects (with depth limit)

/**
 * Constraint type for TypeScript types that can be used with Kro schemas.
 * Ensures only compatible types are used for spec and status,
 * with proper nesting support up to 10 levels deep.
 *
 * The `| object` union is necessary because named TypeScript interfaces
 * (e.g., `interface MySpec { name: string }`) lack index signatures and
 * are not assignable to `Record<string, KroCompatibleValue>`. ArkType's
 * `Type<T>` further constrains this at the type level, and runtime
 * validation catches non-serializable values.
 */
export type KroCompatibleType<Depth extends number = 10> = Depth extends 0
  ? never
  : Record<string, KroCompatibleValue<Depth>> | object;

// =============================================================================
// SCHEMA PROXY TYPE
// =============================================================================

/**
 * The user-facing type for a schema proxy. It enables type-safe
 * access to the spec and status fields of the CRD being defined.
 *
 * TSpec and TStatus should be compatible with Kro's Simple Schema format.
 * We use a looser constraint to preserve specific field types from ArkType schemas.
 */
export type SchemaProxy<TSpec extends object, TStatus extends object> = {
  spec: SchemaMagicProxy<TSpec>;
  status: SchemaMagicProxy<TStatus>;
};
