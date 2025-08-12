/**
 * Common types shared across all domains
 */

/**
 * CEL Expression Builder - Provides an escape hatch for complex CEL expressions
 * while maintaining type safety with KubernetesRef types.
 */
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../constants/brands.js';

export interface CelExpression<T = unknown> {
  [CEL_EXPRESSION_BRAND]: true;
  expression: string;
  _type?: T;
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

export type MagicAssignable<T> = T | undefined | KubernetesRef<T> | KubernetesRef<T | undefined> | CelExpression<T>;

// Type assertion helpers for the magic proxy system
export type MagicString = string | KubernetesRef<string> | CelExpression<string>;
export type MagicNumber = number | KubernetesRef<number> | CelExpression<number>;
export type MagicBoolean = boolean | KubernetesRef<boolean> | CelExpression<boolean>;

// Use declaration merging to make KubernetesRef and CelExpression compatible with their underlying types
// This allows the magic proxy system to work transparently with composition functions
declare global {
  namespace TypeKro {
    interface MagicTypeCompatibility {
      // Make KubernetesRef<string> assignable to string
      KubernetesRefString: KubernetesRef<string> extends string ? true : false;
      // Make CelExpression<string> assignable to string
      CelExpressionString: CelExpression<string> extends string ? true : false;
    }
  }
}

// Forward declaration for types that depend on each other
export interface KubernetesRef<T = unknown> {
  readonly [KUBERNETES_REF_BRAND]: true;
  readonly resourceId: string;
  readonly fieldPath: string;
  readonly _type?: T;
}
