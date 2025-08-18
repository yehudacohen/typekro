import type { V1ReplicationController } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1ReplicationControllerSpec = NonNullable<V1ReplicationController['spec']>;
export type V1ReplicationControllerStatus = NonNullable<V1ReplicationController['status']>;

export function replicationController(
  resource: V1ReplicationController
): Enhanced<V1ReplicationControllerSpec, V1ReplicationControllerStatus> {  
  // Capture expected replicas in closure for readiness evaluation
  const expectedReplicas = resource.spec?.replicas || 1;
  
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'ReplicationController',
    metadata: resource.metadata ?? { name: 'unnamed-replicationcontroller' },
  }).withReadinessEvaluator((liveResource: V1ReplicationController) => {
    try {
      const status = liveResource.status;
      
      // Handle missing status gracefully
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'ReplicationController status not available yet',
          details: { expectedReplicas }
        };
      }
      
      const readyReplicas = status.readyReplicas || 0;
      const availableReplicas = status.availableReplicas || 0;
      
      // ReplicationController is ready when ready and available replicas match expected
      const ready = readyReplicas === expectedReplicas && availableReplicas === expectedReplicas;
      
      if (ready) {
        return {
          ready: true,
          message: `ReplicationController has ${readyReplicas}/${expectedReplicas} ready replicas and ${availableReplicas}/${expectedReplicas} available replicas`
        };
      } else {
        return {
          ready: false,
          reason: 'ReplicasNotReady',
          message: `Waiting for replicas: ${readyReplicas}/${expectedReplicas} ready, ${availableReplicas}/${expectedReplicas} available`,
          details: {
            expectedReplicas,
            readyReplicas,
            availableReplicas,
            replicas: status.replicas || 0
          }
        };
      }
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating ReplicationController readiness: ${error}`,
        details: { expectedReplicas, error: String(error) }
      };
    }
  });
}