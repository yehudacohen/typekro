import type { V1NetworkPolicy } from '@kubernetes/client-node';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1NetworkPolicySpec = NonNullable<V1NetworkPolicy['spec']>;

export function networkPolicy(
  resource: V1NetworkPolicy & { id?: string }
): Enhanced<V1NetworkPolicySpec, object> {
  return createResource({
    ...resource,
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: resource.metadata ?? { name: 'unnamed-networkpolicy' },
  }).withReadinessEvaluator(createAlwaysReadyEvaluator<V1NetworkPolicy>('NetworkPolicy'));
}
