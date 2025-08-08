import type { V1PersistentVolumeClaim } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1PvcSpec = NonNullable<V1PersistentVolumeClaim['spec']>;
export type V1PvcStatus = NonNullable<V1PersistentVolumeClaim['status']>;

export function persistentVolumeClaim(
  resource: V1PersistentVolumeClaim
): Enhanced<V1PvcSpec, V1PvcStatus> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: resource.metadata ?? { name: 'unnamed-pvc' },
  });
}