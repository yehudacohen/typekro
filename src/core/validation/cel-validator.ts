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

    // Convert snake_case to camelCase
    if (id.includes('_')) {
      suggestion = id.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
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
 * Determines if a status field value requires Kro resolution (contains Kubernetes references or CEL expressions)
 */
function requiresKroResolution(value: any): boolean {
  if (isKubernetesRef(value)) {
    return true;
  }

  if (isCelExpression(value)) {
    // Check if the CEL expression contains resource references
    const expression = value.expression;
    const resourceRefPattern = /([a-zA-Z][a-zA-Z0-9]*)\.(status|spec|metadata)\./;
    return resourceRefPattern.test(expression);
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
function separateNestedObject(obj: Record<string, any>): {
  staticPart: Record<string, any>;
  dynamicPart: Record<string, any>;
  hasStatic: boolean;
  hasDynamic: boolean;
} {
  const staticPart: Record<string, any> = {};
  const dynamicPart: Record<string, any> = {};

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
export function separateStatusFields(statusMappings: Record<string, any>): {
  staticFields: Record<string, any>;
  dynamicFields: Record<string, any>;
} {
  const staticFields: Record<string, any> = {};
  const dynamicFields: Record<string, any> = {};

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
      const { staticPart, dynamicPart, hasStatic, hasDynamic } = separateNestedObject(fieldValue);

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
  statusMappings: Record<string, any>,
  resources: Record<string, KubernetesResource>
): CelValidationResult {
  const errors: CelValidationError[] = [];
  const warnings: CelValidationError[] = [];
  const resourceIds = new Set(
    Object.values(resources)
      .map((r) => r.id)
      .filter(Boolean)
  );

  // Separate static and dynamic fields
  const { staticFields, dynamicFields } = separateStatusFields(statusMappings);

  // Only validate dynamic fields that will be sent to Kro
  function validateExpression(fieldName: string, value: any): void {
    if (isCelExpression(value)) {
      const expression = value.expression;

      // Check for direct resource references (resourceId.status.field, resourceId.spec.field, resourceId.metadata.field)
      // This is the most important validation - ensuring referenced resources actually exist
      const directResourceRefPattern = /\b([a-zA-Z][a-zA-Z0-9]*)\.(status|spec|metadata)\./g;
      let directMatch: RegExpExecArray | null = directResourceRefPattern.exec(expression);
      while (directMatch !== null) {
        const referencedId = directMatch[1];
        if (referencedId !== 'schema' && !resourceIds.has(referencedId)) {
          errors.push({
            field: fieldName,
            expression,
            error: `Referenced resource '${referencedId}' does not exist`,
            suggestion: `Available resources: ${Array.from(resourceIds).join(', ')}`,
          });
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

  // Log info about field separation for debugging
  const staticFieldNames = Object.keys(staticFields);
  const _dynamicFieldNames = Object.keys(dynamicFields);

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
  statusMappings?: Record<string, any>
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
