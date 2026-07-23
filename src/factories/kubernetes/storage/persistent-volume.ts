import type { V1PersistentVolume } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1PvSpec = NonNullable<V1PersistentVolume['spec']>;
export type V1PvStatus = NonNullable<V1PersistentVolume['status']>;

const persistentVolumeReadinessEvaluator = registerPortableReadinessEvaluator(
  'typekro.readiness.kubernetes.persistent-volume',
  '1',
  (liveResource: V1PersistentVolume) => {
    try {
      const status = liveResource.status;
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'PersistentVolume status not available yet',
        };
      }
      const phase = status.phase;
      if (phase === 'Available' || phase === 'Bound') {
        return { ready: true, message: `PersistentVolume is ready with phase: ${phase}` };
      }
      return {
        ready: false,
        reason: 'NotAvailable',
        message: `PersistentVolume phase is ${phase || 'unknown'}, waiting for Available or Bound phase`,
        details: { phase },
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating PersistentVolume readiness: ${ensureError(error).message}`,
        details: { error: ensureError(error).message },
      };
    }
  }
);

export function persistentVolume(
  resource: V1PersistentVolume & { id?: string }
): Enhanced<V1PvSpec, V1PvStatus> {
  return createResource(
    {
      ...resource,
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: resource.metadata ?? { name: 'unnamed-pv' },
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(persistentVolumeReadinessEvaluator);
}
