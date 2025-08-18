import type { V1RoleBinding } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function roleBinding(
  resource: V1RoleBinding
): V1RoleBinding & Enhanced<V1RoleBinding, object> {
  return createResource<V1RoleBinding, object>({
    ...resource,
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: resource.metadata ?? { name: 'unnamed-rolebinding' },
  }).withReadinessEvaluator((liveResource: V1RoleBinding) => {
    // RoleBindings are ready when they exist - they're configuration objects
    // that don't have complex status conditions
    return {
      ready: true,
      message: 'RoleBinding is ready'
    };
  }) as V1RoleBinding & Enhanced<V1RoleBinding, object>;
}