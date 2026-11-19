/**
 * Barman Cloud plugin HelmRelease, from the official `plugin-barman-cloud` chart in the
 * CloudNativePG chart repository (the same repository as the operator, so `cnpgHelmRepository`
 * serves both).
 *
 * The chart installs the `ObjectStore` CRD (kept on uninstall), the plugin Deployment and the
 * `barman-cloud` Service the operator discovers it by, and cert-manager `Certificate`s for the
 * plugin's TLS. cert-manager must be running first, and the release must be in the operator's
 * namespace.
 */

import { withChartValueDefaults } from '../../../core/aspects/values-merge.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import { helmRelease } from '../../helm/helm-release.js';
import { helmReleaseLifecycle } from '../../helm/lifecycle.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import {
  BARMAN_CLOUD_PLUGIN_CHART_NAME,
  BARMAN_CLOUD_PLUGIN_CHART_VERSION,
  CNPG_CHART_REPOSITORY_URL,
  DEFAULT_CNPG_NAMESPACE,
  DEFAULT_CNPG_REPOSITORY_NAME,
} from '../constants.js';
import type { BarmanCloudPluginHelmReleaseConfig } from '../types.js';

/**
 * Create the HelmRelease that installs the Barman Cloud plugin.
 *
 * @example
 * ```typescript
 * const plugin = barmanCloudPluginHelmRelease({
 *   name: 'barman-cloud',
 *   namespace: 'cnpg-system',
 *   id: 'barmanCloudPluginHelmRelease',
 * });
 * ```
 */
export function barmanCloudPluginHelmRelease(
  config: Composable<BarmanCloudPluginHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return helmRelease({
    name: config.name,
    namespace: config.namespace ?? DEFAULT_CNPG_NAMESPACE,
    chart: {
      repository: CNPG_CHART_REPOSITORY_URL,
      name: BARMAN_CLOUD_PLUGIN_CHART_NAME,
      version: config.version ?? BARMAN_CLOUD_PLUGIN_CHART_VERSION,
    },
    sourceRef: {
      name: config.repositoryName ?? DEFAULT_CNPG_REPOSITORY_NAME,
      namespace: DEFAULT_FLUX_NAMESPACE,
      kind: 'HelmRepository',
    },
    ...helmReleaseLifecycle(config, { driftDetection: { mode: 'enabled' } }),
    values: withChartValueDefaults({ crds: { create: true } }, config.values) as Record<
      string,
      unknown
    >,
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(createLabeledHelmReleaseEvaluator('Barman Cloud plugin')) as Enhanced<
    HelmReleaseSpec,
    HelmReleaseStatus
  >;
}
