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
  conditionals: Array<{ proxySection: string; falsyValue: string; conditionField: string }>
): void {
  for (const { proxySection, conditionField } of conditionals) {
    replaceInResources(resources, proxySection, (matchedSection) => {
      // Split the matched section on markers so we can separately handle
      // LITERAL text (needs CEL string-literal escaping) and CEL REFERENCES
      // (must NOT be escaped — they're emitted as `string(ref)` concatenation).
      const markerRe = /__KUBERNETES_REF_(__schema__|[^_]+)_([a-zA-Z0-9.$]+)__/g;
      let celTruthy = '';
      let lastIndex = 0;
      let m: RegExpExecArray | null = markerRe.exec(matchedSection);
      while (m !== null) {
        if (m.index > lastIndex) {
          celTruthy += escapeCelStringLiteral(matchedSection.slice(lastIndex, m.index));
        }
        const resourceId = m[1]!;
        const fieldPath = m[2]!;
        const celPath =
          resourceId === '__schema__' ? `schema.${fieldPath}` : `${resourceId}.${fieldPath}`;
        celTruthy += `" + string(${celPath}) + "`;
        lastIndex = m.index + m[0].length;
        m = markerRe.exec(matchedSection);
      }
      if (lastIndex < matchedSection.length) {
        celTruthy += escapeCelStringLiteral(matchedSection.slice(lastIndex));
      }
      return `\${has(schema.spec.${conditionField}) ? "${celTruthy}" : ""}`;
    });
  }
}

/**
 * Escape a literal text chunk for inclusion inside a CEL double-quoted
 * string. Must handle backslash, double quote, newline, carriage return,
 * and tab — in that order, so that the backslash escape doesn't re-escape
 * the backslashes introduced by later substitutions.
 *
 * Previous implementation only escaped newlines, which left literal `"` and
 * `\` characters unescaped. That was a latent bug: any composition that
 * emitted quoted YAML values or Windows-style paths inside a ternary branch
 * would produce malformed CEL and the KRO reconciler would reject the RGD.
 */
function escapeCelStringLiteral(literal: string): string {
  return literal
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

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
