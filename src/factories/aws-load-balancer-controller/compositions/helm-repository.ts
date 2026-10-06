import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { awsLoadBalancerControllerHelmRepository } from '../resources/helm.js';
import {
  type AwsLoadBalancerControllerHelmRepositorySingletonSpec,
  AwsLoadBalancerControllerHelmRepositorySingletonSpecSchema,
  AwsLoadBalancerControllerHelmRepositorySingletonStatusSchema,
} from '../types.js';

/**
 * Shared eks-charts `HelmRepository` singleton, so one controller install's
 * teardown cannot delete the chart source another release still resolves.
 */
export const awsLoadBalancerControllerHelmRepositoryBootstrap: CallableComposition<
  AwsLoadBalancerControllerHelmRepositorySingletonSpec,
  { ready: boolean }
> = kubernetesComposition(
  {
    name: 'aws-load-balancer-controller-helm-repository',
    kind: 'AwsLoadBalancerControllerHelmRepository',
    spec: AwsLoadBalancerControllerHelmRepositorySingletonSpecSchema,
    status: AwsLoadBalancerControllerHelmRepositorySingletonStatusSchema,
  },
  (spec) => {
    const repository = awsLoadBalancerControllerHelmRepository({
      name: spec.name,
      namespace: spec.namespace,
      url: spec.url,
      id: 'repository',
    });
    return {
      ready: Cel.expr<boolean>(
        repository.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
    };
  }
);
