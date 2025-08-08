import type { V1Node } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1NodeSpec = NonNullable<V1Node['spec']>;
export type V1NodeStatus = NonNullable<V1Node['status']>;

export function node(resource: V1Node): Enhanced<V1NodeSpec, V1NodeStatus> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'Node',
    metadata: resource.metadata ?? { name: 'unnamed-node' },
  });
}