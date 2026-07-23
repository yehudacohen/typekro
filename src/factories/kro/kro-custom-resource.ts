/**
 * Generic Kro custom resource factory with schema-based typing
 */

import { ensureError } from '../../core/errors.js';
import {
  identifyPortableReadinessEvaluator,
  registerPortableReadinessStrategy,
} from '../../core/readiness/portable-strategies.js';
import {
  readinessConfiguration,
  readinessLiteral,
  requiredReadinessString,
} from '../../core/readiness/strategy-configuration.js';
import type { Enhanced, ResourceStatus, WithKroStatusFields } from '../../core/types/index.js';
import { createResource } from '../shared.js';

const KRO_CUSTOM_RESOURCE_READINESS_STRATEGY = 'typekro.readiness.kro.custom-resource';

function createKroCustomResourceReadinessEvaluator(resourceKind: string) {
  const evaluator = (liveResource: unknown): ResourceStatus => {
    try {
      const status = (
        liveResource as { status?: WithKroStatusFields<Record<string, unknown>> } | null | undefined
      )?.status;
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: `${resourceKind} status not yet available`,
          details: { statusExists: false },
        };
      }

      const state = status.state;
      const conditions = status.conditions || [];
      if (state === undefined) {
        return {
          ready: false,
          reason: 'StateFieldMissing',
          message: `${resourceKind} state field not yet populated by Kro controller`,
          details: {
            statusExists: true,
            stateExists: false,
            conditions: conditions.length > 0 ? conditions : undefined,
          },
        };
      }
      if (state === 'FAILED') {
        const failedCondition = conditions.find((condition) => condition.status === 'False');
        return {
          ready: false,
          reason: 'KroInstanceFailed',
          message: `${resourceKind} instance failed: ${failedCondition?.message || 'Unknown error'}`,
          details: { state, conditions, observedGeneration: status.observedGeneration },
        };
      }
      if (state === 'PROGRESSING') {
        return {
          ready: false,
          reason: 'KroInstanceProgressing',
          message: `${resourceKind} instance progressing - State: ${state}`,
          details: { state, conditions, observedGeneration: status.observedGeneration },
        };
      }
      if (state !== 'ACTIVE') {
        return {
          ready: false,
          reason: 'StateNotActive',
          message: `${resourceKind} state is '${state}', waiting for 'ACTIVE'`,
          details: { state, conditions, observedGeneration: status.observedGeneration },
        };
      }

      const readyCondition = conditions.find((condition) => condition.type === 'Ready');
      const syncedCondition = conditions.find((condition) => condition.type === 'InstanceSynced');
      if (readyCondition?.status === 'True') {
        return { ready: true, message: `${resourceKind} instance is active and ready` };
      }
      if (readyCondition) {
        return {
          ready: false,
          reason: 'ReadyConditionFalse',
          message: `${resourceKind} Ready condition is '${readyCondition.status}': ${readyCondition.message || 'No message'}`,
          details: { state, conditions, observedGeneration: status.observedGeneration },
        };
      }
      if (syncedCondition?.status === 'True') {
        return { ready: true, message: `${resourceKind} instance is active and synced` };
      }
      if (syncedCondition) {
        return {
          ready: false,
          reason: 'NotSynced',
          message: `${resourceKind} InstanceSynced condition is '${syncedCondition.status}': ${syncedCondition.message || 'No message'}`,
          details: { state, conditions, observedGeneration: status.observedGeneration },
        };
      }
      return {
        ready: false,
        reason: 'ReadinessConditionMissing',
        message: `${resourceKind} Ready or InstanceSynced condition not yet available`,
        details: { state, conditions, observedGeneration: status.observedGeneration },
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating ${resourceKind} readiness: ${ensureError(error).message}`,
        details: { error: ensureError(error).message },
      };
    }
  };

  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id: KRO_CUSTOM_RESOURCE_READINESS_STRATEGY,
    revision: '1',
    configuration: readinessConfiguration({ resourceKind: readinessLiteral(resourceKind) }),
  });
}

registerPortableReadinessStrategy(KRO_CUSTOM_RESOURCE_READINESS_STRATEGY, '1', (configuration) =>
  createKroCustomResourceReadinessEvaluator(
    requiredReadinessString(configuration, 'resourceKind')
  )
);

/**
 * Generic Kro custom resource factory with schema-based typing
 *
 * Creates an Enhanced Kro custom resource with proper status field typing
 * that includes both user-defined and Kro-managed status fields.
 *
 * @param resource - The Kro custom resource configuration
 * @returns Enhanced resource with Kro status fields and readiness evaluation
 */
export function kroCustomResource<TSpec extends object, TStatus extends object>(resource: {
  apiVersion: string; // e.g., 'kro.run/v1alpha1'
  kind: string; // e.g., 'WebApplication'
  metadata: { name: string; namespace?: string };
  spec: TSpec;
}): Enhanced<TSpec, WithKroStatusFields<TStatus>> {
  return createResource<TSpec, WithKroStatusFields<TStatus>>({
    ...resource,
    metadata: resource.metadata ?? { name: 'unnamed-kro-resource' },
  }).withReadinessEvaluator(createKroCustomResourceReadinessEvaluator(resource.kind));
}
