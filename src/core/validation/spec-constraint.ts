/**
 * Spec constraints: an invariant on one spec field, declared once and enforced in both
 * deployment modes.
 *
 * A check written in plain TypeScript inside a composition body runs only in direct mode. In
 * KRO mode the body sees a schema proxy, so the check is skipped, and unless the generated
 * instance schema carries the same constraint, the API server admits any value. A
 * {@link SpecConstraint} keeps both halves together:
 *
 * - `type` is the field's ArkType. Use it for the field in the composition's spec schema. Its
 *   pattern, enum, length and item bounds become markers on the generated instance schema, and
 *   factory validation runs it on a concrete spec.
 * - `rule`, when given, is a CEL rule over `self` for what a marker can't say, such as a
 *   relation between nested fields. Pass {@link specConstraintValidations} as the composition's
 *   `schemaFieldValidations` and it becomes an `x-kubernetes-validations` rule on the field.
 *   `holds` is the same rule in TypeScript.
 * - `check(value)` runs both halves on a concrete value inside the composition body and throws a
 *   `TypeKroError` with the constraint's code. A schema or resource reference passes, because
 *   admission checks the instance.
 *
 * KRO 0.9.2 compares no `x-kubernetes-validations` when it updates an existing instance CRD, so
 * a new `rule` reaches a CRD only when KRO creates it or changes it for another reason. Markers
 * such as `pattern` and `enum` are compared.
 */

import { type Type, type } from 'arktype';
import {
  containsCelExpressions,
  containsKubernetesRefs,
  isMixedTemplate,
  isResourceReference,
} from '../../utils/type-guards.js';
import { TypeKroError } from '../errors.js';

export interface SpecConstraintOptions<T> {
  /** Dot-separated path of the field under `spec`, such as `amiAlias` or `store.conditions`. */
  readonly path: string;
  /** The field's ArkType; its markers are enforced at admission. */
  readonly type: Type<T>;
  /** A CEL rule over `self` (the field) for what `type` can't express. */
  readonly rule?: string;
  /** `rule` in TypeScript, run on a concrete value. Required exactly when `rule` is set. */
  readonly holds?: (value: T) => boolean;
  /** Code of the `TypeKroError` thrown by {@link SpecConstraint.check}. */
  readonly code: string;
  /** Message for a refused concrete value. */
  readonly message: (value: unknown) => string;
}

/** A spec field invariant enforced in direct mode and, through the instance schema, in KRO mode. */
export interface SpecConstraint<T> {
  readonly path: string;
  readonly type: Type<T>;
  readonly rule: string | undefined;
  readonly code: string;
  /** True when a concrete value satisfies both `type` and `rule`. */
  admits(value: unknown): boolean;
  /**
   * Throws unless `value` is admitted. `undefined` passes (optionality is the schema's job), and
   * so does a value holding a schema or resource reference, which admission checks instead.
   */
  check(value: unknown): void;
}

/** True when a value is, or contains, something only known per instance. */
function isSymbolic(value: unknown): boolean {
  return (
    isResourceReference(value) ||
    isMixedTemplate(value) ||
    containsKubernetesRefs(value) ||
    containsCelExpressions(value)
  );
}

/** Declare a spec constraint. See the module comment for how the halves are used. */
export function specConstraint<T>(options: SpecConstraintOptions<T>): SpecConstraint<T> {
  const { path, rule, holds, code, message } = options;
  if (!path || path.split('.').some((segment) => segment.length === 0)) {
    throw new TypeError(
      `Spec constraint path ${JSON.stringify(path)} must be a dotted field path.`
    );
  }
  if ((rule === undefined) !== (holds === undefined)) {
    throw new TypeError(
      `Spec constraint ${path} must give a CEL rule and its TypeScript form together.`
    );
  }
  if (rule !== undefined && !rule.trim()) {
    throw new TypeError(`Spec constraint ${path} has an empty CEL rule.`);
  }
  const fieldType = options.type;

  const admits = (value: unknown): boolean => {
    if (fieldType(value) instanceof type.errors) return false;
    return holds ? holds(value as T) : true;
  };

  return {
    path,
    type: fieldType,
    rule,
    code,
    admits,
    check(value: unknown): void {
      if (value === undefined || isSymbolic(value)) return;
      if (!admits(value)) {
        throw new TypeKroError(message(value), code, { path, value });
      }
    },
  };
}

/**
 * The `schemaFieldValidations` composition option for constraints that carry a CEL rule.
 * Constraints with only a `type` add nothing here; their markers come from the spec schema.
 */
export function specConstraintValidations(
  ...constraints: readonly Pick<SpecConstraint<unknown>, 'path' | 'rule'>[]
): Readonly<Record<string, string>> {
  const validations: Record<string, string> = {};
  for (const constraint of constraints) {
    if (constraint.rule === undefined) continue;
    if (validations[constraint.path] !== undefined) {
      throw new TypeError(
        `Two spec constraints put a CEL rule on ${constraint.path}; combine them into one rule.`
      );
    }
    validations[constraint.path] = constraint.rule;
  }
  return validations;
}
