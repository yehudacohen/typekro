/**
 * CEL Expression Validator for Kro Compatibility
 *
 * This module validates CEL expressions to ensure they comply with Kro's requirements:
 * 1. Status fields must reference actual resources (not hardcoded strings)
 * 2. Resource IDs must be camelCase
 * 3. All referenced resources must exist in the ResourceGraphDefinition
 */

import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import type { KubernetesResource } from '../types.js';

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
 * Check if a CEL expression string references any non-schema resource fields.
 *
 * Any reference to a deployed resource (status, metadata, or spec) requires
 * KRO runtime resolution because:
 * - `resource.status.*` — populated by the cluster after deployment
 * - `resource.metadata.*` — set by K8s (may include generated fields like uid)
 * - `resource.spec.*` — available on the deployed resource object
 *
 * Only `schema.spec.*` references are static (resolved from the user's spec
 * by TypeKro at deploy time). KRO status CEL does NOT support `schema.spec.*`.
 */
function containsNonSchemaResourceReferences(expression: string): boolean {
  // Match `identifier.(status|metadata|spec).field` but NOT `schema.*`
  return /\b(?!schema\.)\w+\.(status|metadata|spec)\./.test(expression);
}

/**
 * Determines if a status field value requires Kro resolution.
 *
 * A value requires KRO resolution if it references any non-schema resource
 * field (status, metadata, or spec). Schema refs and literal values are
 * static — they can be hydrated by the TypeKro runtime at deploy time.
 */
function requiresKroResolution(value: any): boolean {
  if (isKubernetesRef(value)) {
    // Schema refs are static — resolved from the user's spec at deploy time.
    if (value.resourceId === '__schema__') {
      return false;
    }
    // Determine which fields require KRO runtime resolution vs. can be hydrated
    // by TypeKro at deploy time.
    //
    // Dynamic (KRO resolves):
    //   - status.*             — only available after deployment
    //   - metadata.uid         — assigned by API server
    //   - metadata.creationTimestamp — assigned by API server
    //   - metadata.resourceVersion  — assigned by API server
    //   - metadata.generation       — assigned by API server
    //
    // Static (TypeKro resolves at deploy time):
    //   - spec.*                — deterministic from the template
    //   - metadata.name         — set by the composition
    //   - metadata.namespace    — set by the composition
    //   - metadata.labels       — set by the composition
    //   - metadata.annotations  — set by the composition
    if (typeof value.fieldPath !== 'string') return false;
    if (value.fieldPath.startsWith('status.')) return true;
    if (value.fieldPath.startsWith('metadata.')) {
      const staticMetadataFields = ['metadata.name', 'metadata.namespace', 'metadata.labels', 'metadata.annotations'];
      return !staticMetadataFields.some(f => value.fieldPath === f || value.fieldPath.startsWith(`${f}.`));
    }
    return false;
  }

  if (isCelExpression(value)) {
    return containsNonSchemaResourceReferences(value.expression);
  }

  // Strings containing __KUBERNETES_REF__ markers from template literals
  if (typeof value === 'string' && value.includes('__KUBERNETES_REF_')) {
    const refPattern = /__KUBERNETES_REF_(__schema__|[^_]+)_([a-zA-Z0-9.$]+)__/g;
    let match: RegExpExecArray | null = refPattern.exec(value);
    while (match !== null) {
      if (match[1] !== '__schema__') return true;
      match = refPattern.exec(value);
    }
    return false;
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    // Recursively check nested objects
    return Object.values(value).some(requiresKroResolution);
  }

  return false;
}

/**
 * Separates a nested object into static and dynamic parts
 */
function separateNestedObject(obj: Record<string, unknown>): {
  staticPart: Record<string, unknown>;
  dynamicPart: Record<string, unknown>;
  hasStatic: boolean;
  hasDynamic: boolean;
} {
  const staticPart: Record<string, unknown> = {};
  const dynamicPart: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (requiresKroResolution(value)) {
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
 * Separates status mappings into static fields (can be hydrated directly) and dynamic fields (need Kro resolution)
 */
export function separateStatusFields(statusMappings: Record<string, unknown>): {
  staticFields: Record<string, unknown>;
  dynamicFields: Record<string, unknown>;
} {
  const staticFields: Record<string, unknown> = {};
  const dynamicFields: Record<string, unknown> = {};

  // Handle null/undefined inputs
  if (!statusMappings || typeof statusMappings !== 'object') {
    return { staticFields, dynamicFields };
  }

  for (const [fieldName, fieldValue] of Object.entries(statusMappings)) {
    if (
      typeof fieldValue === 'object' &&
      fieldValue !== null &&
      !Array.isArray(fieldValue) &&
      !isKubernetesRef(fieldValue) &&
      !isCelExpression(fieldValue)
    ) {
      // Handle nested objects that might have mixed static/dynamic fields
      const { staticPart, dynamicPart, hasStatic, hasDynamic } = separateNestedObject(
        fieldValue as Record<string, unknown>
      );

      if (hasStatic) {
        staticFields[fieldName] = staticPart;
      }
      if (hasDynamic) {
        dynamicFields[fieldName] = dynamicPart;
      }
    } else if (requiresKroResolution(fieldValue)) {
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
      const expression = value.expression;

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
