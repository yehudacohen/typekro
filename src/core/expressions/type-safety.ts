/**
 * Type Safety Integration for JavaScript to CEL Expression Conversion
 * 
 * This module provides TypeScript type system integration for validating
 * JavaScript expressions during conversion to CEL. It ensures type safety
 * throughout the conversion process and provides compile-time validation.
 */

import type { Type } from 'arktype';
import type { CelExpression, KubernetesRef } from '../types/common.js';
import type { Enhanced } from '../types/kubernetes.js';
import type { SchemaProxy } from '../types/serialization.js';

/**
 * Type information for expression validation
 */
export interface TypeInfo {
  /** The TypeScript type name */
  typeName: string;
  
  /** Whether the type is optional */
  optional: boolean;
  
  /** Whether the type is nullable */
  nullable: boolean;
  
  /** Array element type if this is an array */
  elementType?: TypeInfo;
  
  /** Object property types if this is an object */
  properties?: Record<string, TypeInfo>;
  
  /** Union type alternatives if this is a union */
  unionTypes?: TypeInfo[];
  
  /** The original TypeScript type definition */
  originalType?: any;
}

/**
 * Expression type validation result
 */
export interface TypeValidationResult {
  /** Whether the expression is type-safe */
  valid: boolean;
  
  /** Inferred result type of the expression */
  resultType?: TypeInfo;
  
  /** Type validation errors */
  errors: TypeValidationError[];
  
  /** Type warnings (non-blocking issues) */
  warnings: TypeValidationWarning[];
  
  /** Suggested fixes for type issues */
  suggestions: string[];
}

/**
 * Type validation error
 */
export class TypeValidationError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
    public readonly expectedType: TypeInfo,
    public readonly actualType: TypeInfo,
    public readonly location?: { line: number; column: number }
  ) {
    super(message);
    this.name = 'TypeValidationError';
  }
  
  static forTypeMismatch(
    expression: string,
    expectedType: TypeInfo,
    actualType: TypeInfo,
    location?: { line: number; column: number }
  ): TypeValidationError {
    return new TypeValidationError(
      `Type mismatch: expected ${expectedType.typeName}, got ${actualType.typeName}`,
      expression,
      expectedType,
      actualType,
      location
    );
  }
  
  static forUndefinedProperty(
    expression: string,
    propertyName: string,
    objectType: TypeInfo,
    location?: { line: number; column: number }
  ): TypeValidationError {
    return new TypeValidationError(
      `Property '${propertyName}' does not exist on type '${objectType.typeName}'`,
      expression,
      { typeName: 'undefined', optional: false, nullable: false },
      objectType,
      location
    );
  }
  
  static forInvalidOperation(
    expression: string,
    operation: string,
    leftType: TypeInfo,
    rightType: TypeInfo,
    location?: { line: number; column: number }
  ): TypeValidationError {
    return new TypeValidationError(
      `Cannot apply operator '${operation}' to types '${leftType.typeName}' and '${rightType.typeName}'`,
      expression,
      { typeName: 'boolean', optional: false, nullable: false },
      { typeName: 'invalid', optional: false, nullable: false },
      location
    );
  }
}

/**
 * Type validation warning
 */
export class TypeValidationWarning {
  constructor(
    public readonly message: string,
    public readonly expression: string,
    public readonly location?: { line: number; column: number }
  ) {}
  
  static forPotentialNullAccess(
    expression: string,
    location?: { line: number; column: number }
  ): TypeValidationWarning {
    return new TypeValidationWarning(
      `Potential null/undefined access - consider using optional chaining (?.)`,
      expression,
      location
    );
  }
  
  static forImplicitTypeCoercion(
    expression: string,
    fromType: string,
    toType: string,
    location?: { line: number; column: number }
  ): TypeValidationWarning {
    return new TypeValidationWarning(
      `Implicit type coercion from ${fromType} to ${toType}`,
      expression,
      location
    );
  }
}

/**
 * Type safety validator for JavaScript expressions
 */
export class ExpressionTypeValidator {
  
  /**
   * Validate the types in a JavaScript expression
   */
  validateExpression(
    expression: string,
    availableTypes: Record<string, TypeInfo>,
    expectedResultType?: TypeInfo
  ): TypeValidationResult {
    try {
      // Parse the expression to understand its structure
      const expressionType = this.inferExpressionType(expression, availableTypes);
      
      const errors: TypeValidationError[] = [];
      const warnings: TypeValidationWarning[] = [];
      const suggestions: string[] = [];
      
      // Validate against expected result type if provided
      if (expectedResultType && !this.isTypeCompatible(expressionType, expectedResultType)) {
        errors.push(TypeValidationError.forTypeMismatch(
          expression,
          expectedResultType,
          expressionType
        ));
        
        suggestions.push(this.suggestTypeConversion(expressionType, expectedResultType));
      }
      
      // Check for potential null/undefined access
      if (this.hasNullableAccess(expression, availableTypes)) {
        warnings.push(TypeValidationWarning.forPotentialNullAccess(expression));
        suggestions.push('Consider using optional chaining (?.) for safer property access');
      }
      
      return {
        valid: errors.length === 0,
        resultType: expressionType,
        errors,
        warnings,
        suggestions
      };
    } catch (error) {
      return {
        valid: false,
        errors: [new TypeValidationError(
          `Type validation failed: ${error instanceof Error ? error.message : String(error)}`,
          expression,
          { typeName: 'unknown', optional: false, nullable: false },
          { typeName: 'unknown', optional: false, nullable: false }
        )],
        warnings: [],
        suggestions: []
      };
    }
  }
  
  /**
   * Validate KubernetesRef types during conversion
   */
  validateKubernetesRef(
    ref: KubernetesRef<any>,
    availableResources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<any, any>
  ): TypeValidationResult {
    const errors: TypeValidationError[] = [];
    const warnings: TypeValidationWarning[] = [];
    const suggestions: string[] = [];
    
    try {
      // Validate resource exists
      if (ref.resourceId === '__schema__') {
        if (!schemaProxy) {
          errors.push(new TypeValidationError(
            'Schema reference used but no schema proxy available',
            `${ref.resourceId}.${ref.fieldPath}`,
            { typeName: 'SchemaProxy', optional: false, nullable: false },
            { typeName: 'undefined', optional: false, nullable: false }
          ));
        } else {
          // Validate schema field path
          const schemaType = this.extractSchemaType(schemaProxy, ref.fieldPath);
          if (!schemaType) {
            errors.push(TypeValidationError.forUndefinedProperty(
              `${ref.resourceId}.${ref.fieldPath}`,
              ref.fieldPath,
              { typeName: 'Schema', optional: false, nullable: false }
            ));
          }
        }
      } else {
        // Validate resource reference
        const resource = availableResources[ref.resourceId];
        if (!resource) {
          errors.push(new TypeValidationError(
            `Resource '${ref.resourceId}' not found in available resources`,
            `${ref.resourceId}.${ref.fieldPath}`,
            { typeName: 'Enhanced', optional: false, nullable: false },
            { typeName: 'undefined', optional: false, nullable: false }
          ));
          
          suggestions.push(`Available resources: ${Object.keys(availableResources).join(', ')}`);
        } else {
          // Validate field path on resource
          const fieldType = this.extractResourceFieldType(resource, ref.fieldPath);
          if (!fieldType) {
            errors.push(TypeValidationError.forUndefinedProperty(
              `${ref.resourceId}.${ref.fieldPath}`,
              ref.fieldPath,
              { typeName: resource.constructor.name, optional: false, nullable: false }
            ));
          }
        }
      }
      
      return {
        valid: errors.length === 0,
        resultType: this.inferKubernetesRefType(ref),
        errors,
        warnings,
        suggestions
      };
    } catch (error) {
      return {
        valid: false,
        errors: [new TypeValidationError(
          `KubernetesRef validation failed: ${error instanceof Error ? error.message : String(error)}`,
          `${ref.resourceId}.${ref.fieldPath}`,
          { typeName: 'unknown', optional: false, nullable: false },
          { typeName: 'unknown', optional: false, nullable: false }
        )],
        warnings: [],
        suggestions: []
      };
    }
  }
  
  /**
   * Infer the TypeScript type of an expression
   */
  private inferExpressionType(
    expression: string,
    availableTypes: Record<string, TypeInfo>
  ): TypeInfo {
    // Simple type inference based on expression patterns
    
    // String literals
    if (expression.match(/^["'`].*["'`]$/)) {
      return { typeName: 'string', optional: false, nullable: false };
    }
    
    // Number literals
    if (expression.match(/^\d+(\.\d+)?$/)) {
      return { typeName: 'number', optional: false, nullable: false };
    }
    
    // Boolean literals
    if (expression === 'true' || expression === 'false') {
      return { typeName: 'boolean', optional: false, nullable: false };
    }
    
    // Null/undefined
    if (expression === 'null' || expression === 'undefined') {
      return { typeName: 'null', optional: false, nullable: true };
    }
    
    // Binary operations
    if (expression.includes(' > ') || expression.includes(' < ') || 
        expression.includes(' >= ') || expression.includes(' <= ') ||
        expression.includes(' == ') || expression.includes(' != ') ||
        expression.includes(' && ') || expression.includes(' || ')) {
      return { typeName: 'boolean', optional: false, nullable: false };
    }
    
    // Template literals
    if (expression.includes('${')) {
      return { typeName: 'string', optional: false, nullable: false };
    }
    
    // Property access
    if (expression.includes('.')) {
      const parts = expression.split('.');
      const rootPart = parts[0];
      if (rootPart) {
        const rootType = availableTypes[rootPart];
        if (rootType) {
          return this.followPropertyPath(rootType, parts.slice(1));
        }
      }
    }
    
    // Variable reference
    const variableType = availableTypes[expression];
    if (variableType) {
      return variableType;
    }
    
    // Default to unknown
    return { typeName: 'unknown', optional: false, nullable: false };
  }
  
  /**
   * Check if two types are compatible
   */
  private isTypeCompatible(actualType: TypeInfo, expectedType: TypeInfo): boolean {
    // Exact match
    if (actualType.typeName === expectedType.typeName) {
      return true;
    }
    
    // Handle optionality
    if (expectedType.optional && actualType.typeName === 'undefined') {
      return true;
    }
    
    // Handle nullability
    if (expectedType.nullable && actualType.typeName === 'null') {
      return true;
    }
    
    // Handle union types
    if (expectedType.unionTypes) {
      return expectedType.unionTypes.some(unionType => 
        this.isTypeCompatible(actualType, unionType)
      );
    }
    
    // Handle type coercion for common cases
    if (expectedType.typeName === 'string' && 
        (actualType.typeName === 'number' || actualType.typeName === 'boolean')) {
      return true; // Implicit string conversion
    }
    
    if (expectedType.typeName === 'boolean' && actualType.typeName !== 'void') {
      return true; // Truthy/falsy conversion
    }
    
    return false;
  }
  
  /**
   * Follow a property path through a type definition
   */
  private followPropertyPath(rootType: TypeInfo, path: string[]): TypeInfo {
    let currentType = rootType;
    
    for (const property of path) {
      if (!currentType.properties || !currentType.properties[property]) {
        return { typeName: 'unknown', optional: false, nullable: false };
      }
      currentType = currentType.properties[property];
    }
    
    return currentType;
  }
  
  /**
   * Check if an expression has nullable property access
   */
  private hasNullableAccess(expression: string, availableTypes: Record<string, TypeInfo>): boolean {
    // Look for property access without optional chaining on nullable types
    const propertyAccesses = expression.match(/(\w+)\.(\w+)/g);
    if (!propertyAccesses) {
      // Check if the expression itself is a nullable/optional field
      const fieldType = availableTypes[expression];
      if (fieldType && (fieldType.nullable || fieldType.optional)) {
        return true;
      }
      return false;
    }
    
    for (const access of propertyAccesses) {
      const [object, property] = access.split('.');
      if (object) {
        const objectType = availableTypes[object];
        
        if (objectType && (objectType.nullable || objectType.optional)) {
          // Check if optional chaining is used
          const optionalChainPattern = new RegExp(`${object}\\?\\.${property}`);
          if (!optionalChainPattern.test(expression)) {
            return true;
          }
        }
      }
    }
    
    return false;
  }
  
  /**
   * Suggest type conversion for incompatible types
   */
  private suggestTypeConversion(actualType: TypeInfo, expectedType: TypeInfo): string {
    if (expectedType.typeName === 'string') {
      return `Convert to string using String(${actualType.typeName}) or template literal`;
    }
    
    if (expectedType.typeName === 'number') {
      return `Convert to number using Number(${actualType.typeName}) or parseInt/parseFloat`;
    }
    
    if (expectedType.typeName === 'boolean') {
      return `Convert to boolean using Boolean(${actualType.typeName}) or !! operator`;
    }
    
    return `Ensure the expression returns type '${expectedType.typeName}'`;
  }
  
  /**
   * Extract type information from schema proxy
   */
  private extractSchemaType(_schemaProxy: SchemaProxy<any, any>, _fieldPath: string): TypeInfo | null {
    // This would integrate with the actual schema type system
    // For now, return a placeholder
    return { typeName: 'unknown', optional: false, nullable: false };
  }
  
  /**
   * Extract type information from resource field
   */
  private extractResourceFieldType(_resource: Enhanced<any, any>, _fieldPath: string): TypeInfo | null {
    // This would integrate with the Enhanced type system
    // For now, return a placeholder
    return { typeName: 'unknown', optional: false, nullable: false };
  }
  
  /**
   * Infer the type of a KubernetesRef
   */
  private inferKubernetesRefType(ref: KubernetesRef<any>): TypeInfo {
    // Use the _type property if available
    if (ref._type) {
      return this.convertTypeToTypeInfo(ref._type);
    }
    
    // Default to unknown
    return { typeName: 'unknown', optional: false, nullable: false };
  }
  
  /**
   * Convert a TypeScript type to TypeInfo
   */
  private convertTypeToTypeInfo(type: any): TypeInfo {
    // This would integrate with the TypeScript compiler API
    // For now, return a basic conversion
    if (typeof type === 'string') {
      return { typeName: type, optional: false, nullable: false };
    }
    
    return { typeName: 'unknown', optional: false, nullable: false };
  }
}

/**
 * Type registry for managing available types in different contexts
 */
export class TypeRegistry {
  private types = new Map<string, TypeInfo>();
  private resourceTypes = new Map<string, TypeInfo>();
  private schemaTypes = new Map<string, TypeInfo>();
  
  /**
   * Register a type in the registry
   */
  registerType(name: string, typeInfo: TypeInfo): void {
    this.types.set(name, typeInfo);
  }
  
  /**
   * Register a resource type
   */
  registerResourceType(resourceId: string, typeInfo: TypeInfo): void {
    this.resourceTypes.set(resourceId, typeInfo);
  }
  
  /**
   * Register schema types
   */
  registerSchemaType(fieldPath: string, typeInfo: TypeInfo): void {
    this.schemaTypes.set(fieldPath, typeInfo);
  }
  
  /**
   * Get type information for a name
   */
  getType(name: string): TypeInfo | undefined {
    return this.types.get(name);
  }
  
  /**
   * Get resource type information
   */
  getResourceType(resourceId: string): TypeInfo | undefined {
    return this.resourceTypes.get(resourceId);
  }
  
  /**
   * Get schema type information
   */
  getSchemaType(fieldPath: string): TypeInfo | undefined {
    return this.schemaTypes.get(fieldPath);
  }
  
  /**
   * Get all available types for a context
   */
  getAvailableTypes(): Record<string, TypeInfo> {
    const allTypes: Record<string, TypeInfo> = {};
    
    // Add basic types
    this.types.forEach((typeInfo, name) => {
      allTypes[name] = typeInfo;
    });
    
    // Add resource types with 'resources.' prefix
    this.resourceTypes.forEach((typeInfo, resourceId) => {
      allTypes[`resources.${resourceId}`] = typeInfo;
    });
    
    // Add schema types with 'schema.' prefix
    this.schemaTypes.forEach((typeInfo, fieldPath) => {
      allTypes[`schema.${fieldPath}`] = typeInfo;
    });
    
    return allTypes;
  }
  
  /**
   * Clear all registered types
   */
  clear(): void {
    this.types.clear();
    this.resourceTypes.clear();
    this.schemaTypes.clear();
  }
}

/**
 * Utility functions for type safety integration
 */
export class TypeSafetyUtils {
  /**
   * Create TypeInfo from ArkType definition
   */
  static fromArkType(_arkType: Type): TypeInfo {
    // This would integrate with ArkType's type system
    // For now, return a basic conversion
    return {
      typeName: 'unknown',
      optional: false,
      nullable: false
    };
  }
  
  /**
   * Create TypeInfo for Enhanced resource types
   */
  static fromEnhancedType(enhanced: Enhanced<any, any>): TypeInfo {
    // Extract type information from Enhanced wrapper
    return {
      typeName: enhanced.constructor.name,
      optional: false,
      nullable: false,
      properties: {
        metadata: { typeName: 'ObjectMeta', optional: true, nullable: false },
        spec: { typeName: 'unknown', optional: true, nullable: false },
        status: { typeName: 'unknown', optional: true, nullable: false }
      }
    };
  }
  
  /**
   * Validate that a CEL expression type matches expected type
   */
  static validateCelExpressionType(
    _celExpression: CelExpression,
    expectedType: TypeInfo
  ): TypeValidationResult {
    // This would validate the CEL expression type
    // For now, return a basic validation
    return {
      valid: true,
      resultType: expectedType,
      errors: [],
      warnings: [],
      suggestions: []
    };
  }
}