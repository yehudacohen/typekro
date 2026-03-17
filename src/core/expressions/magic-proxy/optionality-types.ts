/**
 * Type definitions for the Enhanced Type Optionality Handler.
 *
 * These types define the interfaces for optionality analysis, field hydration state
 * tracking, and undefined-to-defined transition handling for KubernetesRef objects
 * within Enhanced types.
 */

import type { ConversionError } from '../../errors.js';
import type { CelExpression, KubernetesRef } from '../../types/common.js';
import type { AnalysisContext } from '../analysis/analyzer.js';

/**
 * Optionality analysis result for a KubernetesRef
 */
export interface OptionalityAnalysisResult {
  /** The KubernetesRef being analyzed */
  kubernetesRef: KubernetesRef<unknown>;

  /** Whether this field might be undefined at runtime */
  potentiallyUndefined: boolean;

  /** Whether this field requires null-safety checks */
  requiresNullSafety: boolean;

  /** Whether optional chaining was used in the original expression */
  hasOptionalChaining: boolean;

  /** The field path being accessed */
  fieldPath: string;

  /** The resource ID being referenced */
  resourceId: string;

  /** Whether this is a schema reference */
  isSchemaReference: boolean;

  /** Confidence level of the optionality analysis (0-1) */
  confidence: number;

  /** Reason for the optionality determination */
  reason: string;

  /** Suggested CEL expression pattern for null-safety */
  suggestedCelPattern: string | undefined;
}

/**
 * Field hydration state information
 */
export interface FieldHydrationState {
  /** Resource ID */
  resourceId: string;

  /** Field path */
  fieldPath: string;

  /** Whether the field is currently hydrated */
  isHydrated: boolean;

  /** Whether the field is in the process of being hydrated */
  isHydrating: boolean;

  /** Whether the field has failed hydration */
  hydrationFailed: boolean;

  /** Timestamp of last hydration attempt */
  lastHydrationAttempt?: Date;

  /** Expected hydration completion time */
  expectedHydrationTime?: Date;
}

/**
 * Optionality handling context
 */
export interface OptionalityContext extends AnalysisContext {
  /** Current field hydration states */
  hydrationStates?: Map<string, FieldHydrationState>;

  /** Whether to be conservative with null-safety (default: true) */
  conservativeNullSafety?: boolean;

  /** Whether to use Kro's conditional operators */
  useKroConditionals?: boolean;

  /** Whether to generate has() checks for potentially undefined fields */
  generateHasChecks?: boolean;

  /** Maximum depth for optionality analysis */
  maxOptionalityDepth?: number;
}

/**
 * Optional chaining pattern information
 */
export interface OptionalChainingPattern {
  /** The KubernetesRef involved in optional chaining */
  kubernetesRef: KubernetesRef<unknown>;

  /** Field path being accessed */
  fieldPath: string;

  /** Whether this is an Enhanced type */
  isEnhancedType: boolean;

  /** Whether the field appears non-optional at compile time */
  appearsNonOptional: boolean;

  /** Whether the field is actually optional at runtime */
  actuallyOptional: boolean;

  /** Depth of the chaining (number of dots) */
  chainingDepth: number;

  /** Suggested CEL pattern for this optional chaining */
  suggestedCelPattern: string;
}

/**
 * Enhanced type field information
 */
export interface EnhancedTypeFieldInfo {
  /** The KubernetesRef for this field */
  kubernetesRef: KubernetesRef<unknown>;

  /** Field path */
  fieldPath: string;

  /** Whether this is an Enhanced type */
  isEnhancedType: boolean;

  /** Whether the field appears non-optional at compile time */
  appearsNonOptional: boolean;

  /** Whether the field is actually optional at runtime */
  actuallyOptional: boolean;

  /** Whether this is a status field */
  isStatusField: boolean;

  /** Whether this field requires optional chaining handling */
  requiresOptionalChaining: boolean;

  /** Confidence level of the analysis */
  confidence: number;
}

/**
 * Hydration state analysis result
 */
export interface HydrationStateAnalysis {
  /** References that are not yet hydrated */
  unhydratedRefs: KubernetesRef<unknown>[];

  /** References that are fully hydrated */
  hydratedRefs: KubernetesRef<unknown>[];

  /** References that are currently being hydrated */
  hydratingRefs: KubernetesRef<unknown>[];

  /** References that failed hydration */
  failedRefs: KubernetesRef<unknown>[];

  /** Total number of references */
  totalRefs: number;

  /** Hydration progress (0-1) */
  hydrationProgress: number;
}

/**
 * Hydration transition plan
 */
export interface HydrationTransitionPlan {
  /** Hydration phases in order */
  phases: HydrationPhase[];

  /** Total expected duration for all phases */
  totalDuration: number;

  /** Critical fields that must be hydrated for the expression to work */
  criticalFields: string[];
}

/**
 * Hydration phase information
 */
export interface HydrationPhase {
  /** Phase name */
  name: string;

  /** Fields expected to be hydrated in this phase */
  fields: KubernetesRef<unknown>[];

  /** Expected duration for this phase (milliseconds) */
  expectedDuration: number;

  /** Dependencies that must be satisfied before this phase */
  dependencies: string[];

  /** Whether this phase is critical for expression evaluation */
  isCritical: boolean;
}

/**
 * Hydration transition handler
 */
export interface HydrationTransitionHandler {
  /** State transitioning from */
  fromState: HydrationState;

  /** State transitioning to */
  toState: HydrationState;

  /** Condition that triggers this transition */
  triggerCondition: string;

  /** Expression to use during this transition */
  transitionExpression: CelExpression;

  /** Priority of this handler (lower = higher priority) */
  priority: number;
}

/**
 * Hydration state
 */
export type HydrationState = 'unhydrated' | 'hydrating' | 'hydrated' | 'failed';

/**
 * Result of undefined-to-defined transition handling
 */
export interface UndefinedToDefinedTransitionResult {
  /** Transition plan for hydration phases */
  transitionPlan: HydrationTransitionPlan;

  /** Expressions for each hydration phase */
  phaseExpressions: Map<string, CelExpression>;

  /** Watch expressions for monitoring hydration progress */
  watchExpressions: CelExpression[];

  /** Fallback expressions for hydration failures */
  fallbackExpressions: Map<string, CelExpression>;

  /** Whether the transition handling was successful */
  valid: boolean;

  /** Errors encountered during transition handling */
  errors: ConversionError[];
}

/**
 * Options for optionality handling
 */
export interface OptionalityHandlingOptions {
  /** Whether to perform deep optionality analysis */
  deepAnalysis?: boolean;

  /** Whether to be conservative with null-safety */
  conservative?: boolean;

  /** Whether to use Kro's conditional operators */
  useKroConditionals?: boolean;

  /** Whether to generate has() checks */
  generateHasChecks?: boolean;

  /** Maximum analysis depth */
  maxDepth?: number;

  /** Whether to include detailed reasoning */
  includeReasoning?: boolean;
}
