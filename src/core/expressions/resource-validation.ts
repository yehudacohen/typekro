/**
 * Resource Reference Type Validation
 * 
 * This module provides validation for resource references during JavaScript
 * to CEL expression conversion. It ensures that resource references are
 * type-safe and that field paths are valid.
 */

import type { KubernetesRef } from '../types/common.js';
import type { Enhanced } from '../types/kubernetes.js';
import type { SchemaProxy } from '../types/serialization.js';
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
export class ResourceValidationError extends Error {
  constructor(
    message: string,
    public readonly resourceRef: string,
    public readonly errorType: ResourceValidationErrorType,
    public readonly location?: { line: number; column: number }
  ) {
    super(message);
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
    
    return new ResourceValidationWarning(
      message,
      resourceRef,
      'DEPRECATED_FIELD',
      location
    );
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
 * Resource reference validator
 */
export class ResourceReferenceValidator {
  private validationCache = new Map<string, ResourceValidationResult>();
  private dependencyGraph = new Map<string, Set<string>>();
  
  /**
   * Validate a KubernetesRef object
   */
  validateKubernetesRef(
    ref: KubernetesRef<any>,
    availableResources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<any, any>,
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
        metadata
      };
      
      // Cache the result
      this.validationCache.set(refKey, result);
      return result;
    } catch (error) {
      const validationError = new ResourceValidationError(
        `Validation failed: ${error instanceof Error ? error.message : String(error)}`,
        refKey,
        'INVALID_FIELD_PATH'
      );
      
      const result: ResourceValidationResult = {
        valid: false,
        errors: [validationError],
        warnings,
        suggestions,
        metadata: this.createDefaultMetadata()
      };
      
      this.validationCache.set(refKey, result);
      return result;
    }
  }
  
  /**
   * Validate multiple KubernetesRef objects
   */
  validateKubernetesRefs(
    refs: KubernetesRef<any>[],
    availableResources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<any, any>,
    context?: ValidationContext
  ): ResourceValidationResult[] {
    return refs.map(ref => this.validateKubernetesRef(ref, availableResources, schemaProxy, context));
  }
  
  /**
   * Validate that a resource reference chain is type-safe
   */
  validateReferenceChain(
    refs: KubernetesRef<any>[],
    availableResources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<any, any>
  ): ResourceValidationResult {
    const errors: ResourceValidationError[] = [];
    const warnings: ResourceValidationWarning[] = [];
    const suggestions: string[] = [];
    
    // Build dependency chain
    const dependencyChain = refs.map(ref => `${ref.resourceId}.${ref.fieldPath}`);
    
    // Check for circular dependencies by looking for duplicates
    const seen = new Set<string>();
    for (const refKey of dependencyChain) {
      if (seen.has(refKey)) {
        // Found a circular dependency
        const circularIndex = dependencyChain.indexOf(refKey);
        const circularChain = dependencyChain.slice(circularIndex);
        errors.push(ResourceValidationError.forCircularReference(
          refKey,
          circularChain
        ));
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
        skipCache: false
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
    
    const resolvedType = refs.length > 0 ? this.getChainResultType(refs) : undefined;
    return {
      valid: errors.length === 0,
      ...(resolvedType && { resolvedType }),
      errors,
      warnings,
      suggestions,
      metadata: this.createDefaultMetadata()
    };
  }
  
  /**
   * Validate schema reference
   */
  private validateSchemaReference(
    ref: KubernetesRef<any>,
    schemaProxy?: SchemaProxy<any, any>,
    _context?: ValidationContext
  ): ResourceValidationResult {
    const errors: ResourceValidationError[] = [];
    const warnings: ResourceValidationWarning[] = [];
    const suggestions: string[] = [];
    
    if (!schemaProxy) {
      errors.push(new ResourceValidationError(
        'Schema reference used but no schema proxy available',
        `${ref.resourceId}.${ref.fieldPath}`,
        'SCHEMA_FIELD_NOT_FOUND'
      ));
      
      return {
        valid: false,
        errors,
        warnings,
        suggestions,
        metadata: this.createDefaultMetadata()
      };
    }
    
    // Validate field path exists in schema
    const fieldType = this.getSchemaFieldType(schemaProxy, ref.fieldPath);
    if (!fieldType) {
      const availableFields = this.getAvailableSchemaFields(schemaProxy);
      errors.push(ResourceValidationError.forSchemaFieldNotFound(
        `${ref.resourceId}.${ref.fieldPath}`,
        ref.fieldPath,
        availableFields
      ));
      
      // Suggest similar field names
      const similarFields = this.findSimilarFieldNames(ref.fieldPath, availableFields);
      if (similarFields.length > 0) {
        suggestions.push(`Did you mean: ${similarFields.join(', ')}?`);
      }
    }
    
    // Check for potential null access
    if (fieldType && (fieldType.optional || fieldType.nullable)) {
      warnings.push(ResourceValidationWarning.forPotentialNullAccess(
        `${ref.resourceId}.${ref.fieldPath}`,
        ref.fieldPath
      ));
      suggestions.push('Consider using optional chaining (?.) for safer access');
    }
    
    const metadata: ResourceValidationMetadata = {
      resourceType: 'Schema',
      fieldOptional: fieldType?.optional || false,
      fieldNullable: fieldType?.nullable || false,
      dependencyDepth: ref.fieldPath.split('.').length,
      isStatusField: ref.fieldPath.startsWith('status.'),
      isSpecField: ref.fieldPath.startsWith('spec.'),
      isMetadataField: ref.fieldPath.startsWith('metadata.')
    };
    
    return {
      valid: errors.length === 0,
      ...(fieldType && { resolvedType: fieldType }),
      errors,
      warnings,
      suggestions,
      metadata
    };
  }
  
  /**
   * Validate resource reference
   */
  private validateResourceReference(
    ref: KubernetesRef<any>,
    availableResources: Record<string, Enhanced<any, any>>,
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
      errors.push(new ResourceValidationError(
        `Resource '${ref.resourceId}' not found. Available resources: ${availableResourceIds.join(', ')}`,
        `${ref.resourceId}.${ref.fieldPath}`,
        'RESOURCE_NOT_FOUND' as ResourceValidationErrorType
      ));
      
      // Suggest similar resource names
      const similarResources = this.findSimilarResourceNames(ref.resourceId, availableResourceIds);
      if (similarResources.length > 0) {
        suggestions.push(`Did you mean: ${similarResources.join(', ')}?`);
      }
      
      return {
        valid: false, // Invalid when resource not found
        errors,
        warnings,
        suggestions,
        metadata: this.createDefaultMetadata()
      };
    }
    
    // Validate field path on resource
    const fieldType = this.getResourceFieldType(resource, ref.fieldPath);
    const availableFields = this.getAvailableResourceFields(resource);
    
    // Check if field path is potentially invalid (but be lenient for common patterns)
    const isCommonField = this.isCommonKubernetesField(ref.fieldPath);
    if (!fieldType && !isCommonField) {
      // Unknown fields are errors by default
      errors.push(new ResourceValidationError(
        `Field path '${ref.fieldPath}' is not valid for resource type '${resource.constructor.name}'`,
        `${ref.resourceId}.${ref.fieldPath}`,
        'INVALID_FIELD_PATH' as ResourceValidationErrorType
      ));
      
      // Suggest similar field names
      const similarFields = this.findSimilarFieldNames(ref.fieldPath, availableFields);
      if (similarFields.length > 0) {
        suggestions.push(`Did you mean: ${similarFields.join(', ')}?`);
      }
    }
    
    // Check for potential null access
    if (fieldType && (fieldType.optional || fieldType.nullable)) {
      warnings.push(ResourceValidationWarning.forPotentialNullAccess(
        `${ref.resourceId}.${ref.fieldPath}`,
        ref.fieldPath
      ));
    }
    
    // Check for deprecated fields
    if (this.isDeprecatedField(resource, ref.fieldPath)) {
      const replacement = this.getFieldReplacement(resource, ref.fieldPath);
      warnings.push(ResourceValidationWarning.forDeprecatedField(
        `${ref.resourceId}.${ref.fieldPath}`,
        ref.fieldPath,
        replacement
      ));
    }
    
    // Check for performance implications
    if (this.hasPerformanceImplications(resource, ref.fieldPath)) {
      warnings.push(ResourceValidationWarning.forPerformanceImpact(
        `${ref.resourceId}.${ref.fieldPath}`,
        'Accessing this field may require additional API calls'
      ));
    }
    
    const apiVersion = this.getResourceApiVersion(resource);
    const kind = this.getResourceKind(resource);
    const metadata: ResourceValidationMetadata = {
      resourceType: resource.constructor.name,
      fieldOptional: fieldType?.optional || false,
      fieldNullable: fieldType?.nullable || false,
      dependencyDepth: ref.fieldPath.split('.').length,
      isStatusField: ref.fieldPath.startsWith('status.'),
      isSpecField: ref.fieldPath.startsWith('spec.'),
      isMetadataField: ref.fieldPath.startsWith('metadata.'),
      ...(apiVersion && { apiVersion }),
      ...(kind && { kind })
    };
    
    return {
      valid: errors.length === 0,
      ...(fieldType && { resolvedType: fieldType }),
      errors,
      warnings,
      suggestions,
      metadata
    };
  }
  
  /**
   * Check for circular dependencies
   */
  private checkCircularDependencies(
    ref: KubernetesRef<any>,
    dependencyChain: string[]
  ): { valid: boolean; errors: ResourceValidationError[] } {
    const refKey = `${ref.resourceId}.${ref.fieldPath}`;
    
    if (dependencyChain.includes(refKey)) {
      return {
        valid: false,
        errors: [ResourceValidationError.forCircularReference(
          refKey,
          dependencyChain
        )]
      };
    }
    
    return { valid: true, errors: [] };
  }
  
  /**
   * Utility methods for type resolution
   */
  private getSchemaFieldType(_schemaProxy: SchemaProxy<any, any>, _fieldPath: string): TypeInfo | undefined {
    // This would integrate with the actual schema type system
    // For now, return a placeholder
    return { typeName: 'unknown', optional: false, nullable: false };
  }
  
  private getResourceFieldType(_resource: Enhanced<any, any>, fieldPath: string): TypeInfo | undefined {
    // This would integrate with the Enhanced type system
    // For now, return a placeholder based on common Kubernetes field patterns
    
    // Define known valid field patterns - be very specific
    const validFieldPatterns = [
      'metadata.name',
      'metadata.namespace',
      'metadata.labels',
      'spec.replicas',
      'spec.selector',
      'spec.template',
      'spec.ports',
      'status.ready',
      'status.readyReplicas', // Note: 'status.readyReplica' (without 's') is NOT valid
      'status.availableReplicas',
      'status.conditions',
      'status.phase',
      'status.podIP',
      'status.clusterIP',
      'status.loadBalancer'
    ];
    
    // Check if the field path exactly matches a known pattern
    const isExactMatch = validFieldPatterns.includes(fieldPath);
    
    // Check if it starts with a valid prefix and has additional nested fields
    const hasValidPrefix = validFieldPatterns.some(pattern => {
      if (fieldPath.startsWith(`${pattern}.`)) return true;
      
      // Handle array indexing like loadBalancer.ingress[0].ip
      const fieldWithArrayPattern = fieldPath.replace(/\[\d+\]/g, '');
      if (fieldWithArrayPattern.startsWith(`${pattern}.`)) return true;
      
      return false;
    });
    
    const isValidField = isExactMatch || hasValidPrefix;
    
    // Return type info only for valid fields
    if (fieldPath.startsWith('metadata.') && isValidField) {
      return { typeName: 'string', optional: true, nullable: false };
    }
    
    if (fieldPath.startsWith('spec.') && isValidField) {
      return { typeName: 'unknown', optional: false, nullable: false };
    }
    
    if (fieldPath.startsWith('status.') && isValidField) {
      return { typeName: 'unknown', optional: true, nullable: true };
    }
    
    // Return undefined for invalid fields (including typos like 'status.readyReplica')
    return undefined;
  }
  
  private getAvailableSchemaFields(_schemaProxy: SchemaProxy<any, any>): string[] {
    // This would extract available fields from the schema
    return ['spec.name', 'spec.replicas', 'status.ready', 'metadata.name'];
  }
  
  private getAvailableResourceFields(resource: Enhanced<any, any>): string[] {
    const resourceKind = resource.constructor.name;
    
    // Common fields for different resource types
    const fieldsByKind: Record<string, string[]> = {
      'Deployment': [
        'metadata.name', 'metadata.namespace', 'metadata.labels', 'metadata.annotations',
        'spec.replicas', 'spec.selector', 'spec.template', 'spec.strategy',
        'status.replicas', 'status.readyReplicas', 'status.availableReplicas', 
        'status.unavailableReplicas', 'status.conditions'
      ],
      'Service': [
        'metadata.name', 'metadata.namespace', 'metadata.labels', 'metadata.annotations',
        'spec.type', 'spec.ports', 'spec.selector', 'spec.clusterIP',
        'status.loadBalancer', 'status.conditions'
      ],
      'Pod': [
        'metadata.name', 'metadata.namespace', 'metadata.labels', 'metadata.annotations',
        'spec.containers', 'spec.volumes', 'spec.nodeSelector',
        'status.phase', 'status.conditions', 'status.hostIP', 'status.podIP', 
        'status.containerStatuses'
      ],
      'ConfigMap': [
        'metadata.name', 'metadata.namespace', 'metadata.labels', 'metadata.annotations',
        'data', 'binaryData'
      ],
      'Secret': [
        'metadata.name', 'metadata.namespace', 'metadata.labels', 'metadata.annotations',
        'type', 'data', 'stringData'
      ]
    };
    
    return fieldsByKind[resourceKind] || [
      'metadata.name', 'metadata.namespace', 'metadata.labels', 'metadata.annotations',
      'spec', 'status'
    ];
  }
  
  private isCommonKubernetesField(fieldPath: string): boolean {
    // Only consider very specific common fields as valid
    // This is more strict to catch typos like 'status.readyReplica'
    const exactCommonFields = [
      'metadata.name',
      'metadata.namespace',
      'metadata.labels',
      'metadata.annotations',
      'spec.replicas',
      'spec.selector',
      'spec.template',
      'spec.ports',
      'status.ready',
      'status.readyReplicas', // Note: 'status.readyReplica' is NOT in this list
      'status.availableReplicas',
      'status.conditions',
      'status.phase',
      'status.podIP',
      'status.clusterIP',
      'status.loadBalancer',
      'status.loadBalancer.ingress',
      'data',
      'stringData',
      'binaryData'
    ];
    
    // Check for exact matches or valid nested paths
    return exactCommonFields.some(field => {
      if (fieldPath === field) return true;
      if (fieldPath.startsWith(`${field}.`)) return true;
      
      // Handle array indexing like loadBalancer.ingress[0].ip
      const fieldWithArrayPattern = fieldPath.replace(/\[\d+\]/g, '');
      if (fieldWithArrayPattern === field || fieldWithArrayPattern.startsWith(`${field}.`)) return true;
      
      return false;
    });
  }
  
  private findSimilarFieldNames(target: string, available: string[]): string[] {
    // Simple similarity matching - could be improved with better algorithms
    return available.filter(field => {
      const similarity = this.calculateSimilarity(target, field);
      return similarity > 0.6;
    }).slice(0, 3);
  }
  
  private findSimilarResourceNames(target: string, available: string[]): string[] {
    return available.filter(resource => {
      const similarity = this.calculateSimilarity(target, resource);
      return similarity > 0.6;
    }).slice(0, 3);
  }
  
  private calculateSimilarity(str1: string, str2: string): number {
    // Simple Levenshtein distance-based similarity
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }
  
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(0));
    
    for (let i = 0; i <= str1.length; i++) matrix[0]![i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j]![0] = j;
    
    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j]![i] = Math.min(
          matrix[j]?.[i - 1]! + 1,
          matrix[j - 1]?.[i]! + 1,
          matrix[j - 1]?.[i - 1]! + indicator
        );
      }
    }
    
    return matrix[str2.length]?.[str1.length]!;
  }
  
  private isDeprecatedField(_resource: Enhanced<any, any>, fieldPath: string): boolean {
    // This would check against a registry of deprecated fields
    const deprecatedFields = ['spec.serviceAccount', 'spec.securityContext.runAsUser'];
    return deprecatedFields.some(deprecated => fieldPath.startsWith(deprecated));
  }
  
  private getFieldReplacement(_resource: Enhanced<any, any>, fieldPath: string): string | undefined {
    // This would provide replacement suggestions for deprecated fields
    const replacements: Record<string, string> = {
      'spec.serviceAccount': 'spec.serviceAccountName',
      'spec.securityContext.runAsUser': 'spec.securityContext.runAsNonRoot'
    };
    
    return replacements[fieldPath];
  }
  
  private hasPerformanceImplications(_resource: Enhanced<any, any>, fieldPath: string): boolean {
    // This would identify fields that might have performance implications
    const performanceFields = ['status.conditions', 'status.events'];
    return performanceFields.some(field => fieldPath.startsWith(field));
  }
  
  private getResourceApiVersion(_resource: Enhanced<any, any>): string | undefined {
    // Extract API version from resource
    return 'v1'; // Placeholder
  }
  
  private getResourceKind(resource: Enhanced<any, any>): string | undefined {
    // Extract kind from resource
    return resource.constructor.name;
  }
  
  private getChainResultType(refs: KubernetesRef<any>[]): TypeInfo | undefined {
    // Get the type of the final reference in the chain
    if (refs.length === 0) return undefined;
    
    const lastRef = refs[refs.length - 1];
    return lastRef?._type ? { typeName: String(lastRef._type), optional: false, nullable: false } : undefined;
  }
  
  private createDefaultMetadata(): ResourceValidationMetadata {
    return {
      resourceType: 'unknown',
      fieldOptional: false,
      fieldNullable: false,
      dependencyDepth: 0,
      isStatusField: false,
      isSpecField: false,
      isMetadataField: false
    };
  }
  
  /**
   * Clear validation cache
   */
  clearCache(): void {
    this.validationCache.clear();
    this.dependencyGraph.clear();
  }
}

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