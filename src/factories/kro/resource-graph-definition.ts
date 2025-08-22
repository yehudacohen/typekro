/**
 * ResourceGraphDefinition factory with readiness evaluation
 */

import { getComponentLogger } from '../../core/logging/index.js';
import type { Enhanced, ResourceStatus } from '../../core/types/index.js';
import { createResource } from '../shared.js';

// Logger for RGD readiness evaluation
const rgdLogger = getComponentLogger('rgd-readiness');

/**
 * ResourceGraphDefinition factory with readiness evaluation
 *
 * Creates an Enhanced ResourceGraphDefinition with Kro-specific readiness logic
 * that checks the RGD status phase and conditions for 'ready' state.
 */
export function resourceGraphDefinition(rgd: any): Enhanced<any, any> {
  // For RGDs, we need to preserve the original structure since they don't need magic proxy functionality
  const rgdResource = {
    ...rgd,
    apiVersion: 'kro.run/v1alpha1',
    kind: 'ResourceGraphDefinition',
  };

  return createResource(rgdResource).withReadinessEvaluator((liveRGD: any): ResourceStatus => {
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
      const failedCondition = conditions.find((c: any) => c && c.status === 'False');
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

      // Check for key readiness conditions (be defensive about conditions structure)
      const reconcilerReady = conditions.find(
        (c: any) => c && c.type === 'ReconcilerReady' && c.status === 'True'
      );
      const graphVerified = conditions.find(
        (c: any) => c && c.type === 'GraphVerified' && c.status === 'True'
      );
      const crdSynced = conditions.find(
        (c: any) => c && c.type === 'CustomResourceDefinitionSynced' && c.status === 'True'
      );
      const allConditionsReady = reconcilerReady && graphVerified && crdSynced;

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
    } catch (error) {
      // Log the error for debugging but don't let it crash the readiness evaluation
      rgdLogger.error('Unexpected error in readiness evaluator', error as Error, { liveRGD });
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating ResourceGraphDefinition readiness: ${error}`,
        details: { error: String(error), liveRGD: liveRGD },
      };
    }
  });
}
