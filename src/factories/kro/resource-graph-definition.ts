/**
 * ResourceGraphDefinition factory with readiness evaluation
 */

import { ensureError } from '../../core/errors.js';
import { getComponentLogger } from '../../core/logging/index.js';
import { registerPortableReadinessEvaluator } from '../../core/readiness/index.js';
import type {
  Enhanced,
  KubernetesCondition,
  ResourceStatus,
  RGDManifest,
} from '../../core/types/index.js';
import { createResource } from '../shared.js';

// Logger for RGD readiness evaluation
const rgdLogger = getComponentLogger('rgd-readiness');

const resourceGraphDefinitionReadinessEvaluator = registerPortableReadinessEvaluator(
  'typekro.readiness.kro.resource-graph-definition',
  '1',
  (liveRGD: RGDManifest): ResourceStatus => {
    try {
      if (!liveRGD) {
        return {
          ready: false,
          reason: 'ResourceNotFound',
          message: 'ResourceGraphDefinition not found in cluster.',
        };
      }

      const status = liveRGD.status;
      const metadata = liveRGD.metadata;
      if (!status) {
        if (metadata?.uid) {
          return {
            ready: false,
            reason: 'StatusPending',
            message:
              'ResourceGraphDefinition exists but Kro controller has not yet initialized status.',
          };
        }
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'Waiting for Kro controller to initialize status.',
        };
      }

      const conditions = Array.isArray(status.conditions) ? status.conditions : [];
      const generation = typeof metadata?.generation === 'number' ? metadata.generation : undefined;
      const hasObservedGeneration = conditions.some(
        (condition: KubernetesCondition) => typeof condition?.observedGeneration === 'number'
      );
      const currentConditions =
        hasObservedGeneration && generation !== undefined
          ? conditions.filter(
              (condition: KubernetesCondition) =>
                (condition.observedGeneration ?? 0) >= generation
            )
          : conditions;

      if (hasObservedGeneration && generation !== undefined && currentConditions.length === 0) {
        return {
          ready: false,
          reason: 'GenerationPending',
          message: `Waiting for Kro controller to process ResourceGraphDefinition generation ${generation}.`,
          details: { generation, conditions },
        };
      }

      const failedCondition = currentConditions.find(
        (condition: KubernetesCondition) => condition && condition.status === 'False'
      );
      if (status.state === 'failed' || failedCondition) {
        const rejected = currentConditions.find(
          (condition: KubernetesCondition) =>
            condition?.status === 'False' && /accepted/i.test(condition?.type ?? '')
        );
        const cause = rejected ?? failedCondition;
        if (rejected) {
          rgdLogger.warn('ResourceGraphDefinition was rejected by Kro (terminal)', {
            name: liveRGD?.metadata?.name,
            type: rejected.type,
            reason: rejected.reason,
            message: rejected.message,
          });
        }
        return {
          ready: false,
          reason: 'RGDProcessingFailed',
          message: `RGD processing failed: ${cause?.message || 'Unknown error'}`,
          ...(rejected ? { terminal: true } : {}),
          details: { state: status.state, generation, conditions },
        };
      }

      const isStateReady = status.state === 'Active';
      const hasV08Conditions = currentConditions.some(
        (condition: KubernetesCondition) =>
          condition?.type === 'Ready' || condition?.type === 'ControllerReady'
      );

      let allConditionsReady: boolean;
      if (hasV08Conditions) {
        allConditionsReady = currentConditions.some(
          (condition: KubernetesCondition) =>
            condition?.type === 'Ready' && condition?.status === 'True'
        );
      } else {
        const reconcilerReady = currentConditions.find(
          (condition: KubernetesCondition) =>
            condition?.type === 'ReconcilerReady' && condition?.status === 'True'
        );
        const graphVerified = currentConditions.find(
          (condition: KubernetesCondition) =>
            condition?.type === 'GraphVerified' && condition?.status === 'True'
        );
        const crdSynced = currentConditions.find(
          (condition: KubernetesCondition) =>
            condition?.type === 'CustomResourceDefinitionSynced' &&
            condition?.status === 'True'
        );
        allConditionsReady = !!(reconcilerReady && graphVerified && crdSynced);
      }

      if (isStateReady && allConditionsReady) {
        return {
          ready: true,
          message: 'ResourceGraphDefinition is active and ready.',
        };
      }

      return {
        ready: false,
        reason: 'ReconciliationPending',
        message: `Waiting for RGD to become active (current state: ${status.state || 'unknown'})`,
        details: { state: status.state, generation, conditions },
      };
    } catch (error: unknown) {
      rgdLogger.error('Unexpected error in readiness evaluator', ensureError(error), { liveRGD });
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating ResourceGraphDefinition readiness: ${ensureError(error).message}`,
        details: { error: ensureError(error).message, liveRGD },
      };
    }
  }
);

/**
 * Input type for the {@link resourceGraphDefinition} factory.
 *
 * Accepts any object with optional `metadata` and `spec` fields.
 * `apiVersion` and `kind` are always overwritten to `kro.run/v1alpha1`
 * / `ResourceGraphDefinition`, so callers may omit them.
 *
 * This is intentionally broader than `RGDManifest` to accommodate
 * call sites that pass inline objects with concrete schema types
 * (like `KroSimpleSchema`), which fail index-signature assignability
 * checks under `exactOptionalPropertyTypes`.
 */
interface ResourceGraphDefinitionInput {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    [key: string]: unknown;
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * ResourceGraphDefinition factory with readiness evaluation
 *
 * Creates an Enhanced ResourceGraphDefinition with Kro-specific readiness logic
 * that checks the RGD status phase and conditions for 'ready' state.
 *
 * @param rgd - An RGD manifest (all fields optional; `apiVersion` and `kind` are
 *              forced to `kro.run/v1alpha1` / `ResourceGraphDefinition`).
 */
export function resourceGraphDefinition(
  rgd: ResourceGraphDefinitionInput
): Enhanced<Record<string, unknown>, Record<string, unknown>> {
  const { namespace: _namespace, ...metadata } = rgd.metadata ?? { name: 'unnamed-rgd' };

  // For RGDs, we need to preserve the original structure since they don't need magic proxy functionality
  const rgdResource = {
    ...rgd,
    apiVersion: 'kro.run/v1alpha1' as const,
    kind: 'ResourceGraphDefinition' as const,
    metadata,
  };

  return createResource<Record<string, unknown>, Record<string, unknown>>(rgdResource, {
    scope: 'cluster',
  }).withReadinessEvaluator(resourceGraphDefinitionReadinessEvaluator);
}
