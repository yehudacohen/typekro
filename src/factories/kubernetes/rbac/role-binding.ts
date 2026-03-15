import type { V1RoleBinding } from '@kubernetes/client-node';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function roleBinding(
  resource: V1RoleBinding & { id?: string }
): V1RoleBinding & Enhanced<V1RoleBinding, object> {
  return createResource<V1RoleBinding, object>({
    ...resource,
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: resource.metadata ?? { name: 'unnamed-rolebinding' },
  }).withReadinessEvaluator(
    createAlwaysReadyEvaluator<V1RoleBinding>('RoleBinding')
  ) as V1RoleBinding & Enhanced<V1RoleBinding, object>;
}
