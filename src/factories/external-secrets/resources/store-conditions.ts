/**
 * Which namespaces may use a ClusterSecretStore.
 *
 * A ClusterSecretStore without `conditions` is usable from every namespace, and so is one whose
 * condition carries an empty `namespaceSelector`. `clusterSecretStore` refuses both, from every
 * caller and in both modes:
 *
 * - concrete conditions must each name namespaces or carry a non-empty selector;
 * - conditions only known per instance must come from a spec field declared with
 *   {@link clusterSecretStoreConditions}, whose CEL rule and `required=true` marker are on the
 *   generated instance schema, so admission refuses the same instances;
 * - a condition built in the composition may take its `namespaces` from a spec field declared
 *   with {@link clusterSecretStoreNamespaces}, which the instance schema requires to list at
 *   least one namespace name.
 *
 * Any other symbolic value is refused when the composition is built: nothing would check it.
 *
 * `namespaceRegexes` are refused unless the caller opts in. ESO grants a namespace access when
 * any regex of a condition matches it, whatever the condition's other selectors say, so a
 * pattern such as `.*` opens the store to every namespace. With the opt-in, a condition may give
 * name patterns instead of names or a selector, and the guarantee that every accepted condition
 * limits the store to some namespaces no longer holds: it rests on the patterns the caller
 * writes.
 */

import { type, type Type } from 'arktype';
import { specConstraint } from '../../../core/validation/spec-constraint.js';
import type { SecretStoreSpec } from '../types.js';

type StoreCondition = NonNullable<SecretStoreSpec['conditions']>[number];

/** Conditions on one store; a bound keeps the CEL rule inside the API server's cost budget. */
const MAX_CONDITIONS = 64;

/** Whether `namespaceRegexes` are accepted. See the module comment. */
export interface ClusterSecretStoreConditionOptions {
  /**
   * Accept `namespaceRegexes`. A regex such as `.*` grants every namespace access, whatever the
   * condition's other selectors say. @default false
   */
  readonly allowNamespaceRegexes?: boolean;
}

/**
 * True when a condition limits the store to some namespaces. An empty `namespaceSelector`
 * selects every namespace, so a condition carrying one is refused even beside a name list.
 * Without `allowRegexes`, a condition giving `namespaceRegexes` is refused.
 */
function conditionLimitsNamespaces(condition: StoreCondition, allowRegexes: boolean): boolean {
  if (!allowRegexes && condition.namespaceRegexes !== undefined) return false;
  const selector = condition.namespaceSelector;
  if (selector !== undefined) {
    return (
      Object.keys(selector.matchLabels ?? {}).length > 0 ||
      (selector.matchExpressions?.length ?? 0) > 0
    );
  }
  return (
    (condition.namespaces?.length ?? 0) > 0 ||
    (allowRegexes && (condition.namespaceRegexes?.length ?? 0) > 0)
  );
}

/** {@link conditionLimitsNamespaces} over every condition, and at least one, in portable CEL. */
function conditionsRule(allowRegexes: boolean): string {
  const selector =
    '((has(c.namespaceSelector.matchLabels) && size(c.namespaceSelector.matchLabels) > 0) || ' +
    '(has(c.namespaceSelector.matchExpressions) && size(c.namespaceSelector.matchExpressions) > 0))';
  const names = allowRegexes
    ? '((has(c.namespaces) && size(c.namespaces) > 0) || ' +
      '(has(c.namespaceRegexes) && size(c.namespaceRegexes) > 0))'
    : '(has(c.namespaces) && size(c.namespaces) > 0)';
  const limits = `(has(c.namespaceSelector) ? ${selector} : ${names})`;
  return `size(self) > 0 && self.all(c, ${allowRegexes ? limits : `!has(c.namespaceRegexes) && ${limits}`})`;
}

const storeCondition = type({
  'namespaces?': 'string[]',
  'namespaceSelector?': {
    'matchLabels?': 'Record<string, string>',
    'matchExpressions?': type({ key: 'string', operator: 'string', 'values?': 'string[]' }).array(),
  },
  'namespaceRegexes?': 'string[]',
});

/** `spec.conditions` of a ClusterSecretStore, with `namespaceRegexes` refused. */
export const CLUSTER_SECRET_STORE_CONDITIONS = specConstraint({
  path: 'conditions',
  type: storeCondition.array().atMostLength(MAX_CONDITIONS),
  rule: conditionsRule(false),
  holds: (conditions) =>
    conditions.length > 0 &&
    conditions.every((condition) => conditionLimitsNamespaces(condition, false)),
  required: true,
  code: 'EXTERNAL_SECRETS_CLUSTER_STORE_UNCONDITIONED',
  declaredWith: 'clusterSecretStoreConditions()',
  message: () =>
    'A ClusterSecretStore must state conditions that limit it to some namespaces: each ' +
    'condition needs namespaces or a non-empty namespaceSelector, and an empty ' +
    'namespaceSelector is refused even beside them. namespaceRegexes are refused unless you ' +
    'opt in with allowNamespaceRegexes, because a pattern such as ".*" matches every ' +
    'namespace. Use a namespaced SecretStore when one namespace needs the secrets.',
});

/** `spec.conditions` of a ClusterSecretStore whose caller opted in to `namespaceRegexes`. */
export const CLUSTER_SECRET_STORE_CONDITIONS_WITH_REGEXES = specConstraint({
  path: 'conditions',
  type: storeCondition.array().atMostLength(MAX_CONDITIONS),
  rule: conditionsRule(true),
  holds: (conditions) =>
    conditions.length > 0 &&
    conditions.every((condition) => conditionLimitsNamespaces(condition, true)),
  required: true,
  code: 'EXTERNAL_SECRETS_CLUSTER_STORE_UNCONDITIONED',
  declaredWith: 'clusterSecretStoreConditions({ allowNamespaceRegexes: true })',
  message: () =>
    'A ClusterSecretStore must state conditions that limit it to some namespaces: each ' +
    'condition needs namespaces, a non-empty namespaceSelector or namespaceRegexes, and an ' +
    'empty namespaceSelector is refused even beside them. Use a namespaced SecretStore when ' +
    'one namespace needs the secrets.',
});

/** A DNS-1123 label: a namespace name. */
export const namespaceName = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 63');

/** The `namespaces` of one condition, by name: at least one. */
export const CLUSTER_SECRET_STORE_NAMESPACES = specConstraint({
  path: 'namespaces',
  type: namespaceName.array().atLeastLength(1),
  required: true,
  code: 'EXTERNAL_SECRETS_CLUSTER_STORE_UNCONDITIONED',
  declaredWith: 'clusterSecretStoreNamespaces()',
  message: (value) =>
    'A ClusterSecretStore namespace list must name at least one namespace; got ' +
    `${JSON.stringify(value)}.`,
});

/**
 * The ArkType for a composition spec field passed as a ClusterSecretStore's `conditions`. The
 * instance schema then requires the field and refuses conditions that any namespace could use.
 * It refuses `namespaceRegexes` unless `allowNamespaceRegexes` is set; a regex such as `.*`
 * grants every namespace access, so with the opt-in the instance schema no longer guarantees
 * that each condition limits the store. A field declared with the opt-in is accepted only by a
 * `clusterSecretStore` call that sets `allowNamespaceRegexes` too. Returns the same type every
 * call with the same options.
 *
 * @example
 * ```typescript
 * const spec = type({ name: 'string', conditions: clusterSecretStoreConditions() });
 * // in the composition body:
 * clusterSecretStore({ name: spec.name, spec: { provider, conditions: spec.conditions } });
 * ```
 */
export function clusterSecretStoreConditions(
  options: ClusterSecretStoreConditionOptions = {}
): Type<NonNullable<SecretStoreSpec['conditions']>> {
  return options.allowNamespaceRegexes === true
    ? CLUSTER_SECRET_STORE_CONDITIONS_WITH_REGEXES.type
    : CLUSTER_SECRET_STORE_CONDITIONS.type;
}

/**
 * The ArkType for a composition spec field used as one condition's `namespaces`: namespace
 * names, at least one, and the instance schema requires the field. Returns the same type every
 * call.
 *
 * @example
 * ```typescript
 * const spec = type({ name: 'string', allowedNamespaces: clusterSecretStoreNamespaces() });
 * // in the composition body:
 * clusterSecretStore({
 *   name: spec.name,
 *   spec: { provider, conditions: [{ namespaces: spec.allowedNamespaces }] },
 * });
 * ```
 */
export function clusterSecretStoreNamespaces(): Type<string[]> {
  return CLUSTER_SECRET_STORE_NAMESPACES.type;
}

/**
 * Throws `EXTERNAL_SECRETS_CLUSTER_STORE_UNCONDITIONED` unless `conditions` limit a
 * ClusterSecretStore to some namespaces in every instance. See the module comment.
 *
 * `namespaceRegexes` pass only with `allowNamespaceRegexes`, which also admits conditions from
 * a field declared with `clusterSecretStoreConditions({ allowNamespaceRegexes: true })`. The
 * opt-in is on the call because direct mode sees only the concrete conditions.
 */
export function assertConditionsLimitNamespaces(
  conditions: unknown,
  options: ClusterSecretStoreConditionOptions = {}
): void {
  // A namespace list from a field declared with clusterSecretStoreNamespaces() is non-empty in
  // every admitted instance; any admitted list stands in for it when the conditions are checked.
  const resolved = Array.isArray(conditions)
    ? conditions.map((condition: unknown) =>
        typeof condition === 'object' &&
        condition !== null &&
        CLUSTER_SECRET_STORE_NAMESPACES.fromSchemaField(
          (condition as { namespaces?: unknown }).namespaces
        )
          ? { ...condition, namespaces: ['admitted'] }
          : condition
      )
    : conditions;
  if (options.allowNamespaceRegexes === true) {
    if (CLUSTER_SECRET_STORE_CONDITIONS.fromSchemaField(resolved)) return;
    CLUSTER_SECRET_STORE_CONDITIONS_WITH_REGEXES.enforce(resolved);
    return;
  }
  CLUSTER_SECRET_STORE_CONDITIONS.enforce(resolved);
}
