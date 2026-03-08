import type { V1ClusterRoleBinding } from '@kubernetes/client-node';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

/**
 * Creates a Kubernetes ClusterRoleBinding resource that is ready immediately upon creation.
 *
 * @security Binding to the `cluster-admin` ClusterRole grants unrestricted access
 * to the entire cluster. Prefer scoped roles with least-privilege permissions.
 * Audit all ClusterRoleBindings regularly and avoid `cluster-admin` in production
 * unless absolutely necessary.
 *
 * @param resource - The ClusterRoleBinding specification conforming to the Kubernetes V1ClusterRoleBinding API.
 * @returns An Enhanced ClusterRoleBinding resource. As a configuration object, readiness is always true.
 * @example
 * const binding = clusterRoleBinding({
 *   metadata: { name: 'admin-binding' },
 *   roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'admin' },
 *   subjects: [{ kind: 'ServiceAccount', name: 'my-sa', namespace: 'default' }],
 * });
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
  ).withReadinessEvaluator(
    createAlwaysReadyEvaluator<V1ClusterRoleBinding>('ClusterRoleBinding')
  ) as V1ClusterRoleBinding & Enhanced<V1ClusterRoleBinding, object>;
}
