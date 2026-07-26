/**
 * Readiness Evaluators for Helm Resources
 *
 * This module provides readiness evaluators for HelmRelease resources,
 * checking Helm installation and upgrade phases for proper readiness.
 */

import { ensureError } from '../../core/errors.js';
import {
  identifyPortableReadinessEvaluator,
  identifyRuntimeReadinessEvaluator,
  registerPortableReadinessStrategy,
} from '../../core/readiness/portable-strategies.js';
import {
  optionalReadinessString,
  readinessConfiguration,
  readinessLiteral,
  requiredReadinessBoolean,
  requiredReadinessNumber,
} from '../../core/readiness/strategy-configuration.js';
import type {
  KubernetesCondition,
  ReadinessEvaluator,
  ResourceStatus,
} from '../../core/types/index.js';

interface HelmReleaseLike {
  status?: {
    phase?: string;
    revision?: number | string;
    message?: string;
    observedGeneration?: number;
    conditions?: KubernetesCondition[];
    lastDeployed?: string;
  };
  metadata?: {
    creationTimestamp?: string;
    generation?: number;
    uid?: string;
  };
}

const HELM_RELEASE_STRATEGY = 'typekro.readiness.flux.helm-release';
const HELM_RELEASE_REVISION_STRATEGY = 'typekro.readiness.flux.helm-release-revision';
const HELM_RELEASE_TEST_STRATEGY = 'typekro.readiness.flux.helm-release-test';
const HELM_READINESS_REVISION = '1';

/**
 * Create a readiness evaluator for HelmRelease resources.
 *
 * Checks multiple readiness criteria in priority order: status phase,
 * Flux CD conditions array, and installation/upgrade progress. Wraps
 * the evaluation in a try/catch for resilience.
 *
 * @param label - Optional label prefix for log messages (e.g., `'Cert-Manager'`).
 *   Defaults to no prefix (`'HelmRelease'`).
 *
 * IMPORTANT: In Flux CD v2, HelmRelease may NOT have status field initially
 * during installation/upgrades. The status field is added later by controllers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- HelmRelease is a CRD without typed client
export function createLabeledHelmReleaseEvaluator(label?: string): ReadinessEvaluator<unknown> {
  const prefix = label ? `${label} ` : '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- HelmRelease is a CRD without typed client
  const evaluator = (liveResource: unknown): ResourceStatus => {
    try {
      const live = liveResource as HelmReleaseLike;
      const status = live.status;

      // Case 1: No status field yet (common during initial creation)
      if (!status) {
        return {
          ready: false,
          reason: 'Installing',
          message: `${prefix}HelmRelease installation in progress - status not available yet`,
        };
      }

      // An apply can advance metadata.generation before Flux has observed the
      // new spec. Never reuse readiness evidence from the preceding
      // generation: doing so makes a direct factory update return while Flux
      // is still reconciling the replacement values. Prefer the top-level
      // observedGeneration and also honor generation-aware Ready conditions
      // when the controller supplies them.
      const desiredGeneration = live.metadata?.generation;
      const readyCondition = status.conditions?.find(
        (condition: KubernetesCondition) => condition.type === 'Ready'
      );
      const observedGenerations = [
        status.observedGeneration,
        readyCondition?.observedGeneration,
      ].filter((generation): generation is number => typeof generation === 'number');
      const staleGenerations =
        typeof desiredGeneration === 'number'
          ? observedGenerations.filter((generation) => generation < desiredGeneration)
          : [];
      if (typeof desiredGeneration === 'number' && staleGenerations.length > 0) {
        return {
          ready: false,
          reason: 'GenerationNotObserved',
          message: `${prefix}HelmRelease has not observed generation ${desiredGeneration} yet`,
          details: {
            desiredGeneration,
            observedGeneration:
              staleGenerations.length > 0 ? Math.max(...staleGenerations) : undefined,
          },
        };
      }

      // Case 2: Check the phase of the HelmRelease (primary readiness indicator)
      if (status.phase === 'Ready') {
        return {
          ready: true,
          message: `${prefix}HelmRelease is ready (revision ${status.revision || 'unknown'})`,
        };
      }

      if (status.phase === 'Failed') {
        return {
          ready: false,
          reason: 'InstallationFailed',
          message: status.message || `${prefix}Helm installation/upgrade failed`,
        };
      }

      // Case 3: Handle Installing/Upgrading phases explicitly
      if (status.phase === 'Installing') {
        return {
          ready: false,
          reason: 'Installing',
          message: `${prefix}HelmRelease installation in progress`,
        };
      }

      if (status.phase === 'Upgrading') {
        return {
          ready: false,
          reason: 'Upgrading',
          message: `${prefix}HelmRelease upgrade in progress`,
        };
      }

      // Case 4: Check conditions array if available (Flux CD v2 pattern)
      if (status.conditions && Array.isArray(status.conditions)) {
        if (readyCondition && readyCondition.status === 'True') {
          return {
            ready: true,
            message:
              readyCondition.message ||
              `${prefix}HelmRelease is ready (revision ${status.revision || 'unknown'})`,
          };
        } else {
          return {
            ready: false,
            reason: readyCondition?.reason || 'NotReady',
            message: readyCondition?.message || `${prefix}HelmRelease is not ready`,
          };
        }
      }

      // Case 5: If status exists but no known phase or conditions, assume processing
      return {
        ready: false,
        reason: 'Processing',
        message: `${prefix}HelmRelease is ${status.phase || 'processing'} (revision ${status.revision || 'unknown'})`,
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating ${prefix}HelmRelease readiness: ${ensureError(error).message}`,
      };
    }
  };
  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id: HELM_RELEASE_STRATEGY,
    revision: HELM_READINESS_REVISION,
    configuration: readinessConfiguration({
      label: label === undefined ? undefined : readinessLiteral(label),
    }),
  });
}

/**
 * Default (unlabeled) readiness evaluator for HelmRelease resources.
 *
 * For a labeled variant, use {@link createLabeledHelmReleaseEvaluator}.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- HelmRelease is a CRD without typed client
export const helmReleaseReadinessEvaluator: ReadinessEvaluator<unknown> =
  createLabeledHelmReleaseEvaluator();

/**
 * Create a readiness evaluator that waits for a specific Helm release revision
 *
 * This is useful when you want to ensure a specific version of a chart is deployed.
 *
 * @param expectedRevision The revision number to wait for
 * @returns ReadinessEvaluator function
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- HelmRelease is a CRD without typed client
export function createHelmRevisionReadinessEvaluator(
  expectedRevision: number
): ReadinessEvaluator<unknown> {
  const evaluator = (liveResource: unknown): ResourceStatus => {
    try {
      const baseStatus = helmReleaseReadinessEvaluator(liveResource);

      // If not ready for other reasons, return that status
      if (!baseStatus.ready) {
        return baseStatus;
      }

      // Check if we have the expected revision
      const live = liveResource as HelmReleaseLike;
      const status = live.status;
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
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating Helm revision readiness: ${ensureError(error).message}`,
      };
    }
  };
  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id: HELM_RELEASE_REVISION_STRATEGY,
    revision: HELM_READINESS_REVISION,
    configuration: readinessConfiguration({
      expectedRevision: readinessLiteral(expectedRevision),
    }),
  });
}

/**
 * Create a readiness evaluator that checks for successful test execution
 *
 * This evaluator waits for Helm tests to complete successfully if they are enabled.
 *
 * @param requireTests Whether to require test success for readiness (default: false)
 * @returns ReadinessEvaluator function
 */
export function createHelmTestReadinessEvaluator(
  requireTests: boolean = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- HelmRelease is a CRD without typed client
): ReadinessEvaluator<unknown> {
  const evaluator = (liveResource: unknown): ResourceStatus => {
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
      const live = liveResource as HelmReleaseLike;
      const status = live.status;
      if (!status) {
        return baseStatus;
      }
      if (status.conditions && Array.isArray(status.conditions)) {
        const testCondition = status.conditions.find(
          (c: KubernetesCondition) => c.type === 'TestSuccess'
        );
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
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating Helm test readiness: ${ensureError(error).message}`,
      };
    }
  };
  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id: HELM_RELEASE_TEST_STRATEGY,
    revision: HELM_READINESS_REVISION,
    configuration: readinessConfiguration({
      requireTests: readinessLiteral(requireTests),
    }),
  });
}

/**
 * Create a readiness evaluator with custom timeout for Helm operations
 *
 * This evaluator considers a HelmRelease failed if it takes too long to install/upgrade.
 *
 * @param timeoutMinutes Maximum time to wait for Helm operations (default: 10 minutes)
 * @returns ReadinessEvaluator function
 */
export function createHelmTimeoutReadinessEvaluator(
  timeoutMinutes: number = 10
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- HelmRelease is a CRD without typed client
): ReadinessEvaluator<unknown> {
  return identifyRuntimeReadinessEvaluator(
    (liveResource: unknown): ResourceStatus => {
      try {
        const baseStatus = helmReleaseReadinessEvaluator(liveResource);

        // If already ready or failed, return that status
        if (baseStatus.ready || baseStatus.reason === 'InstallationFailed') {
          return baseStatus;
        }

        // Check if we have timing information
        const live = liveResource as HelmReleaseLike;
        const status = live.status;
        const metadata = live.metadata;

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
      } catch (error: unknown) {
        return {
          ready: false,
          reason: 'EvaluationError',
          message: `Error evaluating Helm timeout readiness: ${ensureError(error).message}`,
        };
      }
    },
    {
      reason: 'ambient-clock',
      description: `Helm timeout readiness compares resource timestamps with the host clock (${timeoutMinutes} minute limit).`,
    }
  );
}

/**
 * Create a comprehensive readiness evaluator that combines multiple Helm checks
 *
 * This evaluator provides a complete readiness check including revision, tests, and timeout.
 *
 * @param options Configuration options for the comprehensive check
 * @returns ReadinessEvaluator function
 */
export function createComprehensiveHelmReadinessEvaluator(
  options: { expectedRevision?: number; requireTests?: boolean; timeoutMinutes?: number } = {}
): ReadinessEvaluator<unknown> {
  const { expectedRevision, requireTests = false, timeoutMinutes = 10 } = options;

  return identifyRuntimeReadinessEvaluator(
    (liveResource: unknown): ResourceStatus => {
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
        const live = liveResource as HelmReleaseLike;
        const status = live.status;
        return {
          ready: true,
          message: `HelmRelease is fully ready (revision ${status?.revision || 'unknown'})${requireTests ? ' with tests passed' : ''}`,
        };
      } catch (error: unknown) {
        return {
          ready: false,
          reason: 'EvaluationError',
          message: `Error in comprehensive Helm readiness evaluation: ${ensureError(error).message}`,
        };
      }
    },
    {
      reason: 'ambient-clock',
      description: `Comprehensive Helm readiness includes a host-clock timeout (${timeoutMinutes} minute limit).`,
    }
  );
}

registerPortableReadinessStrategy(HELM_RELEASE_STRATEGY, HELM_READINESS_REVISION, (configuration) =>
  createLabeledHelmReleaseEvaluator(optionalReadinessString(configuration, 'label'))
);
registerPortableReadinessStrategy(
  HELM_RELEASE_REVISION_STRATEGY,
  HELM_READINESS_REVISION,
  (configuration) =>
    createHelmRevisionReadinessEvaluator(requiredReadinessNumber(configuration, 'expectedRevision'))
);
registerPortableReadinessStrategy(
  HELM_RELEASE_TEST_STRATEGY,
  HELM_READINESS_REVISION,
  (configuration) =>
    createHelmTestReadinessEvaluator(requiredReadinessBoolean(configuration, 'requireTests'))
);
