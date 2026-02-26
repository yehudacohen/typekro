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
import type { KubernetesRef } from '../types/common.js';
import type { SerializationContext } from '../types/serialization.js';

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
 * This is the authoritative implementation — {@link generateCelReference}
 * is an alias kept for backward-compatibility.
 */
export function getInnerCelPath(ref: KubernetesRef<unknown>): string {
  const resourceId = ref.resourceId === '__schema__' ? 'schema' : ref.resourceId;
  return `${resourceId}.${ref.fieldPath}`;
}

/**
 * Alias for {@link getInnerCelPath} — kept for backward-compatibility.
 *
 * @deprecated Prefer {@link getInnerCelPath}.
 */
export const generateCelReference = getInnerCelPath;

// ---------------------------------------------------------------------------
// Template → CEL concatenation
// ---------------------------------------------------------------------------

/**
 * Convert a template string with `${...}` placeholders to a CEL concatenation
 * expression.
 *
 * @example
 * ```
 * convertTemplateToCelConcat("https://${schema.spec.hostname}")
 * // → '"https://" + schema.spec.hostname'
 * ```
 */
function convertTemplateToCelConcat(templateStr: string): string {
  const parts: string[] = [];
  let currentPos = 0;

  const regex = /\$\{([^}]+)\}/g;
  let match: RegExpExecArray | null = regex.exec(templateStr);

  while (match !== null) {
    if (match.index > currentPos) {
      const literalPart = templateStr.slice(currentPos, match.index);
      if (literalPart) {
        parts.push(`"${literalPart}"`);
      }
    }

    parts.push(match[1] || '');
    currentPos = match.index + match[0].length;
    match = regex.exec(templateStr);
  }

  if (currentPos < templateStr.length) {
    const literalPart = templateStr.slice(currentPos);
    if (literalPart) {
      parts.push(`"${literalPart}"`);
    }
  }

  return parts.join(' + ');
}

// ---------------------------------------------------------------------------
// Single-ref → CEL
// ---------------------------------------------------------------------------

/**
 * Wrap a {@link KubernetesRef} in `${…}` for Kro YAML output.
 */
function generateCelExpression(
  ref: KubernetesRef<unknown>,
  _context?: SerializationContext
): string {
  const expression = getInnerCelPath(ref);
  return `\${${expression}}`;
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
 *   → `${schema.spec.name + "-policy"}`
 *
 * Pattern: `__KUBERNETES_REF_{resourceId}_{fieldPath}__`
 * For schema: `__KUBERNETES_REF___schema___{fieldPath}__`
 */
function convertKubernetesRefMarkersTocel(str: string): string {
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
    return `\${${celPath}}`;
  }

  // Mixed content → CEL concatenation
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  refPattern.lastIndex = 0;
  match = refPattern.exec(str);
  while (match !== null) {
    if (match.index > lastIndex) {
      const textBefore = str.slice(lastIndex, match.index);
      parts.push(`"${textBefore}"`);
    }

    const [, resourceId, fieldPath] = match;
    const celPath =
      resourceId === '__schema__' ? `schema.${fieldPath}` : `${resourceId}.${fieldPath}`;
    parts.push(celPath);

    lastIndex = match.index + match[0].length;
    match = refPattern.exec(str);
  }

  if (lastIndex < str.length) {
    const textAfter = str.slice(lastIndex);
    parts.push(`"${textAfter}"`);
  }

  if (parts.length === 1) {
    return `\${${parts[0]}}`;
  }

  return `\${${parts.join(' + ')}}`;
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
    if ((obj as unknown as Record<string, unknown>).__isTemplate) {
      const templateExpr = obj.expression;
      const celExpression = convertTemplateToCelConcat(templateExpr);
      return `\${${celExpression}}`;
    }
    return `\${${obj.expression}}`;
  }

  // Strings containing __KUBERNETES_REF__ markers from template literals
  if (typeof obj === 'string' && obj.includes('__KUBERNETES_REF_')) {
    return convertKubernetesRefMarkersTocel(obj);
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

    // Preserve the readinessEvaluator function if it exists (non-enumerable)
    const originalObj = obj as { readinessEvaluator?: (...args: unknown[]) => unknown };
    if (originalObj.readinessEvaluator && typeof originalObj.readinessEvaluator === 'function') {
      Object.defineProperty(result, 'readinessEvaluator', {
        value: originalObj.readinessEvaluator,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }

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
  statusMappings: Record<string, unknown>
): Record<string, string> {
  const celExpressions: Record<string, string> = {};

  function serializeValue(value: unknown): string {
    if (isKubernetesRef(value)) {
      return `\${${(value as KubernetesRef<unknown>).resourceId}.${(value as KubernetesRef<unknown>).fieldPath}}`;
    }

    if (isCelExpression(value)) {
      if ((value as unknown as Record<string, unknown>).__isTemplate) {
        const templateExpr = (value as { expression: string }).expression;
        const celExpression = convertTemplateToCelConcat(templateExpr);
        return `\${${celExpression}}`;
      }
      return `\${${(value as { expression: string }).expression}}`;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nestedExpressions: Record<string, string> = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        nestedExpressions[key] = serializeValue(nestedValue);
      }
      return nestedExpressions as unknown as string;
    }

    if (typeof value === 'string') {
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
    celExpressions[fieldName] = serializeValue(fieldValue);
  }

  return celExpressions;
}
