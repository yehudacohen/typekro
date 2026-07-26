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

import { ensureError } from '../errors.js';
import type { PlanValue } from '../planning/types.js';
import type { ReadinessEvaluator, ResourceStatus } from '../types/kubernetes.js';
import {
  identifyPortableReadinessEvaluator,
  registerPortableReadinessStrategy,
} from './portable-strategies.js';

const ALWAYS_READY_STRATEGY = 'typekro.readiness.always';
const CONDITION_READY_STRATEGY = 'typekro.readiness.condition';
const PHASE_READY_STRATEGY = 'typekro.readiness.phase';
const CRD_READY_STRATEGY = 'typekro.readiness.custom-resource-definition';
const BUILTIN_READINESS_REVISION = '1';

function literal(value: string): PlanValue {
  return { kind: 'literal', value };
}

function objectValue(entries: Record<string, PlanValue | undefined>): PlanValue {
  return {
    kind: 'object',
    entries: Object.entries(entries)
      .filter((entry): entry is [string, PlanValue] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value })),
  };
}

function stringArray(values: readonly string[]): PlanValue {
  return { kind: 'array', items: values.map(literal) };
}

function configurationEntries(configuration: PlanValue | undefined): Map<string, PlanValue> {
  if (configuration?.kind !== 'object') return new Map();
  return new Map(configuration.entries.map((entry) => [entry.key, entry.value]));
}

function requiredString(entries: Map<string, PlanValue>, key: string): string {
  const value = entries.get(key);
  if (value?.kind !== 'literal' || typeof value.value !== 'string') {
    throw new Error(`Portable readiness configuration requires string field ${key}.`);
  }
  return value.value;
}

function optionalString(entries: Map<string, PlanValue>, key: string): string | undefined {
  const value = entries.get(key);
  return value?.kind === 'literal' && typeof value.value === 'string' ? value.value : undefined;
}

function requiredStrings(entries: Map<string, PlanValue>, key: string): string[] {
  const value = entries.get(key);
  if (value?.kind !== 'array') {
    throw new Error(`Portable readiness configuration requires string array field ${key}.`);
  }
  return value.items.map((item) => {
    if (item.kind !== 'literal' || typeof item.value !== 'string') {
      throw new Error(`Portable readiness configuration field ${key} must contain strings.`);
    }
    return item.value;
  });
}

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
export function createAlwaysReadyEvaluator<T = unknown>(
  kind: string,
  message = `${kind} is ready (configuration resource)`
): ReadinessEvaluator<T> {
  return identifyPortableReadinessEvaluator(
    () => ({
      ready: true,
      message,
    }),
    {
      kind: 'registered',
      id: ALWAYS_READY_STRATEGY,
      revision: BUILTIN_READINESS_REVISION,
      configuration: objectValue({ kind: literal(kind), message: literal(message) }),
    }
  );
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

  const evaluator = (liveResource: unknown): ResourceStatus => {
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
        message: `Error evaluating ${kind} readiness: ${ensureError(error).message}`,
      };
    }
  };
  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id: CONDITION_READY_STRATEGY,
    revision: BUILTIN_READINESS_REVISION,
    configuration: objectValue({
      conditionType: literal(conditionType),
      defaultReadyMessage: options.defaultReadyMessage
        ? literal(options.defaultReadyMessage)
        : undefined,
      kind: literal(kind),
    }),
  });
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

  const evaluator = (liveResource: T): ResourceStatus => {
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
        message: `Error evaluating ${kind} readiness: ${ensureError(error).message}`,
      };
    }
  };
  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id: PHASE_READY_STRATEGY,
    revision: BUILTIN_READINESS_REVISION,
    configuration: objectValue({
      kind: literal(kind),
      phaseField: literal(phaseField),
      readyPhases: stringArray(readyPhases),
    }),
  });
}

/** Portable readiness for CRDs, which require both Kubernetes establishment conditions. */
export function createCustomResourceDefinitionReadinessEvaluator(): ReadinessEvaluator<unknown> {
  const evaluator: ReadinessEvaluator<unknown> = (liveResource) => {
    const conditions =
      (
        liveResource as {
          status?: { conditions?: Array<{ type?: string; status?: string }> };
        } | null
      )?.status?.conditions ?? [];
    const established = conditions.find((condition) => condition.type === 'Established');
    const namesAccepted = conditions.find((condition) => condition.type === 'NamesAccepted');
    const ready = established?.status === 'True' && namesAccepted?.status === 'True';
    return ready
      ? {
          ready: true,
          message: 'CustomResourceDefinition is established and names are accepted',
        }
      : {
          ready: false,
          reason: 'ConditionsNotMet',
          message: 'CustomResourceDefinition is not established and names accepted yet',
          details: { conditions },
        };
  };
  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id: CRD_READY_STRATEGY,
    revision: BUILTIN_READINESS_REVISION,
    configuration: objectValue({}),
  });
}

registerPortableReadinessStrategy(
  ALWAYS_READY_STRATEGY,
  BUILTIN_READINESS_REVISION,
  (configuration) => {
    const entries = configurationEntries(configuration);
    const kind = requiredString(entries, 'kind');
    return createAlwaysReadyEvaluator(
      kind,
      optionalString(entries, 'message') ?? `${kind} is ready (configuration resource)`
    );
  }
);
registerPortableReadinessStrategy(
  CONDITION_READY_STRATEGY,
  BUILTIN_READINESS_REVISION,
  (configuration) => {
    const entries = configurationEntries(configuration);
    const defaultReadyMessage = optionalString(entries, 'defaultReadyMessage');
    return createConditionBasedReadinessEvaluator({
      kind: requiredString(entries, 'kind'),
      conditionType: requiredString(entries, 'conditionType'),
      ...(defaultReadyMessage ? { defaultReadyMessage } : {}),
    });
  }
);
registerPortableReadinessStrategy(
  PHASE_READY_STRATEGY,
  BUILTIN_READINESS_REVISION,
  (configuration) => {
    const entries = configurationEntries(configuration);
    return createPhaseBasedReadinessEvaluator({
      kind: requiredString(entries, 'kind'),
      phaseField: requiredString(entries, 'phaseField'),
      readyPhases: requiredStrings(entries, 'readyPhases'),
    });
  }
);
registerPortableReadinessStrategy(CRD_READY_STRATEGY, BUILTIN_READINESS_REVISION, () =>
  createCustomResourceDefinitionReadinessEvaluator()
);
