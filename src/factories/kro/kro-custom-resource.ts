/**
 * Generic Kro custom resource factory with schema-based typing
 */

import type { Enhanced, ResourceStatus, WithKroStatusFields } from '../../core/types/index.js';
import { createResource } from '../shared.js';

/**
 * Generic Kro custom resource factory with schema-based typing
 * 
 * Creates an Enhanced Kro custom resource with proper status field typing
 * that includes both user-defined and Kro-managed status fields.
 * 
 * @param resource - The Kro custom resource configuration
 * @returns Enhanced resource with Kro status fields and readiness evaluation
 */
export function kroCustomResource<TSpec extends object, TStatus extends object>(
  resource: {
    apiVersion: string; // e.g., 'kro.run/v1alpha1'
    kind: string;       // e.g., 'WebApplication'
    metadata: { name: string; namespace?: string };
    spec: TSpec;
  }
): Enhanced<TSpec, WithKroStatusFields<TStatus>> {
  // Capture kind in closure for readiness evaluation
  const resourceKind = resource.kind;

  return createResource<TSpec, WithKroStatusFields<TStatus>>({
    ...resource,
    metadata: resource.metadata ?? { name: 'unnamed-kro-resource' },
  }).withReadinessEvaluator((liveResource: any): ResourceStatus => {
    try {
      const status = liveResource.status as WithKroStatusFields<TStatus>;

      // Check if status object exists at all
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: `${resourceKind} status not yet available`,
          details: { statusExists: false }
        };
      }

      const state = status.state;
      const conditions = status.conditions || [];

      // Check if required Kro fields are present
      if (state === undefined) {
        return {
          ready: false,
          reason: 'StateFieldMissing',
          message: `${resourceKind} state field not yet populated by Kro controller`,
          details: {
            statusExists: true,
            stateExists: false,
            conditions: conditions.length > 0 ? conditions : undefined
          }
        };
      }

      // Check for failed state
      if (state === 'FAILED') {
        const failedCondition = conditions.find(c => c.status === 'False');
        return {
          ready: false,
          reason: 'KroInstanceFailed',
          message: `${resourceKind} instance failed: ${failedCondition?.message || 'Unknown error'}`,
          details: {
            state,
            conditions,
            observedGeneration: status.observedGeneration
          }
        };
      }

      // Handle different states
      if (state === 'PROGRESSING') {
        return {
          ready: false,
          reason: 'KroInstanceProgressing',
          message: `${resourceKind} instance progressing - State: ${state}`,
          details: {
            state,
            conditions,
            observedGeneration: status.observedGeneration
          }
        };
      }

      if (state !== 'ACTIVE') {
        return {
          ready: false,
          reason: 'StateNotActive',
          message: `${resourceKind} state is '${state}', waiting for 'ACTIVE'`,
          details: {
            state,
            conditions,
            observedGeneration: status.observedGeneration
          }
        };
      }

      // For ACTIVE state, check for Ready condition (primary) or InstanceSynced condition (fallback)
      const readyCondition = conditions.find(c => c.type === 'Ready');
      const syncedCondition = conditions.find(c => c.type === 'InstanceSynced');

      // Prefer Ready condition if available
      if (readyCondition) {
        if (readyCondition.status === 'True') {
          return {
            ready: true,
            message: `${resourceKind} instance is active and ready`
          };
        } else {
          return {
            ready: false,
            reason: 'ReadyConditionFalse',
            message: `${resourceKind} Ready condition is '${readyCondition.status}': ${readyCondition.message || 'No message'}`,
            details: {
              state,
              conditions,
              observedGeneration: status.observedGeneration
            }
          };
        }
      }

      // Fallback to InstanceSynced condition
      if (syncedCondition) {
        if (syncedCondition.status === 'True') {
          return {
            ready: true,
            message: `${resourceKind} instance is active and synced`
          };
        } else {
          return {
            ready: false,
            reason: 'NotSynced',
            message: `${resourceKind} InstanceSynced condition is '${syncedCondition.status}': ${syncedCondition.message || 'No message'}`,
            details: {
              state,
              conditions,
              observedGeneration: status.observedGeneration
            }
          };
        }
      }

      // No Ready or InstanceSynced condition found
      return {
        ready: false,
        reason: 'ReadinessConditionMissing',
        message: `${resourceKind} Ready or InstanceSynced condition not yet available`,
        details: {
          state,
          conditions,
          observedGeneration: status.observedGeneration
        }
      };
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating ${resourceKind} readiness: ${error}`,
        details: { error: String(error) }
      };
    }
  });
}