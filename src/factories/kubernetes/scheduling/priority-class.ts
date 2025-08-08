import type { V1PriorityClass } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function priorityClass(
  resource: V1PriorityClass
): V1PriorityClass & Enhanced<V1PriorityClass, object> {
  return createResource<V1PriorityClass, object>({
    ...resource,
    apiVersion: 'scheduling.k8s.io/v1',
    kind: 'PriorityClass',
    metadata: resource.metadata ?? { name: 'unnamed-priorityclass' },
  }) as V1PriorityClass & Enhanced<V1PriorityClass, object>;
}