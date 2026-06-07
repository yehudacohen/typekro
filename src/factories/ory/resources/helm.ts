/**
 * Ory Helm integration resources.
 *
 * These wrappers install the official Ory charts through Flux HelmRepository and
 * HelmRelease resources while preserving TypeKro resource ids and typed values.
 */

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Enhanced } from '../../../core/types/index.js';
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
  OryDefaultChartVersion,
  OryDefaultHelmRepositoryUrl,
  OryHelmReleaseConfigInput,
  OryHelmRepositoryFactory,
  OryHydraHelmReleaseFactory,
  OryHydraChartValues,
  OryKetoHelmReleaseFactory,
  OryKetoChartValues,
  OryKratosHelmReleaseFactory,
  OryKratosChartValues,
  OryOathkeeperHelmReleaseFactory,
  OryOathkeeperChartValues,
} from '../types.js';

type OryChartValues =
  | OryHydraChartValues
  | OryKratosChartValues
  | OryKetoChartValues
  | OryOathkeeperChartValues;

export const ORY_HELM_REPOSITORY_URL: OryDefaultHelmRepositoryUrl =
  'https://k8s.ory.sh/helm/charts';
export const ORY_CHART_VERSION: OryDefaultChartVersion = '0.62.0';

const oryHelmRepositoryReadinessEvaluator = createHelmRepositoryReadinessEvaluator('Ory');
const oryHelmReleaseReadinessEvaluator = createLabeledHelmReleaseEvaluator('Ory');

/** Create the official Ory HelmRepository resource. */
export const oryHelmRepository: OryHelmRepositoryFactory = (
  config
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> => {
  const url = config.url ?? ORY_HELM_REPOSITORY_URL;

  return helmRepository({
    ...(config.id && { id: config.id }),
    name: config.name ?? 'ory',
    namespace: config.namespace ?? DEFAULT_FLUX_NAMESPACE,
    url,
    interval: config.interval ?? '5m',
  }).withReadinessEvaluator(oryHelmRepositoryReadinessEvaluator);
};

function createOryHelmRelease(
  chart: 'hydra',
  config: OryHelmReleaseConfigInput<OryHydraChartValues>
): Enhanced<HelmReleaseSpec<OryHydraChartValues>, HelmReleaseStatus>;
function createOryHelmRelease(
  chart: 'kratos',
  config: OryHelmReleaseConfigInput<OryKratosChartValues>
): Enhanced<HelmReleaseSpec<OryKratosChartValues>, HelmReleaseStatus>;
function createOryHelmRelease(
  chart: 'keto',
  config: OryHelmReleaseConfigInput<OryKetoChartValues>
): Enhanced<HelmReleaseSpec<OryKetoChartValues>, HelmReleaseStatus>;
function createOryHelmRelease(
  chart: 'oathkeeper',
  config: OryHelmReleaseConfigInput<OryOathkeeperChartValues>
): Enhanced<HelmReleaseSpec<OryOathkeeperChartValues>, HelmReleaseStatus>;
function createOryHelmRelease<TValues extends OryChartValues>(
  chart: 'hydra' | 'kratos' | 'keto' | 'oathkeeper',
  config: OryHelmReleaseConfigInput<TValues>
): Enhanced<HelmReleaseSpec<TValues>, HelmReleaseStatus> {
  return helmRelease<TValues>({
    ...(config.id && { id: config.id }),
    name: config.name,
    namespace: config.namespace ?? 'default',
    interval: config.interval ?? '5m',
    chart: {
      repository: ORY_HELM_REPOSITORY_URL,
      name: chart,
      version: config.version ?? ORY_CHART_VERSION,
    },
    sourceRef: {
      name: config.repositoryName ?? 'ory',
      namespace: config.repositoryNamespace ?? DEFAULT_FLUX_NAMESPACE,
    },
    ...(config.values && { values: config.values }),
  }).withReadinessEvaluator(oryHelmReleaseReadinessEvaluator);
}

/** Create a Flux HelmRelease for the official Ory Hydra chart. */
export const hydraHelmRelease: OryHydraHelmReleaseFactory = (config) =>
  createOryHelmRelease('hydra', config);

/** Create a Flux HelmRelease for the official Ory Kratos chart. */
export const kratosHelmRelease: OryKratosHelmReleaseFactory = (config) =>
  createOryHelmRelease('kratos', config);

/** Create a Flux HelmRelease for the official Ory Keto chart. */
export const ketoHelmRelease: OryKetoHelmReleaseFactory = (config) =>
  createOryHelmRelease('keto', config);

/** Create a Flux HelmRelease for the official Ory Oathkeeper chart. */
export const oathkeeperHelmRelease: OryOathkeeperHelmReleaseFactory = (config) =>
  createOryHelmRelease('oathkeeper', config);
