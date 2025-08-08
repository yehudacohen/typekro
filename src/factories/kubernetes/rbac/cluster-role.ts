import type { V1ClusterRole } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function clusterRole(resource: V1ClusterRole): Enhanced<V1ClusterRole, unknown> {
  return createResource({
    ...resource,
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: resource.metadata ?? { name: 'unnamed-clusterrole' },
  });
}