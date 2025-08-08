import type { V1RuntimeClass } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1RuntimeClassHandler = V1RuntimeClass;

export function runtimeClass(resource: V1RuntimeClass): Enhanced<V1RuntimeClassHandler, unknown> {
  return createResource({
    ...resource,
    apiVersion: 'node.k8s.io/v1',
    kind: 'RuntimeClass',
    metadata: resource.metadata ?? { name: 'unnamed-runtimeclass' },
  });
}