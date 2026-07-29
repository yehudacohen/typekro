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
import type { HatchetHelmReleaseConfig, HatchetHelmRepositoryConfig } from '../types.js';

export const DEFAULT_HATCHET_REPOSITORY_URL = 'https://hatchet-dev.github.io/hatchet-charts';
export const DEFAULT_HATCHET_REPOSITORY_NAME = 'hatchet';
export const HATCHET_CHART_NAME = 'hatchet-stack';
export const DEFAULT_HATCHET_CHART_VERSION = '0.13.3';
export const DEFAULT_HATCHET_SERVER_VERSION = 'v0.94.10';

export function hatchetHelmRepository(
  config: Composable<HatchetHelmRepositoryConfig>
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return helmRepository({
    name: config.name ?? DEFAULT_HATCHET_REPOSITORY_NAME,
    namespace: config.namespace ?? 'flux-system',
    url: config.url ?? DEFAULT_HATCHET_REPOSITORY_URL,
    interval: config.interval ?? '5m',
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(createHelmRepositoryReadinessEvaluator('Hatchet')) as Enhanced<
    HelmRepositorySpec,
    HelmRepositoryStatus
  >;
}

export function hatchetHelmRelease(
  config: Composable<HatchetHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return helmRelease({
    name: config.name,
    namespace: config.namespace ?? 'hatchet-system',
    chart: {
      repository: config.repositoryUrl ?? DEFAULT_HATCHET_REPOSITORY_URL,
      name: HATCHET_CHART_NAME,
      version: config.version ?? DEFAULT_HATCHET_CHART_VERSION,
    },
    sourceRef: {
      name: config.repositoryName ?? DEFAULT_HATCHET_REPOSITORY_NAME,
      namespace: config.repositoryNamespace ?? config.namespace ?? 'hatchet-system',
      kind: 'HelmRepository',
    },
    driftDetection: { mode: 'enabled' },
    install: {
      timeout: '20m',
      remediation: { retries: 3, remediateLastFailure: true },
    },
    // Hatchet upgrades may commit PostgreSQL migrations. Retry the desired
    // revision, but never automatically roll back to an older server after a
    // migration has succeeded.
    upgrade: {
      timeout: '20m',
      remediation: { retries: 0, remediateLastFailure: false },
    },
    ...(config.valuesFrom && { valuesFrom: config.valuesFrom }),
    values: config.values ?? {},
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(createLabeledHelmReleaseEvaluator('Hatchet')) as Enhanced<
    HelmReleaseSpec,
    HelmReleaseStatus
  >;
}
