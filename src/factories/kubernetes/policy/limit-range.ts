import type { V1LimitRange } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1LimitRangeSpec = NonNullable<V1LimitRange['spec']>;

export function limitRange(resource: V1LimitRange): Enhanced<V1LimitRangeSpec, unknown> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'LimitRange',
    metadata: resource.metadata ?? { name: 'unnamed-limitrange' },
  });
}