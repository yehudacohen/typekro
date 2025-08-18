import type { V1ServiceAccount } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function serviceAccount(resource: V1ServiceAccount): Enhanced<V1ServiceAccount, unknown> {
  return createResource<V1ServiceAccount, object>({
    ...resource,
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: resource.metadata ?? { name: 'unnamed-serviceaccount' },
  }).withReadinessEvaluator((liveResource: V1ServiceAccount) => {
    // ServiceAccounts are ready when they exist - they're configuration objects
    // that don't have complex status conditions
    return {
      ready: true,
      message: 'ServiceAccount is ready'
    };
  });
}