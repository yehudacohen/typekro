import type { V1StorageClass } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function storageClass(
  resource: V1StorageClass
): V1StorageClass & Enhanced<V1StorageClass, object> {
  return createResource<V1StorageClass, object>({
    ...resource,
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: resource.metadata ?? { name: 'unnamed-storageclass' },
  }).withReadinessEvaluator((_liveResource: V1StorageClass) => {
    // StorageClasses are ready when they exist - they're configuration objects
    // that don't have complex status conditions
    return {
      ready: true,
      message: 'StorageClass is ready',
    };
  }) as V1StorageClass & Enhanced<V1StorageClass, object>;
}
