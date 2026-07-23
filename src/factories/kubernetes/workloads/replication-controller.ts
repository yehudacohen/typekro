import type { V1ReplicationController } from '@kubernetes/client-node';
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
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1ReplicationControllerSpec = NonNullable<V1ReplicationController['spec']>;
export type V1ReplicationControllerStatus = NonNullable<V1ReplicationController['status']>;

const REPLICATION_CONTROLLER_READINESS_STRATEGY =
  'typekro.readiness.kubernetes.replication-controller';

function createReplicationControllerReadinessEvaluator(staticExpectedReplicas?: number) {
  const evaluator = (liveResource: V1ReplicationController) => {
    const expectedReplicas = staticExpectedReplicas ?? liveResource.spec?.replicas ?? 1;
    try {
      const status = liveResource.status;
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'ReplicationController status not available yet',
          details: { expectedReplicas },
        };
      }
      const readyReplicas = status.readyReplicas || 0;
      const availableReplicas = status.availableReplicas || 0;
      if (readyReplicas === expectedReplicas && availableReplicas === expectedReplicas) {
        return {
          ready: true,
          message: `ReplicationController has ${readyReplicas}/${expectedReplicas} ready replicas and ${availableReplicas}/${expectedReplicas} available replicas`,
        };
      }
      return {
        ready: false,
        reason: 'ReplicasNotReady',
        message: `Waiting for replicas: ${readyReplicas}/${expectedReplicas} ready, ${availableReplicas}/${expectedReplicas} available`,
        details: {
          expectedReplicas,
          readyReplicas,
          availableReplicas,
          replicas: status.replicas || 0,
        },
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating ReplicationController readiness: ${ensureError(error).message}`,
        details: { expectedReplicas, error: ensureError(error).message },
      };
    }
  };
  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id: REPLICATION_CONTROLLER_READINESS_STRATEGY,
    revision: '1',
    configuration: readinessConfiguration({
      expectedReplicas:
        staticExpectedReplicas === undefined ? undefined : readinessLiteral(staticExpectedReplicas),
    }),
  });
}

registerPortableReadinessStrategy(
  REPLICATION_CONTROLLER_READINESS_STRATEGY,
  '1',
  (configuration) =>
    createReplicationControllerReadinessEvaluator(
      optionalReadinessNumber(configuration, 'expectedReplicas')
    )
);

export function replicationController(
  resource: V1ReplicationController & { id?: string }
): Enhanced<V1ReplicationControllerSpec, V1ReplicationControllerStatus> {
  // Capture expected replicas in closure for readiness evaluation
  const expectedReplicas =
    typeof resource.spec?.replicas === 'number' ? resource.spec.replicas : undefined;

  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'ReplicationController',
    metadata: resource.metadata ?? { name: 'unnamed-replicationcontroller' },
  }).withReadinessEvaluator(createReplicationControllerReadinessEvaluator(expectedReplicas));
}
