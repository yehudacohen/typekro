/**
 * CEL Expression Validator for Kro Compatibility
 *
 * This module validates CEL expressions to ensure they comply with Kro's requirements:
 * 1. Status fields must reference actual resources (not hardcoded strings)
 * 2. Resource IDs must be camelCase
 * 3. All referenced resources must exist in the ResourceGraphDefinition
 */

import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { getComponentLogger } from '../logging/index.js';
import { remapVariableNames } from '../composition/nested-status-cel.js';
import { lookupNestedExpression } from '../serialization/cel-references.js';
import { isStaticExpression } from '../serialization/cel-references.js';
import type { KubernetesResource } from '../types.js';

const logger = getComponentLogger('cel-validator');

export interface CelValidationError {
  field: string;
  expression: string;
  error: string;
  suggestion?: string;
}

export interface CelValidationResult {
  isValid: boolean;
  errors: CelValidationError[];
  warnings: CelValidationError[];
}

/**
 * Validates that a resource ID follows camelCase convention required by Kro
 */
export function validateResourceId(id: string): { isValid: boolean; error?: string } {
  // Check if it's camelCase (starts with lowercase, no hyphens, no underscores)
  const camelCaseRegex = /^[a-z][a-zA-Z0-9]*$/;

  if (!camelCaseRegex.test(id)) {
    let suggestion = id;

    // Convert kebab-case to camelCase
    if (id.includes('-')) {
      suggestion = id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    }

    // Convert dot.case to camelCase
    if (id.includes('.')) {
      suggestion = id.replace(/\.([a-z])/g, (_, letter: string) => letter.toUpperCase());
    }

    // Convert snake_case to camelCase
    if (id.includes('_')) {
      suggestion = id.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    }

    // Ensure first letter is lowercase
    suggestion = suggestion.charAt(0).toLowerCase() + suggestion.slice(1);

    return {
      isValid: false,
      error: `Resource ID '${id}' is not valid. Kro requires camelCase IDs. Suggested: '${suggestion}'`,
    };
  }

  return { isValid: true };
}

/**
 * Determines if a status field value requires Kro resolution.
 *
 * A value requires KRO resolution iff, after transitively resolving any
 * nested-composition references through `nestedStatusCel`, it depends on
 * at least one real-resource reference (a `status.*` or generated
 * `metadata.*` field). Schema refs and literal values — at any depth,
 * including the far side of nested composition references — are static
 * and hydrated by the TypeKro runtime at deploy time.
 *
 * Dynamic (KRO resolves):
 *   - status.*             — only available after deployment
 *   - metadata.uid         — assigned by API server
 *   - metadata.creationTimestamp / resourceVersion / generation
 *
 * Static (TypeKro resolves at deploy time):
 *   - __schema__ refs       — resolved against the CR spec
 *   - metadata.name / namespace / labels / annotations (composition-set)
 *   - Literal values        — emitted as-is
 *   - Nested composition refs whose inner analyzed expression is itself
 *     fully static (transitive check)
 */
function requiresKroResolution(
  value: unknown,
  nestedStatusCel?: Record<string, string>,
  resourceIds?: ReadonlySet<string>
): boolean {
  const localResourceIds = resourceIds ? Array.from(resourceIds) : [];

  if (isKubernetesRef(value)) {
    // Schema refs — always static.
    if (value.resourceId === '__schema__') {
      return false;
    }
    if (typeof value.fieldPath !== 'string') return false;

    // Nested composition refs — look up the inner analyzed expression
    // and classify it transitively. If the inner resolves to something
    // that depends only on schema refs and literals, this outer ref is
    // also static.
    const isNestedComp = (value as { __nestedComposition?: boolean }).__nestedComposition === true;
    if (isNestedComp && nestedStatusCel) {
      const fieldName = value.fieldPath.replace(/^status\./, '');
      const innerExpr = resourceIds?.has(value.resourceId)
        ? lookupNestedExpression(value.resourceId, fieldName, nestedStatusCel, false)
        : lookupNestedExpression(value.resourceId, fieldName, nestedStatusCel);
      if (innerExpr !== undefined) {
        return !isStaticExpression(innerExpr, nestedStatusCel);
      }
      // Nested ref with no entry in the table — conservatively dynamic.
      // This either means the resolution table is incomplete (a real bug
      // we want to surface for diagnosis) or the alias mechanism in
      // `buildNestedCompositionAliases` couldn't match the variable
      // assignment in the composition source. The fallback keeps the
      // serialization succeeding by treating the ref as dynamic, but
      // KRO will reject the resulting CEL at runtime because the virtual
      // baseId isn't a real resource — so we want this on the radar.
      logger.warn('Nested composition ref classified as dynamic — no nestedStatusCel entry', {
        resourceId: value.resourceId,
        fieldPath: value.fieldPath,
        availableKeys: Object.keys(nestedStatusCel).slice(0, 10),
      });
      return true;
    }

    // Direct resource refs — status.* and generated metadata.* are dynamic,
    // composition-set metadata.* is static.
    const fieldPath = value.fieldPath;
    if (fieldPath.startsWith('status.')) return true;
    if (fieldPath.startsWith('metadata.')) {
      const staticMetadataFields = ['metadata.name', 'metadata.namespace', 'metadata.labels', 'metadata.annotations'];
      return !staticMetadataFields.some((f) => fieldPath === f || fieldPath.startsWith(`${f}.`));
    }
    return false;
  }

  if (isCelExpression(value)) {
    // Transitive check: resolve any nested refs inside the expression and
    // ask whether the result contains non-schema refs.
    const normalizedExpression = localResourceIds.length > 0
      ? remapVariableNames(value.expression, localResourceIds)
      : value.expression;
    return !isStaticExpression(normalizedExpression, nestedStatusCel);
  }

  // Strings potentially containing __KUBERNETES_REF__ markers from
  // template literals. Classify transitively: a marker string referencing
  // only schema fields (and literal text) is static even though it
  // contains markers.
  if (typeof value === 'string') {
    if (!value.includes('__KUBERNETES_REF_')) return false;
    const normalizedValue = localResourceIds.length > 0
      ? remapVariableNames(value, localResourceIds)
      : value;
    return !isStaticExpression(normalizedValue, nestedStatusCel);
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.values(value as Record<string, unknown>).some((v) =>
      requiresKroResolution(v, nestedStatusCel, resourceIds)
    );
  }

  return false;
}

/**
 * Separates a nested object into static and dynamic parts.
 *
 * Classification is transitive over nested-composition references when a
 * `nestedStatusCel` lookup table is provided.
 */
function separateNestedObject(
  obj: Record<string, unknown>,
  nestedStatusCel?: Record<string, string>,
  resourceIds?: ReadonlySet<string>
): {
  staticPart: Record<string, unknown>;
  dynamicPart: Record<string, unknown>;
  hasStatic: boolean;
  hasDynamic: boolean;
} {
  const staticPart: Record<string, unknown> = {};
  const dynamicPart: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (requiresKroResolution(value, nestedStatusCel, resourceIds)) {
      dynamicPart[key] = value;
    } else {
      staticPart[key] = value;
    }
  }

  return {
    staticPart,
    dynamicPart,
    hasStatic: Object.keys(staticPart).length > 0,
    hasDynamic: Object.keys(dynamicPart).length > 0,
  };
}

/**
 * Separate status mappings into static fields (hydrated locally by TypeKro)
 * and dynamic fields (emitted as CEL for KRO).
 *
 * When `nestedStatusCel` is provided, classification is transitive — a
 * nested composition reference whose target is a schema-only / literal
 * expression is classified as static even though the reference itself
 * looks like `<id>.status.<field>`. This is the key mechanism that
 * satisfies the "depth-agnostic staticness" invariant for nested
 * compositions.
 *
 * If `nestedStatusCel` is not explicitly passed, the function falls back
 * to reading `statusMappings.__nestedStatusCel` (which is where the
 * composition context attaches the table via Reflect.set), so existing
 * callers continue to work without explicit plumbing.
 */
export function separateStatusFields(
  statusMappings: Record<string, unknown>,
  nestedStatusCel?: Record<string, string>,
  resourceIds?: ReadonlySet<string>
): {
  staticFields: Record<string, unknown>;
  dynamicFields: Record<string, unknown>;
} {
  const staticFields: Record<string, unknown> = {};
  const dynamicFields: Record<string, unknown> = {};

  // Handle null/undefined inputs
  if (!statusMappings || typeof statusMappings !== 'object') {
    return { staticFields, dynamicFields };
  }

  // Fallback: pick up the nested status CEL table from the statusMappings
  // object itself. The composition context attaches it via Reflect.set as
  // a non-enumerable property, so we need getOwnPropertyDescriptor to see it.
  if (!nestedStatusCel) {
    const descriptor = Object.getOwnPropertyDescriptor(statusMappings, '__nestedStatusCel');
    if (descriptor?.value && typeof descriptor.value === 'object') {
      nestedStatusCel = descriptor.value as Record<string, string>;
    }
  }

  for (const [fieldName, fieldValue] of Object.entries(statusMappings)) {
    // Internal metadata fields are not user-facing status.
    if (fieldName.startsWith('__')) continue;

    if (
      typeof fieldValue === 'object' &&
      fieldValue !== null &&
      !Array.isArray(fieldValue) &&
      !isKubernetesRef(fieldValue) &&
      !isCelExpression(fieldValue)
    ) {
      // Handle nested objects that might have mixed static/dynamic fields
      const { staticPart, dynamicPart, hasStatic, hasDynamic } = separateNestedObject(
        fieldValue as Record<string, unknown>,
        nestedStatusCel,
        resourceIds
      );

      if (hasStatic) {
        staticFields[fieldName] = staticPart;
      }
      if (hasDynamic) {
        dynamicFields[fieldName] = dynamicPart;
      }
    } else if (requiresKroResolution(fieldValue, nestedStatusCel, resourceIds)) {
      dynamicFields[fieldName] = fieldValue;
    } else {
      staticFields[fieldName] = fieldValue;
    }
  }

  return { staticFields, dynamicFields };
}

/**
 * Validates CEL expressions in dynamic status fields to ensure they reference actual resources
 */
export function validateStatusCelExpressions(
  statusMappings: Record<string, unknown>,
  resources: Record<string, KubernetesResource>
): CelValidationResult {
  const errors: CelValidationError[] = [];
  const warnings: CelValidationError[] = [];
  // Build set of valid resource identifiers - includes both resource IDs and keys
  // This supports both `resourceId.status.field` and `variableName.status.field` patterns
  const resourceIds = new Set([
    ...Object.keys(resources), // Variable names (from userKeyMap in imperative pattern)
    ...Object.values(resources)
      .map((r) => r.id)
      .filter(Boolean), // Resource IDs
  ]);

  // Separate static and dynamic fields
  const { staticFields, dynamicFields } = separateStatusFields(statusMappings);

  // Only validate dynamic fields that will be sent to Kro
  function validateExpression(fieldName: string, value: any): void {
    if (isCelExpression(value)) {
      const expression = remapVariableNames(
        value.expression,
        Array.from(resourceIds).filter((id): id is string => typeof id === 'string')
      );

      // Check for direct resource references (resourceId.status.field, resourceId.spec.field, resourceId.metadata.field)
      // This is the most important validation - ensuring referenced resources actually exist
      //
      // Extract CEL lambda variable names to exclude them from resource ID checks.
      // CEL macros like .all(v, body), .exists(v, body), .map(v, body), .filter(v, body)
      // introduce lambda variables that should not be treated as resource IDs.
      const lambdaVarPattern = /\.(?:all|exists|map|filter)\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*,/g;
      const lambdaVars = new Set<string>();
      let lambdaMatch: RegExpExecArray | null = lambdaVarPattern.exec(expression);
      while (lambdaMatch !== null) {
        if (lambdaMatch[1]) lambdaVars.add(lambdaMatch[1]);
        lambdaMatch = lambdaVarPattern.exec(expression);
      }
      // Also add 'each' as it's a Kro readyWhen keyword for forEach collections
      lambdaVars.add('each');

      const directResourceRefPattern = /\b([a-zA-Z][a-zA-Z0-9]*)\.(status|spec|metadata)\./g;
      let directMatch: RegExpExecArray | null = directResourceRefPattern.exec(expression);
      while (directMatch !== null) {
        const referencedId = directMatch[1] ?? '';
        if (
          referencedId !== 'schema' &&
          !resourceIds.has(referencedId) &&
          !lambdaVars.has(referencedId)
        ) {
          // Check if this specific reference is a cross-composition status access.
          // Cross-composition references (e.g., `otherComposition.status.ready`) are valid
          // even if the referenced composition is not a registered resource in THIS graph.
          // We only suppress the error when the SPECIFIC unresolved reference accesses .status.,
          // not when .status. appears anywhere in the expression.
          const matchedRef = directMatch[0] ?? '';
          const isCrossCompositionRef =
            matchedRef.includes('.status.') && !matchedRef.includes('.spec.');
          if (isCrossCompositionRef) {
            warnings.push({
              field: fieldName,
              expression,
              error: `Reference '${referencedId}' is not a registered resource — treating as cross-composition reference`,
              suggestion: `If this is not a cross-composition reference, check that resource '${referencedId}' is created in the composition`,
            });
          } else {
            errors.push({
              field: fieldName,
              expression,
              error: `Referenced resource '${referencedId}' does not exist`,
              suggestion: `Available resources: ${Array.from(resourceIds).join(', ')}`,
            });
          }
        }
        directMatch = directResourceRefPattern.exec(expression);
      }
    } else if (typeof value === 'object' && value !== null) {
      // Recursively validate nested objects
      for (const [key, nestedValue] of Object.entries(value)) {
        validateExpression(`${fieldName}.${key}`, nestedValue);
      }
    }
  }

  // Only validate dynamic fields
  for (const [fieldName, fieldValue] of Object.entries(dynamicFields)) {
    validateExpression(fieldName, fieldValue);
  }

  const staticFieldNames = Object.keys(staticFields);

  if (staticFieldNames.length > 0) {
    warnings.push({
      field: 'status',
      expression: '',
      error: `Static fields (${staticFieldNames.join(', ')}) will be hydrated directly, not sent to Kro`,
      suggestion: 'This is normal behavior for fields without Kubernetes references',
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates all resource IDs in a resource collection
 */
export function validateResourceIds(
  resources: Record<string, KubernetesResource>
): CelValidationResult {
  const errors: CelValidationError[] = [];

  for (const [key, resource] of Object.entries(resources)) {
    if (resource.id) {
      const validation = validateResourceId(resource.id);
      if (!validation.isValid) {
        errors.push({
          field: `resources.${key}.id`,
          expression: resource.id,
          error: validation.error!,
        });
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings: [],
  };
}

/**
 * Comprehensive validation for a complete ResourceGraphDefinition
 */
export function validateResourceGraphDefinition(
  resources: Record<string, KubernetesResource>,
  statusMappings?: Record<string, unknown>
): CelValidationResult {
  const resourceIdValidation = validateResourceIds(resources);
  const statusValidation = statusMappings
    ? validateStatusCelExpressions(statusMappings, resources)
    : { isValid: true, errors: [], warnings: [] };

  return {
    isValid: resourceIdValidation.isValid && statusValidation.isValid,
    errors: [...resourceIdValidation.errors, ...statusValidation.errors],
    warnings: [...resourceIdValidation.warnings, ...statusValidation.warnings],
  };
}
