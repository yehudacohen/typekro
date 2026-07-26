import type { V1ComponentStatus } from '@kubernetes/client-node';
import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

const componentStatusReadinessEvaluator = registerPortableReadinessEvaluator(
  'typekro.readiness.kubernetes.component-status',
  '1',
  (liveResource: V1ComponentStatus) => {
    const healthyCondition = (liveResource.conditions || []).find(
      (condition) => condition.type === 'Healthy'
    );
    if (healthyCondition?.status === 'True') {
      return { ready: true, message: 'Component is healthy' };
    }
    const message = healthyCondition?.message || 'Component health status unknown';
    return {
      ready: false,
      reason: healthyCondition?.error || 'HealthUnknown',
      message: `Component is not healthy: ${message}`,
    };
  }
);

export function componentStatus(
  resource: V1ComponentStatus & { id?: string }
): Enhanced<object, unknown> {
  return createResource(
    {
      ...resource,
      apiVersion: 'v1',
      kind: 'ComponentStatus',
      metadata: resource.metadata ?? { name: 'unnamed-componentstatus' },
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(componentStatusReadinessEvaluator);
}
