import type { V1PersistentVolumeClaim } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1PvcSpec = NonNullable<V1PersistentVolumeClaim['spec']>;
export type V1PvcStatus = NonNullable<V1PersistentVolumeClaim['status']>;

/**
 * Creates a Kubernetes PersistentVolumeClaim resource with binding-based readiness evaluation.
 *
 * @param resource - The PVC specification conforming to the Kubernetes V1PersistentVolumeClaim API.
 * @returns An Enhanced PVC resource that is ready when the claim phase is Bound.
 * @example
 * const storage = persistentVolumeClaim({
 *   metadata: { name: 'data-volume' },
 *   spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '10Gi' } } },
 * });
 */
export function persistentVolumeClaim(
  resource: V1PersistentVolumeClaim
): Enhanced<V1PvcSpec, V1PvcStatus> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: resource.metadata ?? { name: 'unnamed-pvc' },
  }).withReadinessEvaluator((liveResource: V1PersistentVolumeClaim) => {
    try {
      const status = liveResource.status;

      if (!status) {
        return { ready: false, reason: 'No status available' };
      }

      const ready = status.phase === 'Bound';

      return {
        ready,
        reason: ready
          ? 'PVC is bound to a volume'
          : `PVC is in ${status.phase} phase, expected Bound`,
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: `Error checking PVC status: ${ensureError(error).message}`,
      };
    }
  });
}
