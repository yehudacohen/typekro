import type { V1ClusterRoleBinding } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

/**
 * Creates a ClusterRoleBinding resource.
 *
 * @security Binding to the `cluster-admin` ClusterRole grants unrestricted access
 * to the entire cluster. Prefer scoped roles with least-privilege permissions.
 * Audit all ClusterRoleBindings regularly and avoid `cluster-admin` in production
 * unless absolutely necessary.
 *
 * @param resource - The ClusterRoleBinding specification
 * @returns Enhanced ClusterRoleBinding resource
 */
export function clusterRoleBinding(
  resource: V1ClusterRoleBinding
): V1ClusterRoleBinding & Enhanced<V1ClusterRoleBinding, object> {
  return createResource<V1ClusterRoleBinding, object>(
    {
      ...resource,
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: resource.metadata ?? { name: 'unnamed-clusterrolebinding' },
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator((_liveResource: V1ClusterRoleBinding) => {
    // ClusterRoleBindings are ready when they exist - they're configuration objects
    // that don't have complex status conditions
    return {
      ready: true,
      message: 'ClusterRoleBinding is ready',
    };
  }) as V1ClusterRoleBinding & Enhanced<V1ClusterRoleBinding, object>;
}
