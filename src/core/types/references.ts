/**
 * Reference-related types for cross-resource references and CEL expressions
 */

import { TypeKroError } from '../errors.js';
import type { CelExpression, KubernetesRef, MagicAssignable } from './common.js';

export interface ResourceReference<_T = unknown> {
  readonly __type: 'ResourceReference';
  readonly resourceId: string;
  readonly fieldPath: string;
  readonly expectedType: string;
}

export type RefOrValue<T> = T | KubernetesRef<NonNullable<T>> | CelExpression<T>;

/**
 * Helper type to exclude undefined/null from a type for property access.
 * This helps SafePropertyAccess work correctly with optional unions.
 */
type ExcludeNullish<T> = T extends null | undefined ? never : T;

/**
 * Helper type for safe property access on union types and intersection types.
 * Distributes over unions and unwraps KubernetesRef to check the inner type.
 * Also handles intersection types like `{name: string} & KubernetesRef<...>`.
 *
 * This is critical for optional chaining on KubernetesRef-wrapped types.
 * When accessing properties through the MagicProxy index signature,
 * we need to check if the property exists in the UNWRAPPED type,
 * not just the wrapper's keys (__brand, resourceId, etc.).
 *
 * @example
 * SafePropertyAccess<{name: string} | undefined, 'name'> → string
 * SafePropertyAccess<KubernetesRef<{name: string} | undefined>, 'name'> → string
 * SafePropertyAccess<{name: string} & KubernetesRef<{name: string}>, 'name'> → string
 *
 * Flow for KubernetesRef<{name: string} | undefined>:
 * 1. Check if T extends KubernetesRef → YES, unwrap to U = {name: string} | undefined
 * 2. Distribute U: process {name: string} and undefined separately
 * 3. For {name: string}: 'name' extends keyof {name: string} → YES → return string
 * 4. For undefined: not an object → return never
 * 5. Union: string | never → string ✅
 *
 * Flow for {name: string} & KubernetesRef<{name: string}>:
 * 1. Distribute over union: single item, no distribution needed
 * 2. Check if extends KubernetesRef: NO (it's an intersection, not a pure KubernetesRef)
 * 3. Check if extends object: YES
 * 4. Check if 'name' extends keyof T: YES (intersections preserve properties)
 * 5. Return T['name'] → string ✅
 */
type SafePropertyAccess<T, K extends PropertyKey> = ExcludeNullish<T> extends infer NonNullT
  ? NonNullT extends any
    ? NonNullT extends KubernetesRef<infer U>
      ? // Pure KubernetesRef: unwrap and check inner type
        U extends any
        ? U extends object
          ? K extends keyof U
            ? U[K]
            : never
          : never
        : never
      : // Not a pure KubernetesRef, but could be intersection or plain object
        NonNullT extends object
        ? K extends keyof NonNullT
          ? NonNullT[K]
          : never
        : never
    : never
  : never;

/**
 * Helper to extract property keys from a union, distributing over each member.
 * For T = A | B | undefined:
 *   - keyof T = keyof A & keyof B & keyof undefined = never (intersection)
 *   - DistributiveKeys<T> = keyof A | keyof B (union, excluding undefined)
 */
type DistributiveKeys<T> = T extends undefined | null ? never : keyof T;

type DistributivePick<T, K extends PropertyKey> = SafePropertyAccess<T, K>;

/**
 * The "Magic Proxy" type. It contains all the real properties of the base type `T`.
 * At compile time, it presents the original types for seamless TypeScript experience.
 * At runtime, it creates KubernetesRef objects for cross-resource references.
 *
 * CRITICAL: We must distribute over unions to extract all possible keys.
 * keyof (A | B | undefined) = never, but DistributiveKeys<A | B | undefined> = keyof A | keyof B
 *
 * The magic here is that TypeScript sees the original types (T), allowing seamless use in
 * composition functions, while the runtime proxy handles the KubernetesRef conversion.
 */
/**
 * A proxy type that makes every known property of `T` assignable to
 * `MagicAssignable<T[K]>` (allowing literal values, `KubernetesRef`, or
 * `CelExpression`), while also accepting arbitrary string keys for
 * cross-composition status references.
 *
 * **Caveat**: Because of the catch-all index signature, typos on property
 * names will **not** produce compile-time errors — they will silently resolve
 * to `MagicAssignable<any>`. If you get unexpected runtime behavior, double-check
 * that your property names match the schema definition exactly.
 */
export type MagicProxy<T> = T & {
  // Distribute over union to get all possible keys, then map them to their types
  [P in DistributiveKeys<T> as P extends string ? P : never]: MagicAssignable<
    DistributivePick<T, P>
  >;
} & {
  /**
   * Catch-all index signature for dynamic property access.
   *
   * This MUST remain `MagicAssignable<any>` because it enables cross-composition
   * status references — e.g., `nestedComp.status.customField` where `customField`
   * is defined by the user's status schema, not a built-in K8s type. TypeScript
   * resolves known properties from `T & MappedType` above; only truly unknown
   * properties fall through to this index signature.
   *
   * Alternatives investigated and rejected:
   * - Branded error type: breaks ~40+ cross-composition references in tests/examples/production
   * - `MagicAssignable<unknown>`: produces unclear errors and breaks assignments
   * - `never`: is a bottom type assignable to everything, provides no safety
   */
  [key: string]: MagicAssignable<any>;
};

/**
 * Schema Magic Proxy type for schema proxies. At compile time, it preserves the original types
 * for seamless developer experience. At runtime, the proxy implementation returns KubernetesRef
 * objects for ALL property access (including known properties).
 * This is used specifically for schema proxies where every field access should create a reference.
 *
 * The magic here is that TypeScript sees the original types (T), allowing seamless use in
 * composition functions, while the runtime proxy handles the KubernetesRef conversion.
 */
export type SchemaMagicProxy<T> = {
  [K in keyof T]: T[K];
};

// =============================================================================
// REFERENCE RESOLUTION CONTEXT AND EVALUATION
// =============================================================================

// ResolutionContext moved to deployment.ts to avoid circular dependency

/**
 * Context for evaluating CEL expressions
 */
export interface CelEvaluationContext {
  resources: Map<string, unknown>;
  variables?: Record<string, unknown>;
  functions?: Record<string, (...args: unknown[]) => unknown>;
}

/**
 * Error thrown when CEL expression evaluation fails
 */
export class CelEvaluationError extends TypeKroError {
  constructor(expression: CelExpression, cause: Error) {
    super(
      `Failed to evaluate CEL expression '${expression.expression}': ${cause.message}`,
      'CEL_EVALUATION_ERROR',
      { expression: expression.expression, cause: cause.message }
    );
    this.name = 'CelEvaluationError';
    this.cause = cause;
  }
}
