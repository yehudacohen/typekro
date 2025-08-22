import type { V1Role } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function role(resource: V1Role): V1Role & Enhanced<V1Role, object> {
  return createResource<V1Role, object>({
    ...resource,
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: resource.metadata ?? { name: 'unnamed-role' },
  }).withReadinessEvaluator((_liveResource: V1Role) => {
    // Roles are ready when they exist - they're configuration objects
    // that don't have complex status conditions
    return {
      ready: true,
      message: 'Role is ready',
    };
  }) as V1Role & Enhanced<V1Role, object>;
}
