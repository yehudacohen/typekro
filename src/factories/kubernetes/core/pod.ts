import type { V1Pod } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1PodSpec = NonNullable<V1Pod['spec']>;
export type V1PodStatus = NonNullable<V1Pod['status']>;

export function pod(resource: V1Pod): Enhanced<V1PodSpec, V1PodStatus> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: resource.metadata ?? { name: 'unnamed-pod' },
  }).withReadinessEvaluator((liveResource: V1Pod) => {
    try {
      const status = liveResource.status;

      if (!status) {
        return { ready: false, reason: 'No status available' };
      }

      // Pod must be in Running phase
      if (status.phase !== 'Running') {
        return {
          ready: false,
          reason: `Pod is in ${status.phase} phase, expected Running`,
        };
      }

      // Check container readiness
      const containerStatuses = status.containerStatuses || [];
      const totalContainers = containerStatuses.length;
      const readyContainers = containerStatuses.filter((c) => c.ready).length;

      if (totalContainers === 0) {
        return { ready: false, reason: 'No container statuses available' };
      }

      const ready = readyContainers === totalContainers;

      return {
        ready,
        reason: ready
          ? `All ${totalContainers} containers are ready`
          : `${readyContainers}/${totalContainers} containers ready`,
      };
    } catch (error) {
      return {
        ready: false,
        reason: `Error checking Pod status: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}
