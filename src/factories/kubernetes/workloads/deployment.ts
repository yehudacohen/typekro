import type { V1Deployment } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import {
  identifyPortableReadinessEvaluator,
  registerPortableReadinessStrategy,
} from '../../../core/readiness/portable-strategies.js';
import {
  optionalReadinessNumber,
  readinessConfiguration,
  readinessLiteral,
} from '../../../core/readiness/strategy-configuration.js';
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

const DEPLOYMENT_READINESS_STRATEGY = 'typekro.readiness.kubernetes.deployment';
const DEPLOYMENT_READINESS_REVISION = '1';

function createDeploymentReadinessEvaluator(
  staticExpectedReplicas?: number
): (liveResource: unknown) => ResourceStatus {
  const evaluator = (input: unknown): ResourceStatus => {
    try {
      const liveResource = input as V1Deployment;
      const status = liveResource.status;
      const expectedReplicas = staticExpectedReplicas ?? liveResource.spec?.replicas ?? 1;

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
      const ready = readyReplicas >= expectedReplicas && availableReplicas >= expectedReplicas;

      return ready
        ? {
            ready: true,
            message: `Deployment has ${readyReplicas}/${expectedReplicas} ready replicas and ${availableReplicas}/${expectedReplicas} available replicas`,
          }
        : {
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
  };

  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id: DEPLOYMENT_READINESS_STRATEGY,
    revision: DEPLOYMENT_READINESS_REVISION,
    configuration: readinessConfiguration({
      expectedReplicas:
        staticExpectedReplicas === undefined ? undefined : readinessLiteral(staticExpectedReplicas),
    }),
  });
}

registerPortableReadinessStrategy(
  DEPLOYMENT_READINESS_STRATEGY,
  DEPLOYMENT_READINESS_REVISION,
  (configuration) =>
    createDeploymentReadinessEvaluator(optionalReadinessNumber(configuration, 'expectedReplicas'))
);

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
  const staticExpectedReplicas = typeof rawReplicas === 'number' ? rawReplicas : undefined;

  // Fluent builder pattern with serialization-safe readiness evaluator
  return createResource({
    ...resource,
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: resource.metadata ?? { name: 'unnamed-deployment' },
  }).withReadinessEvaluator(createDeploymentReadinessEvaluator(staticExpectedReplicas));
}
