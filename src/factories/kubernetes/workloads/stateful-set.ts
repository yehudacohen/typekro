import type { V1StatefulSet } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1StatefulSetSpec = NonNullable<V1StatefulSet['spec']>;
export type V1StatefulSetStatus = NonNullable<V1StatefulSet['status']>;

export function statefulSet(
  resource: V1StatefulSet
): Enhanced<V1StatefulSetSpec, V1StatefulSetStatus> {
  // Capture configuration in closure for StatefulSet-specific readiness logic
  const expectedReplicas = resource.spec?.replicas || 1;
  const updateStrategy = resource.spec?.updateStrategy?.type || 'RollingUpdate';

  return createResource({
    ...resource,
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: resource.metadata ?? { name: 'unnamed-statefulset' },
  }).withReadinessEvaluator((liveResource: V1StatefulSet) => {
    try {
      const status = liveResource.status;

      // Handle missing status gracefully
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'StatefulSet status not available yet',
          details: { expectedReplicas, updateStrategy }
        };
      }

      const readyReplicas = status.readyReplicas || 0;
      const currentReplicas = status.currentReplicas || 0;
      const updatedReplicas = status.updatedReplicas || 0;

      // StatefulSet readiness depends on update strategy
      if (updateStrategy === 'OnDelete') {
        const ready = readyReplicas === expectedReplicas;

        if (ready) {
          return {
            ready: true,
            message: `StatefulSet (OnDelete) has ${readyReplicas}/${expectedReplicas} ready replicas`
          };
        } else {
          return {
            ready: false,
            reason: 'ReplicasNotReady',
            message: `StatefulSet (OnDelete) waiting for replicas: ${readyReplicas}/${expectedReplicas} ready`,
            details: { expectedReplicas, readyReplicas, updateStrategy }
          };
        }
      } else {
        // RollingUpdate: ensure all replicas are updated and ready
        const ready = readyReplicas === expectedReplicas && 
                     currentReplicas === expectedReplicas &&
                     updatedReplicas === expectedReplicas;

        if (ready) {
          return {
            ready: true,
            message: `StatefulSet (RollingUpdate) has all ${expectedReplicas} replicas ready, current, and updated`
          };
        } else {
          return {
            ready: false,
            reason: 'RollingUpdateInProgress',
            message: `StatefulSet (RollingUpdate) updating: ${readyReplicas}/${expectedReplicas} ready, ${currentReplicas}/${expectedReplicas} current, ${updatedReplicas}/${expectedReplicas} updated`,
            details: {
              expectedReplicas,
              readyReplicas,
              currentReplicas,
              updatedReplicas,
              updateStrategy
            }
          };
        }
      }
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating StatefulSet readiness: ${error}`,
        details: { expectedReplicas, updateStrategy, error: String(error) }
      };
    }
  });
}