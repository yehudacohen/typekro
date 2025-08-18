import type { V1Deployment } from '@kubernetes/client-node';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { V1DeploymentSpec, V1DeploymentStatus } from '../types.js';

export function deployment(resource: V1Deployment): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  // Capture expected replicas in closure for readiness evaluation
  const expectedReplicas = resource.spec?.replicas || 1;

  // Fluent builder pattern with serialization-safe readiness evaluator
  return createResource({
    ...resource,
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: resource.metadata ?? { name: 'unnamed-deployment' },
  }).withReadinessEvaluator((liveResource: V1Deployment): ResourceStatus => {
    try {
      const status = liveResource.status;

      // Handle missing status gracefully
      if (!status) {
        return {
          ready: false,

          reason: 'StatusMissing',
          message: 'Deployment status not available yet',
          details: { expectedReplicas }
        };
      }

      const readyReplicas = status.readyReplicas || 0;
      const availableReplicas = status.availableReplicas || 0;

      // FIX: The readiness condition was too strict. It should check for >= instead of ===
      // to correctly handle rolling updates and scaling events.
      const ready = readyReplicas >= expectedReplicas && availableReplicas >= expectedReplicas;

      if (ready) {
        return {
          ready: true,
          message: `Deployment has ${readyReplicas}/${expectedReplicas} ready replicas and ${availableReplicas}/${expectedReplicas} available replicas`
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

            updatedReplicas: status.updatedReplicas ||
              0
          }
        };
      }
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating deployment readiness: ${error}`,
        details: { expectedReplicas, error: String(error) }
      };
    }
  });
}