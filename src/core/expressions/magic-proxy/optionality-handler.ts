/**
 * Enhanced Type Optionality Handler for JavaScript to CEL Expression Conversion
 *
 * This module handles the mismatch between Enhanced type compile-time non-optionality
 * and runtime optionality during field hydration. Enhanced types show fields as
 * non-optional at compile time, but KubernetesRef objects might resolve to undefined
 * during field hydration.
 *
 * Key Features:
 * - Automatic null-safety detection for Enhanced type KubernetesRef objects
 * - CEL expression generation with has() checks for potentially undefined fields
 * - Support for optional chaining with Enhanced types that appear non-optional
 * - Integration with field hydration timing to handle undefined-to-defined transitions
 * - Context-aware optionality handling based on field hydration state
 */

import { ConversionError, ensureError } from '../../errors.js';
import { getComponentLogger } from '../../logging/index.js';
import type { CelExpression } from '../../types/common.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { CelConversionResult } from '../analysis/analyzer.js';
import {
  analyzeKubernetesRefOptionality,
  extractKubernetesRefsFromExpression,
} from './optionality-analysis.js';
import {
  convertToBasicCel,
  generateCelWithHasChecksImpl,
  generateNullSafeExpression,
  generateSourceMapping,
} from './optionality-cel-generation.js';
import {
  analyzeHydrationStates,
  createTransitionPlan,
  extractPotentialKubernetesRefsFromEnhanced,
  generateEnhancedTypeNullSafetyPattern,
  generateFallbackExpressions,
  generateHydrationDependentExpression,
  generateHydrationTransitionHandlers,
  generatePhaseExpressions,
  generatePostHydrationExpression,
  generatePreHydrationExpression,
  generateWatchExpressions,
} from './optionality-hydration.js';
import {
  analyzeOptionalChainingPatterns,
  generateOptionalChainingCelExpression,
} from './optionality-optional-chaining.js';
import type {
  FieldHydrationState,
  HydrationTransitionHandler,
  OptionalityAnalysisResult,
  OptionalityContext,
  OptionalityHandlingOptions,
  UndefinedToDefinedTransitionResult,
} from './optionality-types.js';

// Re-export all types for backward compatibility
export type {
  EnhancedTypeFieldInfo,
  FieldHydrationState,
  HydrationPhase,
  HydrationState,
  HydrationStateAnalysis,
  HydrationTransitionHandler,
  HydrationTransitionPlan,
  OptionalChainingPattern,
  OptionalityAnalysisResult,
  OptionalityContext,
  OptionalityHandlingOptions,
  UndefinedToDefinedTransitionResult,
} from './optionality-types.js';

/**
 * Enhanced Type Optionality Handler
 *
 * Handles the complexity of Enhanced types that appear non-optional at compile time
 * but may be undefined at runtime during field hydration.
 */
export class EnhancedTypeOptionalityHandler {
  private logger = getComponentLogger('optionality-handler');

  constructor(_options?: OptionalityHandlingOptions) {
    void _options;
  }

  /**
   * Analyze KubernetesRef objects for optionality requirements
   *
   * This method determines whether KubernetesRef objects in expressions require
   * null-safety handling based on Enhanced type behavior and field hydration timing.
   */
  analyzeOptionalityRequirements(
    expression: unknown,
    context: OptionalityContext
  ): OptionalityAnalysisResult[] {
    const results: OptionalityAnalysisResult[] = [];

    try {
      // Extract all KubernetesRef objects from the expression
      const kubernetesRefs = extractKubernetesRefsFromExpression(expression);

      this.logger.debug('Analyzing optionality requirements', {
        expressionType: typeof expression,
        kubernetesRefCount: kubernetesRefs.length,
        contextType: context.type,
      });

      for (const ref of kubernetesRefs) {
        const analysis = analyzeKubernetesRefOptionality(ref, context);
        results.push(analysis);
      }

      return results;
    } catch (error: unknown) {
      this.logger.error('Failed to analyze optionality requirements', ensureError(error));
      return [];
    }
  }

  /**
   * Generate CEL expressions with appropriate null-safety checks
   *
   * This method takes the optionality analysis results and generates CEL expressions
   * that include proper null-safety handling for potentially undefined fields.
   */
  generateNullSafeCelExpression(
    originalExpression: unknown,
    optionalityResults: OptionalityAnalysisResult[],
    context: OptionalityContext
  ): CelConversionResult {
    try {
      // Determine if any KubernetesRef objects require null-safety
      const requiresNullSafety = optionalityResults.some((result) => result.requiresNullSafety);

      if (!requiresNullSafety) {
        // No null-safety required, return as-is
        return {
          valid: true,
          celExpression: convertToBasicCel(originalExpression, context),
          dependencies: optionalityResults.map((r) => r.kubernetesRef),
          sourceMap: [],
          errors: [],
          warnings: [],
          requiresConversion: optionalityResults.length > 0,
        };
      }

      // Generate null-safe CEL expression
      const nullSafeCel = generateNullSafeExpression(
        originalExpression,
        optionalityResults,
        context,
        this.logger
      );

      return {
        valid: true,
        celExpression: nullSafeCel,
        dependencies: optionalityResults.map((r) => r.kubernetesRef),
        sourceMap: generateSourceMapping(originalExpression, nullSafeCel, context),
        errors: [],
        warnings: [],
        requiresConversion: true,
      };
    } catch (error: unknown) {
      const conversionError = new ConversionError(
        `Failed to generate null-safe CEL expression: ${ensureError(error).message}`,
        String(originalExpression),
        'unknown'
      );

      return {
        valid: false,
        celExpression: null,
        dependencies: optionalityResults.map((r) => r.kubernetesRef),
        sourceMap: [],
        errors: [conversionError],
        warnings: [],
        requiresConversion: true,
      };
    }
  }

  /**
   * Handle optional chaining with Enhanced types
   *
   * This method specifically handles cases where optional chaining is used with
   * Enhanced types that appear non-optional at compile time.
   */
  handleOptionalChainingWithEnhancedTypes(
    expression: unknown,
    context: OptionalityContext
  ): CelConversionResult {
    try {
      // Detect optional chaining patterns in the expression
      const optionalChainingAnalysis = analyzeOptionalChainingPatterns(expression, context);

      if (optionalChainingAnalysis.patterns.length === 0) {
        // No optional chaining detected - analyze for regular optionality
        const optionalityResults = this.analyzeOptionalityRequirements(expression, context);
        return this.generateNullSafeCelExpression(expression, optionalityResults, context);
      }

      // Generate appropriate CEL expressions for optional chaining with Enhanced types
      const celResult = generateOptionalChainingCelExpression(
        expression,
        optionalChainingAnalysis,
        context,
        (expr, ctx) => {
          const optionalityResults = this.analyzeOptionalityRequirements(expr, ctx);
          return this.generateNullSafeCelExpression(expr, optionalityResults, ctx);
        }
      );

      return celResult;
    } catch (error: unknown) {
      const conversionError = new ConversionError(
        `Failed to handle optional chaining: ${ensureError(error).message}`,
        String(expression),
        'optional-chaining'
      );

      return {
        valid: false,
        celExpression: null,
        dependencies: extractKubernetesRefsFromExpression(expression),
        sourceMap: [],
        errors: [conversionError],
        warnings: [],
        requiresConversion: true,
      };
    }
  }

  /**
   * Automatically detect null-safety requirements for Enhanced type KubernetesRef objects
   *
   * This method analyzes Enhanced types and their KubernetesRef objects to determine
   * which fields require null-safety checks despite appearing non-optional at compile time.
   */
  detectNullSafetyRequirements(
    enhancedResources: Record<string, Enhanced<unknown, unknown>>,
    context: OptionalityContext
  ): Map<string, OptionalityAnalysisResult[]> {
    const nullSafetyMap = new Map<string, OptionalityAnalysisResult[]>();

    try {
      this.logger.debug('Detecting null-safety requirements for Enhanced types', {
        resourceCount: Object.keys(enhancedResources).length,
        contextType: context.type,
      });

      for (const [resourceId, enhancedResource] of Object.entries(enhancedResources)) {
        const resourceAnalysis: OptionalityAnalysisResult[] = [];

        // Analyze the Enhanced resource for potential KubernetesRef objects
        const potentialRefs = extractPotentialKubernetesRefsFromEnhanced(
          enhancedResource,
          resourceId
        );

        for (const ref of potentialRefs) {
          const analysis = analyzeKubernetesRefOptionality(ref, context);

          // Enhanced types require special handling
          if (analysis.potentiallyUndefined) {
            analysis.reason = `Enhanced type field '${analysis.fieldPath}' appears non-optional at compile time but may be undefined at runtime during field hydration`;
            analysis.requiresNullSafety = true;
            analysis.suggestedCelPattern = generateEnhancedTypeNullSafetyPattern(ref, context);
          }

          resourceAnalysis.push(analysis);
        }

        if (resourceAnalysis.length > 0) {
          nullSafetyMap.set(resourceId, resourceAnalysis);
        }
      }

      this.logger.debug('Null-safety detection complete', {
        resourcesWithNullSafety: nullSafetyMap.size,
        totalAnalysisResults: Array.from(nullSafetyMap.values()).reduce(
          (sum, arr) => sum + arr.length,
          0
        ),
      });

      return nullSafetyMap;
    } catch (error: unknown) {
      this.logger.error('Failed to detect null-safety requirements', ensureError(error));
      return new Map();
    }
  }

  /**
   * Integrate with field hydration timing
   *
   * This method provides integration with TypeKro's field hydration system to
   * handle the transition from undefined to defined values during hydration.
   */
  integrateWithFieldHydrationTiming(
    expression: unknown,
    hydrationStates: Map<string, FieldHydrationState>,
    context: OptionalityContext
  ): {
    preHydrationExpression: CelExpression | null;
    postHydrationExpression: CelExpression | null;
    hydrationDependentExpression: CelExpression | null;
    transitionHandlers: HydrationTransitionHandler[];
  } {
    try {
      const kubernetesRefs = extractKubernetesRefsFromExpression(expression);

      // Analyze hydration states for all references
      const hydrationAnalysis = analyzeHydrationStates(kubernetesRefs, hydrationStates);

      // Generate expressions for different hydration phases
      const preHydrationExpr = generatePreHydrationExpression(
        expression,
        hydrationAnalysis.unhydratedRefs,
        context
      );

      const postHydrationExpr = generatePostHydrationExpression(
        expression,
        hydrationAnalysis.hydratedRefs,
        context
      );

      const hydrationDependentExpr = generateHydrationDependentExpression(
        expression,
        hydrationAnalysis.hydratingRefs,
        context
      );

      // Generate transition handlers for undefined-to-defined transitions
      const transitionHandlers = generateHydrationTransitionHandlers(
        expression,
        hydrationAnalysis,
        context
      );

      return {
        preHydrationExpression: preHydrationExpr,
        postHydrationExpression: postHydrationExpr,
        hydrationDependentExpression: hydrationDependentExpr,
        transitionHandlers,
      };
    } catch (error: unknown) {
      this.logger.error('Failed to integrate with field hydration timing', ensureError(error));
      return {
        preHydrationExpression: null,
        postHydrationExpression: null,
        hydrationDependentExpression: null,
        transitionHandlers: [],
      };
    }
  }

  /**
   * Handle undefined-to-defined transitions during field hydration
   *
   * This method creates handlers for the transition from undefined to defined
   * values as fields are hydrated over time.
   */
  handleUndefinedToDefinedTransitions(
    expression: unknown,
    hydrationStates: Map<string, FieldHydrationState>,
    context: OptionalityContext
  ): UndefinedToDefinedTransitionResult {
    try {
      const kubernetesRefs = extractKubernetesRefsFromExpression(expression);
      const transitionPlan = createTransitionPlan(kubernetesRefs, hydrationStates, context);

      return {
        transitionPlan,
        phaseExpressions: generatePhaseExpressions(
          expression,
          transitionPlan,
          context,
          this.logger
        ),
        watchExpressions: generateWatchExpressions(transitionPlan, context),
        fallbackExpressions: generateFallbackExpressions(expression, transitionPlan, context),
        valid: true,
        errors: [],
      };
    } catch (error: unknown) {
      const transitionError = new ConversionError(
        `Failed to handle undefined-to-defined transitions: ${ensureError(error).message}`,
        String(expression),
        'unknown'
      );

      return {
        transitionPlan: { phases: [], totalDuration: 0, criticalFields: [] },
        phaseExpressions: new Map(),
        watchExpressions: [],
        fallbackExpressions: new Map(),
        valid: false,
        errors: [transitionError],
      };
    }
  }

  /**
   * Generate CEL expressions with has() checks for potentially undefined fields
   *
   * This method creates comprehensive CEL expressions that include has() checks
   * for all potentially undefined fields in the expression.
   */
  generateCelWithHasChecks(
    expression: unknown,
    optionalityResults: OptionalityAnalysisResult[],
    context: OptionalityContext
  ): CelExpression {
    return generateCelWithHasChecksImpl(expression, optionalityResults, context, this.logger);
  }
}

/**
 * Convenience function to analyze optionality requirements
 */
export function analyzeOptionalityRequirements(
  expression: unknown,
  context: OptionalityContext,
  options?: OptionalityHandlingOptions
): OptionalityAnalysisResult[] {
  const handler = new EnhancedTypeOptionalityHandler(options);
  return handler.analyzeOptionalityRequirements(expression, context);
}

/**
 * Convenience function to generate null-safe CEL expressions
 */
export function generateNullSafeCelExpression(
  expression: unknown,
  optionalityResults: OptionalityAnalysisResult[],
  context: OptionalityContext,
  options?: OptionalityHandlingOptions
): CelConversionResult {
  const handler = new EnhancedTypeOptionalityHandler(options);
  return handler.generateNullSafeCelExpression(expression, optionalityResults, context);
}

/**
 * Convenience function to handle optional chaining with Enhanced types
 */
export function handleOptionalChainingWithEnhancedTypes(
  expression: unknown,
  context: OptionalityContext,
  options?: OptionalityHandlingOptions
): CelConversionResult {
  const handler = new EnhancedTypeOptionalityHandler(options);
  return handler.handleOptionalChainingWithEnhancedTypes(expression, context);
}

/**
 * Convenience function to generate CEL expressions with has() checks
 */
export function generateCelWithHasChecks(
  expression: unknown,
  optionalityResults: OptionalityAnalysisResult[],
  context: OptionalityContext,
  options?: OptionalityHandlingOptions
): CelExpression {
  const handler = new EnhancedTypeOptionalityHandler(options);
  return handler.generateCelWithHasChecks(expression, optionalityResults, context);
}

/**
 * Convenience function to detect null-safety requirements for Enhanced types
 */
export function detectNullSafetyRequirements(
  enhancedResources: Record<string, Enhanced<unknown, unknown>>,
  context: OptionalityContext,
  options?: OptionalityHandlingOptions
): Map<string, OptionalityAnalysisResult[]> {
  const handler = new EnhancedTypeOptionalityHandler(options);
  return handler.detectNullSafetyRequirements(enhancedResources, context);
}

/**
 * Convenience function to integrate with field hydration timing
 */
export function integrateWithFieldHydrationTiming(
  expression: unknown,
  hydrationStates: Map<string, FieldHydrationState>,
  context: OptionalityContext,
  options?: OptionalityHandlingOptions
): {
  preHydrationExpression: CelExpression | null;
  postHydrationExpression: CelExpression | null;
  hydrationDependentExpression: CelExpression | null;
  transitionHandlers: HydrationTransitionHandler[];
} {
  const handler = new EnhancedTypeOptionalityHandler(options);
  return handler.integrateWithFieldHydrationTiming(expression, hydrationStates, context);
}

/**
 * Convenience function to handle undefined-to-defined transitions
 */
export function handleUndefinedToDefinedTransitions(
  expression: unknown,
  hydrationStates: Map<string, FieldHydrationState>,
  context: OptionalityContext,
  options?: OptionalityHandlingOptions
): UndefinedToDefinedTransitionResult {
  const handler = new EnhancedTypeOptionalityHandler(options);
  return handler.handleUndefinedToDefinedTransitions(expression, hydrationStates, context);
}
