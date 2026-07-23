import type { V1StatefulSet } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import {
  identifyPortableReadinessEvaluator,
  registerPortableReadinessStrategy,
} from '../../../core/readiness/portable-strategies.js';
import {
  optionalReadinessNumber,
  optionalReadinessString,
  readinessConfiguration,
  readinessLiteral,
} from '../../../core/readiness/strategy-configuration.js';
import { registerFactory } from '../../../core/resources/factory-registry.js';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

// Self-register with semantic aliases for fuzzy resource key matching.
registerFactory({
  factoryName: 'StatefulSet',
  kind: 'StatefulSet',
  apiVersion: 'apps/v1',
  semanticAliases: ['database', 'db', 'cache', 'redis'],
});

const STATEFUL_SET_READINESS_STRATEGY = 'typekro.readiness.kubernetes.stateful-set';
const STATEFUL_SET_READINESS_REVISION = '1';

function createStatefulSetReadinessEvaluator(
  staticExpectedReplicas?: number,
  staticUpdateStrategy?: string
): (liveResource: unknown) => ResourceStatus {
  const evaluator = (input: unknown): ResourceStatus => {
    let expectedReplicas = staticExpectedReplicas ?? 1;
    let updateStrategy = staticUpdateStrategy ?? 'RollingUpdate';

    try {
      const liveResource = input as V1StatefulSet;
      expectedReplicas = staticExpectedReplicas ?? liveResource.spec?.replicas ?? 1;
      updateStrategy =
        staticUpdateStrategy ?? liveResource.spec?.updateStrategy?.type ?? 'RollingUpdate';
      const status = liveResource.status;
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'StatefulSet status not available yet',
          details: { expectedReplicas, updateStrategy },
        };
      }

      const readyReplicas = status.readyReplicas || 0;
      const currentReplicas = status.currentReplicas || 0;
      const updatedReplicas = status.updatedReplicas || 0;

      if (updateStrategy === 'OnDelete') {
        const ready = readyReplicas === expectedReplicas;
        return ready
          ? {
              ready: true,
              message: `StatefulSet (OnDelete) has ${readyReplicas}/${expectedReplicas} ready replicas`,
            }
          : {
              ready: false,
              reason: 'ReplicasNotReady',
              message: `StatefulSet (OnDelete) waiting for replicas: ${readyReplicas}/${expectedReplicas} ready`,
              details: { expectedReplicas, readyReplicas, updateStrategy },
            };
      }

      const ready =
        readyReplicas === expectedReplicas &&
        currentReplicas === expectedReplicas &&
        updatedReplicas === expectedReplicas;
      return ready
        ? {
            ready: true,
            message: `StatefulSet (RollingUpdate) has all ${expectedReplicas} replicas ready, current, and updated`,
          }
        : {
            ready: false,
            reason: 'RollingUpdateInProgress',
            message: `StatefulSet (RollingUpdate) updating: ${readyReplicas}/${expectedReplicas} ready, ${currentReplicas}/${expectedReplicas} current, ${updatedReplicas}/${expectedReplicas} updated`,
            details: {
              expectedReplicas,
              readyReplicas,
              currentReplicas,
              updatedReplicas,
              updateStrategy,
            },
          };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating StatefulSet readiness: ${ensureError(error).message}`,
        details: { expectedReplicas, updateStrategy, error: ensureError(error).message },
      };
    }
  };

  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id: STATEFUL_SET_READINESS_STRATEGY,
    revision: STATEFUL_SET_READINESS_REVISION,
    configuration: readinessConfiguration({
      expectedReplicas:
        staticExpectedReplicas === undefined ? undefined : readinessLiteral(staticExpectedReplicas),
      updateStrategy:
        staticUpdateStrategy === undefined ? undefined : readinessLiteral(staticUpdateStrategy),
    }),
  });
}

registerPortableReadinessStrategy(
  STATEFUL_SET_READINESS_STRATEGY,
  STATEFUL_SET_READINESS_REVISION,
  (configuration) =>
    createStatefulSetReadinessEvaluator(
      optionalReadinessNumber(configuration, 'expectedReplicas'),
      optionalReadinessString(configuration, 'updateStrategy')
    )
);

export type V1StatefulSetSpec = NonNullable<V1StatefulSet['spec']>;
export type V1StatefulSetStatus = NonNullable<V1StatefulSet['status']>;

/**
 * Creates a Kubernetes StatefulSet resource with update-strategy-aware readiness evaluation.
 *
 * @param resource - The StatefulSet specification conforming to the Kubernetes V1StatefulSet API.
 * @returns An Enhanced StatefulSet resource that evaluates readiness differently for RollingUpdate (all replicas must be ready, current, and updated) vs OnDelete (all replicas must be ready) strategies.
 * @example
 * const db = statefulSet({
 *   metadata: { name: 'postgres' },
 *   spec: { replicas: 3, serviceName: 'postgres', selector: { matchLabels: { app: 'postgres' } }, template: { ... } },
 * });
 */
export function statefulSet(
  resource: V1StatefulSet & { id?: string }
): Enhanced<V1StatefulSetSpec, V1StatefulSetStatus> {
  // Capture configuration in closure for StatefulSet-specific readiness logic
  const expectedReplicas =
    typeof resource.spec?.replicas === 'number' ? resource.spec.replicas : undefined;
  const updateStrategy =
    typeof resource.spec?.updateStrategy?.type === 'string'
      ? resource.spec.updateStrategy.type
      : undefined;

  return createResource({
    ...resource,
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: resource.metadata ?? { name: 'unnamed-statefulset' },
  }).withReadinessEvaluator(createStatefulSetReadinessEvaluator(expectedReplicas, updateStrategy));
}
