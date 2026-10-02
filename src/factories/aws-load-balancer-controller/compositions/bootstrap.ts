// `awsLoadBalancerControllerBootstrap`: installs the AWS Load Balancer
// Controller through Flux.
//
// It owns the controller `HelmRelease` and delegates the shared eks-charts
// `HelmRepository` to a singleton. It creates no Namespace (the default,
// kube-system, always exists; Flux creates any other) and no AWS resources:
// the IAM role, its policy and the subnet tags are prerequisites.

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import {
  DEFAULT_AWS_LBC_CHART_VERSION,
  DEFAULT_AWS_LBC_NAMESPACE,
  DEFAULT_AWS_LBC_REPOSITORY_NAME,
  DEFAULT_AWS_LBC_REPOSITORY_URL,
} from '../constants.js';
import { awsLoadBalancerControllerHelmRelease } from '../resources/helm.js';
import {
  type AwsLoadBalancerControllerBootstrapConfig,
  AwsLoadBalancerControllerBootstrapConfigSchema,
  type AwsLoadBalancerControllerBootstrapOptions,
  type AwsLoadBalancerControllerBootstrapStatus,
  AwsLoadBalancerControllerBootstrapStatusSchema,
} from '../types.js';
import { mapAwsLoadBalancerControllerConfigToHelmValues } from '../utils/helm-values-mapper.js';
import { awsLoadBalancerControllerHelmRepositoryBootstrap } from './helm-repository.js';

const RELEASE_ID = 'awsLoadBalancerControllerHelmRelease';

// The chart version Flux INSTALLED, from the release history (newest first).
// A projection, not a spec echo: KRO drops status fields that reference no
// resource. Same shape as the Traefik bootstrap's, for the same cel-go /
// cel-js reasons: a lazy ternary, and `filter` instead of `has(history[0].x)`.
const INSTALLED_CHART_VERSION = (() => {
  const history = `${RELEASE_ID}.status.history`;
  const matching = `${history}.filter(entry, has(entry.chartVersion))`;
  return `has(${history}) ? (size(${matching}) > 0 ? ${matching}[0].chartVersion : "") : ""`;
})();

/**
 * Build an AWS Load Balancer Controller bootstrap composition.
 *
 * Use it to set the release's install/upgrade/CRD policy or to pass raw chart
 * values. Options are build-time and must be concrete.
 *
 * @example
 * ```typescript
 * const lbc = makeAwsLoadBalancerControllerBootstrap({
 *   upgrade: { timeout: '20m' },
 *   values: { enableShield: false },
 * });
 * ```
 */
export function makeAwsLoadBalancerControllerBootstrap(
  options: AwsLoadBalancerControllerBootstrapOptions = {}
): CallableComposition<
  AwsLoadBalancerControllerBootstrapConfig,
  AwsLoadBalancerControllerBootstrapStatus
> {
  return kubernetesComposition(
    {
      name: options.name ?? 'aws-load-balancer-controller-bootstrap',
      kind: options.kind ?? 'AwsLoadBalancerControllerBootstrap',
      spec: AwsLoadBalancerControllerBootstrapConfigSchema,
      status: AwsLoadBalancerControllerBootstrapStatusSchema,
    },
    (spec) => {
      singleton(awsLoadBalancerControllerHelmRepositoryBootstrap, {
        id: 'eksChartsHelmRepository',
        spec: {
          name: DEFAULT_AWS_LBC_REPOSITORY_NAME,
          namespace: DEFAULT_FLUX_NAMESPACE,
          url: DEFAULT_AWS_LBC_REPOSITORY_URL,
        },
      });

      const release = awsLoadBalancerControllerHelmRelease({
        name: spec.name,
        namespace: DEFAULT_FLUX_NAMESPACE,
        targetNamespace: Cel.default(spec.namespace, DEFAULT_AWS_LBC_NAMESPACE),
        version: Cel.default(spec.chartVersion, DEFAULT_AWS_LBC_CHART_VERSION),
        repositoryName: DEFAULT_AWS_LBC_REPOSITORY_NAME,
        repositoryNamespace: DEFAULT_FLUX_NAMESPACE,
        ...(options.install ? { install: options.install } : {}),
        ...(options.upgrade ? { upgrade: options.upgrade } : {}),
        ...(options.driftDetection ? { driftDetection: options.driftDetection } : {}),
        values: mapAwsLoadBalancerControllerConfigToHelmValues(spec, options.values),
        id: RELEASE_ID,
      });

      const releaseStatus = helmReleaseConditionSummary(release);
      return {
        ready: releaseStatus.ready,
        failed: releaseStatus.failed,
        phase: releaseStatus.phase,
        version: Cel.expr<string>(INSTALLED_CHART_VERSION),
      };
    }
  );
}

/**
 * The default AWS Load Balancer Controller bootstrap.
 *
 * @example
 * ```typescript
 * const factory = awsLoadBalancerControllerBootstrap.factory('kro', { namespace: 'platform' });
 * await factory.deploy({
 *   name: 'aws-load-balancer-controller',
 *   clusterName: 'prod',
 *   region: 'us-east-1',
 *   vpcId: 'vpc-0123456789abcdef0',
 *   serviceAccount: {
 *     annotations: {
 *       'eks.amazonaws.com/role-arn': 'arn:aws:iam::111122223333:role/aws-load-balancer-controller',
 *     },
 *   },
 * });
 * ```
 */
export const awsLoadBalancerControllerBootstrap: CallableComposition<
  AwsLoadBalancerControllerBootstrapConfig,
  AwsLoadBalancerControllerBootstrapStatus
> = makeAwsLoadBalancerControllerBootstrap();
