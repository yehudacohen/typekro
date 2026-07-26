import type { V1PodDisruptionBudget } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1PdbSpec = NonNullable<V1PodDisruptionBudget['spec']>;
export type V1PdbStatus = NonNullable<V1PodDisruptionBudget['status']>;

const podDisruptionBudgetReadinessEvaluator = registerPortableReadinessEvaluator(
  'typekro.readiness.kubernetes.pod-disruption-budget',
  '1',
  (liveResource: V1PodDisruptionBudget) => {
    try {
      const status = liveResource.status;
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'PodDisruptionBudget status not available yet',
        };
      }

      const currentHealthy = status.currentHealthy || 0;
      const desiredHealthy = status.desiredHealthy || 0;
      const expectedPods = status.expectedPods || 0;

      if (expectedPods > 0 && currentHealthy >= desiredHealthy) {
        return {
          ready: true,
          message: `PodDisruptionBudget is ready with ${currentHealthy}/${expectedPods} healthy pods (desired: ${desiredHealthy})`,
        };
      }
      if (expectedPods === 0) {
        return { ready: true, message: 'PodDisruptionBudget is ready (no matching pods)' };
      }
      return {
        ready: false,
        reason: 'InsufficientHealthyPods',
        message: `Waiting for healthy pods: ${currentHealthy}/${expectedPods} healthy (desired: ${desiredHealthy})`,
        details: { currentHealthy, desiredHealthy, expectedPods },
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating PodDisruptionBudget readiness: ${ensureError(error).message}`,
        details: { error: ensureError(error).message },
      };
    }
  }
);

export function podDisruptionBudget(
  resource: V1PodDisruptionBudget & { id?: string }
): Enhanced<V1PdbSpec, V1PdbStatus> {
  return createResource({
    ...resource,
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: resource.metadata ?? { name: 'unnamed-pdb' },
  }).withReadinessEvaluator(podDisruptionBudgetReadinessEvaluator);
}
