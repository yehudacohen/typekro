/**
 * Field hydration timing and undefined-to-defined transition handling
 * for the Enhanced Type Optionality Handler.
 *
 * These standalone functions handle analyzing hydration states, creating
 * transition plans, and generating expressions for different hydration phases.
 */

import {
  DEFAULT_EARLY_HYDRATION_DURATION,
  DEFAULT_LATE_HYDRATION_DURATION,
} from '../../config/defaults.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../constants/brands.js';
import { ensureError } from '../../errors.js';
import type { TypeKroLogger } from '../../logging/types.js';
import type { CelExpression, KubernetesRef } from '../../types/common.js';
import type { Enhanced } from '../../types/kubernetes.js';
import { convertToBasicCel } from './optionality-cel-generation.js';
import { convertToKroOptionalSyntax } from './optionality-optional-chaining.js';
import type {
  FieldHydrationState,
  HydrationPhase,
  HydrationStateAnalysis,
  HydrationTransitionHandler,
  HydrationTransitionPlan,
  OptionalityContext,
} from './optionality-types.js';

/**
 * Analyze hydration states for KubernetesRef objects
 */
export function analyzeHydrationStates(
  kubernetesRefs: KubernetesRef<unknown>[],
  hydrationStates: Map<string, FieldHydrationState>
): HydrationStateAnalysis {
  const unhydratedRefs: KubernetesRef<unknown>[] = [];
  const hydratedRefs: KubernetesRef<unknown>[] = [];
  const hydratingRefs: KubernetesRef<unknown>[] = [];
  const failedRefs: KubernetesRef<unknown>[] = [];

  for (const ref of kubernetesRefs) {
    const stateKey = `${ref.resourceId}:${ref.fieldPath}`;
    const state = hydrationStates.get(stateKey);

    if (!state) {
      unhydratedRefs.push(ref);
    } else if (state.hydrationFailed) {
      failedRefs.push(ref);
    } else if (state.isHydrated) {
      hydratedRefs.push(ref);
    } else if (state.isHydrating) {
      hydratingRefs.push(ref);
    } else {
      unhydratedRefs.push(ref);
    }
  }

  return {
    unhydratedRefs,
    hydratedRefs,
    hydratingRefs,
    failedRefs,
    totalRefs: kubernetesRefs.length,
    hydrationProgress: hydratedRefs.length / kubernetesRefs.length,
  };
}

/**
 * Create transition plan for hydration phases
 */
export function createTransitionPlan(
  kubernetesRefs: KubernetesRef<unknown>[],
  _hydrationStates: Map<string, FieldHydrationState>,
  _context: OptionalityContext
): HydrationTransitionPlan {
  const phases: HydrationPhase[] = [];
  const criticalFields: string[] = [];

  // Group fields by expected hydration timing
  const immediateFields: KubernetesRef<unknown>[] = [];
  const earlyFields: KubernetesRef<unknown>[] = [];
  const lateFields: KubernetesRef<unknown>[] = [];

  for (const ref of kubernetesRefs) {
    const fieldPath = ref.fieldPath || '';

    if (
      ref.resourceId === '__schema__' ||
      fieldPath.startsWith('metadata.') ||
      fieldPath.startsWith('spec.')
    ) {
      immediateFields.push(ref);
    } else if (
      fieldPath.includes('ready') ||
      fieldPath.includes('available') ||
      fieldPath.includes('replicas')
    ) {
      earlyFields.push(ref);
      if (fieldPath.includes('ready') || fieldPath.includes('available')) {
        criticalFields.push(`${ref.resourceId}.${fieldPath}`);
      }
    } else {
      lateFields.push(ref);
    }
  }

  // Create phases
  if (immediateFields.length > 0) {
    phases.push({
      name: 'immediate',
      fields: immediateFields,
      expectedDuration: 0,
      dependencies: [],
      isCritical: false,
    });
  }

  if (earlyFields.length > 0) {
    phases.push({
      name: 'early',
      fields: earlyFields,
      expectedDuration: DEFAULT_EARLY_HYDRATION_DURATION,
      dependencies: immediateFields.map((ref) => `${ref.resourceId}.${ref.fieldPath}`),
      isCritical: true,
    });
  }

  if (lateFields.length > 0) {
    phases.push({
      name: 'late',
      fields: lateFields,
      expectedDuration: DEFAULT_LATE_HYDRATION_DURATION,
      dependencies: [...immediateFields, ...earlyFields].map(
        (ref) => `${ref.resourceId}.${ref.fieldPath}`
      ),
      isCritical: false,
    });
  }

  const totalDuration = phases.reduce((sum, phase) => sum + phase.expectedDuration, 0);

  return { phases, totalDuration, criticalFields };
}

/**
 * Generate hydration transition handlers
 */
export function generateHydrationTransitionHandlers(
  expression: unknown,
  hydrationAnalysis: HydrationStateAnalysis,
  context: OptionalityContext
): HydrationTransitionHandler[] {
  const handlers: HydrationTransitionHandler[] = [];

  // Handler for unhydrated -> hydrating transition
  if (hydrationAnalysis.unhydratedRefs.length > 0) {
    handlers.push({
      fromState: 'unhydrated',
      toState: 'hydrating',
      triggerCondition: generateHydrationStartCondition(hydrationAnalysis.unhydratedRefs),
      transitionExpression: generateHydrationStartExpression(
        expression,
        hydrationAnalysis.unhydratedRefs,
        context
      ),
      priority: 1,
    });
  }

  // Handler for hydrating -> hydrated transition
  if (hydrationAnalysis.hydratingRefs.length > 0) {
    handlers.push({
      fromState: 'hydrating',
      toState: 'hydrated',
      triggerCondition: generateHydrationCompleteCondition(hydrationAnalysis.hydratingRefs),
      transitionExpression: generateHydrationCompleteExpression(
        expression,
        hydrationAnalysis.hydratingRefs,
        context
      ),
      priority: 2,
    });
  }

  // Handler for hydration failure
  if (hydrationAnalysis.failedRefs.length > 0) {
    handlers.push({
      fromState: 'hydrating',
      toState: 'failed',
      triggerCondition: generateHydrationFailureCondition(hydrationAnalysis.failedRefs),
      transitionExpression: generateHydrationFailureExpression(
        expression,
        hydrationAnalysis.failedRefs,
        context
      ),
      priority: 3,
    });
  }

  return handlers;
}

/**
 * Generate phase expressions for different hydration phases
 */
export function generatePhaseExpressions(
  expression: unknown,
  transitionPlan: HydrationTransitionPlan,
  context: OptionalityContext,
  logger: TypeKroLogger
): Map<string, CelExpression> {
  const phaseExpressions = new Map<string, CelExpression>();

  for (const phase of transitionPlan.phases) {
    try {
      const phaseExpression = generatePhaseSpecificExpression(expression, phase, context);

      phaseExpressions.set(phase.name, phaseExpression);
    } catch (error: unknown) {
      logger.error(`Failed to generate expression for phase ${phase.name}`, ensureError(error));
    }
  }

  return phaseExpressions;
}

/**
 * Generate watch expressions for monitoring hydration progress
 */
export function generateWatchExpressions(
  transitionPlan: HydrationTransitionPlan,
  _context: OptionalityContext
): CelExpression[] {
  const watchExpressions: CelExpression[] = [];

  for (const phase of transitionPlan.phases) {
    for (const field of phase.fields) {
      const resourcePath =
        field.resourceId === '__schema__'
          ? `schema.${field.fieldPath}`
          : `resources.${field.resourceId}.${field.fieldPath}`;

      const watchExpression: CelExpression = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `has(${resourcePath})`,
        type: 'boolean',
      } as CelExpression;

      watchExpressions.push(watchExpression);
    }
  }

  return watchExpressions;
}

/**
 * Generate fallback expressions for hydration failures
 */
export function generateFallbackExpressions(
  _expression: unknown,
  transitionPlan: HydrationTransitionPlan,
  _context: OptionalityContext
): Map<string, CelExpression> {
  const fallbackExpressions = new Map<string, CelExpression>();

  for (const phase of transitionPlan.phases) {
    const fallbackExpression: CelExpression = {
      [CEL_EXPRESSION_BRAND]: true,
      expression: phase.isCritical ? 'false' : 'null',
      type: phase.isCritical ? 'boolean' : 'null',
    } as CelExpression;

    fallbackExpressions.set(phase.name, fallbackExpression);
  }

  return fallbackExpressions;
}

/**
 * Generate phase-specific expression
 */
export function generatePhaseSpecificExpression(
  _expression: unknown,
  phase: HydrationPhase,
  _context: OptionalityContext
): CelExpression {
  // Generate expression that only uses fields available in this phase
  const availableFields = phase.fields.map((field) => {
    const resourcePath =
      field.resourceId === '__schema__'
        ? `schema.${field.fieldPath}`
        : `resources.${field.resourceId}.${field.fieldPath}`;
    return resourcePath;
  });

  // Create a simplified expression using only available fields
  const phaseExpression = availableFields.length > 0 ? availableFields.join(' && ') : 'true';

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: phaseExpression,
    type: 'boolean',
  } as CelExpression;
}

/**
 * Generate condition for hydration start
 */
export function generateHydrationStartCondition(refs: KubernetesRef<unknown>[]): string {
  const conditions = refs.map((ref) => {
    const resourcePath =
      ref.resourceId === '__schema__'
        ? `schema.${ref.fieldPath}`
        : `resources.${ref.resourceId}.${ref.fieldPath}`;
    return `!has(${resourcePath})`;
  });

  return conditions.join(' && ');
}

/**
 * Generate expression for hydration start
 */
export function generateHydrationStartExpression(
  _expression: unknown,
  _refs: KubernetesRef<unknown>[],
  _context: OptionalityContext
): CelExpression {
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: 'null', // Return null while hydrating
    type: 'null',
  } as CelExpression;
}

/**
 * Generate condition for hydration complete
 */
export function generateHydrationCompleteCondition(refs: KubernetesRef<unknown>[]): string {
  const conditions = refs.map((ref) => {
    const resourcePath =
      ref.resourceId === '__schema__'
        ? `schema.${ref.fieldPath}`
        : `resources.${ref.resourceId}.${ref.fieldPath}`;
    return `has(${resourcePath})`;
  });

  return conditions.join(' && ');
}

/**
 * Generate expression for hydration complete
 */
export function generateHydrationCompleteExpression(
  expression: unknown,
  _refs: KubernetesRef<unknown>[],
  context: OptionalityContext
): CelExpression {
  // Use the original expression since all fields are now available
  return convertToBasicCel(expression, context);
}

/**
 * Generate condition for hydration failure
 */
export function generateHydrationFailureCondition(_refs: KubernetesRef<unknown>[]): string {
  // This would typically check for timeout or error conditions
  return 'false'; // Placeholder
}

/**
 * Generate expression for hydration failure
 */
export function generateHydrationFailureExpression(
  _expression: unknown,
  _refs: KubernetesRef<unknown>[],
  _context: OptionalityContext
): CelExpression {
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: 'false', // Return false on failure
    type: 'boolean',
  } as CelExpression;
}

/**
 * Generate pre-hydration expression (for unhydrated fields)
 */
export function generatePreHydrationExpression(
  _expression: unknown,
  _unhydratedRefs: KubernetesRef<unknown>[],
  _context: OptionalityContext
): CelExpression {
  // For pre-hydration, return a safe default or null check
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: 'false', // Safe default before hydration
    type: 'boolean',
  } as CelExpression;
}

/**
 * Generate post-hydration expression (for hydrated fields)
 */
export function generatePostHydrationExpression(
  expression: unknown,
  _hydratedRefs: KubernetesRef<unknown>[],
  context: OptionalityContext
): CelExpression {
  // For post-hydration, can use the fields directly
  return convertToBasicCel(expression, context);
}

/**
 * Generate hydration-dependent expression (for fields being hydrated)
 */
export function generateHydrationDependentExpression(
  _expression: unknown,
  hydratingRefs: KubernetesRef<unknown>[],
  _context: OptionalityContext
): CelExpression {
  // For fields being hydrated, use conditional checks
  const conditionalChecks = hydratingRefs
    .map((ref) => {
      const resourcePath =
        ref.resourceId === '__schema__'
          ? `schema.${ref.fieldPath}`
          : `resources.${ref.resourceId}.${ref.fieldPath}`;
      return `has(${resourcePath})`;
    })
    .join(' && ');

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: conditionalChecks,
    type: 'boolean',
  } as CelExpression;
}

/**
 * Extract potential KubernetesRef objects from Enhanced resources
 */
export function extractPotentialKubernetesRefsFromEnhanced(
  _enhancedResource: Enhanced<unknown, unknown>,
  resourceId: string
): KubernetesRef<unknown>[] {
  const refs: KubernetesRef<unknown>[] = [];

  // Common field paths that might contain KubernetesRef objects in Enhanced types
  const commonFieldPaths = [
    'status.readyReplicas',
    'status.availableReplicas',
    'status.conditions',
    'status.phase',
    'status.podIP',
    'status.hostIP',
    'status.loadBalancer.ingress',
    'spec.replicas',
    'spec.selector',
    'metadata.name',
    'metadata.namespace',
    'metadata.labels',
    'metadata.annotations',
  ];

  for (const fieldPath of commonFieldPaths) {
    // Create a potential KubernetesRef for analysis
    const potentialRef: KubernetesRef<unknown> = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId,
      fieldPath,
      type: 'unknown',
    } as KubernetesRef<unknown>;

    refs.push(potentialRef);
  }

  return refs;
}

/**
 * Generate Enhanced type-specific null-safety patterns
 */
export function generateEnhancedTypeNullSafetyPattern(
  kubernetesRef: KubernetesRef<unknown>,
  context: OptionalityContext
): string {
  const resourcePath =
    kubernetesRef.resourceId === '__schema__'
      ? `schema.${kubernetesRef.fieldPath}`
      : `resources.${kubernetesRef.resourceId}.${kubernetesRef.fieldPath}`;

  // For Enhanced types, we need to be extra careful about null-safety
  if (context.generateHasChecks) {
    // Use has() checks for potentially undefined Enhanced type fields
    if (kubernetesRef.fieldPath?.includes('.')) {
      // For nested fields, check each level
      const pathParts = kubernetesRef.fieldPath.split('.');
      const checks: string[] = [];

      for (let i = 0; i < pathParts.length; i++) {
        const partialPath = pathParts.slice(0, i + 1).join('.');
        const fullPath =
          kubernetesRef.resourceId === '__schema__'
            ? `schema.${partialPath}`
            : `resources.${kubernetesRef.resourceId}.${partialPath}`;
        checks.push(`has(${fullPath})`);
      }

      return `${checks.join(' && ')} && ${resourcePath}`;
    } else {
      return `has(${resourcePath}) && ${resourcePath}`;
    }
  }

  if (context.useKroConditionals) {
    // Use Kro's ? prefix operator for Enhanced types
    return convertToKroOptionalSyntax(resourcePath);
  }

  // Fallback to basic null check
  return `${resourcePath} != null && ${resourcePath}`;
}
