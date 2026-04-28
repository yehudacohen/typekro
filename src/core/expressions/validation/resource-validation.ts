/**
 * Resource Reference Type Validation
 *
 * This module provides validation for resource references during JavaScript
 * to CEL expression conversion. It ensures that resource references are
 * type-safe and that field paths are valid.
 */

import { ensureError } from '../../errors.js';
import type { KubernetesRef } from '../../types/common.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { SchemaProxy } from '../../types/serialization.js';

import {
  createDefaultMetadata,
  findSimilarFieldNames,
  findSimilarResourceNames,
  getAvailableResourceFields,
  getAvailableSchemaFields,
  getChainResultType,
  getFieldReplacement,
  getResourceApiVersion,
  getResourceFieldType,
  getResourceKind,
  getSchemaFieldType,
  hasPerformanceImplications,
  isCommonKubernetesField,
  isDeprecatedField,
} from './resource-field-utils.js';
import type {
  ResourceValidationErrorType,
  ResourceValidationMetadata,
  ResourceValidationResult,
  ValidationContext,
} from './resource-validation-types.js';
import { ResourceValidationError, ResourceValidationWarning } from './resource-validation-types.js';
import type { TypeInfo } from './type-safety.js';

export type {
  ResourceValidationErrorType,
  ResourceValidationMetadata,
  ResourceValidationResult,
  ResourceValidationWarningType,
  ValidationContext,
} from './resource-validation-types.js';
// Re-export everything from sub-modules for backward compatibility
export {
  ResourceValidationError,
  ResourceValidationWarning,
} from './resource-validation-types.js';

/**
 * Resource reference validator
 */
export class ResourceReferenceValidator {
  private validationCache = new Map<string, ResourceValidationResult>();
  private dependencyGraph = new Map<string, Set<string>>();

  /**
   * Validate a KubernetesRef object
   */
  validateKubernetesRef(
    ref: KubernetesRef<unknown>,
    availableResources: Record<string, Enhanced<unknown, unknown>>,
    schemaProxy?: SchemaProxy<Record<string, unknown>, Record<string, unknown>>,
    context?: ValidationContext
  ): ResourceValidationResult {
    const refKey = `${ref.resourceId}.${ref.fieldPath}`;

    // Check cache first
    const cached = this.validationCache.get(refKey);
    if (cached && !context?.skipCache) {
      return cached;
    }

    const errors: ResourceValidationError[] = [];
    const warnings: ResourceValidationWarning[] = [];
    const suggestions: string[] = [];

    let resolvedType: TypeInfo | undefined;
    let metadata: ResourceValidationMetadata;

    try {
      if (ref.resourceId === '__schema__') {
        // Validate schema reference
        const result = this.validateSchemaReference(ref, schemaProxy, context);
        resolvedType = result.resolvedType;
        metadata = result.metadata;
        errors.push(...result.errors);
        warnings.push(...result.warnings);
        suggestions.push(...result.suggestions);
      } else {
        // Validate resource reference
        const result = this.validateResourceReference(ref, availableResources, context);
        resolvedType = result.resolvedType;
        metadata = result.metadata;
        errors.push(...result.errors);
        warnings.push(...result.warnings);
        suggestions.push(...result.suggestions);
      }

      // Check for circular dependencies
      if (context?.checkCircularDependencies) {
        const circularCheck = this.checkCircularDependencies(ref, context.dependencyChain || []);
        if (!circularCheck.valid) {
          errors.push(...circularCheck.errors);
        }
      }

      const result: ResourceValidationResult = {
        valid: errors.length === 0,
        ...(resolvedType && { resolvedType }),
        errors,
        warnings,
        suggestions,
        metadata,
      };

      // Cache the result
      this.validationCache.set(refKey, result);
      return result;
    } catch (error: unknown) {
      const validationError = new ResourceValidationError(
        `Validation failed: ${ensureError(error).message}`,
        refKey,
        'INVALID_FIELD_PATH'
      );

      const result: ResourceValidationResult = {
        valid: false,
        errors: [validationError],
        warnings,
        suggestions,
        metadata: createDefaultMetadata(),
      };

      this.validationCache.set(refKey, result);
      return result;
    }
  }

  /**
   * Validate multiple KubernetesRef objects
   */
  validateKubernetesRefs(
    refs: KubernetesRef<unknown>[],
    availableResources: Record<string, Enhanced<unknown, unknown>>,
    schemaProxy?: SchemaProxy<Record<string, unknown>, Record<string, unknown>>,
    context?: ValidationContext
  ): ResourceValidationResult[] {
    return refs.map((ref) =>
      this.validateKubernetesRef(ref, availableResources, schemaProxy, context)
    );
  }

  /**
   * Validate that a resource reference chain is type-safe
   */
  validateReferenceChain(
    refs: KubernetesRef<unknown>[],
    availableResources: Record<string, Enhanced<unknown, unknown>>,
    schemaProxy?: SchemaProxy<Record<string, unknown>, Record<string, unknown>>
  ): ResourceValidationResult {
    const errors: ResourceValidationError[] = [];
    const warnings: ResourceValidationWarning[] = [];
    const suggestions: string[] = [];

    // Build dependency chain
    const dependencyChain = refs.map((ref) => `${ref.resourceId}.${ref.fieldPath}`);

    // Check for circular dependencies by looking for duplicates
    const seen = new Set<string>();
    for (const refKey of dependencyChain) {
      if (seen.has(refKey)) {
        // Found a circular dependency
        const circularIndex = dependencyChain.indexOf(refKey);
        const circularChain = dependencyChain.slice(circularIndex);
        errors.push(ResourceValidationError.forCircularReference(refKey, circularChain));
        break;
      }
      seen.add(refKey);
    }

    // Validate each reference in the chain
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      if (!ref) continue;

      const context: ValidationContext = {
        checkCircularDependencies: true,
        dependencyChain: dependencyChain.slice(0, i),
        skipCache: false,
      };

      const result = this.validateKubernetesRef(ref, availableResources, schemaProxy, context);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
      suggestions.push(...result.suggestions);

      // If this reference is invalid, stop validation
      if (!result.valid) {
        break;
      }
    }

    const resolvedType = refs.length > 0 ? getChainResultType(refs) : undefined;
    return {
      valid: errors.length === 0,
      ...(resolvedType && { resolvedType }),
      errors,
      warnings,
      suggestions,
      metadata: createDefaultMetadata(),
    };
  }

  /**
   * Validate schema reference
   */
  private validateSchemaReference(
    ref: KubernetesRef<unknown>,
    schemaProxy?: SchemaProxy<Record<string, unknown>, Record<string, unknown>>,
    _context?: ValidationContext
  ): ResourceValidationResult {
    const errors: ResourceValidationError[] = [];
    const warnings: ResourceValidationWarning[] = [];
    const suggestions: string[] = [];

    if (!schemaProxy) {
      errors.push(
        new ResourceValidationError(
          'Schema reference used but no schema proxy available',
          `${ref.resourceId}.${ref.fieldPath}`,
          'SCHEMA_FIELD_NOT_FOUND'
        )
      );

      return {
        valid: false,
        errors,
        warnings,
        suggestions,
        metadata: createDefaultMetadata(),
      };
    }

    // Validate field path exists in schema
    const fieldType = getSchemaFieldType(schemaProxy, ref.fieldPath);
    if (!fieldType) {
      const availableFields = getAvailableSchemaFields(schemaProxy);
      errors.push(
        ResourceValidationError.forSchemaFieldNotFound(
          `${ref.resourceId}.${ref.fieldPath}`,
          ref.fieldPath,
          availableFields
        )
      );

      // Suggest similar field names
      const similarFields = findSimilarFieldNames(ref.fieldPath, availableFields);
      if (similarFields.length > 0) {
        suggestions.push(`Did you mean: ${similarFields.join(', ')}?`);
      }
    }

    // Check for potential null access
    if (fieldType && (fieldType.optional || fieldType.nullable)) {
      warnings.push(
        ResourceValidationWarning.forPotentialNullAccess(
          `${ref.resourceId}.${ref.fieldPath}`,
          ref.fieldPath
        )
      );
      suggestions.push('Consider using optional chaining (?.) for safer access');
    }

    const metadata: ResourceValidationMetadata = {
      resourceType: 'Schema',
      fieldOptional: fieldType?.optional || false,
      fieldNullable: fieldType?.nullable || false,
      dependencyDepth: ref.fieldPath.split('.').length,
      isStatusField: ref.fieldPath.startsWith('status.'),
      isSpecField: ref.fieldPath.startsWith('spec.'),
      isMetadataField: ref.fieldPath.startsWith('metadata.'),
    };

    return {
      valid: errors.length === 0,
      ...(fieldType && { resolvedType: fieldType }),
      errors,
      warnings,
      suggestions,
      metadata,
    };
  }

  /**
   * Validate resource reference
   */
  private validateResourceReference(
    ref: KubernetesRef<unknown>,
    availableResources: Record<string, Enhanced<unknown, unknown>>,
    _context?: ValidationContext
  ): ResourceValidationResult {
    const errors: ResourceValidationError[] = [];
    const warnings: ResourceValidationWarning[] = [];
    const suggestions: string[] = [];

    // Check if resource exists
    const resource = availableResources[ref.resourceId];
    if (!resource) {
      const availableResourceIds = Object.keys(availableResources);

      // Missing resources are errors by default
      errors.push(
        new ResourceValidationError(
          `Resource '${ref.resourceId}' not found. Available resources: ${availableResourceIds.join(', ')}`,
          `${ref.resourceId}.${ref.fieldPath}`,
          'RESOURCE_NOT_FOUND' as ResourceValidationErrorType
        )
      );

      // Suggest similar resource names
      const similarResources = findSimilarResourceNames(ref.resourceId, availableResourceIds);
      if (similarResources.length > 0) {
        suggestions.push(`Did you mean: ${similarResources.join(', ')}?`);
      }

      return {
        valid: false, // Invalid when resource not found
        errors,
        warnings,
        suggestions,
        metadata: createDefaultMetadata(),
      };
    }

    // Validate field path on resource
    const fieldType = getResourceFieldType(resource, ref.fieldPath);
    const availableFields = getAvailableResourceFields(resource);

    // Check if field path is potentially invalid (but be lenient for common patterns)
    const isCommonField = isCommonKubernetesField(ref.fieldPath);
    if (!fieldType && !isCommonField) {
      // Unknown fields are errors by default
      errors.push(
        new ResourceValidationError(
          `Field path '${ref.fieldPath}' is not valid for resource type '${resource.constructor.name}'`,
          `${ref.resourceId}.${ref.fieldPath}`,
          'INVALID_FIELD_PATH' as ResourceValidationErrorType
        )
      );

      // Suggest similar field names
      const similarFields = findSimilarFieldNames(ref.fieldPath, availableFields);
      if (similarFields.length > 0) {
        suggestions.push(`Did you mean: ${similarFields.join(', ')}?`);
      }
    }

    // Check for potential null access
    if (fieldType && (fieldType.optional || fieldType.nullable)) {
      warnings.push(
        ResourceValidationWarning.forPotentialNullAccess(
          `${ref.resourceId}.${ref.fieldPath}`,
          ref.fieldPath
        )
      );
    }

    // Check for deprecated fields
    if (isDeprecatedField(resource, ref.fieldPath)) {
      const replacement = getFieldReplacement(resource, ref.fieldPath);
      warnings.push(
        ResourceValidationWarning.forDeprecatedField(
          `${ref.resourceId}.${ref.fieldPath}`,
          ref.fieldPath,
          replacement
        )
      );
    }

    // Check for performance implications
    if (hasPerformanceImplications(resource, ref.fieldPath)) {
      warnings.push(
        ResourceValidationWarning.forPerformanceImpact(
          `${ref.resourceId}.${ref.fieldPath}`,
          'Accessing this field may require additional API calls'
        )
      );
    }

    const apiVersion = getResourceApiVersion(resource);
    const kind = getResourceKind(resource);
    const metadata: ResourceValidationMetadata = {
      resourceType: resource.constructor.name,
      fieldOptional: fieldType?.optional || false,
      fieldNullable: fieldType?.nullable || false,
      dependencyDepth: ref.fieldPath.split('.').length,
      isStatusField: ref.fieldPath.startsWith('status.'),
      isSpecField: ref.fieldPath.startsWith('spec.'),
      isMetadataField: ref.fieldPath.startsWith('metadata.'),
      ...(apiVersion && { apiVersion }),
      ...(kind && { kind }),
    };

    return {
      valid: errors.length === 0,
      ...(fieldType && { resolvedType: fieldType }),
      errors,
      warnings,
      suggestions,
      metadata,
    };
  }

  /**
   * Check for circular dependencies
   */
  private checkCircularDependencies(
    ref: KubernetesRef<unknown>,
    dependencyChain: string[]
  ): { valid: boolean; errors: ResourceValidationError[] } {
    const refKey = `${ref.resourceId}.${ref.fieldPath}`;

    if (dependencyChain.includes(refKey)) {
      return {
        valid: false,
        errors: [ResourceValidationError.forCircularReference(refKey, dependencyChain)],
      };
    }

    return { valid: true, errors: [] };
  }

  /**
   * Clear validation cache
   */
  clearCache(): void {
    this.validationCache.clear();
    this.dependencyGraph.clear();
  }
}
