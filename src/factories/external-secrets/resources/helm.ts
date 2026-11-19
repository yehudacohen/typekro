// External Secrets Operator Helm resources: the chart repository and the controller release.
// The chart templates its CRDs (`installCRDs: true`), so Helm upgrades them with the chart and
// no Flux CRD policy is needed.

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import {
  createHelmRepositoryReadinessEvaluator,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
  helmRepository,
} from '../../helm/helm-repository.js';
import { helmReleaseLifecycle } from '../../helm/lifecycle.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import { createResource } from '../../shared.js';
import {
  DEFAULT_EXTERNAL_SECRETS_CHART_VERSION,
  DEFAULT_EXTERNAL_SECRETS_NAMESPACE,
  DEFAULT_EXTERNAL_SECRETS_REPOSITORY_NAME,
  DEFAULT_EXTERNAL_SECRETS_REPOSITORY_URL,
  EXTERNAL_SECRETS_CHART_NAME,
} from '../constants.js';
import type {
  ExternalSecretsHelmReleaseConfig,
  ExternalSecretsHelmRepositoryConfig,
} from '../types.js';

/** The chart's HTTP HelmRepository. */
export function externalSecretsHelmRepository(
  config: Composable<ExternalSecretsHelmRepositoryConfig> = {}
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return helmRepository({
    name: config.name ?? DEFAULT_EXTERNAL_SECRETS_REPOSITORY_NAME,
    namespace: config.namespace ?? DEFAULT_FLUX_NAMESPACE,
    url: config.url ?? DEFAULT_EXTERNAL_SECRETS_REPOSITORY_URL,
    interval: config.interval ?? '1h',
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(createHelmRepositoryReadinessEvaluator('External Secrets')) as Enhanced<
    HelmRepositorySpec,
    HelmRepositoryStatus
  >;
}

/** The HelmRelease that installs the External Secrets Operator and its CRDs. */
export function externalSecretsHelmRelease(
  config: Composable<ExternalSecretsHelmReleaseConfig>
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
          chart: EXTERNAL_SECRETS_CHART_NAME,
          version: config.version ?? DEFAULT_EXTERNAL_SECRETS_CHART_VERSION,
          sourceRef: {
            kind: 'HelmRepository' as const,
            name: config.repositoryName ?? DEFAULT_EXTERNAL_SECRETS_REPOSITORY_NAME,
            namespace: config.repositoryNamespace ?? namespace,
          },
        },
      },
      targetNamespace: config.targetNamespace ?? DEFAULT_EXTERNAL_SECRETS_NAMESPACE,
      // Pinned so Flux does not compose `<targetNamespace>-<name>`.
      releaseName: config.name,
      ...helmReleaseLifecycle(config, {
        install: { createNamespace: config.createNamespace ?? true, remediation: { retries: 3 } },
        upgrade: { remediation: { retries: 3, remediateLastFailure: true, strategy: 'rollback' } },
        driftDetection: { mode: 'enabled' },
      }),
      ...(config.values ? { values: config.values as Record<string, unknown> } : {}),
    },
  }).withReadinessEvaluator(createLabeledHelmReleaseEvaluator('External Secrets'));
}
