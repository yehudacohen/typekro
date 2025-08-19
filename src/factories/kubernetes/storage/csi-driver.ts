import type { V1CSIDriver } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1CSIDriverSpec = NonNullable<V1CSIDriver['spec']>;

export function csiDriver(resource: V1CSIDriver): Enhanced<V1CSIDriverSpec, unknown> {
  return createResource({
    ...resource,
    apiVersion: 'storage.k8s.io/v1',
    kind: 'CSIDriver',
    metadata: resource.metadata ?? { name: 'unnamed-csidriver' },
  }).withReadinessEvaluator(() => {
    // CSIDriver is a configuration resource - ready when it exists
    return {
      ready: true,
      message: 'CSIDriver is ready when created (configuration resource)',
    };
  });
}
