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
  });
}