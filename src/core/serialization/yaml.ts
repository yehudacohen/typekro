/**
 * YAML generation functionality for Kro ResourceGraphDefinitions
 *
 * Supports Kro 0.9.1+ ResourceGraphDefinition serialization, including
 * forEach, includeWhen, readyWhen, externalRef, mixed-template CEL, omit(),
 * schema group, and allowBreakingChanges annotation.
 */

import * as yaml from 'js-yaml';
import { getMetadataField } from '../metadata/resource-metadata.js';
import { escapeRegExp } from '../../utils/helpers.js';
import {
  extractResourceReferences,
  isCelExpression,
  isKubernetesRef,
} from '../../utils/type-guards.js';
import {
  getForEach,
  getIncludeWhen,
  getReadyWhen,
  getResourceId,
  getTemplateOverrides,
} from '../metadata/index.js';
import { generateDeterministicResourceId } from '../resources/id.js';
import type {
  KroExternalRef,
  KroResourceGraphDefinition,
  KroResourceTemplate,
  KroSimpleSchema,
  KroSimpleSchemaWithMetadata,
  ResourceDependency,
  SerializationContext,
  SerializationOptions,
} from '../types/serialization.js';
import type { KubernetesResource } from '../types.js';
import { finalizeCelForKro, getInnerCelPath, normalizeRefMarkersToCelPaths, processResourceReferences } from './cel-references.js';
import { generateKroSchema } from './schema.js';

/**
 * Read a non-enumerable property from an Enhanced resource.
 *
 * Used only for `__externalRef` which is NOT part of the WeakMap migration
 * (it's an enumerable direct-assign property). Tier 2 properties (includeWhen,
 * readyWhen, forEach, __templateOverrides) use WeakMap getters instead.
 */
function readNonEnumerable<T>(resource: KubernetesResource, key: string): T | undefined {
  return Reflect.get(resource, key) as T | undefined;
}

/**
 * Read a Tier 2 metadata property from a resource.
 * Checks WeakMap metadata first, falls back to legacy non-enumerable property.
 *
 * The fallback MUST validate the value is an array because Enhanced proxy
 * resources intercept ALL property access and return KubernetesRef proxies
 * (functions) for unknown keys. Without this guard, accessing `.includeWhen`
 * on a proxy resource would return a truthy proxy function — causing a
 * spurious self-referencing `includeWhen` condition in the Kro YAML.
 */
function readIncludeWhen(resource: KubernetesResource): unknown[] | undefined {
  const fromWeakMap = getIncludeWhen(resource);
  if (fromWeakMap) return fromWeakMap;
  const legacy = readNonEnumerable<unknown[]>(resource, 'includeWhen');
  return Array.isArray(legacy) ? legacy : undefined;
}

function readReadyWhen(resource: KubernetesResource): unknown[] | undefined {
  const fromWeakMap = getReadyWhen(resource);
  if (fromWeakMap) return fromWeakMap;
  const legacy = readNonEnumerable<unknown[]>(resource, 'readyWhen');
  return Array.isArray(legacy) ? legacy : undefined;
}

function readForEachDimensions(resource: KubernetesResource): Record<string, string>[] | undefined {
  const fromWeakMap = getForEach(resource);
  if (fromWeakMap) return fromWeakMap;
  const legacy = readNonEnumerable<Record<string, string>[]>(resource, 'forEach');
  return Array.isArray(legacy) ? legacy : undefined;
}

function readTemplateOverrides(
  resource: KubernetesResource
): Array<{ propertyPath: string; celExpression: string }> | undefined {
  return (
    getTemplateOverrides(resource) ??
    readNonEnumerable<Array<{ propertyPath: string; celExpression: string }>>(
      resource,
      '__templateOverrides'
    )
  );
}

// ---------------------------------------------------------------------------
// includeWhen → CEL conversion
// ---------------------------------------------------------------------------

/**
 * Convert a single includeWhen value to a CEL expression string.
 *
 * Accepted input types:
 *  - KubernetesRef proxy  → `${schema.spec.field}` — the field's value is
 *    used as the boolean condition. This is the semantics of the explicit
 *    `.withIncludeWhen(spec.boolField)` API: the caller is being deliberate
 *    about the field they want as the test. Callers who need a presence
 *    check on an optional field should use `Cel.has(ref)` explicitly, or
 *    write `if (spec.optional)` in the composition body (which the AST
 *    analyzer rewrites to `has(...)` automatically based on the schema).
 *  - CelExpression object → `${expression}` — use Cel.has / Cel.not /
 *    Cel.expr to build explicit conditions.
 *  - string (already CEL) → pass-through
 *  - string with __KUBERNETES_REF__ markers → convert markers to CEL
 */
function convertIncludeWhenValueToCel(value: unknown, context: SerializationContext): string | undefined {
  if (typeof value === 'string') {
    if (value.includes('__KUBERNETES_REF_')) {
      return `\${${convertRefMarkersInString(value, context)}}`;
    }
    return value;
  }

  if (isKubernetesRef(value)) {
    const celPath = normalizeRefMarkersToCelPaths(getInnerCelPath(value), context);
    return `\${${celPath}}`;
  }

  if (isCelExpression(value)) {
    return `\${${normalizeRefMarkersToCelPaths(value.expression, context)}}`;
  }

  // Fallback — coerce to string
  if (value !== undefined && value !== null) {
    return String(value);
  }
  return undefined;
}

/**
 * Resolve the includeWhen property from an Enhanced resource to an array of CEL strings.
 *
 * The stored value can be:
 *  - A single KubernetesRef / CelExpression / string
 *  - An array of the above
 *  - undefined (no condition)
 */
function resolveIncludeWhen(raw: unknown, context: SerializationContext): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;

  const items = Array.isArray(raw) ? raw : [raw];
  const celStrings: string[] = [];

  for (const item of items) {
    const cel = convertIncludeWhenValueToCel(item, context);
    if (cel) celStrings.push(cel);
  }

  return celStrings.length > 0 ? celStrings : undefined;
}

// ---------------------------------------------------------------------------
// readyWhen → CEL conversion
// ---------------------------------------------------------------------------

const READY_WHEN_CALLBACK_METHODS = new Set(['exists', 'all', 'filter', 'map', 'some', 'every']);

function findMatchingParen(source: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;

  for (let i = openIndex; i < source.length; i++) {
    const char = source[i];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function normalizeArrowBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return trimmed;

  return trimmed
    .replace(/^\{\s*(?:return\s+)?/, '')
    .replace(/;?\s*\}\s*$/, '')
    .trim();
}

function convertReadyWhenCallbackMethods(expression: string): string {
  let result = '';
  let index = 0;

  while (index < expression.length) {
    const dotIndex = expression.indexOf('.', index);
    if (dotIndex === -1) {
      result += expression.slice(index);
      break;
    }

    result += expression.slice(index, dotIndex);

    let cursor = dotIndex + 1;
    while (/\s/.test(expression[cursor] ?? '')) cursor++;

    const methodMatch = /^[a-zA-Z_$][a-zA-Z0-9_$]*/.exec(expression.slice(cursor));
    if (!methodMatch || !READY_WHEN_CALLBACK_METHODS.has(methodMatch[0])) {
      result += expression[dotIndex];
      index = dotIndex + 1;
      continue;
    }

    const method = methodMatch[0];
    cursor += method.length;
    while (/\s/.test(expression[cursor] ?? '')) cursor++;

    if (expression[cursor] !== '(') {
      result += expression[dotIndex];
      index = dotIndex + 1;
      continue;
    }

    const closeIndex = findMatchingParen(expression, cursor);
    if (closeIndex === -1) {
      result += expression[dotIndex];
      index = dotIndex + 1;
      continue;
    }

    const callbackSource = expression.slice(cursor + 1, closeIndex).trim();
    const arrowIndex = callbackSource.indexOf('=>');
    if (arrowIndex === -1) {
      result += expression.slice(dotIndex, closeIndex + 1);
      index = closeIndex + 1;
      continue;
    }

    let param = callbackSource.slice(0, arrowIndex).trim();
    param = param.replace(/^\(\s*/, '').replace(/\s*\)$/, '').trim();
    const colonIndex = param.indexOf(':');
    if (colonIndex !== -1) param = param.slice(0, colonIndex).trim();

    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(param)) {
      result += expression.slice(dotIndex, closeIndex + 1);
      index = closeIndex + 1;
      continue;
    }

    let body = normalizeArrowBody(callbackSource.slice(arrowIndex + 2));
    body = body.replace(/===/g, '==').replace(/!==/g, '!=');
    body = convertReadyWhenCallbackMethods(body);

    const celMethod = method === 'some' ? 'exists' : method === 'every' ? 'all' : method;
    result += `.${celMethod}(${param}, ${body})`;
    index = closeIndex + 1;
  }

  return result;
}

/**
 * Convert a readyWhen callback function to a CEL expression string by parsing its source.
 *
 * Strategy: use fn.toString() and simple regex/string transforms to convert
 * JavaScript expressions to CEL, replacing the callback parameter with the resource id.
 *
 * Examples:
 *   (self) => self.status.readyReplicas > 0
 *   → "web.status.readyReplicas > 0"
 *
 *   (self) => self.status.phase === 'Running'
 *   → 'app.status.phase == "Running"'
 *
 *   (self) => self.status.conditions.exists((c) => c.type === 'Ready' && c.status === 'True')
 *   → 'db.status.conditions.exists(c, c.type == "Ready" && c.status == "True")'
 */
function convertReadyWhenCallbackToCel(
  fn: (...args: unknown[]) => unknown,
  resourceId: string
): string {
  const fnStr = fn.toString();

  // Extract parameter name and body from arrow function
  // Patterns:
  //   (self) => self.status.readyReplicas > 0
  //   self => self.status.readyReplicas > 0
  //   (self) => { return self.status.readyReplicas > 0; }
  const arrowMatch = fnStr.match(
    /^\s*\(?([a-zA-Z_$][a-zA-Z0-9_$]*)\)?\s*=>\s*(?:\{\s*(?:return\s+)?)?([\s\S]+?)(?:\s*;?\s*\})?$/
  );

  let paramName: string;
  let bodyStr: string;

  if (arrowMatch?.[1] && arrowMatch[2]) {
    paramName = arrowMatch[1];
    bodyStr = arrowMatch[2].trim();
    // Remove trailing semicolons and closing braces
    bodyStr = bodyStr
      .replace(/;\s*$/, '')
      .replace(/\}\s*$/, '')
      .trim();
  } else {
    // Fallback: try regular function syntax
    const funcMatch = fnStr.match(
      /function\s*\w*\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)\s*\{\s*(?:return\s+)?([\s\S]+?);\s*\}/
    );
    if (funcMatch?.[1] && funcMatch[2]) {
      paramName = funcMatch[1];
      bodyStr = funcMatch[2].trim();
    } else {
      // Cannot parse — return as-is
      return fnStr;
    }
  }

  // Replace parameter name with resource id (word boundary to avoid substrings)
  let celExpr = bodyStr.replace(new RegExp(`\\b${escapeRegExp(paramName)}\\b`, 'g'), resourceId);

  // JS → CEL operator conversions (must happen before inner callback processing)
  celExpr = celExpr.replace(/===/g, '==');
  celExpr = celExpr.replace(/!==/g, '!=');

  // Convert JS arrow function callbacks inside CEL macros and natural JS array
  // helpers. Use a balanced scanner instead of a regex so nested parentheses in
  // predicate bodies don't truncate the callback body.
  celExpr = convertReadyWhenCallbackMethods(celExpr);

  // Convert remaining single-quoted strings to double-quoted for CEL
  celExpr = celExpr.replace(/'([^']+)'/g, '"$1"');

  return celExpr;
}

/**
 * Convert a readyWhen value to a CEL expression string.
 *
 * Accepted input types:
 *  - Function (callback)  → parse source to produce CEL
 *  - KubernetesRef proxy  → `${resourceId.fieldPath}`
 *  - CelExpression object → `${expression}`
 *  - string (already CEL) → pass-through
 */
function convertReadyWhenValueToCel(
  value: unknown,
  resourceId: string,
  hasForEach: boolean,
  context: SerializationContext
): string | undefined {
  // Callback function — parse source to extract CEL expression
  if (typeof value === 'function') {
    const baseId = hasForEach ? 'each' : resourceId;
    const celExpr = convertReadyWhenCallbackToCel(value as (...args: unknown[]) => unknown, baseId);
    return `\${${celExpr}}`;
  }

  if (isKubernetesRef(value)) {
    const celPath = normalizeRefMarkersToCelPaths(getInnerCelPath(value), context);
    return `\${${celPath}}`;
  }

  if (isCelExpression(value)) {
    return `\${${normalizeRefMarkersToCelPaths(value.expression, context)}}`;
  }

  if (typeof value === 'string') {
    if (value.includes('__KUBERNETES_REF_')) {
      const converted = convertRefMarkersInString(value, context);
      return converted.includes('${') ? converted : `\${${converted}}`;
    }
    return value;
  }

  if (value !== undefined && value !== null) {
    return String(value);
  }
  return undefined;
}

/**
 * Resolve the readyWhen property from an Enhanced resource to an array of CEL strings.
 */
function resolveReadyWhen(
  raw: unknown,
  resourceId: string,
  hasForEach: boolean,
  context: SerializationContext
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;

  const items = Array.isArray(raw) ? raw : [raw];
  const celStrings: string[] = [];

  for (const item of items) {
    const cel = convertReadyWhenValueToCel(item, resourceId, hasForEach, context);
    if (cel) celStrings.push(cel);
  }

  return celStrings.length > 0 ? celStrings : undefined;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Convert __KUBERNETES_REF__ markers in a string to plain CEL references (no ${} wrapper).
 *
 * Input:  "__KUBERNETES_REF_web_status.readyReplicas__ > 0"
 * Output: "web.status.readyReplicas > 0"
 */
function convertRefMarkersInString(str: string, context: SerializationContext): string {
  return normalizeRefMarkersToCelPaths(str, context);
}

// ---------------------------------------------------------------------------
// forEach $item sentinel substitution
// ---------------------------------------------------------------------------

/**
 * Recursively walk a template object and replace forEach sentinel references.
 *
 * During proxy-based tracing, element accesses on schema arrays produce
 * KubernetesRef field paths that include the `$item` sentinel. For example,
 * iterating `schema.spec.workers` yields refs like `schema.spec.workers.$item.name`.
 *
 * In the serialized Kro YAML these must become the forEach variable name, e.g.,
 * `worker.name` (where `worker` is the forEach dimension key).
 *
 * This function handles both:
 * - CEL expression strings wrapped in `${}`: `${schema.spec.workers.$item.name}` → `${worker.name}`
 * - Raw reference strings: `schema.spec.workers.$item.name` → `worker.name`
 * - Concatenated CEL: `${schema.spec.name + "-" + schema.spec.workers.$item}` →
 *   `${schema.spec.name + "-" + worker}`
 *
 * @param template The resource template (object, array, or primitive)
 * @param basePath The schema base path WITHOUT $item (e.g., `schema.spec.workers`)
 * @param varName  The forEach variable name (e.g., `worker`)
 */
function substituteForEachSentinels<T>(template: T, basePath: string, varName: string): T {
  if (typeof template === 'string') {
    // Replace "basePath.$item.field" with "varName.field"
    // Replace "basePath.$item" (no trailing field) with "varName"
    // The basePath may contain dots, so we escape them for the regex.
    const escaped = basePath.replace(/\./g, '\\.');
    // Match basePath.$item followed by optional .field... or end of reference
    const pattern = new RegExp(`${escaped}\\.\\$item(?:\\.([a-zA-Z0-9_.]+))?`, 'g');
    return template.replace(pattern, (_match, fieldTail: string | undefined) => {
      return fieldTail ? `${varName}.${fieldTail}` : varName;
    }) as T;
  }

  if (Array.isArray(template)) {
    return template.map((item) => substituteForEachSentinels(item, basePath, varName)) as T;
  }

  if (template !== null && typeof template === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      result[key] = substituteForEachSentinels(value, basePath, varName);
    }
    return result as T;
  }

  // Primitives (number, boolean, null, undefined) pass through unchanged
  return template;
}

/**
 * Strip orphaned `$item` sentinel references from a template.
 *
 * After forEach substitution, any remaining `$item` paths are from non-forEach
 * contexts — typically when `...spec.array` is spread into a literal array.
 * These are not valid CEL identifiers and must be collapsed to the parent
 * array reference.
 *
 * Handles both wrapped CEL (`${path.$item.field}`) and raw paths.
 * Strips `.$item` and any trailing field access, keeping just the parent path.
 */
function stripOrphanedItemSentinels<T>(template: T): T {
  if (typeof template === 'string') {
    const normalized = normalizeOptionalArrayConditional(template);
    if (normalized !== undefined) return normalized as T;
    if (!template.includes('$item')) return template;
    // Match any path segment ending with .$item optionally followed by .field
    const stripped = template.replace(/(\w[\w.]*)\.\$item(?:\.[a-zA-Z0-9_.]+)?/g, '$1');
    return (normalizeOptionalArrayConditional(stripped) ?? stripped) as T;
  }

  if (Array.isArray(template)) {
    const collapsed = collapseOrphanedArraySpreads(template);
    if (collapsed !== undefined) return collapsed as T;
    return template.map((item) => stripOrphanedItemSentinels(item)) as T;
  }

  if (template !== null && typeof template === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      result[key] = stripOrphanedItemSentinels(value);
    }
    return result as T;
  }

  return template;
}

function normalizeOptionalArrayConditional(value: string): string | undefined {
  const match = value.match(/^\$\{has\(([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\) \? (\[.*), \1\] : (\[.*\])\}$/);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const [, basePath, truthyPrefix, fallbackList] = match;
  if (`${truthyPrefix}]` !== fallbackList) return undefined;
  return `\${${fallbackList} + (has(${basePath}) ? ${basePath} : [])}`;
}

function findOrphanedItemBase(value: unknown): string | undefined {
  const serialized = JSON.stringify(value);
  return serialized?.match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.\$item/)?.[1];
}

function isDirectOrphanedItemElement(value: unknown, basePath: string): boolean {
  if (typeof value === 'string') {
    return value.includes('${') && value.includes(`${basePath}.$item`);
  }
  if (Array.isArray(value)) return value.every((item) => isDirectOrphanedItemElement(item, basePath));
  if (value && typeof value === 'object') {
    const entries = Object.values(value);
    return entries.length > 0 && entries.every((entry) => isDirectOrphanedItemElement(entry, basePath));
  }
  return false;
}

function collapseOrphanedArraySpreads(items: unknown[]): string | undefined {
  const parts: string[] = [];
  let literals: unknown[] = [];
  let sawSpread = false;

  const flushLiterals = () => {
    if (literals.length === 0) return;
    parts.push(celValueForTemplate(literals));
    literals = [];
  };

  for (const item of items) {
    const basePath = findOrphanedItemBase(item);
    if (!basePath || !isDirectOrphanedItemElement(item, basePath)) {
      literals.push(stripOrphanedItemSentinels(item));
      continue;
    }

    sawSpread = true;
    flushLiterals();
    const serialized = JSON.stringify(item) ?? '';
    parts.push(serialized.includes(`has(${basePath})`) ? `(has(${basePath}) ? ${basePath} : [])` : basePath);
  }

  if (!sawSpread) return undefined;
  flushLiterals();
  return parts.length > 0 ? `\${${parts.join(' + ')}}` : undefined;
}

function celValueForTemplate(value: unknown): string {
  if (typeof value === 'string') return celStringForTemplate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(celValueForTemplate).join(', ')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(
      ([key, entryValue]) => `${JSON.stringify(key)}: ${celValueForTemplate(entryValue)}`
    );
    return `{${entries.join(', ')}}`;
  }
  return 'null';
}

function celStringForTemplate(value: string): string {
  const fullCel = value.match(/^\$\{(.+)\}$/);
  if (fullCel?.[1]) return fullCel[1];
  if (!value.includes('${')) return JSON.stringify(value);

  const parts: string[] = [];
  let cursor = 0;
  const pattern = /\$\{([^}]+)\}/g;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(JSON.stringify(value.slice(cursor, index)));
    if (match[1]) parts.push(`string(${match[1]})`);
    cursor = index + match[0].length;
  }
  if (cursor < value.length) parts.push(JSON.stringify(value.slice(cursor)));
  return parts.length > 0 ? parts.join(' + ') : '""';
}

// ---------------------------------------------------------------------------
// Template override application
// ---------------------------------------------------------------------------

/**
 * Apply template overrides to a processed resource template.
 *
 * Template overrides are CEL expressions that should replace literal values
 * in the template. They are generated by the composition body analyzer when
 * it detects ternary expressions in factory arguments that evaluated to a
 * literal at runtime (because `===` on proxies fails).
 *
 * @param template - The processed template object (after processResourceReferences)
 * @param overrides - Array of {propertyPath, celExpression} overrides
 */
function applyTemplateOverrides(
  template: Record<string, unknown>,
  overrides: Array<{ propertyPath: string; celExpression: string }>,
  context: SerializationContext
): void {
  for (const { propertyPath, celExpression } of overrides) {
    const parts = propertyPath.split('.');
    let target: Record<string, unknown> | unknown[] | undefined = template;

    // Walk to the parent of the target property. Object-branch ternaries can
    // produce paths that only exist in the non-selected branch, so materialize
    // missing containers instead of silently dropping those overrides.
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue;
      if (!target) break;
      const next = Array.isArray(target) && /^\d+$/.test(part)
        ? target[Number(part)]
        : (target as Record<string, unknown>)[part];
      if (next && typeof next === 'object') {
        target = next as Record<string, unknown> | unknown[];
      } else {
        if (!celExpression.includes('omit()')) {
          target = undefined;
          break;
        }
        const nextPart = parts[i + 1];
        const container: Record<string, unknown> | unknown[] = nextPart && /^\d+$/.test(nextPart) ? [] : {};
        if (Array.isArray(target) && /^\d+$/.test(part)) {
          target[Number(part)] = container;
        } else {
          (target as Record<string, unknown>)[part] = container;
        }
        target = container;
      }
    }

    if (!target) continue;

    const lastKey = parts[parts.length - 1];
    if (lastKey) {
      const finalized = finalizeCelForKro(celExpression, context.nestedStatusCel, context);
      if (Array.isArray(target) && /^\d+$/.test(lastKey)) {
        target[Number(lastKey)] = finalized;
      } else {
        (target as Record<string, unknown>)[lastKey] = finalized;
      }
    }
  }
}

function toIdSuffix(resourceId: string): string {
  return resourceId.charAt(0).toUpperCase() + resourceId.slice(1);
}

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function deriveResourceIdAliases(resourceId: string): string[] {
  const aliases: string[] = [];
  for (const match of resourceId.matchAll(/\d+/g)) {
    const suffix = resourceId.slice((match.index ?? 0) + match[0].length);
    if (suffix && /^[A-Z]/.test(suffix)) {
      aliases.push(suffix.charAt(0).toLowerCase() + suffix.slice(1));
    }
  }
  return aliases;
}

function resolveDependsOnResourceId(
  dependencyId: string,
  currentResourceId: string,
  knownResourceIds?: ReadonlySet<string>
): string {
  if (!knownResourceIds || knownResourceIds.has(dependencyId)) {
    return dependencyId;
  }

  const suffix = toIdSuffix(dependencyId);
  const candidates = Array.from(knownResourceIds).filter((resourceId) =>
    resourceId.endsWith(suffix)
  );

  if (candidates.length === 0) {
    return dependencyId;
  }

  if (candidates.length === 1) {
    return candidates[0] ?? dependencyId;
  }

  return candidates.sort(
    (left, right) => commonPrefixLength(right, currentResourceId) - commonPrefixLength(left, currentResourceId)
  )[0] ?? dependencyId;
}

// ---------------------------------------------------------------------------
// Resource entry builder
// ---------------------------------------------------------------------------

/**
 * Build a KroResourceTemplate entry for a single resource.
 *
 * - If the resource has `__externalRef`, emits `externalRef` instead of `template`.
 * - Reads non-enumerable `includeWhen` and `readyWhen` arrays and converts to CEL.
 * - Reads non-enumerable `forEach` dimensions (populated by proxy layer / AST analysis).
 * - Reads non-enumerable `__templateOverrides` for ternary CEL substitution.
 */
function buildResourceEntry(
  id: string,
  resource: KubernetesResource,
  context: SerializationContext
): KroResourceTemplate {
  const isExternalRef = readNonEnumerable<boolean>(resource, '__externalRef');

  if (isExternalRef) {
    const forEach = readForEachDimensions(resource);
    if (forEach && forEach.length > 0) {
      throw new Error(`Resource '${id}' cannot use both externalRef and forEach`);
    }

    // externalRef resources: emit externalRef metadata, NOT template.
    // Use Object.getOwnPropertyDescriptor to bypass the Enhanced proxy's get trap
    // and read the actual underlying values. Going through the proxy would cause
    // metadata.namespace to return a KubernetesRef function proxy when namespace
    // doesn't exist, which yaml.dump cannot serialize.
    const apiVersionDesc = Object.getOwnPropertyDescriptor(resource, 'apiVersion');
    const kindDesc = Object.getOwnPropertyDescriptor(resource, 'kind');
    const metadataDesc = Object.getOwnPropertyDescriptor(resource, 'metadata');
    const rawMeta = metadataDesc?.value as Record<string, unknown> | undefined;

    // Process marker strings in metadata values to convert them to CEL expressions.
    // externalRef metadata.name may contain __KUBERNETES_REF__ markers from template
    // literals (e.g., `${spec.name}-db-${dbOwner}`).
    const rawName = rawMeta && 'name' in rawMeta ? rawMeta.name : '';
    const rawNamespace = rawMeta && 'namespace' in rawMeta ? rawMeta.namespace : undefined;
    const processedName = processResourceReferences(rawName, context);
    const processedNamespace = processResourceReferences(rawNamespace, context);
    const extRef: KroExternalRef = {
      apiVersion: String(apiVersionDesc?.value ?? ''),
      kind: String(kindDesc?.value ?? ''),
      metadata: {
        name: String(processedName ?? ''),
        ...(rawNamespace !== undefined && processedNamespace !== undefined && {
          namespace: String(processedNamespace),
        }),
      },
    };

    const entry: KroResourceTemplate = { id, externalRef: extRef };

    // externalRef can still have includeWhen (but NOT forEach — mutually exclusive)
    const rawIncludeWhen = readIncludeWhen(resource);
    const includeWhen = resolveIncludeWhen(rawIncludeWhen, context);
    if (includeWhen) {
      entry.includeWhen = includeWhen;
    }

    return entry;
  }

  // Regular resource: emit template
  const entry: KroResourceTemplate = {
    id,
    template: processResourceReferences(resource, context),
  };

  // forEach — collection dimensions (populated by proxy layer / AST analysis)
  const forEach = readForEachDimensions(resource);
  const hasForEach = forEach !== undefined && forEach.length > 0;
  if (hasForEach) {
    entry.forEach = forEach;

    // Replace $item sentinel references in the template with actual forEach variable names.
    // During runtime, schema array element proxies produce refs with `$item` in the field path
    // (e.g., `schema.spec.workers.$item.name`). We replace these with the forEach variable name
    // (e.g., `worker.name`) based on the forEach dimensions.
    if (entry.template) {
      for (const dimension of forEach) {
        const [varName, sourceExpr] = Object.entries(dimension)[0] ?? [];
        if (varName && sourceExpr) {
          // sourceExpr is like "${schema.spec.workers}" or "${schema.spec.workers.filter(...)}"
          // Extract the base path: "schema.spec.workers"
          const basePath = sourceExpr
            .replace(/^\$\{/, '')
            .replace(/\}$/, '')
            .replace(/\.filter\(.*$/, '')
            .replace(/\.map\(.*$/, '');
          // Replace "basePath.$item.X" with "varName.X" and "basePath.$item" with "varName"
          entry.template = substituteForEachSentinels(entry.template, basePath, varName);
        }
      }
    }
  }

  // Orphaned $item sentinels — strip remaining $item references from non-forEach
  // resources. When a schema array proxy is spread (`...spec.envFrom`) into a
  // literal array, the proxy iterator yields $item-marked refs that never get
  // matched by a forEach dimension. Collapse `path.$item.field` → `path` so
  // the CEL expression references the whole array (valid CEL), rather than
  // leaving `$item` which is not a valid CEL identifier.
  if (entry.template && !hasForEach) {
    entry.template = stripOrphanedItemSentinels(entry.template);
  }

  // Template overrides — ternary expressions in factory args that evaluated to
  // literals at runtime but should be CEL conditionals in the output.
  const templateOverrides = readTemplateOverrides(resource);
  if (templateOverrides && templateOverrides.length > 0 && entry.template) {
    applyTemplateOverrides(entry.template as Record<string, unknown>, templateOverrides, context);
  }

  // includeWhen — conditional resource creation (convert raw values to CEL)
  const rawIncludeWhen = readIncludeWhen(resource);
  const includeWhen = resolveIncludeWhen(rawIncludeWhen, context);
  if (includeWhen) {
    entry.includeWhen = includeWhen;
  }

  // readyWhen — resource readiness conditions (convert callbacks/refs to CEL)
  const rawReadyWhen = readReadyWhen(resource);
  const readyWhen = resolveReadyWhen(rawReadyWhen, id, hasForEach, context);
  if (readyWhen) {
    entry.readyWhen = readyWhen;
  }

  // dependsOn — explicit dependency ordering via template annotation injection.
  //
  // KRO builds its dependency graph ONLY from template expression references.
  // readyWhen only supports self-references (e.g., self.status.readyReplicas)
  // — it CANNOT reference other resources. To establish a dependency edge
  // between resources, we inject an annotation into the dependent resource's
  // template that references the dependency's metadata.name. KRO scans ALL
  // template fields for expressions and creates DAG edges from them.
  //
  // Once KRO sees the edge, it automatically waits for the dependency to be
  // ready (all its own readyWhen conditions satisfied) before creating the
  // dependent resource. No cross-resource readyWhen is needed.
  const dependsOnDeps = getMetadataField(resource, 'dependsOn') as
    | Array<{ resourceId: string }>
    | undefined;
  if (dependsOnDeps && dependsOnDeps.length > 0) {
    const template = entry.template as Record<string, unknown> | undefined;
    if (template) {
      const metadata = (template.metadata ?? {}) as Record<string, unknown>;
      const annotations = (metadata.annotations ?? {}) as Record<string, string>;
      for (const dep of dependsOnDeps) {
        const resolvedDependencyId = resolveDependsOnResourceId(dep.resourceId, id, context.resourceIds);
        annotations[`typekro.dev/depends-on-${resolvedDependencyId}`] = `\${${resolvedDependencyId}.metadata.name}`;
      }
      metadata.annotations = annotations;
      template.metadata = metadata;
    }
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Main serialization function
// ---------------------------------------------------------------------------

/**
 * Serializes resources to Kro YAML (ResourceGraphDefinition).
 *
 * Supports Kro 0.9.1+ features:
 * - externalRef: Resources marked with __externalRef emit `externalRef` instead of `template`
 * - includeWhen: Non-enumerable includeWhen arrays are emitted per resource
 * - readyWhen: Non-enumerable readyWhen arrays are emitted per resource
 * - forEach: Non-enumerable forEach dimensions are emitted per resource
 * - group: Custom API group in schema (passed through customSchema)
 * - allowBreakingChanges: Emits annotation on RGD metadata
 */
export function serializeResourceGraphToYaml(
  name: string,
  resources: Record<string, KubernetesResource>,
  options?: SerializationOptions,
  customSchema?: KroSimpleSchema
): string {
  // Extract optional-field omit list from schema metadata (if present).
  // These fields get `has() ? ... : omit()` wrapping applied inline during
  // ref-to-CEL conversion — no post-hoc YAML-string rewriting needed.
  const schemaWithMeta = customSchema as KroSimpleSchemaWithMetadata | undefined;
  const omitFieldsList = schemaWithMeta?.__omitFields;
  const omitFields = omitFieldsList && omitFieldsList.length > 0
    ? new Set(omitFieldsList)
    : undefined;

  // Create serialization context
  const nestedStatusCel = schemaWithMeta?.__nestedStatusCel;
  const context: SerializationContext = {
    celPrefix: 'resources', // Default Kro prefix, but now configurable
    ...(options?.namespace && { namespace: options.namespace }),
    resourceIdStrategy: 'deterministic',
    ...(omitFields && { omitFields }),
    ...(nestedStatusCel && { nestedStatusCel }),
  };

  // 1. Use embedded resource IDs and build dependency graph
  const resourceMap = new Map<string, { id: string; resource: KubernetesResource }>();
  const dependencies: ResourceDependency[] = [];
  const resourceAliases = new Map<string, string>();

  // 2. Process each resource and extract references
  for (const [resourceName, resource] of Object.entries(resources)) {
    // Use the embedded resource ID if available, otherwise generate deterministic one
    const resourceId =
      getResourceId(resource) ||
      generateDeterministicResourceId(
        resource.kind || 'Resource',
        resource.metadata?.name || resourceName,
        resource.metadata?.namespace || options?.namespace
      );
    resourceMap.set(resourceName, { id: resourceId, resource });
    resourceAliases.set(resourceName, resourceId);
    for (const alias of deriveResourceIdAliases(resourceId)) {
      if (!resourceAliases.has(alias)) {
        resourceAliases.set(alias, resourceId);
      }
    }

    const aliases = getMetadataField(resource, 'resourceAliases') as string[] | undefined;
    if (aliases) {
      for (const alias of aliases) {
        resourceAliases.set(alias, resourceId);
      }
    }

    // Extract all ResourceReference objects from the resource
    const refs = extractResourceReferences(resource);
    for (const ref of refs) {
      dependencies.push({
        from: resourceId,
        to: ref.resourceId,
        field: ref.fieldPath,
        required: true,
      });
    }
  }

  const knownResourceIds = new Set<string>(Array.from(resourceMap.values(), ({ id }) => id));
  context.resourceIds = knownResourceIds;
  context.resourceAliases = resourceAliases;

  // 3. Build metadata with optional annotations
  const metadata: KroResourceGraphDefinition['metadata'] = {
    name,
  };

  if (options?.allowBreakingChanges) {
    metadata.annotations = {
      ...metadata.annotations,
      'kro.run/allow-breaking-changes': 'true',
    };
  }

  // 4. Generate Kro ResourceGraphDefinition
  const kroDefinition: KroResourceGraphDefinition = {
    apiVersion: 'kro.run/v1alpha1',
    kind: 'ResourceGraphDefinition',
    metadata,
    spec: {
      schema: customSchema || generateKroSchema(name, resources),
      resources: Array.from(resourceMap.values()).map(({ id, resource }) =>
        buildResourceEntry(id, resource, context)
      ),
    },
  };

  // 5. Convert to YAML
  return yaml.dump(kroDefinition, {
    indent: options?.indent || 2,
    lineWidth: options?.lineWidth || -1,
    noRefs: options?.noRefs ?? true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
    schema: yaml.JSON_SCHEMA,
  });
}
