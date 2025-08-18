import type { V1Secret } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1SecretData = NonNullable<V1Secret['data']>;

export function secret(resource: V1Secret): Enhanced<V1SecretData, unknown> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: resource.metadata ?? { name: 'unnamed-secret' },
  }).withReadinessEvaluator((liveResource: V1Secret) => {
    // Secrets are ready when they exist - they're just data storage
    return {
      ready: true,
      message: 'Secret is ready when created',
    };
  });
}