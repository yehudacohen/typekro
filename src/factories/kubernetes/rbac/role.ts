import type { V1Role } from '@kubernetes/client-node';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function role(resource: V1Role & { id?: string }): V1Role & Enhanced<V1Role, object> {
  return createResource<V1Role, object>({
    ...resource,
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: resource.metadata ?? { name: 'unnamed-role' },
  }).withReadinessEvaluator(createAlwaysReadyEvaluator<V1Role>('Role')) as V1Role &
    Enhanced<V1Role, object>;
}
