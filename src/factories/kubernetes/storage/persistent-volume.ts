import type { V1PersistentVolume } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1PvSpec = NonNullable<V1PersistentVolume['spec']>;
export type V1PvStatus = NonNullable<V1PersistentVolume['status']>;

export function persistentVolume(resource: V1PersistentVolume): Enhanced<V1PvSpec, V1PvStatus> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: resource.metadata ?? { name: 'unnamed-pv' },
  });
}