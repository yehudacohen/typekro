/**
 * YAML generation functionality for Kro ResourceGraphDefinitions
 *
 * Supports Kro v0.8.x features: forEach, includeWhen, readyWhen, externalRef,
 * schema group, and allowBreakingChanges annotation.
 */

import * as yaml from 'js-yaml';
import { escapeRegExp } from '../../utils/helpers.js';
import {
  extractResourceReferences,
  isCelExpression,
  isKubernetesRef,
} from '../../utils/type-guards.js';
import { generateDeterministicResourceId } from '../resources/id.js';
import type {
  KroExternalRef,
  KroResourceGraphDefinition,
  KroResourceTemplate,
  KroSimpleSchema,
  ResourceDependency,
  SerializationContext,
  SerializationOptions,
} from '../types/serialization.js';
import type { KubernetesResource } from '../types.js';
import { getInnerCelPath, processResourceReferences } from './cel-references.js';
import { generateKroSchema } from './schema.js';

/**
 * Read a non-enumerable property from an Enhanced resource.
 * These properties (includeWhen, readyWhen, __externalRef, __resourceId)
 * are defined as non-enumerable to avoid serialization but are still accessible.
 */
function readNonEnumerable<T>(resource: KubernetesResource, key: string): T | undefined {
  return (resource as unknown as Record<string, unknown>)[key] as T | undefined;
}

// ---------------------------------------------------------------------------
// includeWhen → CEL conversion
// ---------------------------------------------------------------------------

/**
 * Convert a single includeWhen value to a CEL expression string.
 *
 * Accepted input types:
 *  - KubernetesRef proxy  → `${schema.spec.field}`
 *  - CelExpression object → `${expression}`
 *  - string (already CEL) → pass-through
 *  - string with __KUBERNETES_REF__ markers → convert markers to CEL
 */
function convertIncludeWhenValueToCel(value: unknown): string | undefined {
  if (typeof value === 'string') {
    if (value.includes('__KUBERNETES_REF_')) {
      return convertRefMarkersInString(value);
    }
    return value;
  }

  if (isKubernetesRef(value)) {
    const celPath = getInnerCelPath(value);
    return `\${${celPath}}`;
  }

  if (isCelExpression(value)) {
    return `\${${value.expression}}`;
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
function resolveIncludeWhen(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;

  const items = Array.isArray(raw) ? raw : [raw];
  const celStrings: string[] = [];

  for (const item of items) {
    const cel = convertIncludeWhenValueToCel(item);
    if (cel) celStrings.push(cel);
  }

  return celStrings.length > 0 ? celStrings : undefined;
}

// ---------------------------------------------------------------------------
// readyWhen → CEL conversion
// ---------------------------------------------------------------------------

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
function convertReadyWhenCallbackToCel(fn: Function, resourceId: string): string {
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

  // Convert JS arrow function callbacks inside .exists(), .filter(), .all(), .map()
  // Pattern: .exists((c) => c.type === 'Ready' && c.status === 'True')
  // → .exists(c, c.type == "Ready" && c.status == "True")
  celExpr = celExpr.replace(
    /\.\s*(exists|all|filter|map)\s*\(\s*\(?([a-zA-Z_$][a-zA-Z0-9_$]*)\)?\s*(?::\s*\w+)?\s*=>\s*([\s\S]+?)\)/g,
    (_match, method: string, innerParam: string, innerBody: string) => {
      let cleanBody = innerBody.trim();
      // Fix operators in inner body too
      cleanBody = cleanBody.replace(/===/g, '==').replace(/!==/g, '!=');
      // Convert single quotes to double quotes for string literals
      cleanBody = cleanBody.replace(/'([^']+)'/g, '"$1"');
      return `.${method}(${innerParam}, ${cleanBody})`;
    }
  );

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
  hasForEach: boolean
): string | undefined {
  // Callback function — parse source to extract CEL expression
  if (typeof value === 'function') {
    const baseId = hasForEach ? 'each' : resourceId;
    const celExpr = convertReadyWhenCallbackToCel(value as Function, baseId);
    return `\${${celExpr}}`;
  }

  if (isKubernetesRef(value)) {
    const celPath = getInnerCelPath(value);
    return `\${${celPath}}`;
  }

  if (isCelExpression(value)) {
    return `\${${value.expression}}`;
  }

  if (typeof value === 'string') {
    if (value.includes('__KUBERNETES_REF_')) {
      return `\${${convertRefMarkersInString(value)}}`;
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
  hasForEach: boolean
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;

  const items = Array.isArray(raw) ? raw : [raw];
  const celStrings: string[] = [];

  for (const item of items) {
    const cel = convertReadyWhenValueToCel(item, resourceId, hasForEach);
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
function convertRefMarkersInString(str: string): string {
  // Pattern: __KUBERNETES_REF_{resourceId}_{fieldPath}__
  // For schema: __KUBERNETES_REF___schema___{fieldPath}__
  const refPattern = /__KUBERNETES_REF_(__schema__|[^_]+)_([a-zA-Z0-9.$]+)__/g;

  return str.replace(refPattern, (_match, resourceId: string, fieldPath: string) => {
    if (resourceId === '__schema__') {
      return `schema.${fieldPath}`;
    }
    return `${resourceId}.${fieldPath}`;
  });
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
  overrides: Array<{ propertyPath: string; celExpression: string }>
): void {
  for (const { propertyPath, celExpression } of overrides) {
    const parts = propertyPath.split('.');
    let target: Record<string, unknown> = template;

    // Walk to the parent of the target property
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue;
      const next = target[part];
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        target = next as Record<string, unknown>;
      } else {
        // Path doesn't exist in the template — skip this override
        target = undefined as unknown as Record<string, unknown>;
        break;
      }
    }

    if (!target) continue;

    const lastKey = parts[parts.length - 1];
    if (lastKey && lastKey in target) {
      target[lastKey] = celExpression;
    }
  }
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
    // externalRef resources: emit externalRef metadata, NOT template.
    // Use Object.getOwnPropertyDescriptor to bypass the Enhanced proxy's get trap
    // and read the actual underlying values. Going through the proxy would cause
    // metadata.namespace to return a KubernetesRef function proxy when namespace
    // doesn't exist, which yaml.dump cannot serialize.
    const apiVersionDesc = Object.getOwnPropertyDescriptor(resource, 'apiVersion');
    const kindDesc = Object.getOwnPropertyDescriptor(resource, 'kind');
    const metadataDesc = Object.getOwnPropertyDescriptor(resource, 'metadata');
    const rawMeta = metadataDesc?.value as Record<string, unknown> | undefined;

    const extRef: KroExternalRef = {
      apiVersion: String(apiVersionDesc?.value ?? ''),
      kind: String(kindDesc?.value ?? ''),
      metadata: {
        name: typeof rawMeta?.name === 'string' ? rawMeta.name : '',
        ...(typeof rawMeta?.namespace === 'string' && { namespace: rawMeta.namespace }),
      },
    };

    const entry: KroResourceTemplate = { id, externalRef: extRef };

    // externalRef can still have includeWhen (but NOT forEach — mutually exclusive)
    const rawIncludeWhen = readNonEnumerable<unknown>(resource, 'includeWhen');
    const includeWhen = resolveIncludeWhen(rawIncludeWhen);
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
  const forEach = readNonEnumerable<Record<string, string>[]>(resource, 'forEach');
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

  // Template overrides — ternary expressions in factory args that evaluated to
  // literals at runtime but should be CEL conditionals in the output.
  const templateOverrides = readNonEnumerable<
    Array<{ propertyPath: string; celExpression: string }>
  >(resource, '__templateOverrides');
  if (templateOverrides && templateOverrides.length > 0 && entry.template) {
    applyTemplateOverrides(entry.template as Record<string, unknown>, templateOverrides);
  }

  // includeWhen — conditional resource creation (convert raw values to CEL)
  const rawIncludeWhen = readNonEnumerable<unknown>(resource, 'includeWhen');
  const includeWhen = resolveIncludeWhen(rawIncludeWhen);
  if (includeWhen) {
    entry.includeWhen = includeWhen;
  }

  // readyWhen — resource readiness conditions (convert callbacks/refs to CEL)
  const rawReadyWhen = readNonEnumerable<unknown>(resource, 'readyWhen');
  const readyWhen = resolveReadyWhen(rawReadyWhen, id, hasForEach);
  if (readyWhen) {
    entry.readyWhen = readyWhen;
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Main serialization function
// ---------------------------------------------------------------------------

/**
 * Serializes resources to Kro YAML (ResourceGraphDefinition).
 *
 * Supports Kro v0.8.x features:
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
  // Create serialization context
  const context: SerializationContext = {
    celPrefix: 'resources', // Default Kro prefix, but now configurable
    ...(options?.namespace && { namespace: options.namespace }),
    resourceIdStrategy: 'deterministic',
  };

  // 1. Use embedded resource IDs and build dependency graph
  const resourceMap = new Map<string, { id: string; resource: KubernetesResource }>();
  const dependencies: ResourceDependency[] = [];

  // 2. Process each resource and extract references
  for (const [resourceName, resource] of Object.entries(resources)) {
    // Use the embedded resource ID if available, otherwise generate deterministic one
    const resourceId =
      readNonEnumerable<string>(resource, '__resourceId') ||
      generateDeterministicResourceId(
        resource.kind || 'Resource',
        resource.metadata?.name || resourceName,
        resource.metadata?.namespace || options?.namespace
      );
    resourceMap.set(resourceName, { id: resourceId, resource });

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

  // 3. Build metadata with optional annotations
  const metadata: KroResourceGraphDefinition['metadata'] = {
    name,
    namespace: options?.namespace || 'default',
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
