import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { setMetadataField } from '../../../core/metadata/resource-metadata.js';
import { Cel } from '../../../core/references/cel.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { helmRelease } from '../../helm/helm-release.js';
import {
  createHelmRepositoryReadinessEvaluator,
  helmRepository,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import type { OpenSearchOperatorHelmReleaseConfig } from '../types.js';

export const DEFAULT_OPENSEARCH_OPERATOR_REPOSITORY_URL =
  'https://opensearch-project.github.io/opensearch-k8s-operator/';
export const DEFAULT_OPENSEARCH_OPERATOR_REPOSITORY_NAME = 'opensearch-operator';
export const OPENSEARCH_OPERATOR_CHART_NAME = 'opensearch-operator';
export const DEFAULT_OPENSEARCH_OPERATOR_VERSION = '3.0.2';

export function openSearchOperatorHelmRepository(
  config: Composable<{
    readonly name?: string;
    readonly namespace?: string;
    readonly url?: string;
    readonly interval?: string;
    readonly id?: string;
  }>
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  const repository = helmRepository({
    name: config.name || DEFAULT_OPENSEARCH_OPERATOR_REPOSITORY_NAME,
    namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
    url: config.url || DEFAULT_OPENSEARCH_OPERATOR_REPOSITORY_URL,
    interval: config.interval || '5m',
    ...(config.id ? { id: config.id } : {}),
  }).withReadinessEvaluator(
    createHelmRepositoryReadinessEvaluator('OpenSearch')
  ) as Enhanced<HelmRepositorySpec, HelmRepositoryStatus>;
  setMetadataField(repository, 'scopes', ['cluster']);
  return repository;
}

export function openSearchOperatorHelmRelease(
  config: Composable<OpenSearchOperatorHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return helmRelease({
    name: config.name,
    namespace: config.namespace,
    chart: {
      repository: DEFAULT_OPENSEARCH_OPERATOR_REPOSITORY_URL,
      name: OPENSEARCH_OPERATOR_CHART_NAME,
      version: config.version,
    },
    sourceRef: {
      name: config.repositoryName,
      namespace: config.repositoryNamespace,
      kind: 'HelmRepository',
    },
    driftDetection: { mode: 'enabled' },
    values: isKubernetesRef(config.values)
      ? Cel.default(config.values, {})
      : (config.values ?? {}),
    ...(config.id ? { id: config.id } : {}),
  }).withReadinessEvaluator(
    createLabeledHelmReleaseEvaluator('OpenSearch')
  ) as Enhanced<HelmReleaseSpec, HelmReleaseStatus>;
}
