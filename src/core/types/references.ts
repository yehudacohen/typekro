/**
 * Reference-related types for cross-resource references and CEL expressions
 */

import type { CelExpression, KubernetesRef, MagicAssignable } from './common.js';

export interface ResourceReference<_T = unknown> {
  readonly __type: 'ResourceReference';
  readonly resourceId: string;
  readonly fieldPath: string;
  readonly expectedType: string;
}

export type RefOrValue<T> = T | KubernetesRef<NonNullable<T>> | CelExpression<T>;

/**
 * The "Magic Proxy" type. It contains all the real properties of the base type `T`.
 * At compile time, it presents the original types for seamless TypeScript experience.
 * At runtime, it creates KubernetesRef objects for cross-resource references.
 *
 * For known fields: Uses the actual type from T (e.g., string, number)
 * For unknown fields: Allows access as `any` type, creating references at runtime
 *
 * The magic here is that TypeScript sees the original types (T), allowing seamless use in
 * composition functions, while the runtime proxy handles the KubernetesRef conversion.
 */
export type MagicProxy<T> = T & {
  // For known properties, $P is now assignable to T[P]
  [P in keyof T as `${P & string}`]: MagicAssignable<T[P]>;
} & {
  // For unknown properties, the result is also assignable to any type.
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
export class CelEvaluationError extends Error {
  constructor(expression: CelExpression, cause: Error) {
    super(`Failed to evaluate CEL expression '${expression.expression}': ${cause.message}`);
    this.name = 'CelEvaluationError';
    this.cause = cause;
  }
}
