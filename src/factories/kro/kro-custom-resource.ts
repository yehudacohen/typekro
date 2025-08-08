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
      const state = status?.state;
      const conditions = status?.conditions || [];
      
      // Kro instances are ready when state is ACTIVE and Ready condition is True
      const readyCondition = conditions.find(c => c.type === 'Ready');
      const isActive = state === 'ACTIVE';
      const isReady = readyCondition?.status === 'True';
      
      if (isActive && isReady) {
        return {
          ready: true,
          message: `Kro ${resourceKind} instance is active and all resources are ready`
        };
      } else if (state === 'FAILED') {
        const failedCondition = conditions.find(c => c.status === 'False');
        return {
          ready: false,
          reason: 'KroInstanceFailed',
          message: `Kro ${resourceKind} instance failed: ${failedCondition?.message || 'Unknown error'}`,
          details: { 
            state,
            conditions,
            observedGeneration: status?.observedGeneration
          }
        };
      } else {
        return {
          ready: false,
          reason: 'KroInstanceProgressing',
          message: `Kro ${resourceKind} instance progressing - State: ${state || 'Unknown'}, Ready: ${readyCondition?.status || 'Unknown'}`,
          details: { 
            state,
            conditions,
            observedGeneration: status?.observedGeneration
          }
        };
      }
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating Kro ${resourceKind} readiness: ${error}`,
        details: { error: String(error) }
      };
    }
  });
}