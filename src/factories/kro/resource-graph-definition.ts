/**
 * ResourceGraphDefinition factory with readiness evaluation
 */

import { ensureError } from '../../core/errors.js';
import { getComponentLogger } from '../../core/logging/index.js';
import type {
  Enhanced,
  KubernetesCondition,
  ResourceStatus,
  RGDManifest,
} from '../../core/types/index.js';
import { createResource } from '../shared.js';

// Logger for RGD readiness evaluation
const rgdLogger = getComponentLogger('rgd-readiness');

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
  // For RGDs, we need to preserve the original structure since they don't need magic proxy functionality
  const rgdResource = {
    ...rgd,
    apiVersion: 'kro.run/v1alpha1' as const,
    kind: 'ResourceGraphDefinition' as const,
    metadata: rgd.metadata ?? { name: 'unnamed-rgd' },
  };

  return createResource<Record<string, unknown>, Record<string, unknown>>(
    rgdResource
  ).withReadinessEvaluator((liveRGD: RGDManifest): ResourceStatus => {
    // This robust readiness check ensures the Kro controller has fully processed the RGD.
    try {
      // Defensive checks for the live resource
      if (!liveRGD) {
        return {
          ready: false,
          reason: 'ResourceNotFound',
          message: 'ResourceGraphDefinition not found in cluster.',
        };
      }

      const status = liveRGD.status;
      const metadata = liveRGD.metadata;

      // 1. If no status exists yet, RGD is still being processed by Kro
      if (!status) {
        // Check if the RGD exists (has metadata with uid) but no status yet
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

      // 2. Check for explicit failure conditions first for faster feedback.
      const conditions = Array.isArray(status.conditions) ? status.conditions : [];
      const failedCondition = conditions.find(
        (c: KubernetesCondition) => c && c.status === 'False'
      );
      if (status.state === 'failed' || failedCondition) {
        return {
          ready: false,
          reason: 'RGDProcessingFailed',
          message: `RGD processing failed: ${failedCondition?.message || 'Unknown error'}`,
          details: { state: status.state, conditions },
        };
      }

      // 3. Check if RGD is in Active state with proper conditions
      const isStateReady = status.state === 'Active';

      // Check for key readiness conditions (be defensive about conditions structure).
      // Support both Kro v0.3.x condition names (ReconcilerReady, GraphVerified,
      // CustomResourceDefinitionSynced) and v0.8.x names (Ready, ControllerReady,
      // KindReady, ResourceGraphAccepted).
      const hasV08Conditions = conditions.some(
        (c: KubernetesCondition) => c?.type === 'Ready' || c?.type === 'ControllerReady'
      );

      let allConditionsReady: boolean;
      if (hasV08Conditions) {
        // Kro v0.8.x: check Ready condition
        const readyCondition = conditions.find(
          (c: KubernetesCondition) => c?.type === 'Ready' && c?.status === 'True'
        );
        allConditionsReady = !!readyCondition;
      } else {
        // Kro v0.3.x: check legacy conditions
        const reconcilerReady = conditions.find(
          (c: KubernetesCondition) => c?.type === 'ReconcilerReady' && c?.status === 'True'
        );
        const graphVerified = conditions.find(
          (c: KubernetesCondition) => c?.type === 'GraphVerified' && c?.status === 'True'
        );
        const crdSynced = conditions.find(
          (c: KubernetesCondition) =>
            c?.type === 'CustomResourceDefinitionSynced' && c?.status === 'True'
        );
        allConditionsReady = !!(reconcilerReady && graphVerified && crdSynced);
      }

      if (isStateReady && allConditionsReady) {
        return {
          ready: true,
          message: 'ResourceGraphDefinition is active and ready.',
        };
      }

      // 4. If none of the above, the RGD is still progressing.
      return {
        ready: false,
        reason: 'ReconciliationPending',
        message: `Waiting for RGD to become active (current state: ${status.state || 'unknown'})`,
        details: { state: status.state, conditions },
      };
    } catch (error: unknown) {
      // Log the error for debugging but don't let it crash the readiness evaluation
      rgdLogger.error('Unexpected error in readiness evaluator', ensureError(error), { liveRGD });
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating ResourceGraphDefinition readiness: ${error}`,
        details: { error: String(error), liveRGD: liveRGD },
      };
    }
  });
}
