import type { V1Ingress } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1IngressSpec = NonNullable<V1Ingress['spec']>;

export function ingress(resource: V1Ingress): Enhanced<V1IngressSpec, any> {
  return createResource({
    ...resource,
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: resource.metadata ?? { name: 'unnamed-ingress' },
  });
}