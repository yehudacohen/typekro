import type { V1IngressClass } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1IngressClassSpec = NonNullable<V1IngressClass['spec']>;

export function ingressClass(resource: V1IngressClass): Enhanced<V1IngressClassSpec, unknown> {
  return createResource({
    ...resource,
    apiVersion: 'networking.k8s.io/v1',
    kind: 'IngressClass',
    metadata: resource.metadata ?? { name: 'unnamed-ingressclass' },
  });
}