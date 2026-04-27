import { escapeCelString as escapeCelStringLiteral } from '../../utils/cel-escape.js';
import { KUBERNETES_REF_MARKER_SOURCE } from '../../shared/brands.js';
import { getMetadataField } from '../metadata/index.js';
import { generateDeterministicResourceId, getResourceId } from '../resources/id.js';
import type { KubernetesResource } from '../types/kubernetes.js';
import type { SerializationContext } from '../types/serialization.js';
import { normalizeRefMarkersToCelPaths } from './cel-references.js';

/**
 * KRO YAML Post-Processing Utilities
 *
 * Shared helpers for applying ternary conditionals to resource data before
 * YAML serialization. Used by both the toResourceGraph pipeline (core.ts)
 * and the KRO factory deployment path (kro-factory.ts).
 *
 * Extracted to avoid circular dependencies between core.ts and kro-factory.ts.
 *
 * Note: KRO 0.9+ omit() wrapping for optional fields is NOT in this module —
 * it's applied inline during ref-to-CEL conversion via
 * `SerializationContext.omitFields` in `cel-references.ts`. That keeps
 * `has() ? ... : omit()` generation as a structured operation on
 * KubernetesRef objects instead of a post-hoc regex rewrite of the
 * serialized YAML string.
 */

/**
 * Apply ternary conditionals to resource data by replacing raw marker sections
 * with CEL conditional expressions. This runs BEFORE processResourceReferences
 * so that the markers within the truthy branch get converted to mixed-template
 * CEL format by the normal pipeline.
 *
 * For `spec.redisUrl ? \`redis:\n  url: ${spec.redisUrl}\` : ''`, the raw
 * settings.yml string contains the redis section with a __KUBERNETES_REF__
 * marker. This function replaces that section with a CEL conditional that
 * processResourceReferences will then convert to the final mixed-template form.
 *
 * FRAGILE: operates on raw string values inside resource data by substring
 * matching. The `proxySection` must be byte-identical to what was extracted
 * by `extractTernaryConditionals` in schema.ts — meaning the composition's
 * string construction (typically a template literal) and the re-execution
 * pass both need to produce the same newline/indentation layout. If a
 * composition author post-processes the settings string, interpolates it
 * through another templating layer, or if the extraction heuristic in
 * schema.ts is updated to include/exclude different surrounding context,
 * the match will fail silently and the ternary will not be applied.
 *
 * Tracked for replacement with AST-based detection in
 * https://github.com/yehudacohen/typekro/issues/57
 */
export function applyTernaryConditionalsToResources(
  resources: Record<string, unknown>,
  conditionals: Array<{ proxySection: string; falsyValue: string; conditionField: string }>,
  nestedStatusCel?: Record<string, string>
): void {
  const context = createMarkerResolutionContext(resources, nestedStatusCel);
  for (const { proxySection, conditionField } of conditionals) {
    replaceInResources(resources, proxySection, (matchedSection) => {
      // Split the matched section on markers so we can separately handle
      // LITERAL text (needs CEL string-literal escaping) and CEL REFERENCES
      // (must NOT be escaped — they're emitted as `string(ref)` concatenation).
      const markerRe = new RegExp(KUBERNETES_REF_MARKER_SOURCE, 'g');
      let celTruthy = '';
      let lastIndex = 0;
      let m: RegExpExecArray | null = markerRe.exec(matchedSection);
      while (m !== null) {
        if (m.index > lastIndex) {
          celTruthy += escapeCelStringLiteral(matchedSection.slice(lastIndex, m.index));
        }
        const resourceId = m[1];
        const fieldPath = m[2];
        if (!resourceId || !fieldPath) continue;
        const celPath = unwrapKroExpression(normalizeRefMarkersToCelPaths(m[0], context));
        const stringExpr = celPath.startsWith('string(') ? celPath : `string(${celPath})`;
        celTruthy += `" + ${stringExpr} + "`;
        lastIndex = m.index + m[0].length;
        m = markerRe.exec(matchedSection);
      }
      if (lastIndex < matchedSection.length) {
        celTruthy += escapeCelStringLiteral(matchedSection.slice(lastIndex));
      }
      return `\${${schemaSpecHasGuard(conditionField)} ? "${celTruthy}" : ""}`;
    });
  }
}

function unwrapKroExpression(expr: string): string {
  const trimmed = expr.trim();
  return trimmed.startsWith('${') && trimmed.endsWith('}') ? trimmed.slice(2, -1) : trimmed;
}

function createMarkerResolutionContext(
  resources: Record<string, unknown>,
  nestedStatusCel?: Record<string, string>
): SerializationContext {
  const resourceAliases = new Map<string, string>();
  const resourceIds = new Set<string>();

  for (const [resourceName, resource] of Object.entries(resources)) {
    if (!resource || typeof resource !== 'object') continue;
    const kubernetesResource = resource as KubernetesResource;
    const resourceId =
      getResourceId(kubernetesResource) ||
      generateDeterministicResourceId(
        kubernetesResource.kind || 'Resource',
        kubernetesResource.metadata?.name || resourceName,
        kubernetesResource.metadata?.namespace
      );
    resourceIds.add(resourceId);
    resourceAliases.set(resourceName, resourceId);
    for (const alias of deriveResourceIdAliases(resourceId)) {
      if (!resourceAliases.has(alias)) {
        resourceAliases.set(alias, resourceId);
      }
    }

    const aliases = getMetadataField(kubernetesResource, 'resourceAliases') as string[] | undefined;
    if (aliases) {
      for (const alias of aliases) {
        resourceAliases.set(alias, resourceId);
      }
    }
  }

  return {
    celPrefix: 'resources',
    resourceIdStrategy: 'deterministic',
    resourceIds,
    resourceAliases,
    ...(nestedStatusCel && { nestedStatusCel }),
  };
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

function schemaSpecHasGuard(conditionField: string): string {
  const segments = conditionField.split('.').filter(Boolean);
  if (segments.length === 0) return 'false';
  return segments
    .map((_, index) => `has(schema.spec.${segments.slice(0, index + 1).join('.')})`)
    .join(' && ');
}

/**
 * escapeCelStringLiteral is imported from utils/cel-escape.ts (aliased
 * at the import site to preserve the local name used by callsites).
 */

/** Recursively find and replace string sections in resource data. */
function replaceInResources(
  obj: unknown,
  section: string,
  replacer: (matched: string) => string
): void {
  if (!obj || typeof obj !== 'object') return;
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const val = record[key];
    if (typeof val === 'string' && val.includes(section)) {
      record[key] = (val as string).replaceAll(section, replacer(section));
    } else if (typeof val === 'object' && val !== null) {
      replaceInResources(val, section, replacer);
    }
  }
}
