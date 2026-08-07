import type { Enhanced } from '../../../core/types/index.js';
import { helmRelease } from '../../helm/helm-release.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import { helmRepository } from '../../helm/helm-repository.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import type { HelmRepositorySpec, HelmRepositoryStatus } from '../../helm/helm-repository.js';
import type { NatsHelmValues } from '../types.js';

export const DEFAULT_NATS_REPOSITORY_URL = 'https://nats-io.github.io/k8s/helm/charts/';
export const DEFAULT_NATS_REPOSITORY_NAME = 'nats';
export const DEFAULT_NACK_REPOSITORY_NAME = 'nack-controller';
export const DEFAULT_NATS_VERSION = '2.14.0';
export const DEFAULT_NACK_VERSION = '0.34.0';

export function natsHelmRepository(config: {
  name?: string;
  namespace?: string;
  url?: string;
  id?: string;
}): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return helmRepository({
    name: config.name ?? DEFAULT_NATS_REPOSITORY_NAME,
    namespace: config.namespace ?? 'flux-system',
    url: config.url ?? DEFAULT_NATS_REPOSITORY_URL,
    interval: '5m',
    ...(config.id && { id: config.id }),
  }) as Enhanced<HelmRepositorySpec, HelmRepositoryStatus>;
}

function natsChartRelease(config: {
  name: string;
  namespace: string;
  chart: 'nats' | 'nack';
  version: string;
  values: NatsHelmValues;
  repositoryName?: string;
  repositoryNamespace?: string;
  repositoryUrl?: string;
  id?: string;
}): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return helmRelease({
    name: config.name,
    namespace: config.namespace,
    chart: {
      repository: config.repositoryUrl ?? DEFAULT_NATS_REPOSITORY_URL,
      name: config.chart,
      version: config.version,
    },
    sourceRef: {
      name: config.repositoryName ?? DEFAULT_NATS_REPOSITORY_NAME,
      namespace: config.repositoryNamespace ?? config.namespace,
      kind: 'HelmRepository',
    },
    driftDetection: { mode: 'enabled' },
    values: config.values,
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(createLabeledHelmReleaseEvaluator('NATS')) as Enhanced<
    HelmReleaseSpec,
    HelmReleaseStatus
  >;
}

export function natsHelmRelease(
  config: Parameters<typeof natsChartRelease>[0]
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return natsChartRelease(config);
}
