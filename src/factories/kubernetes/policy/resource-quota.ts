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
  });
}