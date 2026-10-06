// KEDA Helm resources: the shared kedacore `HelmRepository`
// and the `keda` `HelmRelease`.

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Composable, Enhanced, ReadinessEvaluator } from '../../../core/types/index.js';
import {
  createHelmRepositoryReadinessEvaluator,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { helmReleaseLifecycle } from '../../helm/lifecycle.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import { createResource } from '../../shared.js';
import {
  DEFAULT_KEDA_CHART_VERSION,
  DEFAULT_KEDA_NAMESPACE,
  DEFAULT_KEDA_REPOSITORY_NAME,
  DEFAULT_KEDA_REPOSITORY_URL,
  KEDA_CHART_NAME,
} from '../constants.js';
import type { KedaHelmReleaseConfig, KedaHelmRepositoryConfig } from '../types.js';

/** KEDA `HelmRelease` readiness (the shared Flux evaluator). */
export const kedaHelmReleaseReadinessEvaluator: ReadinessEvaluator<unknown> =
  createLabeledHelmReleaseEvaluator('KEDA');

/**
 * Create the Flux `HelmRepository` for the official kedacore charts.
 *
 * @example
 * ```typescript
 * kedaHelmRepository({ id: 'kedaRepository' });
 * ```
 */
export function kedaHelmRepository(
  config: Composable<KedaHelmRepositoryConfig> = {}
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return createResource<HelmRepositorySpec, HelmRepositoryStatus>({
    ...(config.id ? { id: config.id } : {}),
    apiVersion: 'source.toolkit.fluxcd.io/v1',
    kind: 'HelmRepository',
    metadata: {
      name: config.name ?? DEFAULT_KEDA_REPOSITORY_NAME,
      namespace: config.namespace ?? DEFAULT_FLUX_NAMESPACE,
    },
    spec: {
      url: config.url ?? DEFAULT_KEDA_REPOSITORY_URL,
      interval: config.interval ?? '1h',
    },
  }).withReadinessEvaluator(createHelmRepositoryReadinessEvaluator('KEDA'));
}

/**
 * Create the `HelmRelease` for the kedacore `keda` chart. The chart renders
 * its CRDs as templates (`crds.install`), so they upgrade with the release.
 *
 * @example
 * ```typescript
 * kedaHelmRelease({ name: 'keda', values: { watchNamespace: 'apps' }, id: 'kedaRelease' });
 * ```
 */
export function kedaHelmRelease(
  config: Composable<KedaHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  const namespace = config.namespace ?? DEFAULT_FLUX_NAMESPACE;
  return createResource<HelmReleaseSpec, HelmReleaseStatus>({
    ...(config.id ? { id: config.id } : {}),
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: { name: config.name, namespace },
    spec: {
      interval: '10m',
      timeout: '10m',
      chart: {
        spec: {
          chart: KEDA_CHART_NAME,
          version: config.version ?? DEFAULT_KEDA_CHART_VERSION,
          sourceRef: {
            kind: 'HelmRepository' as const,
            name: config.repositoryName ?? DEFAULT_KEDA_REPOSITORY_NAME,
            namespace: config.repositoryNamespace ?? namespace,
          },
        },
      },
      targetNamespace: config.targetNamespace ?? DEFAULT_KEDA_NAMESPACE,
      // Pinned so Flux does not compose `<targetNamespace>-<name>`.
      releaseName: config.name,
      // The KEDA policy, through the shared lifecycle helper: caller `install`,
      // `upgrade` and `driftDetection` override it field by field. Install and
      // upgrade take their timeout from `spec.timeout`.
      ...helmReleaseLifecycle(config, {
        install: {
          createNamespace: config.createNamespace ?? false,
          remediation: { retries: 3 },
        },
        upgrade: {
          remediation: { retries: 3, remediateLastFailure: true, strategy: 'rollback' },
        },
        driftDetection: { mode: 'enabled' },
      }),
      ...(config.values ? { values: config.values as Record<string, unknown> } : {}),
    },
  }).withReadinessEvaluator(kedaHelmReleaseReadinessEvaluator);
}
