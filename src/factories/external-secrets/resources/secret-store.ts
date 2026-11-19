/**
 * ESO SecretStore and ClusterSecretStore factories for AWS, authenticated through EKS Pod
 * Identity. The provider type has no `auth` field, and `assertPodIdentityProvider` refuses one
 * at runtime too, so no static keys or JWT service-account references reach the cluster. The
 * provider must be written out in the composition, so no instance can add an `auth` section.
 *
 * A ClusterSecretStore without `conditions` is usable from every namespace, so
 * `clusterSecretStore` refuses one: each condition must name namespaces or carry a non-empty
 * selector, and conditions only known per instance must come from a spec field whose instance
 * schema enforces the same (see `store-conditions.ts`). Name patterns need an opt-in.
 */

import { TypeKroError } from '../../../core/errors.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import {
  containsCelExpressions,
  containsKubernetesRefs,
  isCelExpression,
  isKubernetesRef,
  isMixedTemplate,
  isResourceReference,
} from '../../../utils/type-guards.js';
import { createResource } from '../../shared.js';
import { EXTERNAL_SECRETS_API_VERSION } from '../constants.js';
import type {
  ClusterSecretStoreConfig,
  SecretStoreConfig,
  SecretStoreSpec,
  SecretStoreStatus,
} from '../types.js';
import {
  clusterSecretStoreReadinessEvaluator,
  secretStoreReadinessEvaluator,
} from './readiness.js';
import { assertConditionsLimitNamespaces } from './store-conditions.js';

/** AWS provider fields that may come from the composition spec: each is a plain string. */
const SPEC_PROVIDER_LEAVES: ReadonlySet<string> = new Set(['service', 'region', 'role', 'prefix']);

/** True when a value is, or contains, something only known per instance. */
function isSymbolic(value: unknown): boolean {
  return (
    isResourceReference(value) ||
    isMixedTemplate(value) ||
    containsKubernetesRefs(value) ||
    containsCelExpressions(value)
  );
}

/**
 * A plain object written in the composition. A schema reference is a function-backed proxy, so
 * it is not one, and neither is a CEL expression.
 */
function isConcreteObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isKubernetesRef(value) &&
    !isResourceReference(value) &&
    !isCelExpression(value)
  );
}

function refuseSymbolicProvider(where: string): never {
  throw new TypeKroError(
    `${where} of an AWS secret store must be written out in the composition, not taken from ` +
      'the spec: an instance could add an auth section to it. Only provider.aws.service, ' +
      'region, role and prefix may come from the spec.',
    'EXTERNAL_SECRETS_PROVIDER_NOT_CONCRETE',
    { where }
  );
}

/**
 * Throws unless a store spec has a concrete AWS provider with no `auth` section, which Pod
 * Identity does not use.
 *
 * The spec, `provider` and `provider.aws` must be objects written in the composition, and
 * `provider` may name only `aws`. Of the AWS fields, only `service`, `region`, `role` and
 * `prefix` may come from the composition spec. A symbolic `provider`, `provider.aws` or any
 * other field is refused with `EXTERNAL_SECRETS_PROVIDER_NOT_CONCRETE`, and an `auth` section,
 * concrete or symbolic, with `EXTERNAL_SECRETS_AUTH_NOT_POD_IDENTITY`.
 */
export function assertPodIdentityProvider(spec: unknown): void {
  if (!isConcreteObject(spec)) refuseSymbolicProvider('The spec');
  const provider = spec.provider;
  if (!isConcreteObject(provider)) refuseSymbolicProvider('spec.provider');
  const others = Object.keys(provider).filter((key) => key !== 'aws');
  if (others.length > 0) {
    throw new TypeKroError(
      `AWS secret stores authenticate through EKS Pod Identity here; remove provider.${others.join(', provider.')}.`,
      'EXTERNAL_SECRETS_AUTH_NOT_POD_IDENTITY',
      { providers: others }
    );
  }
  const aws = provider.aws;
  if (!isConcreteObject(aws)) refuseSymbolicProvider('spec.provider.aws');
  if ('auth' in aws && aws.auth !== undefined) {
    throw new TypeKroError(
      'AWS secret stores authenticate through EKS Pod Identity here; remove provider.aws.auth.',
      'EXTERNAL_SECRETS_AUTH_NOT_POD_IDENTITY'
    );
  }
  for (const [key, value] of Object.entries(aws)) {
    if (!SPEC_PROVIDER_LEAVES.has(key) && isSymbolic(value)) {
      refuseSymbolicProvider(`spec.provider.aws.${key}`);
    }
  }
}

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
 * condition must name namespaces or carry a non-empty `namespaceSelector`. Conditions from the
 * composition spec must come from a field declared with `clusterSecretStoreConditions()`, or
 * take their `namespaces` from a field declared with `clusterSecretStoreNamespaces()`; the
 * instance schema then refuses the same stores at admission. Any other value only known per
 * instance is refused when the composition is built.
 *
 * `namespaceRegexes` are refused unless `allowNamespaceRegexes` is set. With it, conditions from
 * the spec may also come from a field declared with
 * `clusterSecretStoreConditions({ allowNamespaceRegexes: true })`.
 * ESO grants a namespace access when any regex matches it, whatever the other selectors say, so
 * `.*` opens the store to every namespace: with the opt-in, the patterns are the only limit.
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
  config: Composable<ClusterSecretStoreConfig>
): Enhanced<SecretStoreSpec, SecretStoreStatus> {
  assertPodIdentityProvider(config.spec);
  assertConditionsLimitNamespaces(
    (config.spec as { conditions?: unknown } | undefined)?.conditions,
    { allowNamespaceRegexes: config.allowNamespaceRegexes === true }
  );
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
