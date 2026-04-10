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
 * If `celPath` is exactly `schema.spec.<field>` for a top-level optional
 * field listed in the context's omit set, wrap it with KRO 0.9+
 * `has(...) ? ... : omit()`. Otherwise return it unchanged.
 *
 * The wrapper is only applied to single-ref expressions — never to mixed
 * templates like `${string(schema.spec.name)}-suffix` because those
 * produce string values, not fields, and omit() operates at the field
 * level. Sub-path refs (`schema.spec.env.FOO`) are also not wrapped;
 * omit() removes the containing field, so the wrapper must target the
 * top-level optional field (`schema.spec.env`) and not its children.
 */
function maybeWrapWithOmit(
  celPath: string,
  stringWrap: boolean,
  omitFields: ReadonlySet<string> | undefined
): string {
  const value = stringWrap ? `string(${celPath})` : celPath;
  if (!omitFields || omitFields.size === 0) return value;
  // Top-level schema.spec.<field> with no dotted subpath
  const match = /^schema\.spec\.([A-Za-z_$][\w$]*)$/.exec(celPath);
  const field = match?.[1];
  if (!field || !omitFields.has(field)) return value;
  return `has(${celPath}) ? ${value} : omit()`;
}

/**
 * Wrap a {@link KubernetesRef} in `${…}` for Kro YAML output.
 *
 * When the ref points to a nested composition's virtual status ID
 * (e.g., `innerService1.status.serviceUrl`), resolves it to the
 * actual inner CEL expression using `context.nestedStatusCel`.
 */
function generateCelExpression(
  ref: KubernetesRef<unknown>,
  context?: SerializationContext
): string {
  // Check if this is a nested composition status reference that should
  // be inlined. Virtual IDs like "webAppWithProcessing1" don't exist
  // as resources in the KRO RGD — the real CEL must be substituted.
  if (context?.nestedStatusCel && (ref as { __nestedComposition?: boolean }).__nestedComposition) {
    const fieldName = ref.fieldPath.replace(/^status\./, '');
    const exactKey = `__nestedStatus:${ref.resourceId}:${fieldName}`;
    if (context.nestedStatusCel[exactKey]) {
      return `\${${context.nestedStatusCel[exactKey]}}`;
    }
    // Try base-name match (strip trailing digits)
    const refBase = ref.resourceId.replace(/\d+$/, '');
    for (const [key, cel] of Object.entries(context.nestedStatusCel)) {
      const parts = key.split(':');
      if (parts.length !== 3 || parts[2] !== fieldName) continue;
      const keyBase = parts[1]!.replace(/\d+$/, '');
      if (refBase === keyBase) {
        return `\${${cel}}`;
      }
    }
  }

  const expression = getInnerCelPath(ref);
  const body = maybeWrapWithOmit(expression, false, context?.omitFields);
  return `\${${body}}`;
}

// ---------------------------------------------------------------------------
// __KUBERNETES_REF__ marker conversion
// ---------------------------------------------------------------------------

/**
 * Convert `__KUBERNETES_REF__` markers embedded in a string to CEL
 * expressions.
 *
 * These markers are created when schema proxy values are used in
 * template literals, e.g.:
 *
 * - `__KUBERNETES_REF___schema___spec.name__-policy`
 *   → `${string(schema.spec.name)}-policy`
 *
 * Pattern: `__KUBERNETES_REF_{resourceId}_{fieldPath}__`
 * For schema: `__KUBERNETES_REF___schema___{fieldPath}__`
 */
function convertKubernetesRefMarkersTocel(str: string, context?: SerializationContext): string {
  // Pattern handles both regular resource IDs and __schema__ (which has underscores)
  // The field path is matched with [a-zA-Z0-9.$]+ which captures dot-separated identifiers
  // like "spec.name", "status.readyReplicas", or "spec.workers.$item.name"
  const refPattern = /__KUBERNETES_REF_(__schema__|[^_]+)_([a-zA-Z0-9.$]+)__/g;

  // Fast-path: entire string is a single reference
  const singleRefMatch = str.match(/^__KUBERNETES_REF_(__schema__|[^_]+)_([a-zA-Z0-9.$]+)__$/);
  if (singleRefMatch) {
    const [, resourceId, fieldPath] = singleRefMatch;
    const celPath =
      resourceId === '__schema__' ? `schema.${fieldPath}` : `${resourceId}.${fieldPath}`;
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
  let match: RegExpExecArray | null;

  refPattern.lastIndex = 0;
  match = refPattern.exec(str);
  while (match !== null) {
    if (match.index > lastIndex) {
      result += str.slice(lastIndex, match.index);
    }

    const [, resourceId, fieldPath] = match;
    const celPath =
      resourceId === '__schema__' ? `schema.${fieldPath}` : `${resourceId}.${fieldPath}`;
    result += `\${string(${celPath})}`;

    lastIndex = match.index + match[0].length;
    match = refPattern.exec(str);
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

  // Strings containing __KUBERNETES_REF__ markers from template literals
  if (typeof obj === 'string' && obj.includes('__KUBERNETES_REF_')) {
    return convertKubernetesRefMarkersTocel(obj, context);
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

  function serializeValue(value: unknown): string | Record<string, unknown> {
    if (isKubernetesRef(value)) {
      const ref = value as KubernetesRef<unknown> & { __nestedComposition?: boolean };

      // For nested composition status references, inline the inner composition's
      // actual CEL expression instead of referencing the virtual composition ID.
      if (ref.__nestedComposition && nestedStatusCel) {
        const fieldName = ref.fieldPath.replace(/^status\./, '');
        // Try exact match
        const exactKey = `__nestedStatus:${ref.resourceId}:${fieldName}`;
        logger.debug('Resolving nested composition KubernetesRef', {
          resourceId: ref.resourceId,
          fieldPath: ref.fieldPath,
          fieldName,
          exactKey,
          hasExactMatch: !!nestedStatusCel[exactKey],
        });
        if (nestedStatusCel[exactKey]) {
          return `\${${nestedStatusCel[exactKey]}}`;
        }
        // Try base-name match: strip trailing digits and compare.
        // The expression may use 'nestedService2' while the key has 'nestedService1'.
        // Also try prefix match for variable name → composition baseId mapping.
        const refBase = ref.resourceId.replace(/\d+$/, '');
        for (const [key, cel] of Object.entries(nestedStatusCel)) {
          const parts = key.split(':');
          if (parts.length !== 3 || parts[2] !== fieldName) continue;
          const keyBase = parts[1]!.replace(/\d+$/, '');
          if (refBase === keyBase) {
            return `\${${cel}}`;
          }
          if (isCamelCasePrefix(refBase, keyBase) || isCamelCasePrefix(keyBase, refBase)) {
            logger.warn('Nested status CEL resolved via prefix match (not exact)', {
              refResourceId: ref.resourceId, matchedKey: key, fieldName,
            });
            return `\${${cel}}`;
          }
        }
      }

      // Nested composition ref that couldn't be inlined — the virtual ID
      // doesn't exist in the KRO RGD. Emit as-is; the validator will warn.
      // When nestedStatusCel IS available but didn't match, this is a real
      // missing mapping. When it's unavailable (simple compositions without
      // inner status CEL), the ref passes through for backward compatibility.
      return `\${${ref.resourceId}.${ref.fieldPath}}`;
    }

    if (isCelExpression(value)) {
      if (value.__isTemplate) {
        return value.expression;
      }

      // Replace nested composition status references with the inner composition's
      // actual CEL expression. Handles both standalone refs and refs embedded in
      // larger expressions (e.g., `... && inngest.status.ready`).
      //
      // The fn.toString analysis uses variable names (e.g., `inngest`) but the
      // nested status CEL keys use baseIds with instance numbers (e.g.,
      // `inngestBootstrap1`). We try the exact match first, then scan for keys
      // that start with the variable name.
      let expr = value.expression;
      if (nestedStatusCel) {
        expr = expr.replace(/(\w+)\.status\.([\w.]+)/g, (_match, compId, field) => {
          // Try exact match first
          const exactKey = `__nestedStatus:${compId}:${field}`;
          if (nestedStatusCel[exactKey]) {
            return `(${nestedStatusCel[exactKey]})`;
          }
          // Try base-name match: strip trailing digits and compare.
          // Also try prefix match: the fn.toString variable name (e.g., `inngest`)
          // may be a prefix of the nested composition's baseId (e.g., `inngestBootstrap`).
          const compIdBase = compId.replace(/\d+$/, '');
          for (const [key, cel] of Object.entries(nestedStatusCel)) {
            const parts = key.split(':');
            if (parts.length !== 3 || parts[2] !== field) continue;
            const keyBase = parts[1]!.replace(/\d+$/, '');
            if (compIdBase === keyBase) {
              return `(${cel})`;
            }
            if (isCamelCasePrefix(compIdBase, keyBase) || isCamelCasePrefix(keyBase, compIdBase)) {
              logger.warn('Nested status CEL expression resolved via prefix match', {
                compId, matchedKey: key, field,
              });
              return `(${cel})`;
            }
          }
          // Last resort: the variable name (e.g., "stack") has no structural
          // relationship to the composition baseId (e.g., "webAppWithProcessing1").
          // Try matching by field name alone — if exactly one nested composition
          // provides this field, use it.
          const fieldMatches = Object.entries(nestedStatusCel).filter(([k]) => {
            const p = k.split(':');
            return p.length === 3 && p[2] === field;
          });
          if (fieldMatches.length === 1) {
            logger.debug('Nested status CEL resolved by field-name-only match', {
              compId, field, matchedKey: fieldMatches[0]![0],
            });
            return `(${fieldMatches[0]![1]})`;
          }
          return `${compId}.status.${field}`;
        });
      }

      // KRO status CEL cannot reference `schema.spec.*` — only resource IDs.
      // Replace schema references with their .orValue() defaults, or with the
      // resource's own spec field if a mapping is available.
      // Pattern: `schema.spec.X.Y.orValue(Z)` → `Z` (use the default)
      expr = expr.replace(
        /schema\.spec\.[a-zA-Z0-9_.]+\.orValue\(([^)]+)\)/g,
        '$1'
      );
      // For bare `schema.spec.X.Y` (no orValue): map to the resource's spec
      // field ONLY if X is a known resource ID. E.g., `schema.spec.database.instances`
      // → `database.spec.instances` when `database` is a resource in the RGD.
      // Unknown segments are left as-is (they'll be resolved at deploy time).
      expr = expr.replace(
        /schema\.spec\.([a-zA-Z0-9]+)\.([a-zA-Z0-9.]+)/g,
        (_match, firstSegment, rest) => {
          if (resourceIds?.has(firstSegment)) {
            return `${firstSegment}.spec.${rest}`;
          }
          // Not a known resource ID — keep the original schema ref.
          // This will be resolved by the KRO factory at deploy time.
          return _match;
        }
      );

      return `\${${expr}}`;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nestedExpressions: Record<string, unknown> = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        nestedExpressions[key] = serializeValue(nestedValue);
      }
      return nestedExpressions;
    }

    if (typeof value === 'string') {
      // Convert embedded __KUBERNETES_REF__ markers to CEL expressions
      if (value.includes('__KUBERNETES_REF_')) {
        return convertKubernetesRefMarkersTocel(value);
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
