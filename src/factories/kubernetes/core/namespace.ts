import type { V1Namespace } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1NamespaceSpec = NonNullable<V1Namespace['spec']>;
export type V1NamespaceStatus = NonNullable<V1Namespace['status']>;

export function namespace(resource: V1Namespace): Enhanced<V1NamespaceSpec, V1NamespaceStatus> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: resource.metadata ?? { name: 'unnamed-namespace' },
  });
}