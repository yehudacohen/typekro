import type { V1CSINode } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1CSINodeSpec = NonNullable<V1CSINode['spec']>;

export function csiNode(resource: V1CSINode): Enhanced<V1CSINodeSpec, unknown> {
  return createResource({
    ...resource,
    apiVersion: 'storage.k8s.io/v1',
    kind: 'CSINode',
    metadata: resource.metadata ?? { name: 'unnamed-csinode' },
  });
}
