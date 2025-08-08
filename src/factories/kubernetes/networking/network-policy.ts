import type { V1NetworkPolicy } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1NetworkPolicySpec = NonNullable<V1NetworkPolicy['spec']>;

export function networkPolicy(resource: V1NetworkPolicy): Enhanced<V1NetworkPolicySpec, any> {
  return createResource({
    ...resource,
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: resource.metadata ?? { name: 'unnamed-networkpolicy' },
  });
}