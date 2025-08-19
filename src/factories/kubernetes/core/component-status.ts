import type { V1ComponentStatus } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function componentStatus(resource: V1ComponentStatus): Enhanced<object, unknown> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'ComponentStatus',
    metadata: resource.metadata ?? { name: 'unnamed-componentstatus' },
  }).withReadinessEvaluator((liveResource: V1ComponentStatus) => {
    const conditions = liveResource.conditions || [];
    const healthyCondition = conditions.find(c => c.type === 'Healthy');
    
    if (healthyCondition?.status === 'True') {
      return {
        ready: true,
        message: 'Component is healthy',
      };
    }

    const message = healthyCondition?.message || 'Component health status unknown';
    
    return {
      ready: false,
      reason: healthyCondition?.error || 'HealthUnknown',
      message: `Component is not healthy: ${message}`,
    };
  });
}
