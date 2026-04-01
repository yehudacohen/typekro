/**
 * KRO YAML Post-Processing Utilities
 *
 * Shared functions for applying omit() wrappers and ternary conditionals
 * to serialized KRO RGD YAML. Used by both the toResourceGraph pipeline
 * (core.ts) and the KRO factory deployment path (kro-factory.ts).
 *
 * Extracted to avoid circular dependencies between core.ts and kro-factory.ts.
 */

/**
 * Wrap optional fields without defaults in omit() conditionals (KRO 0.9+).
 *
 * For each optional field, replaces bare `${schema.spec.field}` with
 * `${has(schema.spec.field) ? schema.spec.field : omit()}` in the YAML.
 * The omit() function removes the containing field from the K8s resource
 * when the user doesn't provide it in the CR.
 *
 * Values are double-quoted because `has() ? : omit()` contains YAML-special
 * characters (? and :).
 */
export function applyOmitWrappers(yaml: string, omitFields: string[]): string {
  let result = yaml;
  for (const field of omitFields) {
    const ref = `schema.spec.${field}`;
    const omitExpr = `\${has(${ref}) ? ${ref} : omit()}`;
    const stringOmitExpr = `\${has(${ref}) ? string(${ref}) : omit()}`;

    // Match `key: ${ref}` and replace with `key: "omitExpr"`
    const singlePattern = new RegExp(
      `(:\\s+)\\$\\{${ref.replace(/\./g, '\\.')}\\}`,
      'g'
    );
    result = result.replace(singlePattern, `$1"${omitExpr}"`);

    const stringPattern = new RegExp(
      `(:\\s+)\\$\\{string\\(${ref.replace(/\./g, '\\.')}\\)\\}`,
      'g'
    );
    result = result.replace(stringPattern, `$1"${stringOmitExpr}"`);
  }
  return result;
}

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
 */
export function applyTernaryConditionalsToResources(
  resources: Record<string, unknown>,
  conditionals: Array<{ proxySection: string; falsyValue: string; conditionField: string }>
): void {
  for (const { proxySection, conditionField } of conditionals) {
    replaceInResources(resources, proxySection, (matchedSection) => {
      // Convert markers in the truthy branch to CEL references
      const celTruthy = matchedSection.replace(
        /__KUBERNETES_REF_(__schema__|[^_]+)_([a-zA-Z0-9.$]+)__/g,
        (_m, resourceId: string, fieldPath: string) => {
          const celPath = resourceId === '__schema__' ? `schema.${fieldPath}` : `${resourceId}.${fieldPath}`;
          return `" + string(${celPath}) + "`;
        }
      );
      const escapedTruthy = celTruthy.replace(/\n/g, '\\n');
      return `\${has(schema.spec.${conditionField}) ? "${escapedTruthy}" : ""}`;
    });
  }
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
