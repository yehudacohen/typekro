// Vertical Pod Autoscaler Helm resources: the shared Fairwinds `HelmRepository`
// and the `vpa` `HelmRelease`.

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Composable, Enhanced, ReadinessEvaluator } from '../../../core/types/index.js';
import {
  createHelmRepositoryReadinessEvaluator,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import { createResource } from '../../shared.js';
import {
  DEFAULT_VPA_CHART_VERSION,
  DEFAULT_VPA_NAMESPACE,
  DEFAULT_VPA_REPOSITORY_NAME,
  DEFAULT_VPA_REPOSITORY_URL,
  VPA_CHART_NAME,
} from '../constants.js';
import type { VpaHelmReleaseConfig, VpaHelmRepositoryConfig } from '../types.js';

/** VPA `HelmRelease` readiness (the shared Flux evaluator). */
export const vpaHelmReleaseReadinessEvaluator: ReadinessEvaluator<unknown> =
  createLabeledHelmReleaseEvaluator('VPA');

/**
 * Create the Flux `HelmRepository` for the Fairwinds stable charts.
 *
 * @example
 * ```typescript
 * vpaHelmRepository({ id: 'vpaRepository' });
 * ```
 */
export function vpaHelmRepository(
  config: Composable<VpaHelmRepositoryConfig> = {}
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return createResource<HelmRepositorySpec, HelmRepositoryStatus>({
    ...(config.id ? { id: config.id } : {}),
    apiVersion: 'source.toolkit.fluxcd.io/v1',
    kind: 'HelmRepository',
    metadata: {
      name: config.name ?? DEFAULT_VPA_REPOSITORY_NAME,
      namespace: config.namespace ?? DEFAULT_FLUX_NAMESPACE,
    },
    spec: {
      url: config.url ?? DEFAULT_VPA_REPOSITORY_URL,
      interval: config.interval ?? '1h',
    },
  }).withReadinessEvaluator(createHelmRepositoryReadinessEvaluator('VPA'));
}

/**
 * Create the `HelmRelease` for the Fairwinds `vpa` chart.
 *
 * The chart ships its CRDs in `crds/`, which Helm alone never upgrades; Flux
 * creates and replaces them on install and on every upgrade (`CreateReplace`).
 *
 * @example
 * ```typescript
 * vpaHelmRelease({ name: 'vpa', values: { updater: { enabled: false } }, id: 'vpaRelease' });
 * ```
 */
export function vpaHelmRelease(
  config: Composable<VpaHelmReleaseConfig>
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
          chart: VPA_CHART_NAME,
          version: config.version ?? DEFAULT_VPA_CHART_VERSION,
          sourceRef: {
            kind: 'HelmRepository' as const,
            name: config.repositoryName ?? DEFAULT_VPA_REPOSITORY_NAME,
            namespace: config.repositoryNamespace ?? namespace,
          },
        },
      },
      targetNamespace: config.targetNamespace ?? DEFAULT_VPA_NAMESPACE,
      // Pinned so Flux does not compose `<targetNamespace>-<name>`.
      releaseName: config.name,
      install: {
        createNamespace: config.createNamespace ?? false,
        crds: 'CreateReplace',
        remediation: { retries: 3 },
      },
      upgrade: {
        crds: 'CreateReplace',
        remediation: { retries: 3, remediateLastFailure: true, strategy: 'rollback' },
      },
      driftDetection: { mode: 'enabled' },
      ...(config.values ? { values: config.values as Record<string, unknown> } : {}),
    },
  }).withReadinessEvaluator(vpaHelmReleaseReadinessEvaluator);
}
