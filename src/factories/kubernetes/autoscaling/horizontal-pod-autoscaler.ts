import type { V2HorizontalPodAutoscaler } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V2HpaSpec = NonNullable<V2HorizontalPodAutoscaler['spec']>;
export type V2HpaStatus = NonNullable<V2HorizontalPodAutoscaler['status']>;

export function horizontalPodAutoscaler(
  resource: V2HorizontalPodAutoscaler
): Enhanced<V2HpaSpec, V2HpaStatus> {
  return createResource({
    ...resource,
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: resource.metadata ?? { name: 'unnamed-hpa' },
  }).withReadinessEvaluator((liveResource: V2HorizontalPodAutoscaler) => {
    try {
      const status = liveResource.status;
      
      if (!status) {
        return { ready: false, reason: 'No status available' };
      }

      // HPA is ready when it can read metrics and has current replicas
      const ready = status.currentReplicas !== undefined;
      
      return {
        ready,
        reason: ready 
          ? `HPA is active with ${status.currentReplicas} current replicas`
          : 'HPA is not yet able to read metrics'
      };
    } catch (error) {
      return { 
        ready: false, 
        reason: `Error checking HPA status: ${error instanceof Error ? error.message : String(error)}` 
      };
    }
  });
}