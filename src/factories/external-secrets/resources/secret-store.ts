/**
 * ESO SecretStore and ClusterSecretStore factories for AWS, authenticated through EKS Pod
 * Identity. The provider type has no `auth` field, and `assertPodIdentityProvider` refuses one
 * at runtime too, so no static keys or JWT service-account references reach the cluster.
 */

import { TypeKroError } from '../../../core/errors.js';
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
 * @example
 * ```typescript
 * const store = clusterSecretStore({
 *   name: 'aws-secrets-manager',
 *   spec: { provider: { aws: { service: 'SecretsManager', region: 'us-east-1' } } },
 *   id: 'store',
 * });
 * ```
 */
export function clusterSecretStore(
  config: Composable<Omit<SecretStoreConfig, 'namespace'>>
): Enhanced<SecretStoreSpec, SecretStoreStatus> {
  assertPodIdentityProvider(config.spec);
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
