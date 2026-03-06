/**
 * Readiness Evaluator Factories
 *
 * Generic factories for creating readiness evaluators that follow common
 * Kubernetes patterns. These eliminate duplication across factory files
 * that each implement near-identical readiness logic.
 *
 * Patterns covered:
 * - Always Ready: Configuration resources with no meaningful status
 * - Condition-Based: Standard Kubernetes condition checking (Ready=True)
 * - Phase-Based: Single status.phase field comparison
 */

import type { ReadinessEvaluator, ResourceStatus } from '../types/kubernetes.js';

// =============================================================================
// Pattern 1: Always Ready
// =============================================================================

/**
 * Creates a readiness evaluator that always returns ready.
 *
 * Used for configuration resources (ConfigMap, Secret, ClusterRole, etc.)
 * that have no meaningful status and are considered ready upon creation.
 *
 * @param kind - Resource kind name for messages (e.g., 'ConfigMap')
 * @returns A ReadinessEvaluator that always returns `{ ready: true }`
 *
 * @example
 * ```typescript
 * createResource({ ... }).withReadinessEvaluator(
 *   createAlwaysReadyEvaluator('ConfigMap')
 * );
 * ```
 */
export function createAlwaysReadyEvaluator<T = unknown>(kind: string): ReadinessEvaluator<T> {
  return () => ({
    ready: true,
    message: `${kind} is ready (configuration resource)`,
  });
}

// =============================================================================
// Pattern 2: Condition-Based
// =============================================================================

/** Options for creating a condition-based readiness evaluator. */
export interface ConditionBasedEvaluatorOptions {
  /** Resource kind name for messages (e.g., 'Certificate', 'ClusterIssuer') */
  kind: string;

  /**
   * Primary condition type to check.
   * @default 'Ready'
   */
  conditionType?: string;

  /**
   * Default ready message when the condition message is absent.
   * @default `${kind} is ready`
   */
  defaultReadyMessage?: string;
}

interface StatusWithConditions {
  conditions?: Array<{
    type: string;
    status: string;
    reason?: string;
    message?: string;
  }>;
}

/**
 * Creates a readiness evaluator that checks `status.conditions` for a
 * specific condition type with `status: 'True'`.
 *
 * This is the standard Kubernetes condition-checking pattern used by
 * cert-manager Issuers/Certificates, Flux GitRepositories, and many CRDs.
 *
 * @param options - Configuration for the evaluator
 * @returns A ReadinessEvaluator that checks conditions
 *
 * @example
 * ```typescript
 * // Simple: check Ready condition
 * const evaluator = createConditionBasedReadinessEvaluator({ kind: 'ClusterIssuer' });
 *
 * // Custom condition type
 * const evaluator = createConditionBasedReadinessEvaluator({
 *   kind: 'MyResource',
 *   conditionType: 'Available',
 * });
 * ```
 */
export function createConditionBasedReadinessEvaluator(
  options: ConditionBasedEvaluatorOptions
): ReadinessEvaluator<unknown> {
  const { kind, conditionType = 'Ready' } = options;

  return (liveResource: unknown): ResourceStatus => {
    try {
      const resource = liveResource as { status?: StatusWithConditions } | null | undefined;
      const status = resource?.status;

      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: `${kind} status not available`,
        };
      }

      const conditions = status.conditions;
      if (!conditions || conditions.length === 0) {
        return {
          ready: false,
          reason: 'ConditionsMissing',
          message: `${kind} conditions not available`,
        };
      }

      // Look for the target condition
      const targetCondition = conditions.find((c) => c.type === conditionType);

      if (!targetCondition) {
        return {
          ready: false,
          reason: `${conditionType}ConditionMissing`,
          message: `${kind} ${conditionType} condition not found`,
        };
      }

      if (targetCondition.status === 'True') {
        return {
          ready: true,
          message: targetCondition.message || options.defaultReadyMessage || `${kind} is ready`,
          reason: 'Ready',
        };
      }

      // Not ready
      return {
        ready: false,
        reason: targetCondition.reason || 'NotReady',
        message: targetCondition.message || targetCondition.reason || `${kind} is not ready`,
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating ${kind} readiness: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

// =============================================================================
// Pattern 3: Phase-Based
// =============================================================================

/** Options for creating a phase-based readiness evaluator. */
export interface PhaseBasedEvaluatorOptions {
  /** Resource kind name for messages (e.g., 'Namespace', 'PersistentVolumeClaim') */
  kind: string;

  /** Phase values that indicate readiness (e.g., ['Active'], ['Bound'], ['Available', 'Bound']) */
  readyPhases: string[];

  /**
   * Name of the status field containing the phase.
   * @default 'phase'
   */
  phaseField?: string;
}

/**
 * Creates a readiness evaluator that checks `status.phase` (or a custom
 * field) against a set of expected values.
 *
 * Used for resources like Namespaces (Active), PVCs (Bound), and PVs
 * (Available/Bound).
 *
 * @param options - Configuration for the evaluator
 * @returns A ReadinessEvaluator that checks the phase field
 *
 * @example
 * ```typescript
 * const evaluator = createPhaseBasedReadinessEvaluator({
 *   kind: 'Namespace',
 *   readyPhases: ['Active'],
 * });
 * ```
 */
export function createPhaseBasedReadinessEvaluator<T = unknown>(
  options: PhaseBasedEvaluatorOptions
): ReadinessEvaluator<T> {
  const { kind, readyPhases, phaseField = 'phase' } = options;

  return (liveResource: T): ResourceStatus => {
    try {
      const resource = liveResource as { status?: Record<string, unknown> } | null | undefined;
      const status = resource?.status;

      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: `${kind} status not available yet`,
        };
      }

      const phase = status[phaseField] as string | undefined;
      const ready = phase !== undefined && readyPhases.includes(phase);

      if (ready) {
        return {
          ready: true,
          message: `${kind} is ready with phase: ${phase}`,
        };
      }

      return {
        ready: false,
        reason: 'PhaseNotReady',
        message: `${kind} phase is ${phase || 'unknown'}, expected: ${readyPhases.join(' or ')}`,
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating ${kind} readiness: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}
