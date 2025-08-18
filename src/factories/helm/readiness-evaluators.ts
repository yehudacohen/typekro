/**
 * Readiness Evaluators for Helm Resources
 *
 * This module provides readiness evaluators for HelmRelease resources,
 * checking Helm installation and upgrade phases for proper readiness.
 */

import type { ReadinessEvaluator, ResourceStatus } from '../../core/types/index.js';

/**
 * Default readiness evaluator for HelmRelease resources
 * 
 * HelmReleases are considered "ready" when they are successfully installed or upgraded
 * and the Helm release status indicates success.
 */
export const helmReleaseReadinessEvaluator: ReadinessEvaluator = (liveResource: any): ResourceStatus => {
  try {
    // For HelmRelease resources, we check the status conditions
    const status = liveResource.status;
    
    if (!status) {
      return {
        ready: false,
        reason: 'StatusMissing',
        message: 'HelmRelease status not available yet',
      };
    }

    // Check the phase of the HelmRelease
    if (status.phase === 'Ready') {
      return {
        ready: true,
        message: `HelmRelease is ready (revision ${status.revision || 'unknown'})`,
      };
    }

    if (status.phase === 'Failed') {
      return {
        ready: false,
        reason: 'InstallationFailed',
        message: status.message || 'Helm installation/upgrade failed',
      };
    }

    // Check for specific Helm phases
    if (status.phase === 'Installing') {
      return {
        ready: false,
        reason: 'Installing',
        message: 'Helm chart is being installed',
      };
    }

    if (status.phase === 'Upgrading') {
      return {
        ready: false,
        reason: 'Upgrading',
        message: 'Helm chart is being upgraded',
      };
    }

    // Check conditions array if available (Flux CD v2 pattern)
    if (status.conditions && Array.isArray(status.conditions)) {
      const readyCondition = status.conditions.find((c: any) => c.type === 'Ready');
      if (readyCondition) {
        if (readyCondition.status === 'True') {
          return {
            ready: true,
            message: readyCondition.message || `HelmRelease is ready (revision ${status.revision || 'unknown'})`,
          };
        } else {
          return {
            ready: false,
            reason: readyCondition.reason || 'NotReady',
            message: readyCondition.message || 'HelmRelease is not ready',
          };
        }
      }

      // Check for Released condition as fallback
      const releasedCondition = status.conditions.find((c: any) => c.type === 'Released');
      if (releasedCondition && releasedCondition.status === 'True') {
        return {
          ready: true,
          message: releasedCondition.message || `Helm chart released successfully (revision ${status.revision || 'unknown'})`,
        };
      }
    }

    // Still processing or unknown state
    return {
      ready: false,
      reason: 'Processing',
      message: `HelmRelease is ${status.phase || 'processing'}`,
    };
  } catch (error) {
    return {
      ready: false,
      reason: 'EvaluationError',
      message: `Error evaluating HelmRelease readiness: ${error}`,
    };
  }
};

/**
 * Create a readiness evaluator that waits for a specific Helm release revision
 * 
 * This is useful when you want to ensure a specific version of a chart is deployed.
 * 
 * @param expectedRevision The revision number to wait for
 * @returns ReadinessEvaluator function
 */
export function createHelmRevisionReadinessEvaluator(expectedRevision: number): ReadinessEvaluator {
  return (liveResource: any): ResourceStatus => {
    try {
      const baseStatus = helmReleaseReadinessEvaluator(liveResource);
      
      // If not ready for other reasons, return that status
      if (!baseStatus.ready) {
        return baseStatus;
      }

      // Check if we have the expected revision
      const status = liveResource.status;
      const currentRevision = status?.revision;
      
      if (currentRevision === expectedRevision) {
        return {
          ready: true,
          message: `HelmRelease is ready at expected revision ${expectedRevision}`,
        };
      }

      return {
        ready: false,
        reason: 'WrongRevision',
        message: `HelmRelease is ready but at revision ${currentRevision}, expected ${expectedRevision}`,
      };
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating Helm revision readiness: ${error}`,
      };
    }
  };
}

/**
 * Create a readiness evaluator that checks for successful test execution
 * 
 * This evaluator waits for Helm tests to complete successfully if they are enabled.
 * 
 * @param requireTests Whether to require test success for readiness (default: false)
 * @returns ReadinessEvaluator function
 */
export function createHelmTestReadinessEvaluator(requireTests: boolean = false): ReadinessEvaluator {
  return (liveResource: any): ResourceStatus => {
    try {
      const baseStatus = helmReleaseReadinessEvaluator(liveResource);
      
      // If not ready for other reasons, return that status
      if (!baseStatus.ready) {
        return baseStatus;
      }

      // If tests are not required, return the base status
      if (!requireTests) {
        return baseStatus;
      }

      // Check for test conditions
      const status = liveResource.status;
      if (status.conditions && Array.isArray(status.conditions)) {
        const testCondition = status.conditions.find((c: any) => c.type === 'TestSuccess');
        if (testCondition) {
          if (testCondition.status === 'True') {
            return {
              ready: true,
              message: `HelmRelease is ready and tests passed (revision ${status.revision || 'unknown'})`,
            };
          } else {
            return {
              ready: false,
              reason: 'TestsFailed',
              message: testCondition.message || 'Helm tests failed',
            };
          }
        }
      }

      // No test condition found but tests are required
      return {
        ready: false,
        reason: 'TestsPending',
        message: 'Waiting for Helm tests to complete',
      };
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating Helm test readiness: ${error}`,
      };
    }
  };
}

/**
 * Create a readiness evaluator with custom timeout for Helm operations
 * 
 * This evaluator considers a HelmRelease failed if it takes too long to install/upgrade.
 * 
 * @param timeoutMinutes Maximum time to wait for Helm operations (default: 10 minutes)
 * @returns ReadinessEvaluator function
 */
export function createHelmTimeoutReadinessEvaluator(timeoutMinutes: number = 10): ReadinessEvaluator {
  return (liveResource: any): ResourceStatus => {
    try {
      const baseStatus = helmReleaseReadinessEvaluator(liveResource);
      
      // If already ready or failed, return that status
      if (baseStatus.ready || baseStatus.reason === 'InstallationFailed') {
        return baseStatus;
      }

      // Check if we have timing information
      const status = liveResource.status;
      const metadata = liveResource.metadata;
      
      // Use lastDeployed time or creation time as reference
      let startTime: Date | null = null;
      
      if (status?.lastDeployed) {
        startTime = new Date(status.lastDeployed);
      } else if (metadata?.creationTimestamp) {
        startTime = new Date(metadata.creationTimestamp);
      }

      if (startTime) {
        const now = new Date();
        const elapsedMinutes = (now.getTime() - startTime.getTime()) / (1000 * 60);
        
        if (elapsedMinutes > timeoutMinutes) {
          return {
            ready: false,
            reason: 'Timeout',
            message: `HelmRelease operation timed out after ${Math.round(elapsedMinutes)} minutes (limit: ${timeoutMinutes} minutes)`,
          };
        }
      }

      return baseStatus;
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating Helm timeout readiness: ${error}`,
      };
    }
  };
}

/**
 * Create a comprehensive readiness evaluator that combines multiple Helm checks
 * 
 * This evaluator provides a complete readiness check including revision, tests, and timeout.
 * 
 * @param options Configuration options for the comprehensive check
 * @returns ReadinessEvaluator function
 */
export function createComprehensiveHelmReadinessEvaluator(options: {
  expectedRevision?: number;
  requireTests?: boolean;
  timeoutMinutes?: number;
} = {}): ReadinessEvaluator {
  const {
    expectedRevision,
    requireTests = false,
    timeoutMinutes = 10
  } = options;

  return (liveResource: any): ResourceStatus => {
    try {
      // First check timeout
      const timeoutEvaluator = createHelmTimeoutReadinessEvaluator(timeoutMinutes);
      const timeoutStatus = timeoutEvaluator(liveResource);
      
      if (timeoutStatus.reason === 'Timeout') {
        return timeoutStatus;
      }

      // Then check basic readiness
      const baseStatus = helmReleaseReadinessEvaluator(liveResource);
      if (!baseStatus.ready) {
        return baseStatus;
      }

      // Check revision if specified
      if (expectedRevision !== undefined) {
        const revisionEvaluator = createHelmRevisionReadinessEvaluator(expectedRevision);
        const revisionStatus = revisionEvaluator(liveResource);
        if (!revisionStatus.ready) {
          return revisionStatus;
        }
      }

      // Check tests if required
      if (requireTests) {
        const testEvaluator = createHelmTestReadinessEvaluator(true);
        const testStatus = testEvaluator(liveResource);
        if (!testStatus.ready) {
          return testStatus;
        }
      }

      // All checks passed
      const status = liveResource.status;
      return {
        ready: true,
        message: `HelmRelease is fully ready (revision ${status?.revision || 'unknown'})${requireTests ? ' with tests passed' : ''}`,
      };
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error in comprehensive Helm readiness evaluation: ${error}`,
      };
    }
  };
}