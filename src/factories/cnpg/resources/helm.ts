/**
 * CloudNativePG Helm Resource Factories
 *
 * Wrappers around the generic Helm factories with CNPG-specific defaults.
 * Used by the cnpgBootstrap composition to install the operator.
 */

import type { Enhanced } from '../../../core/types/index.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import {
  createHelmRepositoryReadinessEvaluator,
  helmRepository,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import { helmRelease } from '../../helm/helm-release.js';
import type { CnpgHelmReleaseConfig, CnpgHelmRepositoryConfig } from '../types.js';

/** Default Helm chart repository URL for CloudNativePG. */
const DEFAULT_CNPG_REPO_URL = 'https://cloudnative-pg.github.io/charts';

/** Default chart version. */
const DEFAULT_CNPG_VERSION = '0.23.0';

/** Default Flux namespace for HelmRepository resources. */
const DEFAULT_FLUX_NAMESPACE = 'flux-system';

/**
 * Sanitize Helm values by removing non-serializable objects.
 *
 * Helm values cannot contain KubernetesRef proxies or CelExpression objects.
 * This round-trips through JSON to strip them.
 */
function sanitizeHelmValues(values: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(values, (_key, value) => {
      if (isKubernetesRef(value)) {
        return undefined;
      }
      if (isCelExpression(value)) {
        return undefined;
      }
      return value;
    })
  );
}

/**
 * Create a HelmRepository for the CloudNativePG chart repository.
 *
 * @param config - Repository configuration with CNPG-specific defaults
 * @returns Enhanced HelmRepository resource
 *
 * @example
 * ```typescript
 * const repo = cnpgHelmRepository({
 *   name: 'cnpg-repo',
 *   namespace: 'flux-system',
 *   id: 'cnpgHelmRepository',
 * });
 * ```
 */
export function cnpgHelmRepository(
  config: CnpgHelmRepositoryConfig
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return helmRepository({
    name: config.name || 'cnpg-repo',
    namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
    url: config.url || DEFAULT_CNPG_REPO_URL,
    interval: config.interval || '5m',
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(
    createHelmRepositoryReadinessEvaluator('CNPG')
  ) as Enhanced<HelmRepositorySpec, HelmRepositoryStatus>;
}

/**
 * Create a HelmRelease for the CloudNativePG operator.
 *
 * @param config - Release configuration with CNPG-specific defaults
 * @returns Enhanced HelmRelease resource
 *
 * @example
 * ```typescript
 * const release = cnpgHelmRelease({
 *   name: 'cnpg',
 *   namespace: 'cnpg-system',
 *   version: '0.23.0',
 *   values: { crds: { create: true } },
 *   id: 'cnpgHelmRelease',
 * });
 * ```
 */
export function cnpgHelmRelease(
  config: CnpgHelmReleaseConfig
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  const sanitizedValues = config.values ? sanitizeHelmValues(config.values) : {};

  return helmRelease({
    name: config.name,
    namespace: config.namespace || 'cnpg-system',
    chart: {
      repository: DEFAULT_CNPG_REPO_URL,
      name: 'cloudnative-pg',
      version: config.version || DEFAULT_CNPG_VERSION,
    },
    sourceRef: {
      name: config.repositoryName || 'cnpg-repo',
      namespace: DEFAULT_FLUX_NAMESPACE,
      kind: 'HelmRepository',
    },
    values: {
      crds: { create: true },
      ...sanitizedValues,
    },
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(
    createLabeledHelmReleaseEvaluator('CNPG')
  ) as Enhanced<HelmReleaseSpec, HelmReleaseStatus>;
}
