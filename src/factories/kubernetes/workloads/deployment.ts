import type { V1Deployment } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import { registerFactory } from '../../../core/resources/factory-registry.js';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { V1DeploymentSpec, V1DeploymentStatus } from '../types.js';

// Self-register with semantic aliases for fuzzy resource key matching.
// The base kind/apiVersion is auto-registered by createResource, but
// semantic aliases require explicit registration.
registerFactory({
  factoryName: 'Deployment',
  kind: 'Deployment',
  apiVersion: 'apps/v1',
  semanticAliases: ['deploy', 'database', 'db', 'cache', 'redis'],
});

/**
 * Creates a Kubernetes Deployment resource with replica-based readiness evaluation.
 *
 * @param resource - The Deployment specification conforming to the Kubernetes V1Deployment API.
 * @returns An Enhanced Deployment resource that tracks readiness based on ready and available replica counts.
 * @example
 * const app = deployment({
 *   metadata: { name: 'my-app' },
 *   spec: { replicas: 3, selector: { matchLabels: { app: 'my-app' } }, template: { ... } },
 * });
 */
export function deployment(
  resource: V1Deployment & { id?: string }
): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  // Capture expected replicas in closure for readiness evaluation
  // Handle the case where replicas might be a KubernetesRef (magic proxy) instead of a number
  // When replicas is a KubernetesRef, we'll use the live resource's spec.replicas at evaluation time
  const rawReplicas = resource.spec?.replicas;
  const staticExpectedReplicas = typeof rawReplicas === 'number' ? rawReplicas : null;

  // Fluent builder pattern with serialization-safe readiness evaluator
  return createResource({
    ...resource,
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: resource.metadata ?? { name: 'unnamed-deployment' },
  }, { dnsAddressable: true }).withReadinessEvaluator((liveResource: V1Deployment): ResourceStatus => {
    try {
      const status = liveResource.status;

      // Use the live resource's spec.replicas if we don't have a static value
      // This handles the case where replicas was a KubernetesRef that got resolved during deployment
      const expectedReplicas = staticExpectedReplicas ?? liveResource.spec?.replicas ?? 1;

      // Handle missing status gracefully
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'Deployment status not available yet',
          details: { expectedReplicas },
        };
      }

      const readyReplicas = status.readyReplicas || 0;
      const availableReplicas = status.availableReplicas || 0;

      // Check if replicas are ready - use >= to handle rolling updates and scaling events
      const ready = readyReplicas >= expectedReplicas && availableReplicas >= expectedReplicas;

      if (ready) {
        return {
          ready: true,
          message: `Deployment has ${readyReplicas}/${expectedReplicas} ready replicas and ${availableReplicas}/${expectedReplicas} available replicas`,
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
            updatedReplicas: status.updatedReplicas || 0,
          },
        };
      }
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating deployment readiness: ${ensureError(error).message}`,
        details: {
          expectedReplicas: staticExpectedReplicas ?? 1,
          error: ensureError(error).message,
        },
      };
    }
  });
}
