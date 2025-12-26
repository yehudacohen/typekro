import type { V1ClusterRole } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function clusterRole(resource: V1ClusterRole): Enhanced<V1ClusterRole, unknown> {
  return createResource<V1ClusterRole, object>(
    {
      ...resource,
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: resource.metadata ?? { name: 'unnamed-clusterrole' },
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator((_liveResource: V1ClusterRole) => {
    // ClusterRoles are ready when they exist - they're configuration objects
    // that don't have complex status conditions
    return {
      ready: true,
      message: 'ClusterRole is ready',
    };
  });
}
