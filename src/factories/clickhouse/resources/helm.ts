/**
 * ClickHouse Operator Helm Resource Factories
 *
 * Wrappers around the generic Helm factories with Altinity-specific defaults.
 * Used by the `clickhouseOperatorBootstrap` composition to install the
 * OFFICIAL Altinity clickhouse-operator (build-around: we wrap the official
 * chart rather than hand-rolling operator manifests).
 *
 * Chart: `altinity-clickhouse-operator` from https://helm.altinity.com
 * (Apache-2.0). The operator is cluster-scoped and owns the ClickHouse CRDs —
 * exactly ONE install per cluster.
 */

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { setMetadataField } from '../../../core/metadata/resource-metadata.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import { helmRelease } from '../../helm/helm-release.js';
import {
  createHelmRepositoryReadinessEvaluator,
  helmRepository,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import type {
  ClickHouseHelmRepositoryConfig,
  ClickHouseOperatorHelmReleaseConfig,
} from '../types.js';

/** Official Altinity Helm chart repository URL. */
export const DEFAULT_CLICKHOUSE_REPO_URL = 'https://helm.altinity.com';

/** Default Flux HelmRepository name for the Altinity chart repository. */
export const DEFAULT_CLICKHOUSE_REPO_NAME = 'altinity';

/** Official operator chart name. */
export const CLICKHOUSE_OPERATOR_CHART_NAME = 'altinity-clickhouse-operator';

/** Default altinity-clickhouse-operator chart version. */
export const DEFAULT_CLICKHOUSE_OPERATOR_VERSION = '0.27.1';

/**
 * Create a Flux HelmRepository for the official Altinity chart repository.
 *
 * @param config - Repository configuration with Altinity defaults
 * @returns Enhanced HelmRepository resource
 *
 * @example
 * ```typescript
 * const repo = clickhouseHelmRepository({
 *   name: 'altinity',
 *   namespace: 'flux-system',
 *   id: 'clickhouseHelmRepository',
 * });
 * ```
 */
export function clickhouseHelmRepository(
  config: Composable<ClickHouseHelmRepositoryConfig>
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  const repo = helmRepository({
    name: config.name || DEFAULT_CLICKHOUSE_REPO_NAME,
    namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
    url: config.url || DEFAULT_CLICKHOUSE_REPO_URL,
    interval: config.interval || '5m',
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(
    createHelmRepositoryReadinessEvaluator('ClickHouse')
  ) as Enhanced<HelmRepositorySpec, HelmRepositoryStatus>;

  // The chart repository is one cluster-level Flux source shared by every
  // consumer — never torn down with an individual instance.
  setMetadataField(repo, 'scopes', ['cluster']);

  return repo;
}

/**
 * Create a Flux HelmRelease for the Altinity clickhouse-operator.
 *
 * IMPORTANT: the operator owns the ClickHouse CRDs and watches cluster-wide —
 * install exactly ONE release per cluster (enforced by convention via the
 * `shared` default in `clickhouseOperatorBootstrap`).
 *
 * @param config - Release configuration with Altinity defaults
 * @returns Enhanced HelmRelease resource
 *
 * @example
 * ```typescript
 * const release = clickhouseOperatorHelmRelease({
 *   name: 'clickhouse-operator',
 *   namespace: 'clickhouse-system',
 *   version: '0.27.1',
 *   id: 'clickhouseOperatorHelmRelease',
 * });
 * ```
 */
export function clickhouseOperatorHelmRelease(
  config: Composable<ClickHouseOperatorHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  // Pass values directly — the core proxy system handles serialization.
  return helmRelease({
    name: config.name,
    namespace: config.namespace || 'clickhouse-system',
    chart: {
      repository: DEFAULT_CLICKHOUSE_REPO_URL,
      name: CLICKHOUSE_OPERATOR_CHART_NAME,
      version: config.version || DEFAULT_CLICKHOUSE_OPERATOR_VERSION,
    },
    sourceRef: {
      name: config.repositoryName || DEFAULT_CLICKHOUSE_REPO_NAME,
      namespace: DEFAULT_FLUX_NAMESPACE,
      kind: 'HelmRepository',
    },
    driftDetection: { mode: 'enabled' },
    values: config.values || {},
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(
    createLabeledHelmReleaseEvaluator('ClickHouse')
  ) as Enhanced<HelmReleaseSpec, HelmReleaseStatus>;
}
