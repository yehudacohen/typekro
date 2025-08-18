import type { V1ConfigMap } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1ConfigMapData = NonNullable<V1ConfigMap['data']>;

export function configMap(resource: V1ConfigMap): Enhanced<V1ConfigMapData, unknown> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: resource.metadata ?? { name: 'unnamed-configmap' },
  }).withReadinessEvaluator((liveResource: V1ConfigMap) => {
    // ConfigMaps are ready when they exist - they're just data storage
    return {
      ready: true,
      message: 'ConfigMap is ready when created',
    };
  });
}