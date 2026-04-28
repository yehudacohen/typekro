/**
 * Comprehensive resource type validator for KubernetesRef objects.
 *
 * Validates KubernetesRef field paths against known Kubernetes resource patterns,
 * performs type compatibility checking, and supports custom schema validators.
 */

import { ensureError } from '../../errors.js';
import type { KubernetesRef } from '../../types/common.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { SchemaProxy } from '../../types/serialization.js';

/**
 * Resource type validation result
 */
export interface ResourceTypeValidationResult {
  /** The field path that was validated */
  fieldPath: string;

  /** The KubernetesRef that was validated */
  reference: KubernetesRef<unknown>;

  /** Whether the type validation passed */
  valid: boolean;

  /** Expected type */
  expectedType: string;

  /** Actual type (if determinable) */
  actualType?: string;

  /** Validation error message */
  error?: string;
}

/**
 * Context for resource type validation
 */
export interface ResourceTypeValidationContext {
  /** Available resources for validation */
  availableResources?: Record<string, Enhanced<unknown, unknown>> | undefined;

  /** Schema proxy for schema validation */
  schemaProxy?: SchemaProxy<Record<string, unknown>, Record<string, unknown>> | undefined;

  /** Type of schema being validated */
  schemaType?: string;

  /** Whether to perform strict type checking */
  strictTypeChecking?: boolean;
}

/**
 * Information about a resource type
 */
export interface ResourceTypeInfo {
  /** API version of the resource */
  apiVersion: string;

  /** Kind of the resource */
  kind: string;

  /** Common fields and their types */
  commonFields: Record<string, string>;
}

/**
 * Schema validator interface
 */
export interface SchemaValidator {
  /** Validate a field in the schema */
  validateField(fieldPath: string, expectedType?: unknown): SchemaFieldValidationResult;
}

/**
 * Result of schema field validation
 */
export interface SchemaFieldValidationResult {
  /** Whether the validation passed */
  valid: boolean;

  /** Error message if validation failed */
  error?: string;

  /** Actual type of the field */
  actualType?: string;
}

/**
 * Result of field path validation
 */
export interface FieldPathValidationResult {
  /** Whether the validation passed */
  valid: boolean;

  /** Error message if validation failed */
  error?: string;

  /** Actual type of the field */
  actualType?: string | undefined;
}

/**
 * Result of type compatibility validation
 */
export interface TypeCompatibilityValidationResult {
  /** Whether the types are compatible */
  valid: boolean;

  /** Error message if validation failed */
  error?: string;

  /** Actual type found */
  actualType?: string;
}

/**
 * Comprehensive resource type validator for KubernetesRef objects.
 * Validates schema references, resource references, field path patterns,
 * and type compatibility.
 */
export class ResourceTypeValidator {
  private knownResourceTypes: Map<string, ResourceTypeInfo>;
  private schemaValidators: Map<string, SchemaValidator>;

  constructor() {
    this.knownResourceTypes = new Map();
    this.schemaValidators = new Map();
    this.initializeKnownTypes();
  }

  /**
   * Validate a KubernetesRef for type correctness
   */
  validateKubernetesRef(
    ref: KubernetesRef<unknown>,
    context: ResourceTypeValidationContext
  ): ResourceTypeValidationResult {
    const result: ResourceTypeValidationResult = {
      fieldPath: `${ref.resourceId}.${ref.fieldPath}`,
      reference: ref,
      valid: true,
      expectedType: ref._type ? String(ref._type) : 'unknown',
    };

    try {
      if (ref.resourceId === '__schema__') {
        return this.validateSchemaRef(ref, context, result);
      } else {
        return this.validateResourceRef(ref, context, result);
      }
    } catch (error: unknown) {
      result.valid = false;
      result.error = ensureError(error).message;
      return result;
    }
  }

  /**
   * Validate a schema reference
   */
  private validateSchemaRef(
    ref: KubernetesRef<unknown>,
    context: ResourceTypeValidationContext,
    result: ResourceTypeValidationResult
  ): ResourceTypeValidationResult {
    if (!context.schemaProxy) {
      result.valid = false;
      result.error = 'Schema proxy not available for validation';
      return result;
    }

    // Validate field path structure
    const pathValidation = this.validateSchemaFieldPath(ref.fieldPath);
    if (!pathValidation.valid) {
      result.valid = false;
      result.error = pathValidation.error || 'Validation failed';
      return result;
    }

    // Validate against schema if available
    const schemaValidator = this.schemaValidators.get(context.schemaType || 'default');
    if (schemaValidator) {
      const schemaValidation = schemaValidator.validateField(ref.fieldPath, ref._type);
      if (!schemaValidation.valid) {
        result.valid = false;
        result.error = schemaValidation.error || 'Schema validation failed';
        result.actualType = schemaValidation.actualType || 'unknown';
      }
    }

    return result;
  }

  /**
   * Validate a resource reference
   */
  private validateResourceRef(
    ref: KubernetesRef<unknown>,
    context: ResourceTypeValidationContext,
    result: ResourceTypeValidationResult
  ): ResourceTypeValidationResult {
    // Check if resource exists
    const resource = context.availableResources?.[ref.resourceId];
    if (!resource) {
      result.valid = false;
      result.error = `Resource '${ref.resourceId}' not found`;
      return result;
    }

    // Validate field path structure
    const pathValidation = this.validateResourceFieldPath(ref.fieldPath, resource);
    if (!pathValidation.valid) {
      result.valid = false;
      result.error = pathValidation.error || 'Path validation failed';
      result.actualType = pathValidation.actualType || 'unknown';
      return result;
    }

    // Validate type compatibility
    const typeValidation = this.validateTypeCompatibility(ref, resource);
    if (!typeValidation.valid) {
      result.valid = false;
      result.error = typeValidation.error || 'Type validation failed';
      result.actualType = typeValidation.actualType || 'unknown';
    }

    return result;
  }

  /**
   * Validate schema field path structure
   */
  private validateSchemaFieldPath(fieldPath: string): FieldPathValidationResult {
    const parts = fieldPath.split('.');

    if (parts.length < 2) {
      return {
        valid: false,
        error: 'Schema field path must have at least 2 parts (e.g., spec.name)',
      };
    }

    const rootField = parts[0];
    if (rootField !== 'spec' && rootField !== 'status') {
      return {
        valid: false,
        error: `Schema field path must start with 'spec' or 'status', got '${rootField}'`,
      };
    }

    return { valid: true };
  }

  /**
   * Validate resource field path structure
   */
  private validateResourceFieldPath(
    fieldPath: string,
    resource: Enhanced<unknown, unknown>
  ): FieldPathValidationResult {
    const parts = fieldPath.split('.');

    if (parts.length === 0) {
      return {
        valid: false,
        error: 'Field path cannot be empty',
      };
    }

    const rootField = parts[0];
    const validRootFields = ['metadata', 'spec', 'status'];

    if (!rootField || !validRootFields.includes(rootField)) {
      return {
        valid: false,
        error: `Invalid root field '${rootField || 'undefined'}'. Must be one of: ${validRootFields.join(', ')}`,
      };
    }

    // Validate specific field patterns
    const patternValidation = this.validateFieldPattern(fieldPath);
    if (!patternValidation.valid) {
      return patternValidation;
    }

    // Try to infer actual type from resource
    const actualType = this.inferFieldType(fieldPath, resource);

    return {
      valid: true,
      actualType: actualType || 'unknown',
    };
  }

  /**
   * Validate field patterns against known Kubernetes patterns
   */
  private validateFieldPattern(fieldPath: string): FieldPathValidationResult {
    // Known valid patterns
    const validPatterns = [
      // Metadata fields
      { pattern: /^metadata\.(name|namespace|uid|resourceVersion|generation)$/, type: 'string' },
      { pattern: /^metadata\.labels\..+$/, type: 'string' },
      { pattern: /^metadata\.annotations\..+$/, type: 'string' },

      // Common spec fields
      { pattern: /^spec\.replicas$/, type: 'number' },
      { pattern: /^spec\.selector\.matchLabels\..+$/, type: 'string' },

      // Common status fields
      { pattern: /^status\.ready$/, type: 'boolean' },
      {
        pattern: /^status\.(replicas|readyReplicas|availableReplicas|unavailableReplicas)$/,
        type: 'number',
      },
      { pattern: /^status\.conditions\[\d+\]\.(type|status|reason|message)$/, type: 'string' },
      { pattern: /^status\.conditions\[\d+\]\.lastTransitionTime$/, type: 'string' },
      { pattern: /^status\.loadBalancer\.ingress\[\d+\]\.(ip|hostname)$/, type: 'string' },
      { pattern: /^status\.(podIP|hostIP)$/, type: 'string' },
      { pattern: /^status\.phase$/, type: 'string' },

      // Generic patterns
      { pattern: /^spec\./, type: 'unknown' },
      { pattern: /^status\./, type: 'unknown' },
    ];

    const matchingPattern = validPatterns.find((p) => p.pattern.test(fieldPath));

    if (!matchingPattern) {
      return {
        valid: false,
        error: `Field path '${fieldPath}' does not match any known Kubernetes field patterns`,
      };
    }

    return {
      valid: true,
      actualType: matchingPattern.type,
    };
  }

  /**
   * Validate type compatibility between expected and actual types
   */
  private validateTypeCompatibility(
    ref: KubernetesRef<unknown>,
    resource: Enhanced<unknown, unknown>
  ): TypeCompatibilityValidationResult {
    if (!ref._type) {
      // No expected type specified, assume compatible
      return { valid: true };
    }

    const expectedType = String(ref._type);
    const actualType = this.inferFieldType(ref.fieldPath, resource);

    if (!actualType || actualType === 'unknown') {
      // Cannot determine actual type, assume compatible
      return { valid: true };
    }

    // Check type compatibility
    const compatible = this.areTypesCompatible(expectedType, actualType);

    if (!compatible) {
      return {
        valid: false,
        error: `Type mismatch: expected '${expectedType}' but field has type '${actualType}'`,
        actualType,
      };
    }

    return { valid: true, actualType };
  }

  /**
   * Check if two types are compatible
   */
  private areTypesCompatible(expectedType: string, actualType: string): boolean {
    // Exact match
    if (expectedType === actualType) {
      return true;
    }

    // Compatible type mappings
    const compatibleTypes: Record<string, string[]> = {
      string: ['string', 'unknown'],
      number: ['number', 'integer', 'float', 'unknown'],
      boolean: ['boolean', 'unknown'],
      object: ['object', 'unknown'],
      array: ['array', 'unknown'],
      unknown: ['string', 'number', 'boolean', 'object', 'array', 'unknown'],
    };

    const compatibleWithExpected = compatibleTypes[expectedType] || [];
    return compatibleWithExpected.includes(actualType);
  }

  /**
   * Infer the type of a field from a resource
   */
  private inferFieldType(fieldPath: string, _resource: Enhanced<unknown, unknown>): string | undefined {
    // Try to infer type from field path patterns
    if (
      fieldPath.includes('replicas') ||
      fieldPath.includes('generation') ||
      fieldPath.includes('port')
    ) {
      return 'number';
    }

    if (fieldPath.includes('ready') || fieldPath.includes('enabled')) {
      return 'boolean';
    }

    if (
      fieldPath.includes('name') ||
      fieldPath.includes('namespace') ||
      fieldPath.includes('ip') ||
      fieldPath.includes('phase')
    ) {
      return 'string';
    }

    if (
      fieldPath.includes('labels') ||
      fieldPath.includes('annotations') ||
      fieldPath.includes('selector')
    ) {
      return 'object';
    }

    if (fieldPath.includes('conditions') || fieldPath.includes('ingress')) {
      return 'array';
    }

    return 'unknown';
  }

  /**
   * Initialize known resource types
   */
  private initializeKnownTypes(): void {
    // Common Kubernetes resource types
    this.knownResourceTypes.set('Deployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      commonFields: {
        'metadata.name': 'string',
        'metadata.namespace': 'string',
        'spec.replicas': 'number',
        'status.readyReplicas': 'number',
        'status.availableReplicas': 'number',
      },
    });

    this.knownResourceTypes.set('Service', {
      apiVersion: 'v1',
      kind: 'Service',
      commonFields: {
        'metadata.name': 'string',
        'metadata.namespace': 'string',
        'spec.type': 'string',
        'spec.ports': 'array',
        'status.loadBalancer.ingress': 'array',
      },
    });

    this.knownResourceTypes.set('Pod', {
      apiVersion: 'v1',
      kind: 'Pod',
      commonFields: {
        'metadata.name': 'string',
        'metadata.namespace': 'string',
        'status.phase': 'string',
        'status.podIP': 'string',
        'status.hostIP': 'string',
      },
    });
  }

  /**
   * Register a custom schema validator
   */
  registerSchemaValidator(schemaType: string, validator: SchemaValidator): void {
    this.schemaValidators.set(schemaType, validator);
  }

  /**
   * Register a custom resource type
   */
  registerResourceType(name: string, typeInfo: ResourceTypeInfo): void {
    this.knownResourceTypes.set(name, typeInfo);
  }
}
