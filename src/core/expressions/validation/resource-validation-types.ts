/**
 * Resource Reference Validation Types
 *
 * Type definitions, error classes, and warning classes for resource
 * reference validation during JavaScript to CEL expression conversion.
 */

import { TypeKroError } from '../../errors.js';
import type { TypeInfo } from './type-safety.js';

/**
 * Resource reference validation result
 */
export interface ResourceValidationResult {
  /** Whether the resource reference is valid */
  valid: boolean;

  /** Resolved type of the resource reference */
  resolvedType?: TypeInfo;

  /** Validation errors */
  errors: ResourceValidationError[];

  /** Validation warnings */
  warnings: ResourceValidationWarning[];

  /** Suggested fixes */
  suggestions: string[];

  /** Additional metadata about the reference */
  metadata: ResourceValidationMetadata;
}

/**
 * Resource validation error
 */
export class ResourceValidationError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceRef: string,
    public readonly errorType: ResourceValidationErrorType,
    public readonly location?: { line: number; column: number }
  ) {
    super(message, 'RESOURCE_VALIDATION_ERROR', {
      resourceRef,
      errorType,
      location,
    });
    this.name = 'ResourceValidationError';
  }

  static forResourceNotFound(
    resourceRef: string,
    resourceId: string,
    availableResources: string[],
    location?: { line: number; column: number }
  ): ResourceValidationError {
    return new ResourceValidationError(
      `Resource '${resourceId}' not found. Available resources: ${availableResources.join(', ')}`,
      resourceRef,
      'RESOURCE_NOT_FOUND',
      location
    );
  }

  static forInvalidFieldPath(
    resourceRef: string,
    fieldPath: string,
    resourceType: string,
    location?: { line: number; column: number }
  ): ResourceValidationError {
    return new ResourceValidationError(
      `Field path '${fieldPath}' is not valid for resource type '${resourceType}'`,
      resourceRef,
      'INVALID_FIELD_PATH',
      location
    );
  }

  static forTypeIncompatibility(
    resourceRef: string,
    expectedType: string,
    actualType: string,
    location?: { line: number; column: number }
  ): ResourceValidationError {
    return new ResourceValidationError(
      `Type incompatibility: expected '${expectedType}', got '${actualType}'`,
      resourceRef,
      'TYPE_INCOMPATIBILITY',
      location
    );
  }

  static forCircularReference(
    resourceRef: string,
    dependencyChain: string[],
    location?: { line: number; column: number }
  ): ResourceValidationError {
    return new ResourceValidationError(
      `Circular reference detected: ${dependencyChain.join(' -> ')} -> ${resourceRef}`,
      resourceRef,
      'CIRCULAR_REFERENCE',
      location
    );
  }

  static forSchemaFieldNotFound(
    resourceRef: string,
    fieldPath: string,
    availableFields: string[],
    location?: { line: number; column: number }
  ): ResourceValidationError {
    return new ResourceValidationError(
      `Schema field '${fieldPath}' not found. Available fields: ${availableFields.join(', ')}`,
      resourceRef,
      'SCHEMA_FIELD_NOT_FOUND',
      location
    );
  }
}

/**
 * Resource validation warning
 */
export class ResourceValidationWarning {
  constructor(
    public readonly message: string,
    public readonly resourceRef: string,
    public readonly warningType: ResourceValidationWarningType,
    public readonly location?: { line: number; column: number }
  ) {}

  static forPotentialNullAccess(
    resourceRef: string,
    fieldPath: string,
    location?: { line: number; column: number }
  ): ResourceValidationWarning {
    return new ResourceValidationWarning(
      `Field '${fieldPath}' may be null or undefined at runtime`,
      resourceRef,
      'POTENTIAL_NULL_ACCESS',
      location
    );
  }

  static forDeprecatedField(
    resourceRef: string,
    fieldPath: string,
    replacement?: string,
    location?: { line: number; column: number }
  ): ResourceValidationWarning {
    const message = replacement
      ? `Field '${fieldPath}' is deprecated, use '${replacement}' instead`
      : `Field '${fieldPath}' is deprecated`;

    return new ResourceValidationWarning(message, resourceRef, 'DEPRECATED_FIELD', location);
  }

  static forPerformanceImpact(
    resourceRef: string,
    reason: string,
    location?: { line: number; column: number }
  ): ResourceValidationWarning {
    return new ResourceValidationWarning(
      `Potential performance impact: ${reason}`,
      resourceRef,
      'PERFORMANCE_IMPACT',
      location
    );
  }
}

/**
 * Resource validation metadata
 */
export interface ResourceValidationMetadata {
  /** Type of resource being referenced */
  resourceType: string;

  /** Whether the field is optional */
  fieldOptional: boolean;

  /** Whether the field can be null */
  fieldNullable: boolean;

  /** Dependency depth (how many levels deep the reference goes) */
  dependencyDepth: number;

  /** Whether this is a status field reference */
  isStatusField: boolean;

  /** Whether this is a spec field reference */
  isSpecField: boolean;

  /** Whether this is a metadata field reference */
  isMetadataField: boolean;

  /** API version of the resource */
  apiVersion?: string;

  /** Kind of the resource */
  kind?: string;
}

/**
 * Error and warning types
 */
export type ResourceValidationErrorType =
  | 'RESOURCE_NOT_FOUND'
  | 'INVALID_FIELD_PATH'
  | 'TYPE_INCOMPATIBILITY'
  | 'CIRCULAR_REFERENCE'
  | 'SCHEMA_FIELD_NOT_FOUND';

export type ResourceValidationWarningType =
  | 'POTENTIAL_NULL_ACCESS'
  | 'DEPRECATED_FIELD'
  | 'PERFORMANCE_IMPACT'
  | 'UNKNOWN_RESOURCE'
  | 'UNKNOWN_FIELD';

/**
 * Validation context
 */
export interface ValidationContext {
  /** Whether to check for circular dependencies */
  checkCircularDependencies?: boolean;

  /** Current dependency chain for circular reference detection */
  dependencyChain?: string[];

  /** Whether to skip cache lookup */
  skipCache?: boolean;

  /** Strict mode enables additional validations */
  strictMode?: boolean;
}
