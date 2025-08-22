import type { V1EndpointSlice } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function endpointSlice(
  resource: V1EndpointSlice
): V1EndpointSlice & Enhanced<V1EndpointSlice, object> {
  return createResource<V1EndpointSlice, object>({
    ...resource,
    apiVersion: 'discovery.k8s.io/v1',
    kind: 'EndpointSlice',
    metadata: resource.metadata ?? { name: 'unnamed-endpointslice' },
  }) as V1EndpointSlice & Enhanced<V1EndpointSlice, object>;
}
