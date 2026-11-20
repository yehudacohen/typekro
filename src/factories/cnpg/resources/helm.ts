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
import type { CnpgHelmReleaseConfig, CnpgHelmRepositoryConfig } from '../types.js';

/** Default Helm chart repository URL for CloudNativePG. */
const DEFAULT_CNPG_REPO_URL = 'https://cloudnative-pg.github.io/charts';

/**
 * Default `cloudnative-pg` chart version: 0.29.2 (released 2026-11-17), which installs operator
 * 1.30.2. The chart declares `kubeVersion: >=1.29.0-0`. New clusters that set no image get
 * PostgreSQL 18.7, and PostgreSQL 14 is no longer supported; see "Upgrading the operator" in the
 * CNPG docs before upgrading an existing install.
 */
export const DEFAULT_CNPG_CHART_VERSION = '0.29.2';
/** Operator version {@link DEFAULT_CNPG_CHART_VERSION} installs. */
export const DEFAULT_CNPG_OPERATOR_VERSION = '1.30.2';

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
      repository: DEFAULT_CNPG_REPO_URL,
      name: 'cloudnative-pg',
      version: config.version || DEFAULT_CNPG_CHART_VERSION,
    },
    sourceRef: {
      name: config.repositoryName || 'cnpg-repo',
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
