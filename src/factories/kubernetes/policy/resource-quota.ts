import type { V1ResourceQuota } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1ResourceQuotaSpec = NonNullable<V1ResourceQuota['spec']>;
export type V1ResourceQuotaStatus = NonNullable<V1ResourceQuota['status']>;

export function resourceQuota(
  resource: V1ResourceQuota
): Enhanced<V1ResourceQuotaSpec, V1ResourceQuotaStatus> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: resource.metadata ?? { name: 'unnamed-resourcequota' },
  }).withReadinessEvaluator((liveResource: V1ResourceQuota) => {
    try {
      const status = liveResource.status;
      
      // Handle missing status gracefully
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'ResourceQuota status not available yet'
        };
      }
      
      // ResourceQuota is ready when it has been processed and has status
      const hard = status.hard || {};
      
      // If there are hard limits defined, we consider it ready when status is populated
      if (Object.keys(hard).length > 0) {
        return {
          ready: true,
          message: `ResourceQuota is ready with ${Object.keys(hard).length} limits defined`
        };
      }
      
      return {
        ready: true,
        message: 'ResourceQuota is ready'
      };
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating ResourceQuota readiness: ${error}`,
        details: { error: String(error) }
      };
    }
  });
}