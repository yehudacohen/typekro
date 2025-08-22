import type { ReadinessEvaluator, ResourceStatus } from '../../../core/types/index.js';

/**
 * Readiness evaluator for Kustomization resources
 *
 * Checks if the Kustomization has been successfully applied and all resources are ready.
 * This evaluator follows TypeKro patterns and integrates with the cluster state access system.
 */
export const kustomizationReadinessEvaluator: ReadinessEvaluator = (
  liveResource: any
): ResourceStatus => {
  try {
    const status = liveResource.status;

    if (!status) {
      return {
        ready: false,
        reason: 'StatusMissing',
        message: 'Kustomization status not available yet',
      };
    }

    // Check for conditions array
    if (!status.conditions || !Array.isArray(status.conditions)) {
      return {
        ready: false,
        reason: 'ConditionsMissing',
        message: 'Kustomization conditions not available',
      };
    }

    // Check for Ready condition
    const readyCondition = status.conditions.find((c: any) => c.type === 'Ready');
    if (!readyCondition) {
      return {
        ready: false,
        reason: 'ReadyConditionMissing',
        message: 'Ready condition not found in Kustomization status',
      };
    }

    if (readyCondition.status !== 'True') {
      return {
        ready: false,
        reason: readyCondition.reason || 'NotReady',
        message: readyCondition.message || 'Kustomization is not ready',
      };
    }

    // Check for Healthy condition if present
    const healthyCondition = status.conditions.find((c: any) => c.type === 'Healthy');
    if (healthyCondition && healthyCondition.status !== 'True') {
      return {
        ready: false,
        reason: healthyCondition.reason || 'NotHealthy',
        message: healthyCondition.message || 'Kustomization resources are not healthy',
      };
    }

    // Check if we have applied resources
    if (status.inventory?.entries && status.inventory.entries.length === 0) {
      return {
        ready: false,
        reason: 'NoResourcesApplied',
        message: 'No resources have been applied by this Kustomization',
      };
    }

    return {
      ready: true,
      message: `Kustomization is ready with ${status.inventory?.entries?.length || 0} applied resources`,
    };
  } catch (error) {
    return {
      ready: false,
      reason: 'EvaluationError',
      message: `Error evaluating Kustomization readiness: ${error}`,
    };
  }
};
