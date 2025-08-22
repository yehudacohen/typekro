import type { V1PersistentVolume } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1PvSpec = NonNullable<V1PersistentVolume['spec']>;
export type V1PvStatus = NonNullable<V1PersistentVolume['status']>;

export function persistentVolume(resource: V1PersistentVolume): Enhanced<V1PvSpec, V1PvStatus> {
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: resource.metadata ?? { name: 'unnamed-pv' },
  }).withReadinessEvaluator((liveResource: V1PersistentVolume) => {
    try {
      const status = liveResource.status;

      // Handle missing status gracefully
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'PersistentVolume status not available yet',
        };
      }

      const phase = status.phase;

      // PV is ready when phase is Available or Bound
      const ready = phase === 'Available' || phase === 'Bound';

      if (ready) {
        return {
          ready: true,
          message: `PersistentVolume is ready with phase: ${phase}`,
        };
      } else {
        return {
          ready: false,
          reason: 'NotAvailable',
          message: `PersistentVolume phase is ${phase || 'unknown'}, waiting for Available or Bound phase`,
          details: { phase },
        };
      }
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating PersistentVolume readiness: ${error}`,
        details: { error: String(error) },
      };
    }
  });
}
