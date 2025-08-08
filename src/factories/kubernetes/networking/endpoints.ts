import type { V1Endpoints } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function endpoints(resource: V1Endpoints): V1Endpoints & Enhanced<V1Endpoints, object> {
  return createResource<V1Endpoints, object>({
    ...resource,
    apiVersion: 'v1',
    kind: 'Endpoints',
    metadata: resource.metadata ?? { name: 'unnamed-endpoints' },
  }) as V1Endpoints & Enhanced<V1Endpoints, object>;
}