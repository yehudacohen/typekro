import type { V1Node } from '@kubernetes/client-node';
import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1NodeSpec = NonNullable<V1Node['spec']>;
export type V1NodeStatus = NonNullable<V1Node['status']>;

const nodeReadinessEvaluator = registerPortableReadinessEvaluator(
  'typekro.readiness.kubernetes.node',
  '1',
  (liveResource: V1Node) => {
    const status = liveResource.status;
    if (!status) {
      return { ready: false, reason: 'StatusMissing', message: 'Node status not available yet' };
    }
    const readyCondition = (status.conditions || []).find(
      (condition) => condition.type === 'Ready'
    );
    if (readyCondition?.status === 'True') {
      return { ready: true, message: 'Node is ready and schedulable' };
    }
    return {
      ready: false,
      reason: readyCondition?.reason || 'Unknown',
      message: `Node is not ready: ${readyCondition?.message || 'Node readiness condition not found'}`,
    };
  }
);

export function node(resource: V1Node & { id?: string }): Enhanced<V1NodeSpec, V1NodeStatus> {
  return createResource(
    {
      ...resource,
      apiVersion: 'v1',
      kind: 'Node',
      metadata: resource.metadata ?? { name: 'unnamed-node' },
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(nodeReadinessEvaluator);
}
