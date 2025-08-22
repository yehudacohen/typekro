import type { V1ReplicaSet } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1ReplicaSetSpec = NonNullable<V1ReplicaSet['spec']>;
export type V1ReplicaSetStatus = NonNullable<V1ReplicaSet['status']>;

export function replicaSet(resource: V1ReplicaSet): Enhanced<V1ReplicaSetSpec, V1ReplicaSetStatus> {
  return createResource({
    ...resource,
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: resource.metadata ?? { name: 'unnamed-replicaset' },
  }).withReadinessEvaluator((liveResource: V1ReplicaSet) => {
    try {
      const status = liveResource.status;
      const spec = liveResource.spec;

      if (!status) {
        return { ready: false, reason: 'No status available' };
      }

      const expectedReplicas = spec?.replicas || 1;
      const readyReplicas = status.readyReplicas || 0;

      const ready = readyReplicas >= expectedReplicas;

      return {
        ready,
        reason: ready
          ? `All ${expectedReplicas} replicas are ready`
          : `${readyReplicas}/${expectedReplicas} replicas ready`,
      };
    } catch (error) {
      return {
        ready: false,
        reason: `Error checking ReplicaSet status: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}
