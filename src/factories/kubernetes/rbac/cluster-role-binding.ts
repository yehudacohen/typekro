import type { V1ClusterRoleBinding } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function clusterRoleBinding(
  resource: V1ClusterRoleBinding
): V1ClusterRoleBinding & Enhanced<V1ClusterRoleBinding, object> {
  return createResource<V1ClusterRoleBinding, object>({
    ...resource,
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: resource.metadata ?? { name: 'unnamed-clusterrolebinding' },
  }) as V1ClusterRoleBinding & Enhanced<V1ClusterRoleBinding, object>;
}