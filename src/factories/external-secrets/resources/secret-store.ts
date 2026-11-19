/**
 * ESO SecretStore and ClusterSecretStore factories for AWS, authenticated through EKS Pod
 * Identity. The provider type has no `auth` field, and `assertPodIdentityProvider` refuses one
 * at runtime too, so no static keys or JWT service-account references reach the cluster.
 *
 * A ClusterSecretStore without `conditions` is usable from every namespace, so
 * `clusterSecretStore` refuses one: each condition must name namespaces, carry a non-empty
 * selector or give name patterns.
 */

import { type } from 'arktype';
import { TypeKroError } from '../../../core/errors.js';
import { specConstraint } from '../../../core/validation/spec-constraint.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import { EXTERNAL_SECRETS_API_VERSION } from '../constants.js';
import type { SecretStoreConfig, SecretStoreSpec, SecretStoreStatus } from '../types.js';
import {
  clusterSecretStoreReadinessEvaluator,
  secretStoreReadinessEvaluator,
} from './readiness.js';

/** Throws if an AWS provider carries an `auth` section, which Pod Identity does not use. */
export function assertPodIdentityProvider(spec: unknown): void {
  const aws = (spec as { provider?: { aws?: Record<string, unknown> } } | undefined)?.provider?.aws;
  if (aws && typeof aws === 'object' && 'auth' in aws && aws.auth !== undefined) {
    throw new TypeKroError(
      'AWS secret stores authenticate through EKS Pod Identity here; remove provider.aws.auth.',
      'EXTERNAL_SECRETS_AUTH_NOT_POD_IDENTITY'
    );
  }
}

type StoreCondition = NonNullable<SecretStoreSpec['conditions']>[number];

/**
 * True when a condition limits the store to some namespaces. An empty `namespaceSelector`
 * selects every namespace, so a condition carrying one is refused even beside a name list.
 */
function conditionLimitsNamespaces(condition: StoreCondition): boolean {
  const selector = condition.namespaceSelector;
  const selects =
    selector !== undefined &&
    (Object.keys(selector.matchLabels ?? {}).length > 0 ||
      (selector.matchExpressions?.length ?? 0) > 0);
  if (selector !== undefined && !selects) return false;
  return (
    (condition.namespaces?.length ?? 0) > 0 ||
    selects ||
    (condition.namespaceRegexes?.length ?? 0) > 0
  );
}

const storeCondition = type({
  'namespaces?': 'string[]',
  'namespaceSelector?': {
    'matchLabels?': 'Record<string, string>',
    'matchExpressions?': type({ key: 'string', operator: 'string', 'values?': 'string[]' }).array(),
  },
  'namespaceRegexes?': 'string[]',
});

/**
 * `spec.conditions` of a ClusterSecretStore: at least one condition, and every condition limits
 * the store to some namespaces. Checked on concrete conditions; a composition that takes them
 * from its spec enforces the same on its instance schema.
 */
export const CLUSTER_SECRET_STORE_CONDITIONS = specConstraint({
  path: 'conditions',
  type: storeCondition
    .array()
    .atLeastLength(1)
    .narrow(
      (conditions, ctx) =>
        conditions.every(conditionLimitsNamespaces) ||
        ctx.mustBe('conditions that each name namespaces, a non-empty selector or patterns')
    ),
  code: 'EXTERNAL_SECRETS_CLUSTER_STORE_UNCONDITIONED',
  message: () =>
    'A ClusterSecretStore must state conditions that limit it to some namespaces: each ' +
    'condition needs namespaces, a non-empty namespaceSelector or namespaceRegexes. Use a ' +
    'namespaced SecretStore when one namespace needs the secrets.',
});

/** Create a namespaced SecretStore for AWS Secrets Manager or Parameter Store. */
export function secretStore(
  config: Composable<SecretStoreConfig>
): Enhanced<SecretStoreSpec, SecretStoreStatus> {
  assertPodIdentityProvider(config.spec);
  return createResource(
    {
      apiVersion: EXTERNAL_SECRETS_API_VERSION,
      kind: 'SecretStore',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
      },
      spec: config.spec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced' }
  ).withReadinessEvaluator(secretStoreReadinessEvaluator) as Enhanced<
    SecretStoreSpec,
    SecretStoreStatus
  >;
}

/**
 * Create a cluster-scoped ClusterSecretStore for AWS Secrets Manager or Parameter Store.
 *
 * `spec.conditions` is required: a store without it is usable from every namespace. Each
 * condition must name namespaces, carry a non-empty `namespaceSelector` or give
 * `namespaceRegexes`.
 *
 * @example
 * ```typescript
 * const store = clusterSecretStore({
 *   name: 'aws-secrets-manager',
 *   spec: {
 *     provider: { aws: { service: 'SecretsManager', region: 'us-east-1' } },
 *     conditions: [{ namespaces: ['payments', 'orders'] }],
 *   },
 *   id: 'store',
 * });
 * ```
 */
export function clusterSecretStore(
  config: Composable<Omit<SecretStoreConfig, 'namespace'>>
): Enhanced<SecretStoreSpec, SecretStoreStatus> {
  assertPodIdentityProvider(config.spec);
  const conditions = (config.spec as { conditions?: unknown } | undefined)?.conditions;
  if (conditions === undefined) CLUSTER_SECRET_STORE_CONDITIONS.check([]);
  CLUSTER_SECRET_STORE_CONDITIONS.check(conditions);
  return createResource(
    {
      apiVersion: EXTERNAL_SECRETS_API_VERSION,
      kind: 'ClusterSecretStore',
      metadata: { name: config.name },
      spec: config.spec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(clusterSecretStoreReadinessEvaluator) as Enhanced<
    SecretStoreSpec,
    SecretStoreStatus
  >;
}
