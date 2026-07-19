import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import { helmRelease } from '../../helm/helm-release.js';
import {
  createHelmRepositoryReadinessEvaluator,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
  helmRepository,
} from '../../helm/helm-repository.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import type { HarborHelmReleaseConfig, HarborHelmRepositoryConfig } from '../types.js';

export const DEFAULT_HARBOR_REPOSITORY_URL = 'https://helm.goharbor.io';
export const DEFAULT_HARBOR_REPOSITORY_NAME = 'harbor';
export const HARBOR_CHART_NAME = 'harbor';
export const DEFAULT_HARBOR_CHART_VERSION = '1.19.1';
export const DEFAULT_HARBOR_VERSION = 'v2.15.1';

export function harborHelmRepository(
  config: Composable<HarborHelmRepositoryConfig>
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return helmRepository({
    name: config.name ?? DEFAULT_HARBOR_REPOSITORY_NAME,
    namespace: config.namespace ?? DEFAULT_FLUX_NAMESPACE,
    url: config.url ?? DEFAULT_HARBOR_REPOSITORY_URL,
    interval: config.interval ?? '5m',
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(createHelmRepositoryReadinessEvaluator('Harbor')) as Enhanced<
    HelmRepositorySpec,
    HelmRepositoryStatus
  >;
}

export function harborHelmRelease(
  config: Composable<HarborHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return helmRelease({
    name: config.name,
    namespace: config.namespace ?? 'harbor-system',
    chart: {
      repository: config.repositoryUrl ?? DEFAULT_HARBOR_REPOSITORY_URL,
      name: HARBOR_CHART_NAME,
      version: config.version ?? DEFAULT_HARBOR_CHART_VERSION,
    },
    sourceRef: {
      name: config.repositoryName ?? DEFAULT_HARBOR_REPOSITORY_NAME,
      namespace: config.repositoryNamespace ?? DEFAULT_FLUX_NAMESPACE,
      kind: 'HelmRepository',
    },
    driftDetection: { mode: 'enabled' },
    install: { timeout: '20m', remediation: { retries: 3 } },
    // Harbor may migrate its external database during an upgrade. Retrying the
    // same revision is bounded, but an automatic rollback to an older chart is
    // not universally safe once that migration has committed.
    upgrade: {
      timeout: '20m',
      remediation: { retries: 0, remediateLastFailure: false },
    },
    values: config.values ?? {},
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(createLabeledHelmReleaseEvaluator('Harbor')) as Enhanced<
    HelmReleaseSpec,
    HelmReleaseStatus
  >;
}
