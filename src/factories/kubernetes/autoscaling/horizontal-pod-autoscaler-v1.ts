import type { V1HorizontalPodAutoscaler } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1HpaSpec = NonNullable<V1HorizontalPodAutoscaler['spec']>;
export type V1HpaStatus = NonNullable<V1HorizontalPodAutoscaler['status']>;

export function horizontalPodAutoscalerV1(
  resource: V1HorizontalPodAutoscaler
): Enhanced<V1HpaSpec, V1HpaStatus> {
  return createResource({
    ...resource,
    apiVersion: 'autoscaling/v1',
    kind: 'HorizontalPodAutoscaler',
    metadata: resource.metadata ?? { name: 'unnamed-hpa-v1' },
  }).withReadinessEvaluator((liveResource: V1HorizontalPodAutoscaler) => {
    const status = liveResource.status;
    const spec = liveResource.spec;
    
    if (!status) {
      return {
        ready: false,
        reason: 'StatusMissing',
        message: 'HorizontalPodAutoscaler status not available yet',
      };
    }

    const currentReplicas = status.currentReplicas || 0;
    const desiredReplicas = status.desiredReplicas || 0;
    const minReplicas = spec?.minReplicas || 1;
    const maxReplicas = spec?.maxReplicas || 1;

    // HPA is ready when it has valid current replicas within bounds
    const ready = currentReplicas > 0 && 
                  currentReplicas >= minReplicas && 
                  currentReplicas <= maxReplicas &&
                  desiredReplicas > 0;

    return {
      ready,
      message: ready
        ? `HPA is active with ${currentReplicas} current replicas (desired: ${desiredReplicas})`
        : `HPA is scaling: ${currentReplicas} current replicas (desired: ${desiredReplicas}, min: ${minReplicas}, max: ${maxReplicas})`,
    };
  });
}
