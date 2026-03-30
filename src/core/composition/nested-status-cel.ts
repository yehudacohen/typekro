/**
 * Nested Status CEL Extraction
 *
 * Extracts CEL expressions from an inner composition's analyzed status mappings
 * and registers them on the parent composition context. This allows the outer
 * composition's status builder to reference nested composition status fields
 * (e.g., `inngest.status.ready`) which get inlined as real CEL expressions
 * in the KRO YAML output.
 *
 * Responsibilities:
 * 1. Phase A/B fallback: use Phase A values unless they're artifacts, then Phase B
 * 2. Variable name re-mapping: map fn.toString variable names to resource IDs
 * 3. Garbled expression recovery: extract `.status.field` from factory call source
 * 4. CEL expression registration on the parent context
 */

import { getComponentLogger } from '../logging/index.js';
import { KUBERNETES_REF_BRAND } from '../constants/brands.js';

const logger = getComponentLogger('nested-status-cel');

export interface NestedStatusCelContext {
  /** Base ID for the nested composition (e.g., "inngestBootstrap1") */
  baseId: string;
  /** Resource IDs from the inner composition's execution context */
  innerResourceIds: string[];
  /** Callback to register a CEL mapping on the parent context */
  registerMapping: (key: string, value: string) => void;
}

/**
 * Extract CEL expressions from analyzed status mappings and register them
 * on the parent context for KRO YAML inlining.
 */
export function extractNestedStatusCel(
  obj: Record<string, unknown>,
  ctx: NestedStatusCelContext,
  pathPrefix: string = '',
  phaseBFallbackObj?: Record<string, unknown>
): void {
  for (const [field, celExpr] of Object.entries(obj)) {
    if (field.startsWith('__')) continue;

    const fieldPath = pathPrefix ? `${pathPrefix}.${field}` : field;

    // Recurse into nested objects (not CelExpression or KubernetesRef)
    if (
      celExpr &&
      typeof celExpr === 'object' &&
      !('expression' in celExpr) &&
      !(KUBERNETES_REF_BRAND in (celExpr as Record<string | symbol, unknown>)) &&
      !Array.isArray(celExpr)
    ) {
      const analyzedObj = celExpr as Record<string, unknown>;
      const phaseBSub = phaseBFallbackObj?.[field];
      const usePhaseB =
        Object.keys(analyzedObj).length === 0 &&
        phaseBSub &&
        typeof phaseBSub === 'object' &&
        !Array.isArray(phaseBSub) &&
        Object.keys(phaseBSub as Record<string, unknown>).length > 0;

      const subObj = usePhaseB ? (phaseBSub as Record<string, unknown>) : analyzedObj;
      const subPhaseBFallback = phaseBSub && typeof phaseBSub === 'object'
        ? (phaseBSub as Record<string, unknown>)
        : undefined;

      extractNestedStatusCel(subObj, ctx, fieldPath, subPhaseBFallback);
      continue;
    }

    // Extract the expression string from the analyzed value
    let exprStr = extractExpressionString(celExpr, phaseBFallbackObj?.[field]);
    if (!exprStr) continue;

    // Re-map variable names to resource IDs
    exprStr = remapVariableNames(exprStr, ctx.innerResourceIds);

    // Recover from garbled fn.toString output
    exprStr = recoverGarbledExpression(exprStr, ctx.innerResourceIds);
    if (!exprStr) continue;

    const key = `__nestedStatus:${ctx.baseId}:${fieldPath}`;
    ctx.registerMapping(key, exprStr);
  }
}

/**
 * Extract a CEL expression string from an analyzed status value.
 * Handles CelExpression objects, KubernetesRef objects, plain strings,
 * and falls back to Phase B for comparison artifacts.
 */
function extractExpressionString(
  value: unknown,
  phaseBFallback: unknown
): string | undefined {
  if (value && typeof value === 'object' && 'expression' in value) {
    return (value as { expression: string }).expression;
  }
  if (
    value &&
    typeof value === 'object' &&
    KUBERNETES_REF_BRAND in (value as Record<string | symbol, unknown>)
  ) {
    const ref = value as { resourceId: string; fieldPath: string };
    return `${ref.resourceId}.${ref.fieldPath}`;
  }
  if (typeof value === 'string') {
    return value;
  }
  // Comparison artifact (false/NaN) — fall back to Phase B
  if (phaseBFallback && typeof phaseBFallback === 'object' && 'expression' in phaseBFallback) {
    return (phaseBFallback as { expression: string }).expression;
  }
  return undefined;
}

/**
 * Re-map fn.toString variable names to actual inner resource IDs.
 *
 * Phase B produces expressions with variable names from the source code
 * (e.g., `d.status.ready`). These need to be mapped to resource IDs
 * (e.g., `deployment.status.ready`).
 *
 * Uses scored matching: exact-lowercase → single-resource → unambiguous-prefix.
 * Logs a warning when no match or ambiguous match is found.
 */
export function remapVariableNames(
  exprStr: string,
  innerResourceIds: string[]
): string {
  return exprStr.replace(/\b(\w+)\.(metadata|status|spec)\./g, (match, id, section) => {
    if (innerResourceIds.includes(id) || id === 'schema') return match;

    const lower = id.toLowerCase();

    // 1. Exact match after lowercasing
    const exactLower = innerResourceIds.find(r => r.toLowerCase() === lower);
    if (exactLower) return `${exactLower}.${section}.`;

    // 2. Single resource — unambiguous
    if (innerResourceIds.length === 1) return `${innerResourceIds[0]}.${section}.`;

    // 3. Prefix match at camelCase boundary — must be unambiguous
    const prefixMatches = innerResourceIds.filter(r =>
      r.toLowerCase().startsWith(lower) &&
      (lower.length === r.length || /[A-Z_-]/.test(r[lower.length]!))
    );
    if (prefixMatches.length === 1) return `${prefixMatches[0]}.${section}.`;

    // No match or ambiguous
    if (prefixMatches.length > 1) {
      logger.warn('Ambiguous variable name in nested status CEL', {
        variable: id,
        candidates: prefixMatches,
        expression: exprStr.slice(0, 80),
      });
    } else {
      logger.warn('Unresolvable variable name in nested status CEL', {
        variable: id,
        innerResourceIds,
        expression: exprStr.slice(0, 80),
      });
    }
    return match;
  });
}

/**
 * Recover a CEL expression from garbled fn.toString output.
 *
 * When fn.toString produces source code containing factory calls (`({`, `=>`),
 * Cel.expr() calls, or `new` expressions, the raw source is not valid CEL.
 * Extract the `.status.field` reference pattern and map it to an inner resource.
 *
 * Returns the cleaned expression, or undefined if recovery fails.
 */
export function recoverGarbledExpression(
  exprStr: string,
  innerResourceIds: string[]
): string | undefined {
  const garbledMarkers = ['({', '=>', 'new ', 'Cel.expr('];
  if (!garbledMarkers.some(m => exprStr.includes(m))) {
    return exprStr; // Not garbled
  }

  const statusMatches = [...exprStr.matchAll(/(\w+)?\.status\.(\w+)/g)];
  if (statusMatches.length === 0 || innerResourceIds.length === 0) {
    logger.warn('Garbled expression with no recoverable status reference', {
      expression: exprStr.slice(0, 100),
    });
    return undefined;
  }

  const [, varName, statusField] = statusMatches[0]!;
  let targetResource = innerResourceIds[0]!;

  if (varName && innerResourceIds.length > 1) {
    const match = innerResourceIds.find(r =>
      r.toLowerCase().startsWith(varName.toLowerCase())
    );
    if (match) {
      targetResource = match;
    } else {
      logger.warn('Garbled expression variable does not match any inner resource', {
        variable: varName,
        innerResourceIds,
        expression: exprStr.slice(0, 100),
      });
    }
  }

  return `${targetResource}.status.${statusField}`;
}
