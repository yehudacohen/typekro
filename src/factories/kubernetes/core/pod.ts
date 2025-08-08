import type { V1Pod } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource, processPodSpec } from '../../shared.js';

export type V1PodSpec = NonNullable<V1Pod['spec']>;
export type V1PodStatus = NonNullable<V1Pod['status']>;

export function pod(resource: V1Pod): Enhanced<V1PodSpec, V1PodStatus> {
  if (resource.spec) {
    const processed = processPodSpec(resource.spec);
    if (processed) {
      resource.spec = processed;
    }
  }
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: resource.metadata ?? { name: 'unnamed-pod' },
  });
}