import type { V1ComponentStatus } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function componentStatus(resource: V1ComponentStatus): Enhanced<V1ComponentStatus, unknown> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'ComponentStatus',
    metadata: resource.metadata ?? { name: 'unnamed-componentstatus' },
  });
}