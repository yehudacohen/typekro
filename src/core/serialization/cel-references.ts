/**
 * CEL Reference Serialization
 *
 * Functions for converting KubernetesRef objects, CelExpression objects,
 * and __KUBERNETES_REF__ marker strings into CEL expression strings
 * suitable for Kro ResourceGraphDefinition YAML output.
 *
 * This module is the **single authority** for KubernetesRef → CEL string
 * conversion.  No other module should duplicate this logic.
 */

import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { getComponentLogger } from '../logging/index.js';
import { copyResourceMetadata } from '../metadata/index.js';
import type { KubernetesRef } from '../types/common.js';
import type { SerializationContext } from '../types/serialization.js';

const logger = getComponentLogger('cel-references');

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

/**
 * Compute the inner CEL path for a {@link KubernetesRef}.
 *
 * The special sentinel `__schema__` is normalised to `schema` so that
 * the resulting path is valid Kro CEL (e.g. `schema.spec.name`).
 *
 * @remarks
 * This is the authoritative implementation.
 */
export function getInnerCelPath(ref: KubernetesRef<unknown>): string {
  const resourceId = ref.resourceId === '__schema__' ? 'schema' : ref.resourceId;
  return `${resourceId}.${ref.fieldPath}`;
}

// ---------------------------------------------------------------------------
// Single-ref → CEL
// ---------------------------------------------------------------------------

/**
 * If `celPath` is a `schema.spec.<dotted.path>` reference whose path
 * — or any of its ancestor prefixes — is listed in the context's omit
 * set, wrap it with KRO 0.9+ `has(...) ? ... : omit()`. Otherwise
 * return it unchanged.
 *
 * The wrapper is only applied to single-ref expressions — never to
 * mixed templates like `${string(schema.spec.name)}-suffix` because
 * those produce string values, not fields, and `omit()` operates at
 * the field level.
 *
 * **Ancestor-prefix lookup:** `omitFields` may contain either leaf
 * paths (`database.storageClass`) or parent paths (`env`, `cache`).
 * The walk goes leaf-to-root and guards with `has()` on the *deepest*
 * ancestor that's in the set. This covers three cases in one pass:
 *
 *   1. Exact leaf match — `database.storageClass?` → guard
 *      `has(schema.spec.database.storageClass)`.
 *   2. Whole-object optional — `env?: {...}` → any child ref
 *      `schema.spec.env.FOO` is guarded by `has(schema.spec.env)`
 *      because leaf access throws when the parent is absent.
 *   3. Mixed — both `cache?` (parent) and `cache.replicas?` (child)
 *      in the set → a ref to `schema.spec.cache.replicas` prefers
 *      the *deeper* `cache.replicas` guard so a partially-populated
 *      `cache: { shards: 1 }` (parent present, child absent) still
 *      omits correctly.
 */
function maybeWrapWithOmit(
  celPath: string,
  stringWrap: boolean,
  omitFields: ReadonlySet<string> | undefined
): string {
  const value = stringWrap ? `string(${celPath})` : celPath;
  if (!omitFields || omitFields.size === 0) return value;

  // Only handle refs rooted at `schema.spec.`.
  const refMatch = /^schema\.spec\.([A-Za-z_$][\w$.]*)$/.exec(celPath);
  const refPath = refMatch?.[1];
  if (!refPath) return value;

  // Walk from leaf to root: find the deepest ancestor that's in the
  // omit set. That ancestor is the one we guard via has(), because
  // its absence implies the absence of every descendant.
  //
  // When the guard is an ANCESTOR (not the leaf itself), we must also
  // guard the leaf path. KRO's has() on an ancestor like cnpgOperator
  // returns true if the object exists in the schema — but sub-fields
  // like cnpgOperator.version may still be absent if the user provides
  // an incomplete object. Chain has() checks to cover both levels.
  const segments = refPath.split('.');
  for (let i = segments.length; i >= 1; i--) {
    const prefix = segments.slice(0, i).join('.');
    if (omitFields.has(prefix)) {
      const guardPath = `schema.spec.${prefix}`;
      // If the guard is the field itself (i === segments.length), a single has() suffices.
      // If the guard is an ancestor, chain has() checks for ALL intermediate
      // levels between the guard and the leaf. For `cnpgOperator.monitoring.enabled`
      // guarded by `cnpgOperator`, we need:
      //   has(cnpgOperator) && has(cnpgOperator.monitoring) && has(cnpgOperator.monitoring.enabled)
      // A single has(ancestor) + has(leaf) misses intermediates like `monitoring`.
      if (i === segments.length) {
        return `has(${guardPath}) ? ${value} : omit()`;
      }
      const guards = [`has(${guardPath})`];
      for (let j = i + 1; j <= segments.length; j++) {
        const intermediatePath = `schema.spec.${segments.slice(0, j).join('.')}`;
        guards.push(`has(${intermediatePath})`);
      }
      return `${guards.join(' && ')} ? ${value} : omit()`;
    }
  }
  return value;
}

/**
 * Wrap a {@link KubernetesRef} in `${…}` for Kro YAML output.
 *
 * When the ref points to a nested composition's virtual status ID
 * (e.g., `innerService1.status.serviceUrl`), resolve it via the
 * transitive resolver — substituting the inner composition's analyzed
 * expression and producing valid KRO CEL (no raw markers, no virtual
 * IDs).
 *
 * The nested-composition lookup delegates to {@link lookupNestedExpression}
 * — the single source of truth for the match strategy. See that function
 * for the full priority order.
 */
function generateCelExpression(
  ref: KubernetesRef<unknown>,
  context?: SerializationContext
): string {
  const isNestedComp = (ref as { __nestedComposition?: boolean }).__nestedComposition === true;
  if (isNestedComp && context?.nestedStatusCel) {
    const fieldName = ref.fieldPath.replace(/^status\./, '');
    const innerExpr = lookupNestedExpression(ref.resourceId, fieldName, context.nestedStatusCel);
    if (innerExpr !== undefined) {
      return finalizeCelForKro(innerExpr, context.nestedStatusCel, context);
    }
  }

  const expression = getInnerCelPath(ref);
  const body = maybeWrapWithOmit(expression, false, context?.omitFields);
  return `\${${body}}`;
}

// ---------------------------------------------------------------------------
// __KUBERNETES_REF__ marker primitives
// ---------------------------------------------------------------------------

/**
 * Single source of truth for __KUBERNETES_REF__ marker detection.
 *
 * Marker shape:
 *   - Resource ref:  `__KUBERNETES_REF_<resourceId>_<fieldPath>__`
 *   - Schema ref:    `__KUBERNETES_REF___schema___<fieldPath>__`
 *
 * `resourceId` is `__schema__` for schema refs, or a single underscore-free
 * identifier for resource refs. `fieldPath` is a dot-separated identifier
 * sequence like "spec.name" or "status.workers.$item.name".
 *
 * Two flavors are needed:
 *  - `MARKER_PATTERN_SOURCE` is the non-global base pattern. Create a fresh
 *    `new RegExp(MARKER_PATTERN_SOURCE, 'g')` wherever global matching is
 *    needed — avoids the stateful-lastIndex footgun.
 *  - `MARKER_PATTERN_FULL` matches when the entire string is exactly one
 *    marker (for the single-ref fast path in
 *    {@link convertKubernetesRefMarkersTocel}).
 */
/**
 * Non-global base pattern for __KUBERNETES_REF__ markers. Create a fresh
 * `RegExp(MARKER_PATTERN_SOURCE, 'g')` wherever global matching is needed —
 * avoids the stateful-lastIndex footgun of a module-level `/g` regex.
 */
const MARKER_PATTERN_SOURCE = '__KUBERNETES_REF_(__schema__|[^_]+)_([a-zA-Z0-9.$]+)__';
const MARKER_PATTERN_FULL = /^__KUBERNETES_REF_(__schema__|[^_]+)_([a-zA-Z0-9.$]+)__$/;

/**
 * Convert a marker substring captured from {@link MARKER_PATTERN_G} (or
 * {@link MARKER_PATTERN_FULL}) to its bare CEL path. Handles the
 * `__schema__` sentinel by emitting `schema.<fieldPath>`; otherwise
 * emits `<resourceId>.<fieldPath>`.
 */
function markerToCelPath(resourceId: string, fieldPath: string): string {
  return resourceId === '__schema__' ? `schema.${fieldPath}` : `${resourceId}.${fieldPath}`;
}

/**
 * Normalize any `__KUBERNETES_REF__` markers in `str` to their bare CEL paths
 * in-place — without wrapping them in `${…}`. Used by the static/dynamic
 * classifier and the transitive resolver when we need to scan for non-
 * schema references inside a marker-laden string.
 *
 * Unlike {@link convertKubernetesRefMarkersTocel}, this does NOT produce a
 * KRO mixed-template string. It produces a raw CEL-path blend where
 * markers have been replaced by their dotted CEL paths.
 *
 * Example:
 *   "http://__KUBERNETES_REF___schema___spec.name__:__KUBERNETES_REF___schema___spec.port__"
 *   →
 *   "http://schema.spec.name:schema.spec.port"
 *
 * The result isn't valid CEL on its own — it's literal text interleaved
 * with CEL paths, suitable for pattern matching only.
 */
function normalizeMarkerString(str: string): string {
  return str.replace(new RegExp(MARKER_PATTERN_SOURCE, 'g'), (_match, id: string, path: string) =>
    markerToCelPath(id, path)
  );
}

// ---------------------------------------------------------------------------
// CEL lambda variable handling
// ---------------------------------------------------------------------------

/**
 * Pattern to extract lambda variable names from CEL macro calls.
 *
 * CEL macros (`.all`, `.exists`, `.exists_one`, `.map`, `.filter`)
 * introduce a local variable in their first argument that should NOT
 * be treated as a resource identifier when scanning for `<id>.status.X`
 * patterns. The classification regex is shared with `cel-validator.ts`
 * — keep them in sync if you change one.
 *
 * Note: `each` is also a special identifier — it's the implicit element
 * variable used by KRO `forEach`/`readyWhen` callback bodies.
 */
const CEL_LAMBDA_MACRO_PATTERN =
  /\.(?:all|exists|exists_one|map|filter)\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*,/g;

/**
 * Build the set of identifiers that should be treated as lambda-bound
 * variables when scanning `expr` for resource references. Always includes
 * `each` as a sentinel for `forEach.readyWhen` bodies.
 */
function collectLambdaVars(expr: string): Set<string> {
  const vars = new Set<string>(['each']);
  for (const m of expr.matchAll(CEL_LAMBDA_MACRO_PATTERN)) {
    if (m[1]) vars.add(m[1]);
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Static / dynamic classification
// ---------------------------------------------------------------------------

/**
 * Check whether an already-resolved CEL-path string contains any
 * non-schema resource references. "Non-schema resource reference" means
 * any `<identifier>.(status|metadata|spec).<path>` where `<identifier>`
 * is neither `schema` nor a CEL macro lambda variable.
 *
 * Lambda variables (the `c` in `.exists(c, c.status == "True")`) are
 * detected via {@link collectLambdaVars} and excluded — otherwise a
 * legitimate macro body would falsely classify the parent expression
 * as dynamic for the wrong reason.
 */
function containsNoNonSchemaRefs(expr: string): boolean {
  const lambdaVars = collectLambdaVars(expr);
  const pattern = /\b([a-zA-Z_$][\w$]*)\.(status|metadata|spec)\./g;
  for (const m of expr.matchAll(pattern)) {
    const id = m[1];
    if (id === 'schema') continue;
    if (id && lambdaVars.has(id)) continue;
    return false;
  }
  return true;
}

/**
 * Classify an expression as static (iff, after resolving all nested-
 * composition references and schema markers, it contains no references
 * to real-resource `status`/`metadata`/`spec` fields) or dynamic.
 *
 * This is the authoritative depth-agnostic static/dynamic classifier.
 * It supersedes the local syntactic check in `validation/cel-validator.ts`
 * for nested-composition references.
 *
 * Input shapes accepted:
 *  - CEL expression strings (e.g., `"app.status.readyReplicas >= 1"`)
 *  - Marker strings (e.g., `"http://__KUBERNETES_REF___schema___spec.name__"`)
 *  - Mixed: CEL paths + marker tokens + literals
 *
 * Returns `true` iff the fully-resolved expression is purely
 * schema-and-literal.
 */
export function isStaticExpression(
  expr: string,
  nestedStatusCel: Record<string, string> | undefined
): boolean {
  const afterNesting = resolveNestedCompositionRefs(expr, nestedStatusCel);
  const afterMarkers = normalizeMarkerString(afterNesting);
  return containsNoNonSchemaRefs(afterMarkers);
}

// ---------------------------------------------------------------------------
// Nested composition reference resolution
// ---------------------------------------------------------------------------

/**
 * Maximum number of substitution passes when resolving nested composition
 * references in {@link resolveNestedCompositionRefs}. The fixed-point loop
 * normally converges in one or two passes (one per level of nesting), so
 * 16 is a comfortable cap that handles pathologically deep compositions
 * without giving runaway substitution loops a chance to wedge serialization.
 *
 * Hitting this limit indicates a real bug in the resolution table — most
 * likely a cycle introduced by a faulty alias entry — not a legitimate
 * composition shape.
 */
const NESTED_REF_RESOLUTION_DEPTH_LIMIT = 16;

/**
 * Look up a nested composition's analyzed expression by `(resourceId, fieldName)`.
 *
 * **Single source of truth** for the nested-status match strategy. Used by
 * every code path that needs to find an inner expression from a
 * `nestedStatusCel` table — both the structured-ref paths
 * (`generateCelExpression`, `serializeStatusMappingsToCel`) and the
 * string-resolver path (`substituteNestedRefsOnce`,
 * `resolveNestedRefMarkers`).
 *
 * Returns `undefined` when no match is found, leaving the caller to
 * decide how to handle missing entries (typically: leave the reference
 * in place and let downstream validation flag it).
 *
 * Match priority:
 *  1. **Exact baseId match.** The reference uses the virtual nested
 *     composition baseId verbatim (e.g., from a template literal on a
 *     nested status proxy where `toString()` embeds the baseId).
 *  2. **Base-name match (instance digits stripped).** Both the requested
 *     id and the candidate baseIds have their trailing instance digits
 *     stripped, then compared for equality. Handles the case where the
 *     reference uses `webAppWithProcessing2` but the table has
 *     `webAppWithProcessing1`.
 *  3. **Unambiguous camelCase / case-insensitive prefix.** The
 *     reference uses a name that structurally relates to one (and only
 *     one) baseId stem (e.g., `inngest` matching `inngestBootstrap`).
 *  4. **Field-name uniqueness.** When exactly one nested composition in
 *     the table provides the requested field, use it. Handles the case
 *     of arbitrary local variable names (e.g.,
 *     `const stack = webAppWithProcessing(...); stack.status.databaseUrl`).
 *
 * Ambiguous matches (multiple candidates from the prefix or field-name
 * strategies) emit a warning log and return `undefined` so the caller
 * can fall through to its own error handling.
 */
function lookupNestedExpression(
  resourceId: string,
  fieldName: string,
  nestedStatusCel: Record<string, string>
): string | undefined {
  // Strategy 1: exact match.
  const exactKey = `__nestedStatus:${resourceId}:${fieldName}`;
  if (Object.hasOwn(nestedStatusCel, exactKey)) {
    return nestedStatusCel[exactKey];
  }

  // Gather all entries for the requested field name once — strategies
  // 2-4 all need this list.
  const fieldSuffix = `:${fieldName}`;
  const fieldMatches: Array<{ key: string; baseId: string }> = [];
  for (const key of Object.keys(nestedStatusCel)) {
    if (!key.endsWith(fieldSuffix)) continue;
    const parts = key.split(':');
    if (parts.length === 3 && parts[1]) {
      fieldMatches.push({ key, baseId: parts[1] });
    }
  }
  if (fieldMatches.length === 0) return undefined;

  // Strategy 2: base-name match (instance digits stripped).
  const refBase = resourceId.replace(/\d+$/, '');
  const baseNameMatches = fieldMatches.filter(
    (m) => m.baseId.replace(/\d+$/, '') === refBase
  );
  if (baseNameMatches.length === 1) {
    return nestedStatusCel[baseNameMatches[0]!.key];
  }

  // Strategy 3: unambiguous camelCase / case-insensitive prefix.
  const prefixMatches = fieldMatches.filter((m) => {
    const baseStem = m.baseId.replace(/\d+$/, '');
    return (
      isCamelCasePrefix(resourceId, baseStem) ||
      isCamelCasePrefix(baseStem, resourceId) ||
      baseStem.toLowerCase() === resourceId.toLowerCase()
    );
  });
  if (prefixMatches.length === 1) {
    return nestedStatusCel[prefixMatches[0]!.key];
  }
  if (prefixMatches.length > 1) {
    logger.warn('Ambiguous nested composition prefix match', {
      resourceId,
      fieldName,
      candidates: prefixMatches.map((m) => m.baseId),
    });
    return undefined;
  }

  // Strategy 4: field-name uniqueness.
  if (fieldMatches.length === 1) {
    return nestedStatusCel[fieldMatches[0]!.key];
  }
  logger.warn('Ambiguous nested composition field-name match', {
    resourceId,
    fieldName,
    candidates: fieldMatches.map((m) => m.baseId),
  });
  return undefined;
}

/**
 * Transitively substitute nested-composition references inline from a
 * lookup table.
 *
 * Searches `expr` for `<id>.status.<fieldPath>` patterns and, when `<id>`
 * resolves to a nested composition entry via {@link lookupNestedExpression},
 * replaces the match with the inner composition's analyzed expression
 * wrapped in parentheses (to preserve operator precedence in compound
 * expressions).
 *
 * **Does NOT touch `__KUBERNETES_REF__` markers.** Callers that need to
 * emit final KRO CEL should run {@link convertKubernetesRefMarkersTocel}
 * on the result. Callers that need to classify the result as
 * static/dynamic should run {@link normalizeMarkerString} then
 * {@link containsNoNonSchemaRefs} (or just call
 * {@link isStaticExpression} which composes both steps).
 *
 * Iterates to a fixed point up to {@link NESTED_REF_RESOLUTION_DEPTH_LIMIT}
 * — substituted expressions may themselves contain nested references that
 * become resolvable once the outer reference is inlined (the three-level
 * nesting case: L1 → L2 → L3).
 *
 * **Lambda variables are skipped.** When the resolved `<id>` is a CEL
 * macro lambda variable like the `c` in `.exists(c, c.status == "Ready")`,
 * the substitution does NOT fire — the variable refers to the macro's
 * iteration element, not a nested composition.
 */
function resolveNestedCompositionRefs(
  expr: string,
  nestedStatusCel: Record<string, string> | undefined
): string {
  if (!nestedStatusCel || Object.keys(nestedStatusCel).length === 0) {
    return expr;
  }

  let current = expr;
  for (let i = 0; i < NESTED_REF_RESOLUTION_DEPTH_LIMIT; i++) {
    const next = substituteNestedRefsOnce(current, nestedStatusCel);
    if (next === current) return current;
    current = next;
  }
  logger.warn('Nested composition resolution depth limit exceeded', {
    depthLimit: NESTED_REF_RESOLUTION_DEPTH_LIMIT,
    expressionPreview: expr.slice(0, 200),
  });
  return current;
}

/**
 * One pass of nested-reference substitution. See
 * {@link resolveNestedCompositionRefs} for the full contract.
 */
function substituteNestedRefsOnce(
  expr: string,
  nestedStatusCel: Record<string, string>
): string {
  const lambdaVars = collectLambdaVars(expr);
  // Match `<id>.status.<fieldPath>`. The fieldPath capture is greedy on
  // dots so paths like `components.app` are captured whole — that's the
  // form `nestedStatusCel` keys use after recursive extraction.
  const pattern = /\b([a-zA-Z_$][\w$]*)\.status\.([a-zA-Z_$][\w$.]*)/g;
  return expr.replace(pattern, (match, id: string, field: string) => {
    if (id === 'schema') return match;
    if (lambdaVars.has(id)) return match;
    const innerExpr = lookupNestedExpression(id, field, nestedStatusCel);
    if (innerExpr === undefined) return match;
    return `(${innerExpr})`;
  });
}

/**
 * Resolve `__KUBERNETES_REF__` markers whose resourceId is a virtual
 * nested composition baseId (rather than a real resource). Each such
 * marker is replaced inline with the inner composition's analyzed
 * expression from `nestedStatusCel`.
 *
 * The substitution rewrites the marker into a KRO-formatted segment via
 * {@link innerExprToYamlSegment}. Markers whose resourceId IS a real
 * resource ID (or `__schema__`) are left in place — they're handled by
 * downstream {@link convertKubernetesRefMarkersTocel}.
 *
 * Lookup uses the shared {@link lookupNestedExpression} so the match
 * strategy stays consistent with the rest of the resolver.
 */
function resolveNestedRefMarkers(
  str: string,
  nestedStatusCel: Record<string, string> | undefined
): string {
  if (!nestedStatusCel || Object.keys(nestedStatusCel).length === 0) {
    return str;
  }
  return str.replace(new RegExp(MARKER_PATTERN_SOURCE, 'g'), (match, id: string, path: string) => {
    if (id === '__schema__') return match;
    // Strip leading "status." since nestedStatusCel keys use the bare field path.
    const fieldPath = path.replace(/^status\./, '');
    const innerExpr = lookupNestedExpression(id, fieldPath, nestedStatusCel);
    if (innerExpr === undefined) return match;
    return innerExprToYamlSegment(innerExpr, nestedStatusCel);
  });
}

/**
 * Matches a bare CEL literal — an integer, float, boolean, or null.
 * Used by {@link innerExprToYamlSegment} to detect when a resolved
 * nested-composition value should be wrapped in `string(...)` so
 * template-literal-originated references produce string values instead
 * of the literal's natural CEL type.
 */
const BARE_LITERAL_PATTERN = /^\s*(-?\d+(?:\.\d+)?|true|false|null)\s*$/;

/**
 * Convert an inner composition's analyzed expression into a YAML-embeddable
 * segment. Recursively resolves nested references within the inner expression
 * and produces the appropriate KRO format.
 *
 * **Called from the marker-substitution path** (`resolveNestedRefMarkers`),
 * which runs when the user wrote a template literal that coerced a nested
 * composition proxy into a marker string (e.g., `` `${stack.status.cachePort}` ``).
 * The template literal is the user's explicit signal that they want a
 * STRING value — so when the resolved expression is a bare literal
 * (number, boolean, null), we wrap it with `string(...)` so KRO's CEL
 * evaluation produces a string matching the user's intent.
 *
 * The direct-ref path ({@link generateCelExpression} → {@link finalizeCelForKro})
 * deliberately does NOT apply this wrapping — a direct assignment like
 * `replicas: stack.status.someCount` should preserve the natural numeric
 * type because the destination field expects a number.
 */
function innerExprToYamlSegment(
  innerExpr: string,
  nestedStatusCel: Record<string, string>
): string {
  // Recursively resolve any further nested refs the inner expression itself
  // contains (multi-level nesting).
  const resolved = resolveNestedCompositionRefs(innerExpr, nestedStatusCel);
  if (resolved.includes('__KUBERNETES_REF_')) {
    // Marker-laden — convert to mixed-template form.
    return convertKubernetesRefMarkersTocel(resolved);
  }
  if (resolved.includes('${')) {
    // Already a KRO template (from Cel.template) — pass through.
    return resolved;
  }
  // Bare literal reached via a template-literal coercion — wrap with
  // `string(...)` so KRO evaluates it to a string value. This matches
  // direct-mode JS semantics (`${6379}` stringifies to `"6379"`) and
  // prevents type-mismatch errors when the literal is used in a
  // string-typed context like env var values.
  if (BARE_LITERAL_PATTERN.test(resolved)) {
    return `\${string(${resolved.trim()})}`;
  }
  // Plain CEL — wrap in ${...}.
  return `\${${resolved}}`;
}

/**
 * Produce the final KRO CEL form for a nested-composition value, with all
 * nested references substituted in and all schema markers converted to
 * mixed-template form.
 *
 * The return value is always a valid KRO expression string ready to be
 * embedded directly into a YAML value position (resource template field,
 * status CEL expression). Three cases are handled:
 *
 *  - Marker-laden input (from a template literal) → converted to KRO
 *    mixed-template form via {@link convertKubernetesRefMarkersTocel}.
 *  - Input that already contains `${…}` segments (from a `Cel.template()`
 *    call, for example) → returned as-is; assumed to be in KRO form.
 *  - Plain-CEL input (raw CEL with no markers or `${…}`) → wrapped in
 *    `${…}` so KRO recognizes it as an expression to evaluate.
 */
export function finalizeCelForKro(
  expr: string,
  nestedStatusCel: Record<string, string> | undefined,
  context?: SerializationContext
): string {
  const resolved = resolveNestedCompositionRefs(expr, nestedStatusCel);
  if (resolved.includes('__KUBERNETES_REF_')) {
    return convertKubernetesRefMarkersTocel(resolved, context);
  }
  if (resolved.includes('${')) {
    // Already contains KRO template placeholders — pass through.
    return resolved;
  }
  return `\${${resolved}}`;
}

// ---------------------------------------------------------------------------
// __KUBERNETES_REF__ marker → KRO CEL conversion
// ---------------------------------------------------------------------------

/**
 * Convert `__KUBERNETES_REF__` markers embedded in a string to CEL
 * expressions in KRO mixed-template form.
 *
 * These markers are created when schema proxy values are used in
 * template literals, e.g.:
 *
 * - `__KUBERNETES_REF___schema___spec.name__-policy`
 *   → `${string(schema.spec.name)}-policy`
 *
 * Single-reference inputs use a fast path that avoids the `string(…)`
 * wrapper and supports `has()/omit()` for optional schema fields. Mixed
 * inputs always wrap each reference in `${string(…)}` so KRO accepts
 * non-string types in string contexts (ConfigMap data values, env var
 * values).
 */
function convertKubernetesRefMarkersTocel(str: string, context?: SerializationContext): string {
  // Fast-path: entire string is a single reference.
  const singleRefMatch = MARKER_PATTERN_FULL.exec(str);
  if (singleRefMatch) {
    const [, resourceId, fieldPath] = singleRefMatch;
    const celPath = markerToCelPath(resourceId!, fieldPath!);
    // Single-ref: safe to wrap with has()/omit() for optional schema fields.
    const body = maybeWrapWithOmit(celPath, false, context?.omitFields);
    return `\${${body}}`;
  }

  // Mixed content → KRO mixed-template format: literal${string(ref)}literal
  // Each ${…} is independently evaluated. We wrap in string() so KRO's type
  // validator accepts non-string types (booleans, numbers) in string contexts
  // like ConfigMap data values.
  //
  // Mixed templates produce STRING values (not fields), so has()/omit() wrapping
  // is intentionally NOT applied here — omit() operates at the YAML field level,
  // and mixing it into a concatenation would be a type error.
  let result = '';
  let lastIndex = 0;

  // Fresh global instance per call — no shared lastIndex state.
  for (const match of str.matchAll(new RegExp(MARKER_PATTERN_SOURCE, 'g'))) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      result += str.slice(lastIndex, idx);
    }
    const [, resourceId, fieldPath] = match;
    result += `\${string(${markerToCelPath(resourceId!, fieldPath!)})}`;
    lastIndex = idx + match[0].length;
  }

  if (lastIndex < str.length) {
    result += str.slice(lastIndex);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Recursive resource reference processing
// ---------------------------------------------------------------------------

/**
 * Recursively replace all {@link KubernetesRef} objects with CEL expressions
 * for Kro YAML output.
 *
 * This is the **only** function that should perform this transformation.
 */
export function processResourceReferences(obj: unknown, context?: SerializationContext): unknown {
  if (isKubernetesRef(obj)) {
    return generateCelExpression(obj, context);
  }

  if (isCelExpression(obj)) {
    if (obj.__isTemplate) {
      // Template expressions from Cel.template() are already in Kro's mixed-template
      // format (e.g. "http://${schema.spec.name}.${service.metadata.namespace}").
      // Pass them through as-is — do NOT convert to CEL concat or re-wrap.
      return obj.expression;
    }
    // Bare CelExpression — may be a single schema.spec.X reference (possibly
    // wrapped in `string(...)`). Apply omit() wrapping only when the whole
    // expression is exactly one schema.spec.<field> (or string() of one),
    // and <field> is a top-level optional field.
    const expr = obj.expression;
    const bareField = /^schema\.spec\.([A-Za-z_$][\w$]*)$/.exec(expr)?.[1];
    if (bareField && context?.omitFields?.has(bareField)) {
      return `\${${maybeWrapWithOmit(expr, false, context.omitFields)}}`;
    }
    const stringField = /^string\(schema\.spec\.([A-Za-z_$][\w$]*)\)$/.exec(expr)?.[1];
    if (stringField && context?.omitFields?.has(stringField)) {
      const innerPath = `schema.spec.${stringField}`;
      return `\${${maybeWrapWithOmit(innerPath, true, context.omitFields)}}`;
    }
    return `\${${expr}}`;
  }

  // Strings containing __KUBERNETES_REF__ markers from template literals.
  // First resolve any nested-composition references — markers produced by
  // `createKubernetesRefProxy` use a virtual baseId as the resourceId,
  // and that baseId only resolves via `nestedStatusCel`. After that, any
  // remaining markers (schema refs and direct resource refs) are converted
  // to KRO mixed-template form.
  if (typeof obj === 'string' && obj.includes('__KUBERNETES_REF_')) {
    const resolved = resolveNestedRefMarkers(obj, context?.nestedStatusCel);
    if (resolved.includes('__KUBERNETES_REF_')) {
      return convertKubernetesRefMarkersTocel(resolved, context);
    }
    // All markers were resolved through nestedStatusCel — the result is
    // pure literal text or KRO-formatted CEL. Pass it through.
    return resolved;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => processResourceReferences(item, context));
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      // Exclude hidden resourceId property and id field from the final template
      if (key === '__resourceId' || key === 'id') continue;
      result[key] = processResourceReferences(value, context);
    }

    // Preserve resource metadata (resourceId, readinessEvaluator, etc.) via WeakMap
    // Also migrates legacy non-enumerable properties from source
    copyResourceMetadata(obj, result);

    return result;
  }

  return obj;
}

// ---------------------------------------------------------------------------
// Status-mapping serialization
// ---------------------------------------------------------------------------

/**
 * Serialize user-defined status mappings to CEL expressions for Kro schema.
 *
 * Only processes dynamic fields that require Kro resolution.
 */
export function serializeStatusMappingsToCel(
  statusMappings: Record<string, unknown>,
  nestedStatusCel?: Record<string, string>,
  resourceIds?: Set<string>
): Record<string, string | Record<string, unknown>> {
  logger.debug('Serializing status mappings to CEL', {
    fieldCount: Object.keys(statusMappings).length,
    hasNestedStatusCel: !!nestedStatusCel,
    nestedStatusCelKeys: nestedStatusCel ? Object.keys(nestedStatusCel) : [],
  });
  const celExpressions: Record<string, string | Record<string, unknown>> = {};

  /**
   * Rewrite `schema.spec.*` references inside a resolved CEL expression so
   * the result is valid KRO status CEL. KRO does not accept `schema.spec.*`
   * in status CEL, so we apply two rewrites:
   *
   *  - `schema.spec.X.Y.orValue(Z)` → `Z` (substitute the default)
   *  - `schema.spec.X.Y` → `X.spec.Y` iff `X` is a known resource ID
   *    (routes the reference to the deployed resource's spec field)
   *
   * Unknown schema references are left intact; the KRO factory's deploy-
   * time hydration handles them.
   */
  function rewriteSchemaRefsForKroStatus(expr: string): string {
    let out = expr.replace(
      /schema\.spec\.[a-zA-Z0-9_.]+\.orValue\(([^)]+)\)/g,
      '$1'
    );
    out = out.replace(
      /schema\.spec\.([a-zA-Z0-9]+)\.([a-zA-Z0-9.]+)/g,
      (_match, firstSegment, rest) => {
        if (resourceIds?.has(firstSegment)) {
          return `${firstSegment}.spec.${rest}`;
        }
        return _match;
      }
    );
    return out;
  }

  /**
   * Compose the inner-expression resolution + KRO-status finalization
   * pipeline used by both the KubernetesRef and CelExpression branches.
   * Centralized here so the two branches don't drift on what "produce
   * KRO status CEL from a resolved expression" means.
   */
  function statusFieldFromExpression(expr: string): string {
    const resolved = resolveNestedCompositionRefs(expr, nestedStatusCel);
    if (resolved.includes('__KUBERNETES_REF_')) {
      // Marker-laden — use mixed-template form.
      return convertKubernetesRefMarkersTocel(resolved);
    }
    return `\${${rewriteSchemaRefsForKroStatus(resolved)}}`;
  }

  function serializeValue(value: unknown): string | Record<string, unknown> {
    if (isKubernetesRef(value)) {
      const ref = value as KubernetesRef<unknown> & { __nestedComposition?: boolean };

      // For nested composition status references, look up the inner
      // composition's analyzed CEL via the shared resolver and finalize
      // it for KRO status emission.
      if (ref.__nestedComposition && nestedStatusCel) {
        const fieldName = ref.fieldPath.replace(/^status\./, '');
        const innerExpr = lookupNestedExpression(ref.resourceId, fieldName, nestedStatusCel);
        if (innerExpr !== undefined) {
          return statusFieldFromExpression(innerExpr);
        }
      }

      // Unresolved nested composition ref — emit as-is for backward
      // compatibility. Downstream validation will flag it if the virtual
      // id doesn't correspond to a real resource.
      return `\${${ref.resourceId}.${ref.fieldPath}}`;
    }

    if (isCelExpression(value)) {
      if (value.__isTemplate) {
        return value.expression;
      }
      return statusFieldFromExpression(value.expression);
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nestedExpressions: Record<string, unknown> = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        nestedExpressions[key] = serializeValue(nestedValue);
      }
      return nestedExpressions;
    }

    if (typeof value === 'string') {
      if (value.includes('__KUBERNETES_REF_')) {
        // Resolve nested refs first (substitution is a no-op on pure marker
        // strings but handles mixed forms), then convert markers to KRO CEL.
        const resolved = resolveNestedCompositionRefs(value, nestedStatusCel);
        return convertKubernetesRefMarkersTocel(resolved);
      }
      return `\${"${value}"}`;
    }
    if (typeof value === 'number') {
      return `\${${value}}`;
    }
    if (typeof value === 'boolean') {
      return `\${${value}}`;
    }

    return `\${""}`;
  }

  for (const [fieldName, fieldValue] of Object.entries(statusMappings)) {
    // Skip internal metadata fields — these are consumed during
    // serialization, not emitted as status fields.
    if (fieldName.startsWith('__')) continue;
    celExpressions[fieldName] = serializeValue(fieldValue);
  }

  return celExpressions;
}

/**
 * Check if `prefix` is a camelCase word prefix of `target`.
 *
 * A valid prefix must end at a camelCase word boundary in the target —
 * the character after the prefix must be uppercase (start of a new word)
 * or the prefix must exhaust the target.
 *
 * Examples:
 *   isCamelCasePrefix('inngest', 'inngestBootstrap') → true  (B is uppercase)
 *   isCamelCasePrefix('db', 'database')              → false (a is lowercase)
 *   isCamelCasePrefix('cache', 'cacheService')       → true  (S is uppercase)
 */
function isCamelCasePrefix(prefix: string, target: string): boolean {
  if (!target.startsWith(prefix)) return false;
  if (prefix.length === target.length) return true;
  // Character after the prefix must be uppercase (camelCase word boundary)
  return /[A-Z]/.test(target[prefix.length]!);
}
