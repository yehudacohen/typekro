/**
 * Dagster Helm resource factories.
 *
 * These wrappers apply official Dagster chart defaults while delegating resource
 * construction and graph-aware Helm values serialization to TypeKro's generic
 * Flux Helm factories.
 */

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { setMetadataField } from '../../../core/metadata/resource-metadata.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import {
  createHelmRepositoryReadinessEvaluator,
  helmRepository,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { helmRelease } from '../../helm/helm-release.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import type {
  DagsterHelmReleaseConfig,
  DagsterHelmRepositoryConfig,
  DagsterHelmValues,
} from '../types.js';

/** Default official Dagster Helm repository URL. */
export const DEFAULT_DAGSTER_REPO_URL = 'https://dagster-io.github.io/helm';

/** Default Flux HelmRepository name for the official Dagster chart. */
export const DEFAULT_DAGSTER_REPO_NAME = 'dagster';

/** Default official Dagster Helm chart version selected by the approved plan. */
export const DEFAULT_DAGSTER_VERSION = '1.13.8';

/**
 * Create a Flux HelmRepository for the official Dagster Helm chart repository.
 *
 * @param config - Repository configuration with Dagster defaults
 * @returns Enhanced HelmRepository resource
 */
export function dagsterHelmRepository(
  config: Composable<DagsterHelmRepositoryConfig>
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  const repo = helmRepository({
    name: config.name || DEFAULT_DAGSTER_REPO_NAME,
    namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
    url: config.url || DEFAULT_DAGSTER_REPO_URL,
    interval: config.interval || '5m',
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(
    createHelmRepositoryReadinessEvaluator('Dagster')
  ) as Enhanced<HelmRepositorySpec, HelmRepositoryStatus>;

  setMetadataField(repo, 'scopes', ['cluster']);

  return repo;
}

/**
 * Create a Flux HelmRelease for Dagster using the official chart defaults.
 *
 * @param config - Release configuration with Dagster defaults
 * @returns Enhanced HelmRelease resource
 */
export function dagsterHelmRelease(
  config: Composable<DagsterHelmReleaseConfig>
): Enhanced<HelmReleaseSpec<DagsterHelmValues>, HelmReleaseStatus> {
  return helmRelease<DagsterHelmValues>({
    name: config.name,
    namespace: config.namespace || config.name,
    chart: {
      repository: DEFAULT_DAGSTER_REPO_URL,
      name: 'dagster',
      version: config.version || DEFAULT_DAGSTER_VERSION,
    },
    sourceRef: {
      name: config.repositoryName || DEFAULT_DAGSTER_REPO_NAME,
      namespace: config.repositoryNamespace || DEFAULT_FLUX_NAMESPACE,
      kind: 'HelmRepository',
    },
    ...(config.values !== undefined && { values: config.values }),
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(createLabeledHelmReleaseEvaluator('Dagster')) as Enhanced<
    HelmReleaseSpec<DagsterHelmValues>,
    HelmReleaseStatus
  >;
}