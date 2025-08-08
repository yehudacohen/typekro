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
  });
}