import type { V1PodDisruptionBudget } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1PdbSpec = NonNullable<V1PodDisruptionBudget['spec']>;
export type V1PdbStatus = NonNullable<V1PodDisruptionBudget['status']>;

export function podDisruptionBudget(
  resource: V1PodDisruptionBudget
): Enhanced<V1PdbSpec, V1PdbStatus> {
  return createResource({
    ...resource,
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: resource.metadata ?? { name: 'unnamed-pdb' },
  }).withReadinessEvaluator((liveResource: V1PodDisruptionBudget) => {
    try {
      const status = liveResource.status;

      // Handle missing status gracefully
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'PodDisruptionBudget status not available yet',
        };
      }

      // PDB is ready when it has been processed and has status
      const currentHealthy = status.currentHealthy || 0;
      const desiredHealthy = status.desiredHealthy || 0;
      const expectedPods = status.expectedPods || 0;

      // PDB is ready when it has been processed by the controller
      if (expectedPods > 0 && currentHealthy >= desiredHealthy) {
        return {
          ready: true,
          message: `PodDisruptionBudget is ready with ${currentHealthy}/${expectedPods} healthy pods (desired: ${desiredHealthy})`,
        };
      } else if (expectedPods === 0) {
        return {
          ready: true,
          message: 'PodDisruptionBudget is ready (no matching pods)',
        };
      } else {
        return {
          ready: false,
          reason: 'InsufficientHealthyPods',
          message: `Waiting for healthy pods: ${currentHealthy}/${expectedPods} healthy (desired: ${desiredHealthy})`,
          details: { currentHealthy, desiredHealthy, expectedPods },
        };
      }
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating PodDisruptionBudget readiness: ${error}`,
        details: { error: String(error) },
      };
    }
  });
}
