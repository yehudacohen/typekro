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
import { KUBERNETES_REF_BRAND, KUBERNETES_REF_MARKER_PATTERN } from '../constants/brands.js';
import { escapeCelString } from '../../utils/cel-escape.js';

const logger = getComponentLogger('nested-status-cel');

export interface NestedStatusCelContext {
  /** Base ID for the nested composition (e.g., "inngestBootstrap1") */
  baseId: string;
  /** Resource IDs from the inner composition's execution context */
  innerResourceIds: string[];
  /** Local variable names that are known nested composition handles and must not be remapped as concrete resources. */
  preserveVariables?: ReadonlySet<string>;
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

    if (Array.isArray(celExpr)) {
      const exprStr = extractArrayExpressionString(celExpr, phaseBFallbackObj?.[field]);
      if (exprStr) {
        registerNestedStatusMapping(fieldPath, exprStr, ctx);
      }

      const phaseBArray = Array.isArray(phaseBFallbackObj?.[field])
        ? (phaseBFallbackObj[field] as unknown[])
        : undefined;
      celExpr.forEach((item, index) => {
        const fallbackItem = phaseBArray?.[index];
        if (isTraversableStatusObject(item)) {
          extractNestedStatusCel(
            item,
            ctx,
            `${fieldPath}.${index}`,
            isTraversableStatusObject(fallbackItem) ? fallbackItem : undefined
          );
        }
      });
      continue;
    }

    // Recurse into nested objects (not CelExpression or KubernetesRef)
    if (isTraversableStatusObject(celExpr)) {
      const analyzedObj = celExpr as Record<string, unknown>;
      const phaseBSub = phaseBFallbackObj?.[field];
      const usePhaseB =
        Object.keys(analyzedObj).length === 0 &&
        phaseBSub &&
        typeof phaseBSub === 'object' &&
        !Array.isArray(phaseBSub) &&
        Object.keys(phaseBSub as Record<string, unknown>).length > 0;

      const subObj = usePhaseB ? (phaseBSub as Record<string, unknown>) : analyzedObj;
      const subPhaseBFallback =
        phaseBSub && typeof phaseBSub === 'object'
          ? (phaseBSub as Record<string, unknown>)
          : undefined;

      extractNestedStatusCel(subObj, ctx, fieldPath, subPhaseBFallback);
      continue;
    }

    // Extract the expression string from the analyzed value
    const exprStr = extractExpressionString(celExpr, phaseBFallbackObj?.[field]);
    if (!exprStr) continue;

    registerNestedStatusMapping(fieldPath, exprStr, ctx);
  }
}

function registerNestedStatusMapping(
  fieldPath: string,
  exprStr: string,
  ctx: NestedStatusCelContext
): void {
  const remapped = remapVariableNames(exprStr, ctx.innerResourceIds, ctx.preserveVariables);
  const normalized = recoverGarbledExpression(remapped, ctx.innerResourceIds);
  if (!normalized) return;

  const key = `__nestedStatus:${ctx.baseId}:${fieldPath}`;
  ctx.registerMapping(key, normalized);
}

function isTraversableStatusObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !('expression' in value) &&
    !(KUBERNETES_REF_BRAND in (value as Record<string | symbol, unknown>))
  );
}

function extractArrayExpressionString(
  value: unknown[],
  phaseBFallback: unknown
): string | undefined {
  const phaseBArray = Array.isArray(phaseBFallback) ? phaseBFallback : undefined;
  const items = value.map((item, index) => extractExpressionString(item, phaseBArray?.[index]));

  if (items.every((item): item is string => typeof item === 'string')) {
    return `[${items.join(', ')}]`;
  }

  if (Array.isArray(phaseBFallback)) {
    const fallbackItems = phaseBFallback.map((item) => extractExpressionString(item, undefined));
    if (fallbackItems.every((item): item is string => typeof item === 'string')) {
      return `[${fallbackItems.join(', ')}]`;
    }
  }

  return undefined;
}

/**
 * Extract an expression string from an analyzed status value, covering
 * every leaf shape produced by the status analysis pipeline:
 *
 *  - **CelExpression object** — return the stored `expression`.
 *  - **KubernetesRef object** — return `<resourceId>.<fieldPath>`.
 *  - **Marker-string** (template literal produced during proxy tracing)
 *    — return as-is. Marker strings are the canonical static form for
 *    schema-only template literals and downstream resolution (finalize
 *    / classify) understands them natively.
 *  - **Plain string** — return as-is. May be a literal or a resolved
 *    CEL path from an earlier pass.
 *  - **Literal number/boolean/null** — stringify so nested refs that
 *    target a literal field can resolve to a concrete value. We prefer
 *    Phase B *only* for likely comparison artifacts (`false` or `NaN`),
 *    where Phase A may have eagerly evaluated a `proxy >= 1` against
 *    a NaN-coerced proxy. For genuine literal values like
 *    `return { active: true }` or `return { port: 6379 }`, we emit the
 *    literal directly — Phase B's stringified form (`"true"`, `"6379"`)
 *    is equivalent but adds a layer of indirection.
 */
function extractExpressionString(value: unknown, phaseBFallback: unknown): string | undefined {
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
  if (Array.isArray(value)) {
    return extractArrayExpressionString(value, phaseBFallback);
  }
  if (isTraversableStatusObject(value)) {
    const fallbackObj = isTraversableStatusObject(phaseBFallback) ? phaseBFallback : undefined;
    const entries = Object.entries(value)
      .filter(([key]) => !key.startsWith('__'))
      .map(([key, entryValue]) => {
        const entryExpr = extractExpressionString(entryValue, fallbackObj?.[key]);
        return entryExpr ? `${JSON.stringify(key)}: ${entryExpr}` : undefined;
      });
    if (entries.every((entry): entry is string => typeof entry === 'string')) {
      return `{${entries.join(', ')}}`;
    }
  }
  if (typeof value === 'string') {
    return isLikelyCelString(value) ? value : `"${escapeCelString(value)}"`;
  }
  if (typeof value === 'number') {
    // NaN comparisons (`proxy >= 1`) produce false in Phase A; if we see
    // NaN here, it's almost certainly a comparison artifact. Prefer Phase B.
    if (Number.isNaN(value) && phaseBHasExpression(phaseBFallback)) {
      return (phaseBFallback as { expression: string }).expression;
    }
    return String(value);
  }
  if (typeof value === 'boolean') {
    // `false` may also be a comparison artifact. `true` is rarely a
    // surprise — but still defer to Phase B if it has a richer form,
    // since the user almost always means a CEL expression when both
    // representations are available.
    if (value === false && phaseBHasExpression(phaseBFallback)) {
      return (phaseBFallback as { expression: string }).expression;
    }
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  // undefined / other — fall back to Phase B if available.
  if (phaseBHasExpression(phaseBFallback)) {
    return (phaseBFallback as { expression: string }).expression;
  }
  return undefined;
}

function isLikelyCelString(value: string): boolean {
  if (value.includes('__KUBERNETES_REF_') || value.includes('${')) return true;
  if (/^(?:true|false|null)$/.test(value)) return true;
  if (/^schema\.spec\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value)) return true;
  if (/^[A-Za-z_$][\w$]*\.(?:metadata|status|spec)\./.test(value)) return true;
  if (/\.(?:exists|all|exists_one|map|filter)\s*\(/.test(value)) return true;
  if (/^(?:has|size|string|int|double|bool)\(.+\)$/.test(value)) return true;
  return false;
}

/** Type guard: does `phaseBFallback` carry a Phase B `expression` field? */
function phaseBHasExpression(phaseBFallback: unknown): phaseBFallback is { expression: string } {
  return (
    !!phaseBFallback &&
    typeof phaseBFallback === 'object' &&
    'expression' in phaseBFallback &&
    typeof (phaseBFallback as { expression: unknown }).expression === 'string'
  );
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
  innerResourceIds: string[],
  preserveVariables?: ReadonlySet<string>
): string {
  const lambdaVariables = extractCelLambdaVariables(exprStr);
  const shouldPreserveVariable = (id: string): boolean =>
    preserveVariables?.has(id) === true || lambdaVariables.has(id);

  const remapResourceId = (id: string): string | undefined => {
    if (shouldPreserveVariable(id)) return undefined;
    if (id === '__schema__') return 'schema';
    if (innerResourceIds.includes(id) || id === 'schema') return id;

    const lower = id.toLowerCase();
    const normalizedLower = lower.replace(/^_+/, '');

    // 1. Exact match after lowercasing
    const exactLower = innerResourceIds.find((r) => {
      const candidate = r.toLowerCase();
      return candidate === lower || candidate === normalizedLower;
    });
    if (exactLower) return exactLower;

    // 2. Single resource — only treat minified/local shorthand names as
    // unambiguous. Named variables like `inner` or `inngest` may refer to
    // nested composition handles rather than the sole concrete resource.
    if (innerResourceIds.length === 1) {
      return innerResourceIds[0];
    }

    // 3. Prefix match at camelCase boundary — must be unambiguous
    const prefixMatches = innerResourceIds.filter(
      (r) =>
        (r.toLowerCase().startsWith(lower) || r.toLowerCase().startsWith(normalizedLower)) &&
        (normalizedLower.length === r.length ||
          /[A-Z_-]/.test(r[normalizedLower.length] ?? r[lower.length] ?? ''))
    );
    if (prefixMatches.length === 1) return prefixMatches[0];

    // 4. Suffix match at camelCase boundary — useful after nested resources
    // are merged into parent ids like `inngestBootstrap1InngestHelmRelease`.
    const suffixMatches = innerResourceIds.filter((r) => {
      const lowerResource = r.toLowerCase();
      if (!lowerResource.endsWith(lower) && !lowerResource.endsWith(normalizedLower)) return false;
      const matchedLength = lowerResource.endsWith(normalizedLower)
        ? normalizedLower.length
        : id.length;
      const boundaryIndex = r.length - matchedLength;
      const boundaryChar = r[boundaryIndex];
      return boundaryIndex <= 0 || (boundaryChar !== undefined && /[A-Z_-]/.test(boundaryChar));
    });
    if (suffixMatches.length === 1) return suffixMatches[0];

    // No match or ambiguous
    if (prefixMatches.length > 1 || suffixMatches.length > 1) {
      logger.warn('Ambiguous variable name in nested status CEL', {
        variable: id,
        candidates: [...prefixMatches, ...suffixMatches],
        expression: exprStr.slice(0, 80),
      });
    } else {
      logger.warn('Unresolvable variable name in nested status CEL', {
        variable: id,
        innerResourceIds,
        expression: exprStr.slice(0, 80),
      });
    }
    return undefined;
  };

  const dottedRemapped = exprStr.replace(
    /\b(\w+)\.(metadata|status|spec)\./g,
    (match, id, section) => {
      const remapped = remapResourceId(id);
      return remapped ? `${remapped}.${section}.` : match;
    }
  );

  return dottedRemapped.replace(
    new RegExp(KUBERNETES_REF_MARKER_PATTERN.source, 'g'),
    (match, id, fieldPath) => {
      const remapped = remapResourceId(id);
      return remapped ? `__KUBERNETES_REF_${remapped}_${fieldPath}__` : match;
    }
  );
}

function extractCelLambdaVariables(exprStr: string): Set<string> {
  const variables = new Set<string>();
  const lambdaPattern = /\.(?:exists|all|exists_one|map|filter)\s*\(\s*([A-Za-z_$][\w$]*)\s*,/g;
  for (const match of exprStr.matchAll(lambdaPattern)) {
    if (match[1]) variables.add(match[1]);
  }
  return variables;
}

/**
 * Source-parse a composition function to find local variable assignments to
 * nested-composition calls, and produce alias entries that map the
 * developer-chosen variable name to the corresponding nested-composition
 * baseId. The aliases let the transitive resolver in `cel-references.ts`
 * resolve references like `stack.status.ready` (where `stack` was bound
 * via `const stack = webAppWithProcessing({...})`) — the variable name
 * has no structural relationship to the baseId `webAppWithProcessing1`,
 * but it does appear in the function's source text, which Phase B AST
 * analysis lifts verbatim into status expressions.
 *
 * Implementation:
 *  1. Scan the function source for `(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\s*\(`
 *     patterns. Each match yields a candidate (varName, factoryName) pair.
 *  2. For each pair, find baseIds in `nestedCompositionIds` whose
 *     instance-digit-stripped stem matches `factoryName`.
 *  3. If exactly one baseId matches, alias `__nestedStatus:<varName>:<field>`
 *     to the same value as `__nestedStatus:<baseId>:<field>` for every
 *     `<field>` the inner composition exposes. Ambiguous matches (multiple
 *     baseIds with the same stem because the user called the same nested
 *     composition multiple times) are skipped — there's no source-only
 *     way to disambiguate them and the field-name-uniqueness fallback in
 *     `cel-references.ts` will kick in if it can.
 *
 * No-ops gracefully when:
 *  - The source can't be parsed (returns empty map)
 *  - No nested compositions have been registered yet
 *  - No variable assignments match a known factoryName
 */
export function buildNestedCompositionAliasTargets(
  compositionFnSource: string,
  nestedCompositionIds: Set<string> | undefined
): Record<string, string> {
  const aliasTargets: Record<string, string> = {};
  if (!nestedCompositionIds || nestedCompositionIds.size === 0) {
    return aliasTargets;
  }

  // Build index: factoryStem → baseIds[]
  const stemToBaseIds = new Map<string, string[]>();
  for (const baseId of nestedCompositionIds) {
    const stem = baseId.replace(/\d+$/, '');
    const arr = stemToBaseIds.get(stem) ?? [];
    arr.push(baseId);
    stemToBaseIds.set(stem, arr);
  }
  for (const [stem, baseIds] of stemToBaseIds) {
    baseIds.sort((a, b) => {
      const aNum = Number(a.match(/(\d+)$/)?.[1] ?? '0');
      const bNum = Number(b.match(/(\d+)$/)?.[1] ?? '0');
      return aNum - bNum;
    });
    stemToBaseIds.set(stem, baseIds);
  }

  const extractFactoryStem = (calleeExpression: string): string | undefined => {
    const match = calleeExpression.match(/([a-zA-Z_$][\w$]*)\s*$/);
    return match?.[1];
  };

  const factoryCallPositions = new Map<string, number[]>();
  const callPattern = /((?:[a-zA-Z_$][\w$]*)(?:\s*(?:\?|)\.\s*[a-zA-Z_$][\w$]*)*)\s*\(/g;
  for (const match of compositionFnSource.matchAll(callPattern)) {
    const calleeExpression = match[1];
    if (!calleeExpression) continue;
    const factoryStem = extractFactoryStem(calleeExpression);
    if (!factoryStem || !stemToBaseIds.has(factoryStem)) continue;
    const positions = factoryCallPositions.get(factoryStem) ?? [];
    positions.push(match.index ?? 0);
    factoryCallPositions.set(factoryStem, positions);
  }

  const chooseBaseIdForCall = (factoryStem: string, callPosition: number): string | undefined => {
    const matchingBaseIds = stemToBaseIds.get(factoryStem);
    if (!matchingBaseIds || matchingBaseIds.length === 0) return undefined;

    const allCallPositions = factoryCallPositions.get(factoryStem) ?? [];
    const callOrdinal = Math.max(
      0,
      allCallPositions.findIndex((position) => position === callPosition)
    );

    const effectiveIndex = allCallPositions.includes(callPosition)
      ? callOrdinal
      : allCallPositions.filter((position) => position < callPosition).length;

    return matchingBaseIds[effectiveIndex] ?? matchingBaseIds.at(-1);
  };

  // Find variable assignments. Match three forms:
  //  1. `const|let|var <varName> = <factoryName>(`
  //  2. `, <varName> = <factoryName>(` (comma-continuation in a single
  //     `const x = ..., y = ...` declaration — common after Bun/esbuild
  //     minifies the source)
  //  3. ` <varName> = <factoryName>(` (loose form for transpiled code
  //     that has converted `const` declarations to assignments)
  //
  // Filter `.foo = bar()` shapes by requiring the LHS to be a bare
  // identifier with no preceding `.` or `?.`.
  const assignPattern =
    /(?:(?:^|[;{(]|\bconst\b|\blet\b|\bvar\b|,)\s*)([a-zA-Z_$][\w$]*)\s*=\s*((?:[a-zA-Z_$][\w$]*)(?:\s*(?:\?|)\.\s*[a-zA-Z_$][\w$]*)*)\s*\(/g;
  for (const m of compositionFnSource.matchAll(assignPattern)) {
    const varName = m[1];
    const factoryName = m[2];
    if (!varName || !factoryName) continue;
    const factoryStem = extractFactoryStem(factoryName);
    if (!factoryStem) continue;
    // Defensive: skip if the LHS is preceded by a `.` (would mean it's
    // a property assignment like `obj.field = factory()`). The regex
    // above doesn't allow this directly, but the boundary character
    // before `varName` could be ambiguous in some shapes — check the
    // character at `m.index` to be sure.
    const startIdx = m.index ?? 0;
    if (startIdx > 0 && compositionFnSource[startIdx] === '.') continue;

    // Skip if the variable name is already a known baseId — exact-match
    // resolution will take precedence and we don't want to shadow it.
    if (nestedCompositionIds.has(varName)) continue;

    const assignmentOffsetInMatch = m[0].indexOf(factoryName);
    const callPosition = (m.index ?? 0) + Math.max(0, assignmentOffsetInMatch);
    const baseId = chooseBaseIdForCall(factoryStem, callPosition);
    if (!baseId) continue;

    aliasTargets[varName] = baseId;
  }

  // Support status destructuring from nested composition handles:
  //   const { status } = webAppWithProcessing(...); status.ready
  //   const { status: appStatus } = webAppWithProcessing(...); appStatus.ready
  // Direct `const { ready } = nested(...)` is intentionally not supported
  // because `ready` is under the returned handle's `.status`, not top-level.
  const statusDestructurePattern =
    /(?:^|[;{(]|\bconst\b|\blet\b|\bvar\b|,)\s*\{\s*status(?:\s*:\s*([a-zA-Z_$][\w$]*))?\s*\}\s*=\s*((?:[a-zA-Z_$][\w$]*)(?:\s*(?:\?|)\.\s*[a-zA-Z_$][\w$]*)*)\s*\(/g;
  for (const m of compositionFnSource.matchAll(statusDestructurePattern)) {
    const aliasName = m[1] || 'status';
    const factoryName = m[2];
    if (!factoryName) continue;
    const factoryStem = extractFactoryStem(factoryName);
    if (!factoryStem) continue;
    if (nestedCompositionIds.has(aliasName)) continue;

    const assignmentOffsetInMatch = m[0].indexOf(factoryName);
    const callPosition = (m.index ?? 0) + Math.max(0, assignmentOffsetInMatch);
    const baseId = chooseBaseIdForCall(factoryStem, callPosition);
    if (!baseId) continue;

    aliasTargets[aliasName] = baseId;
  }

  return aliasTargets;
}

export function buildNestedCompositionAliases(
  compositionFnSource: string,
  nestedCompositionIds: Set<string> | undefined,
  existingMappings: Record<string, string>
): Record<string, string> {
  const aliases: Record<string, string> = {};
  const aliasTargets = buildNestedCompositionAliasTargets(
    compositionFnSource,
    nestedCompositionIds
  );

  for (const [varName, baseId] of Object.entries(aliasTargets)) {
    const baseKeyPrefix = `__nestedStatus:${baseId}:`;
    for (const [key, value] of Object.entries(existingMappings)) {
      if (!key.startsWith(baseKeyPrefix)) continue;
      const fieldPath = key.slice(baseKeyPrefix.length);
      const aliasKey = `__nestedStatus:${varName}:${fieldPath}`;
      if (!Object.hasOwn(existingMappings, aliasKey) && !Object.hasOwn(aliases, aliasKey)) {
        aliases[aliasKey] = value;
      }
    }
  }

  // Diagnostic: if there's something to alias but the regex matched
  // nothing, log at debug level. The function returns gracefully — the
  // field-name-uniqueness fallback in `cel-references.ts:lookupNestedExpression`
  // resolves most missed cases without aliases. This log is a hint for
  // users debugging actual resolution failures (which surface via the
  // "conservatively dynamic" warning in `cel-validator.ts` when a
  // nested ref fails to resolve at classification time). Common causes
  // when aliases come up empty:
  //  - Composition source uses unsupported top-level destructuring (`const { x } = factory()`)
  //  - Composition source uses an IIFE wrapping the factory call
  //  - Imported factory was renamed (`import { x as y } from ...`)
  //  - Aggressive minifier renamed local variables
  const hasAliasableContent = Object.keys(existingMappings).some((k) =>
    k.startsWith('__nestedStatus:')
  );
  if (hasAliasableContent && Object.keys(aliases).length === 0) {
    logger.debug(
      'buildNestedCompositionAliases produced no aliases — relying on field-name-uniqueness fallback for nested ref resolution',
      {
        nestedCompositionIds: nestedCompositionIds ? Array.from(nestedCompositionIds) : [],
        sourcePreview: compositionFnSource.slice(0, 200),
      }
    );
  }

  return aliases;
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
  if (!garbledMarkers.some((m) => exprStr.includes(m))) {
    return exprStr; // Not garbled
  }

  const statusMatches = [...exprStr.matchAll(/(\w+)?\.status\.([a-zA-Z0-9_.]+)/g)];
  if (statusMatches.length === 0 || innerResourceIds.length === 0) {
    logger.warn('Garbled expression with no recoverable status reference', {
      expression: exprStr.slice(0, 100),
    });
    return undefined;
  }

  const firstStatusMatch = statusMatches[0];
  if (!firstStatusMatch) return exprStr;
  const [, varName, statusFieldPath] = firstStatusMatch;
  const firstInnerResource = innerResourceIds[0];
  if (!firstInnerResource) return exprStr;
  let targetResource = firstInnerResource;

  if (varName && innerResourceIds.length > 1) {
    const match = innerResourceIds.find((r) => r.toLowerCase().startsWith(varName.toLowerCase()));
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

  return `${targetResource}.status.${statusFieldPath}`;
}
