import type { V1ServiceAccount } from '@kubernetes/client-node';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/evaluator-factories.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function serviceAccount(resource: V1ServiceAccount): Enhanced<V1ServiceAccount, unknown> {
  return createResource<V1ServiceAccount, object>({
    ...resource,
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: resource.metadata ?? { name: 'unnamed-serviceaccount' },
  }).withReadinessEvaluator(createAlwaysReadyEvaluator<V1ServiceAccount>('ServiceAccount'));
}
