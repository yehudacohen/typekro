/**
 * Which namespaces may use a ClusterSecretStore.
 *
 * A ClusterSecretStore without `conditions` is usable from every namespace, and so is one whose
 * condition carries an empty `namespaceSelector`. `clusterSecretStore` refuses both, from every
 * caller and in both modes:
 *
 * - concrete conditions must each name namespaces, carry a non-empty selector or give name
 *   patterns;
 * - conditions only known per instance must come from a spec field declared with
 *   {@link clusterSecretStoreConditions}, whose CEL rule and `required=true` marker are on the
 *   generated instance schema, so admission refuses the same instances;
 * - a condition built in the composition may take its `namespaces` from a spec field declared
 *   with {@link clusterSecretStoreNamespaces}, which the instance schema requires to list at
 *   least one namespace name.
 *
 * Any other symbolic value is refused when the composition is built: nothing would check it.
 */

import { type, type Type } from 'arktype';
import { specConstraint } from '../../../core/validation/spec-constraint.js';
import type { SecretStoreSpec } from '../types.js';

type StoreCondition = NonNullable<SecretStoreSpec['conditions']>[number];

/** Conditions on one store; a bound keeps the CEL rule inside the API server's cost budget. */
const MAX_CONDITIONS = 64;

/**
 * True when a condition limits the store to some namespaces. An empty `namespaceSelector`
 * selects every namespace, so a condition carrying one is refused even beside a name list.
 */
function conditionLimitsNamespaces(condition: StoreCondition): boolean {
  const selector = condition.namespaceSelector;
  if (selector !== undefined) {
    return (
      Object.keys(selector.matchLabels ?? {}).length > 0 ||
      (selector.matchExpressions?.length ?? 0) > 0
    );
  }
  return (condition.namespaces?.length ?? 0) > 0 || (condition.namespaceRegexes?.length ?? 0) > 0;
}

/** {@link conditionLimitsNamespaces} over every condition, and at least one, in portable CEL. */
const CONDITIONS_RULE =
  'size(self) > 0 && self.all(c, has(c.namespaceSelector) ? ' +
  '((has(c.namespaceSelector.matchLabels) && size(c.namespaceSelector.matchLabels) > 0) || ' +
  '(has(c.namespaceSelector.matchExpressions) && size(c.namespaceSelector.matchExpressions) > 0)) : ' +
  '((has(c.namespaces) && size(c.namespaces) > 0) || ' +
  '(has(c.namespaceRegexes) && size(c.namespaceRegexes) > 0)))';

const storeCondition = type({
  'namespaces?': 'string[]',
  'namespaceSelector?': {
    'matchLabels?': 'Record<string, string>',
    'matchExpressions?': type({ key: 'string', operator: 'string', 'values?': 'string[]' }).array(),
  },
  'namespaceRegexes?': 'string[]',
});

/** `spec.conditions` of a ClusterSecretStore. */
export const CLUSTER_SECRET_STORE_CONDITIONS = specConstraint({
  path: 'conditions',
  type: storeCondition.array().atMostLength(MAX_CONDITIONS),
  rule: CONDITIONS_RULE,
  holds: (conditions) => conditions.length > 0 && conditions.every(conditionLimitsNamespaces),
  required: true,
  code: 'EXTERNAL_SECRETS_CLUSTER_STORE_UNCONDITIONED',
  declaredWith: 'clusterSecretStoreConditions()',
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
 * Returns the same type every call.
 *
 * @example
 * ```typescript
 * const spec = type({ name: 'string', conditions: clusterSecretStoreConditions() });
 * // in the composition body:
 * clusterSecretStore({ name: spec.name, spec: { provider, conditions: spec.conditions } });
 * ```
 */
export function clusterSecretStoreConditions(): Type<NonNullable<SecretStoreSpec['conditions']>> {
  return CLUSTER_SECRET_STORE_CONDITIONS.type;
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
 */
export function assertConditionsLimitNamespaces(conditions: unknown): void {
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
  CLUSTER_SECRET_STORE_CONDITIONS.enforce(resolved);
}
