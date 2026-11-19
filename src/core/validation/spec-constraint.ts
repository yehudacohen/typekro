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
 *   relation between nested fields. `holds` is the same rule in TypeScript. The rule travels
 *   with `type`: any spec field declared with `type` gets it as an `x-kubernetes-validations`
 *   rule on the generated instance schema, with no per-composition wiring.
 * - `required`, when set, marks a field declared with `type` `required=true` on the instance
 *   schema, so admission refuses an instance that omits it. A rule can't refuse a missing field.
 * - `check(value)` runs both halves on a concrete value inside the composition body and throws a
 *   `TypeKroError` with the constraint's code. A schema or resource reference passes, because
 *   admission checks the composition's own instance.
 * - `enforce(value)` is for a factory that accepts the value from any caller. A concrete value
 *   must be admitted. A symbolic value must be a reference to a required schema field declared
 *   with `type`, so the caller's instance schema carries the constraint; anything else symbolic
 *   is refused, because nothing would check it.
 *
 * KRO 0.9.2 compares no `x-kubernetes-validations` when it updates an existing instance CRD, so
 * a new `rule` reaches a CRD only when KRO creates it or changes it for another reason. Markers
 * such as `pattern` and `enum` are compared.
 */

import { type Type, type } from 'arktype';
import { SCHEMA_REFERENCE_OPTIONAL_BRAND } from '../constants/brands.js';
import { declaredSchemaNode, isSchemaReference } from '../references/schema-proxy.js';
import {
  containsCelExpressions,
  containsKubernetesRefs,
  isKubernetesRef,
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
  /** Mark a field declared with the constraint's type `required=true` on the instance schema. */
  readonly required?: boolean;
  /** Code of the `TypeKroError` thrown by {@link SpecConstraint.check}. */
  readonly code: string;
  /** Message for a refused concrete value. */
  readonly message: (value: unknown) => string;
  /**
   * How a caller declares a field this constraint guards, such as
   * `clusterSecretStoreConditions()`, for the message refusing an unguarded reference.
   */
  readonly declaredWith?: string;
}

/** A spec field invariant enforced in direct mode and, through the instance schema, in KRO mode. */
export interface SpecConstraint<T> {
  readonly path: string;
  /** The field's ArkType, carrying `rule` and `required` into any schema that uses it. */
  readonly type: Type<T>;
  readonly rule: string | undefined;
  readonly required: boolean;
  readonly code: string;
  /** True when a concrete value satisfies both `type` and `rule`. */
  admits(value: unknown): boolean;
  /**
   * Throws unless `value` is admitted. `undefined` passes (optionality is the schema's job), and
   * so does a value holding a schema or resource reference, which admission checks instead.
   */
  check(value: unknown): void;
  /**
   * True when `value` is a reference to a schema field that is required (and inside required
   * parents only) and declared with exactly this constraint's `type`.
   */
  fromSchemaField(value: unknown): boolean;
  /**
   * Throws unless `value` is admitted or comes from a schema field this constraint guards (see
   * {@link SpecConstraint.fromSchemaField}). Unlike `check`, `undefined` and any other symbolic
   * value are refused.
   */
  enforce(value: unknown): void;
}

/** What the instance schema must carry for a field declared with a constraint's type. */
export interface SpecConstraintAdmission {
  readonly rule: string | undefined;
  readonly required: boolean;
}

/**
 * Admission halves by the ArkType JSON of each constrained type. A constrained type is narrowed
 * with a predicate of its own, and ArkType names each predicate uniquely in the JSON, so a key
 * matches only a field declared with that very type.
 */
const ADMISSION_BY_TYPE = new Map<string, SpecConstraintAdmission>();

/**
 * The admission halves for a spec field's ArkType JSON node, or `undefined` when the field is
 * not declared with a constraint's type. The KRO schema generator calls this for every field.
 */
export function specConstraintAdmission(node: unknown): SpecConstraintAdmission | undefined {
  if (ADMISSION_BY_TYPE.size === 0 || node === undefined) return undefined;
  return ADMISSION_BY_TYPE.get(JSON.stringify(node));
}

/** `Type.narrow` without ArkType's inference, which can't follow a generic `T`. */
interface NarrowableType {
  narrow(predicate: (value: unknown) => boolean): unknown;
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
  const required = options.required === true;
  const declaredWith = options.declaredWith ?? 'the constrained type';
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

  // A constraint with schema halves beyond the markers gets a predicate of its own, which both
  // runs `holds` and makes the type's JSON unique, so the generator finds the halves by it.
  const fieldType: Type<T> =
    rule !== undefined || required
      ? ((options.type as unknown as NarrowableType).narrow((value) =>
          holds ? holds(value as T) : true
        ) as Type<T>)
      : options.type;
  const typeKey = JSON.stringify(fieldType.json);
  if (rule !== undefined || required) {
    ADMISSION_BY_TYPE.set(typeKey, { rule, required });
  }

  const admits = (value: unknown): boolean => !(fieldType(value) instanceof type.errors);

  const fromSchemaField = (value: unknown): boolean =>
    isKubernetesRef(value) &&
    isSchemaReference(value) &&
    Reflect.get(value, SCHEMA_REFERENCE_OPTIONAL_BRAND) !== true &&
    JSON.stringify(declaredSchemaNode(value)) === typeKey;

  return {
    path,
    type: fieldType,
    rule,
    required,
    code,
    admits,
    check(value: unknown): void {
      if (value === undefined || isSymbolic(value)) return;
      if (!admits(value)) {
        throw new TypeKroError(message(value), code, { path, value });
      }
    },
    fromSchemaField,
    enforce(value: unknown): void {
      if (fromSchemaField(value)) return;
      if (isSymbolic(value)) {
        throw new TypeKroError(
          `${path} is only known per instance here, and nothing would check it: pass a concrete ` +
            `value, or a reference to a required spec field declared with ${declaredWith}, ` +
            'whose instance schema carries the constraint.',
          code,
          { path }
        );
      }
      if (!admits(value)) {
        throw new TypeKroError(message(value), code, { path, value });
      }
    },
  };
}
