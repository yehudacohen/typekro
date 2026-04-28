/**
 * Common types shared across all domains
 */

/**
 * CEL Expression Builder - Provides an escape hatch for complex CEL expressions
 * while maintaining type safety with KubernetesRef types.
 */
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../constants/brands.js';

/**
 * A branded type representing a Common Expression Language (CEL) expression
 * that evaluates to a value of type `T` at Kro runtime.
 *
 * CEL expressions are used in status builders and conditional directives
 * to define dynamic logic that Kro evaluates server-side.
 *
 * Create instances with {@link Cel.expr}, {@link Cel.template}, or {@link Cel.string}.
 *
 * @typeParam T - The TypeScript type this expression evaluates to at runtime.
 *
 * @example
 * ```ts
 * // Boolean expression checking deployment readiness
 * Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0')
 *
 * // String template interpolation
 * Cel.template('https://%s/api', schema.spec.hostname)
 * ```
 */
export interface CelExpression<T = unknown> {
  [CEL_EXPRESSION_BRAND]: true;
  expression: string;
  _type?: T;
  /** When true, the expression is a mixed template containing `${...}` placeholders. */
  __isTemplate?: boolean;
}

/**
 * Magic type that makes composition functions work transparently with KubernetesRef and CelExpression
 */
export type MagicValue<T> = T extends string
  ? string | KubernetesRef<string> | CelExpression<string>
  : T extends number
    ? number | KubernetesRef<number> | CelExpression<number>
    : T extends boolean
      ? boolean | KubernetesRef<boolean> | CelExpression<boolean>
      : T;

/**
 * Specific type for environment variables that only allows strings or CelExpressions that resolve to strings
 * This prevents KubernetesRef<number> from being assigned to env vars without explicit conversion
 */
export type EnvVarValue =
  | string
  | KubernetesRef<string>
  | KubernetesRef<string | undefined>
  | CelExpression<string>;

/**
 * MagicAssignable allows assignment of plain values, KubernetesRef-wrapped values,
 * and CEL expressions to composition properties.
 *
 * Note: We avoid recursive DeepKubernetesRef wrapping to prevent infinite type expansion.
 */
export type MagicAssignable<T> =
  | T
  | undefined
  | CelExpression<T>
  | KubernetesRef<T>
  | KubernetesRef<T | undefined>
  | (T extends DeepKubernetesRef<unknown> ? never : DeepKubernetesRef<T>)
  | (T extends DeepKubernetesRef<unknown> ? never : DeepKubernetesRef<T | undefined>);

// Type assertion helpers for the magic proxy system
export type MagicString = string | KubernetesRef<string> | CelExpression<string>;
export type MagicNumber = number | KubernetesRef<number> | CelExpression<number>;
export type MagicBoolean = boolean | KubernetesRef<boolean> | CelExpression<boolean>;

/**
 * A branded type representing a reference to a Kubernetes resource field.
 *
 * At composition time, property accesses on schema and resource proxies
 * produce `KubernetesRef` values that are serialized into CEL `${...}`
 * references in the Kro manifest. This enables type-safe cross-resource
 * references without string manipulation.
 *
 * Users typically never construct these directly; they are created
 * automatically by the MagicProxy system when accessing proxy properties
 * (e.g., `schema.spec.replicas` or `resources.deployment.status.readyReplicas`).
 *
 * @typeParam T - The TypeScript type of the referenced field value.
 *
 * @example
 * ```ts
 * // These produce KubernetesRef values automatically:
 * const replicas = schema.spec.replicas;      // KubernetesRef<number>
 * const phase = resources.deploy.status.phase; // KubernetesRef<string>
 * ```
 */
export interface KubernetesRef<T = unknown> {
  readonly [KUBERNETES_REF_BRAND]: true;
  readonly resourceId: string;
  readonly fieldPath: string;
  readonly _type?: T;
}

/**
 * Deep proxy type for KubernetesRef that allows nested property access
 * AND primitive value operations (boolean expressions, arithmetic, etc.)
 *
 * This makes the type system match the runtime Proxy behavior where:
 * - Nested objects: Can access properties like .field.subfield
 * - Primitives: Can be used in expressions like && || + - etc.
 *
 * The union with primitive types (T) allows the magic proxy system to work:
 * - KubernetesRef<boolean> | boolean → can be used in boolean expressions
 * - KubernetesRef<number> | number → can be used in arithmetic
 * - KubernetesRef<string> | string → can be used in string operations
 */
export type DeepKubernetesRef<T> = T extends unknown // Distributive conditional - enables proper union handling
  ? T extends boolean
    ? KubernetesRef<boolean> | boolean
    : T extends number
      ? KubernetesRef<T> | number
      : T extends string
        ? KubernetesRef<T> | string
        : T extends object
          ? {
              [K in keyof T]: DeepKubernetesRef<T[K]>;
            } & KubernetesRef<T>
          : KubernetesRef<T> | T
  : never;
