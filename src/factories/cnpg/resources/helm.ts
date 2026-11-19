/**
 * CloudNativePG Helm Resource Factories
 *
 * Wrappers around the generic Helm factories with CNPG-specific defaults.
 * Used by the cnpgBootstrap composition to install the operator.
 */

import { withChartValueDefaults } from '../../../core/aspects/values-merge.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import {
  createHelmRepositoryReadinessEvaluator,
  helmRepository,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { helmReleaseLifecycle } from '../../helm/lifecycle.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import { helmRelease } from '../../helm/helm-release.js';
import {
  CNPG_CHART_REPOSITORY_URL,
  CNPG_CHART_VERSION,
  DEFAULT_CNPG_REPOSITORY_NAME,
} from '../constants.js';
import type { CnpgHelmReleaseConfig, CnpgHelmRepositoryConfig } from '../types.js';

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
  config: Composable<CnpgHelmRepositoryConfig>
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return helmRepository({
    name: config.name || DEFAULT_CNPG_REPOSITORY_NAME,
    namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
    url: config.url || CNPG_CHART_REPOSITORY_URL,
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
 *   version: '0.29.2',
 *   values: { crds: { create: true } },
 *   id: 'cnpgHelmRelease',
 * });
 * ```
 */
export function cnpgHelmRelease(
  config: Composable<CnpgHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  // Pass values directly — the core proxy system handles serialization.
  return helmRelease({
    name: config.name,
    namespace: config.namespace || 'cnpg-system',
    chart: {
      repository: CNPG_CHART_REPOSITORY_URL,
      name: 'cloudnative-pg',
      version: config.version || CNPG_CHART_VERSION,
    },
    sourceRef: {
      name: config.repositoryName || DEFAULT_CNPG_REPOSITORY_NAME,
      namespace: DEFAULT_FLUX_NAMESPACE,
      kind: 'HelmRepository',
    },
    ...helmReleaseLifecycle(config, { driftDetection: { mode: 'enabled' } }),
    // Layer the chart default UNDER the caller's values. Spreading here would
    // enumerate a whole-object schema reference at build time and lose it.
    values: withChartValueDefaults({ crds: { create: true } }, config.values) as Record<
      string,
      unknown
    >,
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(
    createLabeledHelmReleaseEvaluator('CNPG')
  ) as Enhanced<HelmReleaseSpec, HelmReleaseStatus>;
}
