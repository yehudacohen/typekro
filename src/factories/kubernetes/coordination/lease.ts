import type { V1Lease } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1LeaseSpec = NonNullable<V1Lease['spec']>;

export function lease(resource: V1Lease): Enhanced<V1LeaseSpec, unknown> {
  return createResource({
    ...resource,
    apiVersion: 'coordination.k8s.io/v1',
    kind: 'Lease',
    metadata: resource.metadata ?? { name: 'unnamed-lease' },
  });
}
