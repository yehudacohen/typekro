import type { V1ClusterRole } from '@kubernetes/client-node';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function clusterRole(
  resource: V1ClusterRole & { id?: string }
): Enhanced<V1ClusterRole, unknown> {
  return createResource<V1ClusterRole, object>(
    {
      ...resource,
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: resource.metadata ?? { name: 'unnamed-clusterrole' },
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(createAlwaysReadyEvaluator<V1ClusterRole>('ClusterRole'));
}
