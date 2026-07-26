import type { V1ResourceQuota } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1ResourceQuotaSpec = NonNullable<V1ResourceQuota['spec']>;
export type V1ResourceQuotaStatus = NonNullable<V1ResourceQuota['status']>;

const resourceQuotaReadinessEvaluator = registerPortableReadinessEvaluator(
  'typekro.readiness.kubernetes.resource-quota',
  '1',
  (liveResource: V1ResourceQuota) => {
    try {
      const status = liveResource.status;

      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'ResourceQuota status not available yet',
        };
      }

      const hard = status.hard || {};
      if (Object.keys(hard).length > 0) {
        return {
          ready: true,
          message: `ResourceQuota is ready with ${Object.keys(hard).length} limits defined`,
        };
      }

      return { ready: true, message: 'ResourceQuota is ready' };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating ResourceQuota readiness: ${ensureError(error).message}`,
        details: { error: ensureError(error).message },
      };
    }
  }
);

export function resourceQuota(
  resource: V1ResourceQuota & { id?: string }
): Enhanced<V1ResourceQuotaSpec, V1ResourceQuotaStatus> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: resource.metadata ?? { name: 'unnamed-resourcequota' },
  }).withReadinessEvaluator(resourceQuotaReadinessEvaluator);
}
