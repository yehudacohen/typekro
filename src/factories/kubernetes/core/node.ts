import type { V1Node } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1NodeSpec = NonNullable<V1Node['spec']>;
export type V1NodeStatus = NonNullable<V1Node['status']>;

export function node(resource: V1Node): Enhanced<V1NodeSpec, V1NodeStatus> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'Node',
    metadata: resource.metadata ?? { name: 'unnamed-node' },
  }).withReadinessEvaluator((liveResource: V1Node) => {
    const status = liveResource.status;
    
    if (!status) {
      return {
        ready: false,
        reason: 'StatusMissing',
        message: 'Node status not available yet',
      };
    }

    const conditions = status.conditions || [];
    const readyCondition = conditions.find(c => c.type === 'Ready');
    
    if (readyCondition?.status === 'True') {
      return {
        ready: true,
        message: 'Node is ready and schedulable',
      };
    }

    const reason = readyCondition?.reason || 'Unknown';
    const message = readyCondition?.message || 'Node readiness condition not found';
    
    return {
      ready: false,
      reason,
      message: `Node is not ready: ${message}`,
    };
  });
}
