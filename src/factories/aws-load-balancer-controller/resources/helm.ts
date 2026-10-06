// AWS Load Balancer Controller Helm resources: the eks-charts repository and
// the controller release.

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
  AWS_LBC_CHART_NAME,
  DEFAULT_AWS_LBC_CHART_VERSION,
  DEFAULT_AWS_LBC_CRDS_POLICY,
  DEFAULT_AWS_LBC_NAMESPACE,
  DEFAULT_AWS_LBC_REPOSITORY_NAME,
  DEFAULT_AWS_LBC_REPOSITORY_URL,
} from '../constants.js';
import type {
  AwsLoadBalancerControllerHelmReleaseConfig,
  AwsLoadBalancerControllerHelmRepositoryConfig,
} from '../types.js';

const repositoryReadinessEvaluator = createHelmRepositoryReadinessEvaluator(
  'AWS Load Balancer Controller'
);

/** Readiness of the controller `HelmRelease`, from its Flux conditions. */
export const awsLoadBalancerControllerHelmReleaseReadinessEvaluator: ReadinessEvaluator<unknown> =
  createLabeledHelmReleaseEvaluator('AWS Load Balancer Controller');

/**
 * Create the Flux `HelmRepository` for the eks-charts repository.
 *
 * @example
 * ```typescript
 * awsLoadBalancerControllerHelmRepository({ id: 'eksCharts' });
 * ```
 */
export function awsLoadBalancerControllerHelmRepository(
  config: Composable<AwsLoadBalancerControllerHelmRepositoryConfig> = {}
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return createResource<HelmRepositorySpec, HelmRepositoryStatus>({
    ...(config.id ? { id: config.id } : {}),
    apiVersion: 'source.toolkit.fluxcd.io/v1',
    kind: 'HelmRepository',
    metadata: {
      name: config.name ?? DEFAULT_AWS_LBC_REPOSITORY_NAME,
      namespace: config.namespace ?? DEFAULT_FLUX_NAMESPACE,
    },
    spec: {
      url: config.url ?? DEFAULT_AWS_LBC_REPOSITORY_URL,
      interval: config.interval ?? '1h',
    },
  }).withReadinessEvaluator(repositoryReadinessEvaluator);
}

/**
 * Create the Flux `HelmRelease` installing the AWS Load Balancer Controller.
 *
 * The chart ships its CRDs in `crds/`, so `install.crds` and `upgrade.crds`
 * default to `CreateReplace`: Flux skips `crds/` on upgrade otherwise. Every
 * lifecycle field can be overridden; see "Install, upgrade and CRD policy" in
 * the Flux docs.
 *
 * @example
 * ```typescript
 * awsLoadBalancerControllerHelmRelease({
 *   name: 'aws-load-balancer-controller',
 *   values: mapAwsLoadBalancerControllerConfigToHelmValues({
 *     name: 'aws-load-balancer-controller',
 *     clusterName: 'prod',
 *   }),
 * });
 * ```
 */
export function awsLoadBalancerControllerHelmRelease(
  config: Composable<AwsLoadBalancerControllerHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  const namespace = config.namespace ?? DEFAULT_FLUX_NAMESPACE;
  return createResource<HelmReleaseSpec, HelmReleaseStatus>({
    ...(config.id ? { id: config.id } : {}),
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: { name: config.name, namespace },
    spec: {
      interval: config.interval ?? '10m',
      chart: {
        spec: {
          chart: AWS_LBC_CHART_NAME,
          version: config.version ?? DEFAULT_AWS_LBC_CHART_VERSION,
          sourceRef: {
            kind: 'HelmRepository' as const,
            name: config.repositoryName ?? DEFAULT_AWS_LBC_REPOSITORY_NAME,
            namespace: config.repositoryNamespace ?? namespace,
          },
        },
      },
      targetNamespace: config.targetNamespace ?? DEFAULT_AWS_LBC_NAMESPACE,
      // Without it Flux names the release `<targetNamespace>-<name>`, which
      // moves whenever the install namespace does and renames the chart's
      // objects with it.
      releaseName: config.name,
      ...helmReleaseLifecycle(config, {
        install: {
          timeout: '10m',
          remediation: { retries: 3 },
          createNamespace: true,
          crds: DEFAULT_AWS_LBC_CRDS_POLICY,
        },
        upgrade: {
          timeout: '10m',
          remediation: { retries: 3, remediateLastFailure: true, strategy: 'rollback' },
          crds: DEFAULT_AWS_LBC_CRDS_POLICY,
        },
      }),
      ...(config.values ? { values: config.values } : {}),
    },
  }).withReadinessEvaluator(awsLoadBalancerControllerHelmReleaseReadinessEvaluator);
}
