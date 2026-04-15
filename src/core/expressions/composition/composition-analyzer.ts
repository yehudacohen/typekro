/**
 * Composition Body Analyzer
 *
 * Post-hoc AST analysis of composition function bodies to detect control flow
 * patterns (if-statements, for-of loops, ternary expressions) wrapping factory
 * calls. Detected patterns are translated to Kro v0.8.x directives:
 *
 *   - IfStatement → includeWhen
 *   - ForOfStatement / .map() / .forEach() → forEach
 *   - ConditionalExpression (ternary with factory call) → includeWhen
 *   - ConditionalExpression (ternary value in factory arg) → CEL conditional
 *
 * Integration: Called after the composition function executes and all resources
 * are collected, but before YAML serialization. Attaches non-enumerable
 * `includeWhen` and `forEach` properties on Enhanced resource objects.
 */

import { Parser } from 'acorn';
import { ensureError } from '../../errors.js';
import { getComponentLogger } from '../../logging/index.js';
import {
  getForEach,
  getIncludeWhen,
  setForEach,
  setIncludeWhen,
  setTemplateOverrides,
} from '../../metadata/index.js';
import { extractSpecParamName } from './composition-analyzer-helpers.js';
import { extractFunctionBody, walkBody } from './composition-analyzer-traversal.js';
import type { ASTNode, TraversalContext } from './composition-analyzer-types.js';

// Re-export all public types for backward compatibility
export type {
  ASTAnalysisResult,
  ExpressionOverride,
  ForEachDimension,
  IncludeWhenCondition,
  ResourceControlFlow,
  UnregisteredFactory,
} from './composition-analyzer-types.js';

// Import the result type for use in function signatures
import type { ASTAnalysisResult } from './composition-analyzer-types.js';

const logger = getComponentLogger('composition-analyzer');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a composition function's source code to detect control flow
 * patterns (if-statements, for-of loops, ternary expressions) wrapping
 * factory calls. Returns the detected patterns keyed by resource ID.
 *
 * @param compositionFn - The original composition function
 * @param resourceIds - Set of known resource IDs (to validate matches)
 * @returns Analysis result with forEach/includeWhen per resource
 */
export function analyzeCompositionBody(
  compositionFn: (...args: unknown[]) => unknown,
  resourceIds: Set<string>,
  optionalFieldNames?: Set<string>
): ASTAnalysisResult {
  const result: ASTAnalysisResult = {
    resources: new Map(),
    unregisteredFactories: [],
    templateOverrides: new Map(),
    _collectionVariables: new Map(),
    statusOverrides: [],
    resourceStatusTernaries: [],
    variableToResourceId: new Map(),
    errors: [],
  };

  try {
    const fnSource = compositionFn.toString();
    const specParamName = extractSpecParamName(fnSource);

    // Parse the function source
    const ast = Parser.parse(fnSource, {
      ecmaVersion: 2022,
      sourceType: 'script',
      locations: true,
      ranges: true,
    }) as unknown as ASTNode & { body: ASTNode[] };

    // Find the function body
    // The parsed source may be:
    //   - A FunctionDeclaration/FunctionExpression with a body
    //   - An arrow function as an ExpressionStatement
    const functionBody = extractFunctionBody(ast);
    if (!functionBody) {
      logger.debug('Could not extract function body from composition function');
      return result;
    }

    // Note: collection variable tracking is done inline in analyzeReturnCollectionAggregates
    // by detecting spec.array.map(cb).method() patterns directly in the expression tree.
    // Bun's transpiler may inline variable assignments, so we can't rely on VariableDeclaration.

    // Walk the function body. `optionalFieldNames` flows down into
    // `conditionToCel` so that bare truthiness checks on OPTIONAL fields
    // (`if (spec.maybeX)`) are wrapped with `has()` — matching JavaScript
    // truthiness semantics — while bare references to REQUIRED boolean
    // fields (`if (spec.enabled)`) pass through as value reads since
    // `has(...)` on a required field is trivially true.
    const ctx: TraversalContext = {
      forEachStack: [],
      includeWhenStack: [],
      optionalFieldNames: optionalFieldNames ?? new Set(),
    };

    walkBody(functionBody, fnSource, specParamName, ctx, result);

    // Separate registered from unregistered resources.
    // Only add entries that aren't already tracked by registerResourceControlFlow.
    for (const [id] of result.resources) {
      if (!resourceIds.has(id) && !result.unregisteredFactories.some((f) => f.resourceId === id)) {
        // This factory call was found in the AST but wasn't registered at runtime.
        // This happens when the factory is inside an if-branch that wasn't taken
        // (e.g. `if (spec.env === 'production')` where spec is a proxy).
        // Track it so the integration layer can create stub resources.
        // Note: the factoryName may already have been captured by registerResourceControlFlow;
        // this fallback uses '' which causes createStubResource to return null (harmless).
        result.unregisteredFactories.push({
          resourceId: id,
          factoryName: '', // registerResourceControlFlow already captured the better entry
          argSource: '',
        });
        logger.debug(`Resource ${id} found in AST but not registered at runtime`);
      }
    }
  } catch (error: unknown) {
    const msg = `Failed to analyze composition function: ${ensureError(error).message}`;
    logger.warn(msg);
    result.errors.push(msg);
  }

  return result;
}

/**
 * Apply the analysis results to Enhanced resources by attaching
 * non-enumerable `forEach` and `includeWhen` properties.
 *
 * This is the integration point that modifies resources in-place before serialization.
 *
 * @param resources - The resources map (keyed by resource ID)
 * @param analysis - The analysis result from `analyzeCompositionBody()`
 */
export function applyAnalysisToResources(
  resources: Record<string, unknown>,
  analysis: ASTAnalysisResult
): void {
  for (const [resourceId, controlFlow] of analysis.resources) {
    if (resourceId.startsWith('__call__:')) {
      const callStem = resourceId.slice('__call__:'.length);
      for (const [actualId, resource] of Object.entries(resources)) {
        if (!actualId.startsWith(callStem) || !resource || typeof resource !== 'object') continue;

        if (controlFlow.forEach.length > 0) {
          const forEachDimensions = controlFlow.forEach.map((dim) => ({
            [dim.variableName]: dim.source,
          }));
          const existing = getForEach(resource);
          const merged = existing
            ? [...(Array.isArray(existing) ? existing : [existing]), ...forEachDimensions]
            : forEachDimensions;
          setForEach(resource, merged);
        }

        if (controlFlow.includeWhen.length > 0) {
          const celStrings = controlFlow.includeWhen.map((c) => c.expression);
          const existing = getIncludeWhen(resource);
          const merged = existing
            ? [...(Array.isArray(existing) ? existing : [existing]), ...celStrings]
            : celStrings;
          setIncludeWhen(resource, merged);
        }
      }
      continue;
    }

    const resource = resources[resourceId];
    if (!resource || typeof resource !== 'object') continue;

    // Attach forEach dimensions via WeakMap metadata
    if (controlFlow.forEach.length > 0) {
      const forEachDimensions = controlFlow.forEach.map((dim) => ({
        [dim.variableName]: dim.source,
      }));

      // Merge with existing forEach if present (from explicit API)
      const existing = getForEach(resource);
      const merged = existing
        ? [...(Array.isArray(existing) ? existing : [existing]), ...forEachDimensions]
        : forEachDimensions;

      setForEach(resource, merged);
    }

    // Attach includeWhen conditions via WeakMap metadata
    if (controlFlow.includeWhen.length > 0) {
      const celStrings = controlFlow.includeWhen.map((c) => c.expression);

      // Merge with existing includeWhen if present (from explicit .withIncludeWhen() calls)
      const existing = getIncludeWhen(resource);
      const merged = existing
        ? [...(Array.isArray(existing) ? existing : [existing]), ...celStrings]
        : celStrings;

      setIncludeWhen(resource, merged);
    }
  }

  // Attach template overrides via WeakMap metadata
  for (const [resourceId, overrides] of analysis.templateOverrides) {
    const resource = resources[resourceId];
    if (!resource || typeof resource !== 'object' || overrides.length === 0) continue;

    setTemplateOverrides(resource, overrides);
  }
}
