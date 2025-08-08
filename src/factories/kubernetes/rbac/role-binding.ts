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
  }) as V1RoleBinding & Enhanced<V1RoleBinding, object>;
}