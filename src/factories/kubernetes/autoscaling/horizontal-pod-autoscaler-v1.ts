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
  });
}