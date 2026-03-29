/**
 * Status analysis pipeline — decomposed from analyzeAndConvertStatusMappings
 *
 * The original function was a 9-step pipeline with 3 layers of swallowed
 * try/catch fallbacks, making it the single hardest function to maintain.
 *
 * This module decomposes it into explicit, named pipeline stages. Each stage
 * returns a `StageResult<T>` carrying success/failure/degraded state.
 * Degradation is logged at warn level (not debug), making silent failures loud.
 *
 * Pipeline stages:
 *   1. executeStatusBuilder — run the status builder in KubernetesRef context
 *   2. detectCompositionMode — check for __originalCompositionFn (imperative vs declarative)
 *   3. analyzeStatusMappingsForMode — route to imperative or declarative analysis
 *   4. categorizeFields — run analyzeStatusMappingTypes on the result
 *   5. detectExistingCel — detect and preserve backward-compat CEL expressions
 *   6. convertRefsTocel — convert KubernetesRef objects to CEL via CelConversionEngine
 *   7. mergeResults — 3-way merge of converted/preserved/raw mappings
 *   8. logMigrationOpportunities — (side effect) log CEL→JS migration suggestions
 *
 * @see ROADMAP.md Phase 2.9
 */

import {
  containsCelExpressions,
  containsKubernetesRefs,
  isCelExpression,
  isKubernetesRef,
} from '../../utils/type-guards.js';
import { runInStatusBuilderContext } from '../composition/context.js';
import { ensureError } from '../errors.js';
import { analyzeImperativeComposition } from '../expressions/composition/imperative-analyzer.js';
import { celConversionEngine } from '../expressions/factory/cel-conversion-engine.js';
import { CelToJavaScriptMigrationHelper } from '../expressions/factory/migration-helpers.js';
import {
  analyzeStatusBuilderForToResourceGraph,
  type StatusBuilderFunction,
} from '../expressions/factory/status-builder-analyzer.js';
import type { getComponentLogger } from '../logging/index.js';
import type { DeploymentClosure } from '../types/deployment.js';
import type {
  MagicAssignableShape,
  ResourceGraphDefinition,
  SchemaProxy,
} from '../types/serialization.js';
import type { Enhanced, KroCompatibleType } from '../types.js';
import {
  analyzeStatusMappingTypes,
  detectAndPreserveCelExpressions,
  mergePreservedCelExpressions,
} from './status-analysis-helpers.js';

// =============================================================================
// Stage result type
// =============================================================================

/**
 * The outcome of a pipeline stage.
 *
 * - `success`: Stage completed normally with a value.
 * - `degraded`: Stage failed but produced a fallback value. The pipeline continues.
 * - `failure`: Stage failed with no usable value (rare — most stages degrade instead).
 */
export type StageOutcome = 'success' | 'degraded' | 'failure';

export interface StageResult<T> {
  outcome: StageOutcome;
  value: T;
  /** Human-readable reason for degradation/failure */
  reason?: string;
}

function success<T>(value: T): StageResult<T> {
  return { outcome: 'success', value };
}

function degraded<T>(value: T, reason: string): StageResult<T> {
  return { outcome: 'degraded', value, reason };
}

// =============================================================================
// Pipeline logger type alias (avoids repeating the verbose logger type)
// =============================================================================

type PipelineLogger = ReturnType<ReturnType<typeof getComponentLogger>['child']>;

// =============================================================================
// Stage 1: Execute status builder
// =============================================================================

/**
 * Execute the status builder function inside `runInStatusBuilderContext` to
 * produce the raw status mappings (KubernetesRef objects for resource property access).
 */
function executeStatusBuilder<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
  TResources extends Record<string, Enhanced<any, any> | DeploymentClosure>,
>(
  statusBuilder: (
    schema: SchemaProxy<TSpec, TStatus>,
    resources: TResources
  ) => MagicAssignableShape<TStatus>,
  schema: SchemaProxy<TSpec, TStatus>,
  resourcesWithKeys: Record<string, Enhanced<any, any>>
): MagicAssignableShape<TStatus> {
  return runInStatusBuilderContext(() => statusBuilder(schema, resourcesWithKeys as TResources));
}

// =============================================================================
// Stage 2: Detect composition mode
// =============================================================================

interface CompositionMode {
  isImperative: boolean;
  originalCompositionFn: ((...args: unknown[]) => unknown) | undefined;
}

/**
 * Check if the status mappings contain `__originalCompositionFn` which signals
 * an imperative composition (kubernetesComposition) vs. a declarative one.
 */
function detectCompositionMode<TStatus extends KroCompatibleType>(
  statusMappings: MagicAssignableShape<TStatus>
): CompositionMode {
  const originalCompositionFn = (statusMappings as Record<string, unknown>)
    .__originalCompositionFn as ((...args: unknown[]) => unknown) | undefined;

  return {
    isImperative: !!originalCompositionFn,
    originalCompositionFn,
  };
}

// =============================================================================
// Stage 3: Analyze status mappings (imperative or declarative)
// =============================================================================

interface AnalysisStageResult {
  analyzedStatusMappings: Record<string, unknown>;
  imperativeAnalysisSucceeded: boolean;
  /** Raw Phase B fn.toString results before merge filtering. Used by
   *  nested composition status extraction to recover garbled CEL. */
  phaseBStatusMappings?: Record<string, unknown> | undefined;
}

/**
 * Run the appropriate analysis strategy based on composition mode.
 *
 * For imperative: tries status builder analysis first, falls back to
 * imperative composition analysis via fn.toString() AST parsing.
 *
 * For declarative: uses status builder analysis directly.
 *
 * Both paths degrade gracefully to using the raw status mappings.
 */
function analyzeStatusMappingsForMode<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
  TResources extends Record<string, Enhanced<any, any> | DeploymentClosure>,
>(
  mode: CompositionMode,
  statusBuilder: (
    schema: SchemaProxy<TSpec, TStatus>,
    resources: TResources
  ) => MagicAssignableShape<TStatus>,
  schema: SchemaProxy<TSpec, TStatus>,
  resourcesWithKeys: Record<string, Enhanced<any, any>>,
  statusMappings: MagicAssignableShape<TStatus>,
  logger: PipelineLogger
): StageResult<AnalysisStageResult> {
  if (mode.isImperative && mode.originalCompositionFn) {
    return analyzeImperativeStatusMappingsStage(
      statusBuilder,
      schema,
      resourcesWithKeys,
      statusMappings,
      mode.originalCompositionFn,
      logger
    );
  }

  return analyzeDeclarativeStatusMappingsStage(
    statusBuilder,
    schema,
    resourcesWithKeys,
    statusMappings,
    logger
  );
}

// =============================================================================
// Stage 3a: Imperative analysis (2 sub-stages with cascading fallback)
// =============================================================================

/**
 * Analyze status mappings from an imperative composition.
 *
 * Two-phase analysis with cascading fallback:
 *   Phase A: If the raw mappings contain KubernetesRefs or CelExpressions (or
 *            __needsPreAnalysis is set), try analyzeStatusBuilderForToResourceGraph.
 *   Phase B: If Phase A fails or finds no refs, try analyzeImperativeComposition
 *            which parses the original function via fn.toString().
 *   Fallback: Use raw status mappings.
 */
function analyzeImperativeStatusMappingsStage<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
  TResources extends Record<string, Enhanced<any, any> | DeploymentClosure>,
>(
  statusBuilder: (
    schema: SchemaProxy<TSpec, TStatus>,
    resources: TResources
  ) => MagicAssignableShape<TStatus>,
  schema: SchemaProxy<TSpec, TStatus>,
  resourcesWithKeys: Record<string, Enhanced<any, any>>,
  statusMappings: MagicAssignableShape<TStatus>,
  originalCompositionFn: (...args: unknown[]) => unknown,
  logger: PipelineLogger
): StageResult<AnalysisStageResult> {
  logger.debug('Detected imperative composition, checking for existing KubernetesRef objects');

  let hasKubernetesRefs = containsKubernetesRefs(statusMappings);
  let hasCelExpressions = containsCelExpressions(statusMappings);
  const needsPreAnalysis = (statusMappings as Record<string, unknown>).__needsPreAnalysis === true;

  logger.debug('Imperative composition analysis', {
    hasKubernetesRefs,
    hasCelExpressions,
    needsPreAnalysis,
    statusMappings: JSON.stringify(statusMappings, null, 2),
  });

  // Phase A: status builder analysis (when refs/CEL/preAnalysis are present)
  if (hasKubernetesRefs || hasCelExpressions || needsPreAnalysis) {
    logger.debug(
      'Status object already contains KubernetesRef objects or CelExpression objects, using direct analysis'
    );

    try {
      const statusBuilderAnalysis = analyzeStatusBuilderForToResourceGraph(
        statusBuilder as StatusBuilderFunction<TSpec, MagicAssignableShape<TStatus>>,
        resourcesWithKeys as Record<string, Enhanced<any, any>>,
        schema,
        'kro'
      );

      if (statusBuilderAnalysis.requiresConversion) {
        logger.debug('Using status builder analysis for imperative composition', {
          fieldCount: Object.keys(statusBuilderAnalysis.statusMappings).length,
        });
        return success({
          analyzedStatusMappings: statusBuilderAnalysis.statusMappings,
          imperativeAnalysisSucceeded: true,
        });
      }

      // If the analysis was invalid (e.g., status builder returns a captured
      // variable instead of an object literal), fall through to Phase B which
      // can parse the original composition function via fn.toString().
      if (!statusBuilderAnalysis.valid) {
        logger.debug(
          'Phase A analysis invalid, falling through to Phase B fn.toString() analysis',
          { errors: statusBuilderAnalysis.errors.map((e) => e.message) }
        );
        hasKubernetesRefs = false;
        hasCelExpressions = false;
      } else {
        logger.debug('No conversion required, using original status mappings');
        return success({
          analyzedStatusMappings: statusMappings as Record<string, unknown>,
          imperativeAnalysisSucceeded: false,
        });
      }
    } catch (statusAnalysisError: unknown) {
      logger.warn(
        'Status builder analysis failed for imperative composition, falling back to fn.toString() analysis',
        { error: ensureError(statusAnalysisError).message }
      );
      // Clear flags so Phase B activates
      hasKubernetesRefs = false;
      hasCelExpressions = false;
    }
  }

  // Phase B: imperative composition analysis via fn.toString()
  //
  // Phase B parses the original composition function's source code to extract
  // CEL expressions for fields where Phase A only captured comparison artifacts
  // (e.g., `false` from `readyReplicas >= 1`).
  //
  // The results are MERGED with Phase A's raw status at the field level:
  //   - Phase A value is a KubernetesRef, CelExpression, or string → keep it
  //     (already correct — strings may contain schema markers resolved at runtime)
  //   - Phase A value is a comparison artifact (boolean/number primitive) → use
  //     Phase B's CelExpression instead (fn.toString recovered the real expression)
  //
  // This avoids Phase B overwriting correct Phase A values (e.g., Cel.expr()
  // results in inner compositions, or schema-marker strings in URL fields).
  if (!hasKubernetesRefs && !hasCelExpressions) {
    logger.debug(
      'No KubernetesRef objects or CelExpression objects found, analyzing original composition function'
    );

    try {
      const imperativeAnalysis = analyzeImperativeComposition(
        originalCompositionFn,
        resourcesWithKeys as Record<string, Enhanced<any, any>>,
        { factoryType: 'kro' }
      );

      logger.debug('Imperative composition analysis complete', {
        statusFieldCount: Object.keys(imperativeAnalysis.statusMappings).length,
        hasJavaScriptExpressions: imperativeAnalysis.hasJavaScriptExpressions,
      });

      if (imperativeAnalysis.hasJavaScriptExpressions) {
        // Merge Phase A (raw) + Phase B (fn.toString) at the field level.
        const merged = mergePhaseAAndPhaseB(
          statusMappings as Record<string, unknown>,
          imperativeAnalysis.statusMappings,
          logger
        );

        logger.debug('Merged Phase A raw + Phase B fn.toString analysis', {
          fieldCount: Object.keys(merged).length,
        });
        return success({
          analyzedStatusMappings: merged,
          phaseBStatusMappings: imperativeAnalysis.statusMappings,
          imperativeAnalysisSucceeded: true,
        });
      }

      return success({
        analyzedStatusMappings: statusMappings as Record<string, unknown>,
        imperativeAnalysisSucceeded: false,
      });
    } catch (imperativeAnalysisError: unknown) {
      logger.warn('Imperative composition analysis failed, using executed status mappings', {
        error: ensureError(imperativeAnalysisError).message,
      });
      return degraded(
        {
          analyzedStatusMappings: statusMappings as Record<string, unknown>,
          imperativeAnalysisSucceeded: false,
        },
        `Imperative analysis failed: ${ensureError(imperativeAnalysisError).message}`
      );
    }
  }

  // Unreachable in practice but satisfies the type system
  return success({
    analyzedStatusMappings: statusMappings as Record<string, unknown>,
    imperativeAnalysisSucceeded: false,
  });
}

// =============================================================================
// Stage 3b: Declarative analysis
// =============================================================================

/**
 * Analyze status mappings from a declarative (non-imperative) status builder.
 *
 * Uses analyzeStatusBuilderForToResourceGraph directly. Degrades to raw
 * status mappings on failure.
 */
function analyzeDeclarativeStatusMappingsStage<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
  TResources extends Record<string, Enhanced<any, any> | DeploymentClosure>,
>(
  statusBuilder: (
    schema: SchemaProxy<TSpec, TStatus>,
    resources: TResources
  ) => MagicAssignableShape<TStatus>,
  schema: SchemaProxy<TSpec, TStatus>,
  resourcesWithKeys: Record<string, Enhanced<any, any>>,
  statusMappings: MagicAssignableShape<TStatus>,
  logger: PipelineLogger
): StageResult<AnalysisStageResult> {
  try {
    const statusBuilderAnalysis = analyzeStatusBuilderForToResourceGraph(
      statusBuilder as StatusBuilderFunction<TSpec, MagicAssignableShape<TStatus>>,
      resourcesWithKeys as Record<string, Enhanced<any, any>>,
      schema,
      'kro'
    );

    logger.debug('Status builder analysis complete', {
      statusFieldCount: Object.keys(statusBuilderAnalysis.statusMappings).length,
      dependencyCount: statusBuilderAnalysis.dependencies.length,
      hasJavaScriptExpressions: statusBuilderAnalysis.dependencies.length > 0,
    });

    if (statusBuilderAnalysis.dependencies.length > 0) {
      logger.debug('Using analyzed status mappings with CEL expressions', {
        fieldCount: Object.keys(statusBuilderAnalysis.statusMappings).length,
      });
      return success({
        analyzedStatusMappings: statusBuilderAnalysis.statusMappings,
        imperativeAnalysisSucceeded: false,
      });
    }

    return success({
      analyzedStatusMappings: statusMappings as Record<string, unknown>,
      imperativeAnalysisSucceeded: false,
    });
  } catch (analysisError: unknown) {
    logger.warn('Status builder analysis failed, using executed status mappings', {
      error: ensureError(analysisError).message,
    });
    return degraded(
      {
        analyzedStatusMappings: statusMappings as Record<string, unknown>,
        imperativeAnalysisSucceeded: false,
      },
      `Declarative analysis failed: ${ensureError(analysisError).message}`
    );
  }
}

// =============================================================================
// Stage 4: Categorize fields
// =============================================================================

/**
 * Run comprehensive field-level analysis on the status mappings to categorize
 * each field as kubernetesRef, celExpression, staticValue, or complexExpression.
 */
function categorizeFields(
  analyzedStatusMappings: Record<string, unknown>,
  logger: PipelineLogger
): ReturnType<typeof analyzeStatusMappingTypes> {
  const mappingAnalysis = analyzeStatusMappingTypes(analyzedStatusMappings);

  logger.debug('Status mapping analysis complete', {
    kubernetesRefFields: mappingAnalysis.kubernetesRefFields.length,
    celExpressionFields: mappingAnalysis.celExpressionFields.length,
    staticValueFields: mappingAnalysis.staticValueFields.length,
    complexExpressionFields: mappingAnalysis.complexExpressionFields.length,
  });

  return mappingAnalysis;
}

// =============================================================================
// Stage 5: Detect existing CEL
// =============================================================================

interface CelDetectionResult {
  hasExistingCel: boolean;
  preservedMappings: Record<string, unknown>;
}

/**
 * Detect and preserve existing CEL expressions in the raw status mappings
 * for backward compatibility.
 */
function detectExistingCel<TStatus extends KroCompatibleType>(
  statusMappings: MagicAssignableShape<TStatus>
): CelDetectionResult {
  return detectAndPreserveCelExpressions(statusMappings as Record<string, unknown>);
}

// =============================================================================
// Stage 6: Convert KubernetesRefs to CEL
// =============================================================================

interface ConversionResult {
  convertedStatusMappings: Record<string, unknown>;
  hasConversions: boolean;
}

/**
 * Convert KubernetesRef objects in status mappings to CEL expressions
 * via the CelConversionEngine.
 */
function convertRefsToCel<TStatus extends KroCompatibleType>(
  definitionName: string,
  statusMappings: MagicAssignableShape<TStatus>,
  logger: PipelineLogger
): ConversionResult {
  const convertedStatusMappings: Record<string, unknown> = {};
  let hasConversions = false;

  for (const [fieldName, fieldValue] of Object.entries(statusMappings)) {
    if (containsKubernetesRefs(fieldValue)) {
      const conversionResult = celConversionEngine.convertValue(
        fieldValue,
        { factoryType: 'kro', factoryName: definitionName, analysisEnabled: true },
        { factoryType: 'kro', preserveStatic: false }
      );

      if (conversionResult.wasConverted) {
        convertedStatusMappings[fieldName] = conversionResult.converted;
        hasConversions = true;
        logger.debug('Converted field to CEL expression', {
          fieldName,
          strategy: conversionResult.strategy,
          referencesConverted: conversionResult.metrics.referencesConverted,
        });
      } else {
        convertedStatusMappings[fieldName] = fieldValue;
      }
    } else {
      convertedStatusMappings[fieldName] = fieldValue;
    }
  }

  return { convertedStatusMappings, hasConversions };
}

// =============================================================================
// Stage 7: Merge results
// =============================================================================

/**
 * Three-way merge of conversion results, preserved CEL expressions, and raw mappings.
 *
 * The merge logic depends on:
 * - Whether conversions were produced (hasConversions)
 * - Whether existing CEL was detected (hasExistingCel)
 * - Whether imperative analysis already succeeded (imperativeAnalysisSucceeded)
 *
 * When imperativeAnalysisSucceeded is true, the analyzed mappings from Stage 3
 * are kept as-is (they already contain CEL expressions). The merge only applies
 * when imperative analysis did NOT produce results.
 */
function mergeAnalysisResults<TStatus extends KroCompatibleType>(
  currentMappings: Record<string, unknown>,
  statusMappings: MagicAssignableShape<TStatus>,
  conversionResult: ConversionResult,
  celDetection: CelDetectionResult,
  imperativeAnalysisSucceeded: boolean,
  mappingAnalysis: ReturnType<typeof analyzeStatusMappingTypes>,
  logger: PipelineLogger
): Record<string, unknown> {
  if (conversionResult.hasConversions) {
    if (!imperativeAnalysisSucceeded) {
      const merged = mergePreservedCelExpressions(
        conversionResult.convertedStatusMappings,
        celDetection.preservedMappings
      );
      logger.debug('Successfully converted JavaScript expressions to CEL', {
        convertedFields: Object.keys(conversionResult.convertedStatusMappings).filter(
          (key) =>
            conversionResult.convertedStatusMappings[key] !==
            (statusMappings as Record<string, unknown>)[key]
        ).length,
        preservedFields: Object.keys(celDetection.preservedMappings).length,
        staticFields: mappingAnalysis.staticValueFields.length,
      });
      return merged;
    }
    logger.debug('Successfully converted JavaScript expressions to CEL', {
      convertedFields: Object.keys(conversionResult.convertedStatusMappings).filter(
        (key) =>
          conversionResult.convertedStatusMappings[key] !==
          (statusMappings as Record<string, unknown>)[key]
      ).length,
      preservedFields: Object.keys(celDetection.preservedMappings).length,
      staticFields: mappingAnalysis.staticValueFields.length,
    });
    return currentMappings;
  }

  if (celDetection.hasExistingCel) {
    if (!imperativeAnalysisSucceeded) {
      const merged = mergePreservedCelExpressions(
        statusMappings as Record<string, unknown>,
        celDetection.preservedMappings
      );
      logger.debug('Preserved existing CEL expressions without conversion', {
        preservedFields: Object.keys(celDetection.preservedMappings).length,
        staticFields: mappingAnalysis.staticValueFields.length,
        complexFields: mappingAnalysis.complexExpressionFields.length,
      });
      return merged;
    }
    logger.debug('Preserved existing CEL expressions without conversion', {
      preservedFields: Object.keys(celDetection.preservedMappings).length,
      staticFields: mappingAnalysis.staticValueFields.length,
      complexFields: mappingAnalysis.complexExpressionFields.length,
    });
    return currentMappings;
  }

  // Neither conversions nor existing CEL
  if (!imperativeAnalysisSucceeded) {
    logger.debug('Status builder contains only static values and complex expressions', {
      staticFields: mappingAnalysis.staticValueFields.length,
      complexFields: mappingAnalysis.complexExpressionFields.length,
      totalFields: Object.keys(mappingAnalysis.analysisDetails).length,
    });
    return statusMappings as Record<string, unknown>;
  }

  logger.debug('Status builder contains only static values and complex expressions', {
    staticFields: mappingAnalysis.staticValueFields.length,
    complexFields: mappingAnalysis.complexExpressionFields.length,
    totalFields: Object.keys(mappingAnalysis.analysisDetails).length,
  });
  return currentMappings;
}

// =============================================================================
// Stage 8: Log migration opportunities (side effect)
// =============================================================================

/**
 * Log migration opportunities for users still using raw CEL expressions.
 * This is purely informational and does not affect the pipeline result.
 */
function logCelMigrationOpportunities<TStatus extends KroCompatibleType>(
  statusMappings: MagicAssignableShape<TStatus>,
  preservedMappings: Record<string, unknown>,
  logger: PipelineLogger
): void {
  logger.debug('Found existing CEL expressions, preserving for backward compatibility', {
    preservedCount: Object.keys(preservedMappings).length,
  });

  try {
    const migrationHelper = new CelToJavaScriptMigrationHelper();
    const migrationAnalysis = migrationHelper.analyzeMigrationOpportunities(
      statusMappings as Record<string, unknown>
    );

    if (migrationAnalysis.migrationFeasibility.migratableExpressions > 0) {
      logger.info('Migration opportunities detected for CEL expressions', {
        totalExpressions: migrationAnalysis.migrationFeasibility.totalExpressions,
        migratableExpressions: migrationAnalysis.migrationFeasibility.migratableExpressions,
        overallConfidence: Math.round(
          migrationAnalysis.migrationFeasibility.overallConfidence * 100
        ),
      });

      const highConfidenceSuggestions = migrationAnalysis.suggestions.filter(
        (s) => s.confidence >= 0.8 && s.isSafe
      );
      if (highConfidenceSuggestions.length > 0) {
        logger.info('High-confidence migration suggestions available', {
          suggestions: highConfidenceSuggestions.map((s) => ({
            original: s.originalCel,
            suggested: s.suggestedJavaScript,
            confidence: Math.round(s.confidence * 100),
          })),
        });
      }
    }
  } catch (migrationError: unknown) {
    logger.error('Failed to analyze migration opportunities', ensureError(migrationError));
  }
}

// =============================================================================
// Pipeline orchestrator
// =============================================================================

/**
 * Result of the status analysis pipeline.
 *
 * Same shape as the original `StatusAnalysisResult` for backward compatibility.
 */
export interface StatusAnalysisPipelineResult {
  statusMappings: MagicAssignableShape<KroCompatibleType>;
  analyzedStatusMappings: Record<string, unknown>;
  mappingAnalysis: ReturnType<typeof analyzeStatusMappingTypes>;
  imperativeAnalysisSucceeded: boolean;
  /** Raw Phase B fn.toString results (before merge filtering). Available when
   *  Phase B ran for an imperative composition. Used by nested composition
   *  status extraction to recover CEL from garbled fn.toString output. */
  phaseBStatusMappings?: Record<string, unknown> | undefined;
}

/**
 * Run the full status analysis pipeline.
 *
 * This is the decomposed replacement for the original
 * `analyzeAndConvertStatusMappings` function. Each stage is explicit,
 * degradation is logged at warn level, and the flow is traceable.
 */
export function runStatusAnalysisPipeline<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
  TResources extends Record<string, Enhanced<any, any> | DeploymentClosure>,
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  statusBuilder: (
    schema: SchemaProxy<TSpec, TStatus>,
    resources: TResources
  ) => MagicAssignableShape<TStatus>,
  schema: SchemaProxy<TSpec, TStatus>,
  resourcesWithKeys: Record<string, Enhanced<any, any>>,
  logger: PipelineLogger
): StatusAnalysisPipelineResult {
  // Default fallback values
  const emptyAnalysis: ReturnType<typeof analyzeStatusMappingTypes> = {
    kubernetesRefFields: [],
    celExpressionFields: [],
    staticValueFields: [],
    complexExpressionFields: [],
    analysisDetails: {},
  };

  // Stage 1: Execute status builder
  const statusMappings = executeStatusBuilder(statusBuilder, schema, resourcesWithKeys);

  try {
    // Stage 2: Detect composition mode
    const mode = detectCompositionMode(statusMappings);

    // Stage 3: Analyze (imperative or declarative)
    const analysisResult = analyzeStatusMappingsForMode(
      mode,
      statusBuilder,
      schema,
      resourcesWithKeys,
      statusMappings,
      logger
    );

    let { analyzedStatusMappings, imperativeAnalysisSucceeded, phaseBStatusMappings } = analysisResult.value;

    if (analysisResult.outcome === 'degraded') {
      logger.warn('Status analysis degraded', { reason: analysisResult.reason });
    }

    // Stage 4: Categorize fields
    const mappingAnalysis = categorizeFields(analyzedStatusMappings, logger);

    // Stage 5: Detect existing CEL expressions
    const celDetection = detectExistingCel(statusMappings);

    // Stage 8 (side effect): Log migration opportunities if existing CEL found
    if (celDetection.hasExistingCel) {
      logCelMigrationOpportunities(statusMappings, celDetection.preservedMappings, logger);
    }

    // Stage 6: Convert KubernetesRefs to CEL
    const conversionResult = convertRefsToCel(definition.name, statusMappings, logger);

    // Stage 7: Merge results
    analyzedStatusMappings = mergeAnalysisResults(
      analyzedStatusMappings,
      statusMappings,
      conversionResult,
      celDetection,
      imperativeAnalysisSucceeded,
      mappingAnalysis,
      logger
    );

    return {
      statusMappings,
      analyzedStatusMappings,
      mappingAnalysis,
      imperativeAnalysisSucceeded,
      phaseBStatusMappings,
    };
  } catch (error: unknown) {
    logger.error('Failed to analyze status builder', ensureError(error));
    return {
      statusMappings,
      analyzedStatusMappings: statusMappings as Record<string, unknown>,
      mappingAnalysis: emptyAnalysis,
      imperativeAnalysisSucceeded: false,
    };
  }
}

// ── Phase A + Phase B merge ──────────────────────────────────────────────

/**
 * Check if a Phase A value is a comparison artifact that should be replaced
 * by Phase B's fn.toString CEL expression.
 *
 * Comparison artifacts arise when JavaScript comparison operators (`>=`, `&&`)
 * evaluate on proxy values: `kubernetesRef >= 1` produces `NaN >= 1 = false`.
 * These `false` / `NaN` values are not the real status — Phase B recovers the
 * original expression from the source code.
 *
 * Non-artifacts (KubernetesRef, CelExpression, strings, objects) are already
 * correct from Phase A and should be kept.
 */
function isComparisonArtifact(value: unknown): boolean {
  // `false` from NaN comparisons (proxy >= 1 evaluates to NaN >= 1 = false).
  // `true` is NOT an artifact — it's a legitimate static boolean default.
  if (value === false) return true;
  if (typeof value === 'number' && Number.isNaN(value)) return true;
  return false;
}

/**
 * Merge Phase A raw status mappings with Phase B fn.toString analysis results.
 *
 * Phase A captures the executed status object — it has correct values for
 * KubernetesRef objects, CelExpression objects (from explicit Cel.expr()),
 * and strings with schema markers. But comparison operators produce artifacts
 * (`false` from `proxy >= 1`).
 *
 * Phase B parses the composition function's source code — it produces correct
 * CEL for comparison expressions but may incorrectly classify schema-derived
 * values as resource references (e.g., `cache.metadata.name` in source vs
 * the resolved `${schema.spec.name}-cache` in the executed value).
 *
 * The merge uses Phase A for everything except comparison artifacts, which
 * get Phase B's CEL expressions.
 */
function mergePhaseAAndPhaseB(
  phaseA: Record<string, unknown>,
  phaseB: Record<string, unknown>,
  logger: PipelineLogger
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  for (const [key, phaseAValue] of Object.entries(phaseA)) {
    if (key.startsWith('__')) {
      // Preserve internal fields from Phase A
      merged[key] = phaseAValue;
      continue;
    }

    const phaseBValue = phaseB[key];

    // Nested objects: recurse
    if (
      phaseAValue &&
      typeof phaseAValue === 'object' &&
      !isKubernetesRef(phaseAValue) &&
      !isCelExpression(phaseAValue) &&
      !Array.isArray(phaseAValue) &&
      phaseBValue &&
      typeof phaseBValue === 'object' &&
      !isCelExpression(phaseBValue)
    ) {
      merged[key] = mergePhaseAAndPhaseB(
        phaseAValue as Record<string, unknown>,
        phaseBValue as Record<string, unknown>,
        logger
      );
      continue;
    }

    // Phase A has a comparison artifact → use Phase B's CEL expression,
    // but only if Phase B produced clean CEL (not garbled fn.toString with
    // factory calls like `simple.Deployment({...}).status.readyReplicas`).
    if (isComparisonArtifact(phaseAValue) && phaseBValue && isCelExpression(phaseBValue)) {
      const expr = (phaseBValue as { expression: string }).expression;
      const isGarbled = expr.includes('({') || expr.includes('=>') || expr.includes('new ');
      if (!isGarbled) {
        logger.debug('Replacing Phase A artifact with Phase B CEL', {
          field: key,
          phaseAValue,
          phaseBExpression: expr.substring(0, 80),
        });
        merged[key] = phaseBValue;
        continue;
      }
      // Garbled Phase B → keep Phase A's artifact (will be classified as static)
    }

    // Phase A value is already correct
    merged[key] = phaseAValue;
  }

  // Include Phase B-only fields (fields that Phase A missed entirely,
  // e.g., computed fields the proxy execution never populated).
  for (const [key, phaseBValue] of Object.entries(phaseB)) {
    if (!(key in merged) && !key.startsWith('__')) {
      merged[key] = phaseBValue;
    }
  }

  return merged;
}

