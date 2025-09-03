/**
 * Type Inference for CEL Expressions
 * 
 * This module provides type inference capabilities for CEL expressions
 * generated from JavaScript expressions. It analyzes CEL expressions
 * to determine their result types and validates type compatibility.
 */

import type { CelExpression, } from '../types/common.js';
import type { Enhanced } from '../types/kubernetes.js';
import type { SchemaProxy } from '../types/serialization.js';
import type { TypeInfo, TypeValidationResult } from './type-safety.js';

/**
 * CEL expression type inference result
 */
export interface CelTypeInferenceResult {
  /** Inferred result type of the CEL expression */
  resultType: TypeInfo;

  /** Whether the type inference was successful */
  success: boolean;

  /** Type inference errors */
  errors: TypeInferenceError[];

  /** Type inference warnings */
  warnings: TypeInferenceWarning[];

  /** Confidence level of the inference (0-1) */
  confidence: number;

  /** Additional type information */
  metadata: TypeInferenceMetadata;
}

/**
 * Type inference error
 */
export class TypeInferenceError extends Error {
  constructor(
    message: string,
    public readonly celExpression: string,
    public readonly location?: { start: number; end: number }
  ) {
    super(message);
    this.name = 'TypeInferenceError';
  }

  static forUnknownFunction(
    celExpression: string,
    functionName: string,
    location?: { start: number; end: number }
  ): TypeInferenceError {
    return new TypeInferenceError(
      `Unknown CEL function: ${functionName}`,
      celExpression,
      location
    );
  }

  static forIncompatibleOperands(
    celExpression: string,
    operator: string,
    leftType: TypeInfo,
    rightType: TypeInfo,
    location?: { start: number; end: number }
  ): TypeInferenceError {
    return new TypeInferenceError(
      `Incompatible operands for operator '${operator}': ${leftType.typeName} and ${rightType.typeName}`,
      celExpression,
      location
    );
  }

  static forUnresolvableReference(
    celExpression: string,
    reference: string,
    location?: { start: number; end: number }
  ): TypeInferenceError {
    return new TypeInferenceError(
      `Cannot resolve reference: ${reference}`,
      celExpression,
      location
    );
  }
}

/**
 * Type inference warning
 */
export class TypeInferenceWarning {
  constructor(
    public readonly message: string,
    public readonly celExpression: string,
    public readonly location?: { start: number; end: number }
  ) { }

  static forPotentialNullDereference(
    celExpression: string,
    reference: string,
    location?: { start: number; end: number }
  ): TypeInferenceWarning {
    return new TypeInferenceWarning(
      `Potential null dereference: ${reference}`,
      celExpression,
      location
    );
  }

  static forImplicitTypeConversion(
    celExpression: string,
    fromType: string,
    toType: string,
    location?: { start: number; end: number }
  ): TypeInferenceWarning {
    return new TypeInferenceWarning(
      `Implicit type conversion from ${fromType} to ${toType}`,
      celExpression,
      location
    );
  }
}

/**
 * Type inference metadata
 */
export interface TypeInferenceMetadata {
  /** CEL functions used in the expression */
  functionsUsed: string[];

  /** Resource references found in the expression */
  resourceReferences: string[];

  /** Schema references found in the expression */
  schemaReferences: string[];

  /** Whether the expression uses optional chaining */
  usesOptionalChaining: boolean;

  /** Whether the expression can return null */
  canReturnNull: boolean;

  /** Complexity score of the expression (0-10) */
  complexityScore: number;
}

/**
 * CEL type inference engine
 */
export class CelTypeInferenceEngine {
  private functionTypes = new Map<string, CelFunctionSignature>();
  private operatorTypes = new Map<string, CelOperatorSignature>();

  constructor() {
    this.initializeBuiltinTypes();
  }

  /**
   * Infer the type of a CEL expression
   */
  inferType(
    celExpression: CelExpression,
    context: TypeInferenceContext
  ): CelTypeInferenceResult {
    try {
      const expression = celExpression.expression;
      const result = this.analyzeExpression(expression, context);

      return {
        resultType: result.type,
        success: true,
        errors: result.errors,
        warnings: result.warnings,
        confidence: result.confidence,
        metadata: result.metadata
      };
    } catch (error) {
      return {
        resultType: { typeName: 'unknown', optional: false, nullable: false },
        success: false,
        errors: [new TypeInferenceError(
          `Type inference failed: ${error instanceof Error ? error.message : String(error)}`,
          celExpression.expression
        )],
        warnings: [],
        confidence: 0,
        metadata: this.createEmptyMetadata()
      };
    }
  }

  /**
   * Infer types for multiple CEL expressions
   */
  inferTypes(
    celExpressions: CelExpression[],
    context: TypeInferenceContext
  ): CelTypeInferenceResult[] {
    return celExpressions.map(expr => this.inferType(expr, context));
  }

  /**
   * Validate type compatibility between expressions
   */
  validateTypeCompatibility(
    sourceType: TypeInfo,
    targetType: TypeInfo
  ): TypeValidationResult {
    const errors: TypeInferenceError[] = [];
    const warnings: TypeInferenceWarning[] = [];

    // Check exact type match
    if (sourceType.typeName === targetType.typeName) {
      return {
        valid: true,
        resultType: targetType,
        errors: [],
        warnings: [],
        suggestions: []
      };
    }

    // Check assignability
    if (this.isAssignable(sourceType, targetType)) {
      if (this.requiresImplicitConversion(sourceType, targetType)) {
        warnings.push(TypeInferenceWarning.forImplicitTypeConversion(
          '',
          sourceType.typeName,
          targetType.typeName
        ));
      }

      return {
        valid: true,
        resultType: targetType,
        errors: [],
        warnings: warnings.map(w => ({ message: w.message, expression: w.celExpression })),
        suggestions: []
      };
    }

    // Type mismatch
    errors.push(TypeInferenceError.forIncompatibleOperands(
      '',
      '=',
      sourceType,
      targetType
    ));

    return {
      valid: false,
      resultType: targetType,
      errors: errors.map(e => ({
        message: e.message,
        expression: e.celExpression,
        expectedType: targetType,
        actualType: sourceType,
        name: 'TypeValidationError'
      } as any)),
      warnings: [],
      suggestions: [`Convert ${sourceType.typeName} to ${targetType.typeName}`]
    };
  }

  /**
   * Analyze a CEL expression and infer its type
   */
  private analyzeExpression(
    expression: string,
    context: TypeInferenceContext
  ): ExpressionAnalysisResult {
    const errors: TypeInferenceError[] = [];
    const warnings: TypeInferenceWarning[] = [];
    const metadata = this.createEmptyMetadata();

    // First, extract all resource references from the expression
    this.extractResourceReferences(expression, metadata);

    // Parse the expression into tokens
    const tokens = this.tokenizeExpression(expression);

    // Analyze different expression patterns
    if (this.isBinaryOperation(tokens)) {
      return this.analyzeBinaryOperation(tokens, context, metadata);
    }

    if (this.isFunctionCall(tokens)) {
      return this.analyzeFunctionCall(tokens, context, metadata);
    }

    if (this.isResourceReference(tokens)) {
      return this.analyzeResourceReference(tokens, context, metadata);
    }

    if (this.isSchemaReference(tokens)) {
      return this.analyzeSchemaReference(tokens, context, metadata);
    }

    if (this.isLiteral(tokens)) {
      return this.analyzeLiteral(tokens, context, metadata);
    }

    if (this.isConditionalExpression(tokens)) {
      return this.analyzeConditionalExpression(tokens, context, metadata);
    }

    // Default to unknown type
    return {
      type: { typeName: 'unknown', optional: false, nullable: false },
      errors,
      warnings,
      confidence: 0.1,
      metadata
    };
  }

  /**
   * Analyze binary operations (>, <, ==, !=, &&, ||, +, -, *, /)
   */
  private analyzeBinaryOperation(
    tokens: string[],
    context: TypeInferenceContext,
    metadata: TypeInferenceMetadata
  ): ExpressionAnalysisResult {
    const errors: TypeInferenceError[] = [];
    const warnings: TypeInferenceWarning[] = [];

    // Find the operator
    const operatorIndex = this.findMainOperator(tokens);
    if (operatorIndex === -1) {
      errors.push(TypeInferenceError.forUnknownFunction('', 'binary operator'));
      return {
        type: { typeName: 'unknown', optional: false, nullable: false },
        errors,
        warnings,
        confidence: 0,
        metadata
      };
    }

    const operator = tokens[operatorIndex];
    if (!operator) {
      errors.push(TypeInferenceError.forUnknownFunction('', 'unknown_operator'));
      return {
        type: { typeName: 'unknown', optional: false, nullable: false },
        errors,
        warnings,
        confidence: 0,
        metadata
      };
    }
    
    const leftTokens = tokens.slice(0, operatorIndex);
    const rightTokens = tokens.slice(operatorIndex + 1);

    // Analyze operands
    const leftResult = this.analyzeExpression(leftTokens.join(' '), context);
    const rightResult = this.analyzeExpression(rightTokens.join(' '), context);

    // Determine result type based on operator
    const operatorSignature = this.operatorTypes.get(operator);
    if (!operatorSignature) {
      errors.push(TypeInferenceError.forUnknownFunction('', operator));
      return {
        type: { typeName: 'unknown', optional: false, nullable: false },
        errors,
        warnings,
        confidence: 0,
        metadata
      };
    }

    // Validate operand types
    const resultType = this.getOperatorResultType(
      operator,
      leftResult.type,
      rightResult.type
    );

    if (!resultType) {
      errors.push(TypeInferenceError.forIncompatibleOperands(
        '',
        operator,
        leftResult.type,
        rightResult.type
      ));
      return {
        type: { typeName: 'unknown', optional: false, nullable: false },
        errors,
        warnings,
        confidence: 0,
        metadata
      };
    }

    // Combine metadata
    metadata.complexityScore += 1;
    metadata.canReturnNull = leftResult.type.nullable || rightResult.type.nullable;

    return {
      type: resultType,
      errors: [...errors, ...leftResult.errors, ...rightResult.errors],
      warnings: [...warnings, ...leftResult.warnings, ...rightResult.warnings],
      confidence: Math.min(leftResult.confidence, rightResult.confidence) * 0.9,
      metadata
    };
  }

  /**
   * Analyze function calls
   */
  private analyzeFunctionCall(
    tokens: string[],
    _context: TypeInferenceContext,
    metadata: TypeInferenceMetadata
  ): ExpressionAnalysisResult {
    const errors: TypeInferenceError[] = [];
    const warnings: TypeInferenceWarning[] = [];

    // Extract function name - look for function call pattern
    const expression = tokens.join(' ');
    const functionMatch = expression.match(/(\w+)\s*\(/);

    if (!functionMatch) {
      errors.push(TypeInferenceError.forUnknownFunction('', 'unknown'));
      return {
        type: { typeName: 'unknown', optional: false, nullable: false },
        errors,
        warnings,
        confidence: 0,
        metadata
      };
    }

    const functionName = functionMatch[1];
    if (!functionName) {
      errors.push(TypeInferenceError.forUnknownFunction('', 'unknown_function'));
      return {
        type: { typeName: 'unknown', optional: false, nullable: false },
        errors,
        warnings,
        confidence: 0,
        metadata
      };
    }
    
    const functionSignature = this.functionTypes.get(functionName);

    if (!functionSignature) {
      errors.push(TypeInferenceError.forUnknownFunction('', functionName));
      return {
        type: { typeName: 'unknown', optional: false, nullable: false },
        errors,
        warnings,
        confidence: 0,
        metadata
      };
    }

    metadata.functionsUsed.push(functionName);
    metadata.complexityScore += 2;

    return {
      type: functionSignature.returnType,
      errors,
      warnings,
      confidence: 0.8,
      metadata
    };
  }

  /**
   * Analyze resource references (resources.name.field)
   */
  private analyzeResourceReference(
    tokens: string[],
    context: TypeInferenceContext,
    metadata: TypeInferenceMetadata
  ): ExpressionAnalysisResult {
    const errors: TypeInferenceError[] = [];
    const warnings: TypeInferenceWarning[] = [];

    const reference = tokens.join('').replace(/\s+/g, '');
    metadata.resourceReferences.push(reference);

    // Extract resource ID and field path
    const match = reference.match(/^resources\.([^.]+)\.(.+)$/);
    if (!match) {
      errors.push(TypeInferenceError.forUnresolvableReference('', reference));
      return {
        type: { typeName: 'unknown', optional: false, nullable: false },
        errors,
        warnings,
        confidence: 0,
        metadata
      };
    }

    const [, resourceId, fieldPath] = match;
    
    if (!resourceId || !fieldPath) {
      errors.push(TypeInferenceError.forUnresolvableReference('', reference));
      return {
        type: { typeName: 'unknown', optional: false, nullable: false },
        errors,
        warnings,
        confidence: 0,
        metadata
      };
    }

    // Look up resource type
    const resource = context.availableResources[resourceId];
    if (!resource) {
      errors.push(TypeInferenceError.forUnresolvableReference('', reference));
      return {
        type: { typeName: 'unknown', optional: false, nullable: false },
        errors,
        warnings,
        confidence: 0,
        metadata
      };
    }

    // Infer field type
    const fieldType = this.inferResourceFieldType(resource, fieldPath);

    // Check for optional chaining
    if (reference.includes('?')) {
      metadata.usesOptionalChaining = true;
      metadata.canReturnNull = true;
    }

    return {
      type: fieldType,
      errors,
      warnings,
      confidence: 0.9,
      metadata
    };
  }

  /**
   * Analyze schema references (schema.spec.field)
   */
  private analyzeSchemaReference(
    tokens: string[],
    context: TypeInferenceContext,
    metadata: TypeInferenceMetadata
  ): ExpressionAnalysisResult {
    const errors: TypeInferenceError[] = [];
    const warnings: TypeInferenceWarning[] = [];

    const reference = tokens.join('');
    metadata.schemaReferences.push(reference);

    // Extract field path
    const match = reference.match(/^schema\.(.+)$/);
    if (!match) {
      errors.push(TypeInferenceError.forUnresolvableReference('', reference));
      return {
        type: { typeName: 'unknown', optional: false, nullable: false },
        errors,
        warnings,
        confidence: 0,
        metadata
      };
    }

    const [, fieldPath] = match;
    
    if (!fieldPath) {
      errors.push(TypeInferenceError.forUnresolvableReference('', reference));
      return {
        type: { typeName: 'unknown', optional: false, nullable: false },
        errors,
        warnings,
        confidence: 0,
        metadata
      };
    }

    // Infer schema field type
    const fieldType = this.inferSchemaFieldType(context.schemaProxy, fieldPath);

    return {
      type: fieldType,
      errors,
      warnings,
      confidence: 0.9,
      metadata
    };
  }

  /**
   * Analyze literal values
   */
  private analyzeLiteral(
    tokens: string[],
    _context: TypeInferenceContext,
    metadata: TypeInferenceMetadata
  ): ExpressionAnalysisResult {
    const literal = tokens.join(' ');

    // String literals
    if (literal.match(/^["'].*["']$/)) {
      return {
        type: { typeName: 'string', optional: false, nullable: false },
        errors: [],
        warnings: [],
        confidence: 1.0,
        metadata
      };
    }

    // Number literals
    if (literal.match(/^\d+(\.\d+)?$/)) {
      return {
        type: { typeName: 'number', optional: false, nullable: false },
        errors: [],
        warnings: [],
        confidence: 1.0,
        metadata
      };
    }

    // Boolean literals
    if (literal === 'true' || literal === 'false') {
      return {
        type: { typeName: 'boolean', optional: false, nullable: false },
        errors: [],
        warnings: [],
        confidence: 1.0,
        metadata
      };
    }

    // Null literal
    if (literal === 'null') {
      return {
        type: { typeName: 'null', optional: false, nullable: true },
        errors: [],
        warnings: [],
        confidence: 1.0,
        metadata
      };
    }

    // Unknown literal
    return {
      type: { typeName: 'unknown', optional: false, nullable: false },
      errors: [],
      warnings: [],
      confidence: 0.5,
      metadata
    };
  }

  /**
   * Analyze conditional expressions (condition ? true : false)
   */
  private analyzeConditionalExpression(
    tokens: string[],
    context: TypeInferenceContext,
    metadata: TypeInferenceMetadata
  ): ExpressionAnalysisResult {
    const errors: TypeInferenceError[] = [];
    const warnings: TypeInferenceWarning[] = [];

    // Find ? and : operators
    const questionIndex = tokens.indexOf('?');
    const colonIndex = tokens.indexOf(':');

    if (questionIndex === -1 || colonIndex === -1) {
      errors.push(TypeInferenceError.forUnknownFunction('', 'conditional'));
      return {
        type: { typeName: 'unknown', optional: false, nullable: false },
        errors,
        warnings,
        confidence: 0,
        metadata
      };
    }

    const conditionTokens = tokens.slice(0, questionIndex);
    const trueTokens = tokens.slice(questionIndex + 1, colonIndex);
    const falseTokens = tokens.slice(colonIndex + 1);

    // Analyze each part
    const conditionResult = this.analyzeExpression(conditionTokens.join(' '), context);
    const trueResult = this.analyzeExpression(trueTokens.join(' '), context);
    const falseResult = this.analyzeExpression(falseTokens.join(' '), context);

    // Result type is the union of true and false branches
    const resultType = this.unifyTypes(trueResult.type, falseResult.type);

    metadata.complexityScore += 2;
    metadata.canReturnNull = trueResult.type.nullable || falseResult.type.nullable;

    return {
      type: resultType,
      errors: [...errors, ...conditionResult.errors, ...trueResult.errors, ...falseResult.errors],
      warnings: [...warnings, ...conditionResult.warnings, ...trueResult.warnings, ...falseResult.warnings],
      confidence: Math.min(conditionResult.confidence, trueResult.confidence, falseResult.confidence) * 0.9,
      metadata
    };
  }

  /**
   * Initialize builtin CEL function and operator types
   */
  private initializeBuiltinTypes(): void {
    // Comparison operators
    this.operatorTypes.set('>', {
      leftType: { typeName: 'number', optional: false, nullable: false },
      rightType: { typeName: 'number', optional: false, nullable: false },
      returnType: { typeName: 'boolean', optional: false, nullable: false }
    });

    this.operatorTypes.set('<', {
      leftType: { typeName: 'number', optional: false, nullable: false },
      rightType: { typeName: 'number', optional: false, nullable: false },
      returnType: { typeName: 'boolean', optional: false, nullable: false }
    });

    this.operatorTypes.set('==', {
      leftType: { typeName: 'any', optional: false, nullable: false },
      rightType: { typeName: 'any', optional: false, nullable: false },
      returnType: { typeName: 'boolean', optional: false, nullable: false }
    });

    this.operatorTypes.set('!=', {
      leftType: { typeName: 'any', optional: false, nullable: false },
      rightType: { typeName: 'any', optional: false, nullable: false },
      returnType: { typeName: 'boolean', optional: false, nullable: false }
    });

    // Logical operators
    this.operatorTypes.set('&&', {
      leftType: { typeName: 'boolean', optional: false, nullable: false },
      rightType: { typeName: 'boolean', optional: false, nullable: false },
      returnType: { typeName: 'boolean', optional: false, nullable: false }
    });

    this.operatorTypes.set('||', {
      leftType: { typeName: 'boolean', optional: false, nullable: false },
      rightType: { typeName: 'boolean', optional: false, nullable: false },
      returnType: { typeName: 'boolean', optional: false, nullable: false }
    });

    // Arithmetic operators
    this.operatorTypes.set('+', {
      leftType: { typeName: 'number', optional: false, nullable: false },
      rightType: { typeName: 'number', optional: false, nullable: false },
      returnType: { typeName: 'number', optional: false, nullable: false }
    });

    // CEL functions
    this.functionTypes.set('has', {
      parameters: [{ typeName: 'string', optional: false, nullable: false }],
      returnType: { typeName: 'boolean', optional: false, nullable: false }
    });

    this.functionTypes.set('size', {
      parameters: [{ typeName: 'any', optional: false, nullable: false }],
      returnType: { typeName: 'number', optional: false, nullable: false }
    });
  }

  /**
   * Utility methods
   */
  private tokenizeExpression(expression: string): string[] {
    // Simple tokenization - would need more sophisticated parsing for production
    return expression.split(/\s+/).filter(token => token.length > 0);
  }

  private isBinaryOperation(tokens: string[]): boolean {
    return tokens.some(token => ['>', '<', '>=', '<=', '==', '!=', '&&', '||', '+', '-', '*', '/'].includes(token));
  }

  private isFunctionCall(tokens: string[]): boolean {
    const expression = tokens.join(' ');
    return expression.includes('(') && expression.includes(')');
  }

  private isResourceReference(tokens: string[]): boolean {
    const expression = tokens.join('').replace(/\s+/g, '');
    return expression.startsWith('resources.');
  }

  private isSchemaReference(tokens: string[]): boolean {
    return tokens.join('').startsWith('schema.');
  }

  private isLiteral(tokens: string[]): boolean {
    const joined = tokens.join(' ');
    return joined.match(/^(["'].*["']|\d+(\.\d+)?|true|false|null)$/) !== null;
  }

  private isConditionalExpression(tokens: string[]): boolean {
    return tokens.includes('?') && tokens.includes(':');
  }

  private findMainOperator(tokens: string[]): number {
    // Find the main operator (simplified - would need proper precedence parsing)
    const operators = ['||', '&&', '==', '!=', '>', '<', '>=', '<=', '+', '-', '*', '/'];
    for (const op of operators) {
      const index = tokens.indexOf(op);
      if (index !== -1) return index;
    }
    return -1;
  }

  private getOperatorResultType(
    operator: string,
    _leftType: TypeInfo,
    _rightType: TypeInfo
  ): TypeInfo | null {
    const signature = this.operatorTypes.get(operator);
    if (!signature) return null;

    // Simplified type checking
    return signature.returnType;
  }

  private isAssignable(sourceType: TypeInfo, targetType: TypeInfo): boolean {
    if (sourceType.typeName === targetType.typeName) return true;
    if (targetType.typeName === 'any') return true;
    if (sourceType.typeName === 'null' && targetType.nullable) return true;
    if (sourceType.typeName === 'undefined' && targetType.optional) return true;
    return false;
  }

  private requiresImplicitConversion(sourceType: TypeInfo, targetType: TypeInfo): boolean {
    return sourceType.typeName !== targetType.typeName &&
      targetType.typeName !== 'any';
  }

  private inferResourceFieldType(resource: Enhanced<any, any>, fieldPath: string): TypeInfo {
    try {
      const parts = fieldPath.split('.');

      // Handle common Kubernetes resource field patterns
      if (parts[0] === 'metadata') {
        return this.getMetadataFieldType(parts.slice(1));
      }

      if (parts[0] === 'spec') {
        return this.getSpecFieldType(resource, parts.slice(1));
      }

      if (parts[0] === 'status') {
        return this.getStatusFieldType(resource, parts.slice(1));
      }

      return { typeName: 'unknown', optional: true, nullable: false };
    } catch (_error) {
      return { typeName: 'unknown', optional: true, nullable: false };
    }
  }

  private getMetadataFieldType(fieldParts: string[]): TypeInfo {
    const fieldName = fieldParts[0];
    
    if (!fieldName) {
      return { typeName: 'unknown', optional: true, nullable: false };
    }

    // Common metadata fields
    const metadataTypes: Record<string, TypeInfo> = {
      'name': { typeName: 'string', optional: false, nullable: false },
      'namespace': { typeName: 'string', optional: true, nullable: false },
      'labels': { typeName: 'Record<string, string>', optional: true, nullable: false },
      'annotations': { typeName: 'Record<string, string>', optional: true, nullable: false },
      'uid': { typeName: 'string', optional: true, nullable: false },
      'resourceVersion': { typeName: 'string', optional: true, nullable: false },
      'generation': { typeName: 'number', optional: true, nullable: false },
      'creationTimestamp': { typeName: 'string', optional: true, nullable: false }
    };

    if (fieldName in metadataTypes) {
      const baseType = metadataTypes[fieldName];
      if (!baseType) {
        return { typeName: 'string', optional: true, nullable: false };
      }

      // Handle nested access (e.g., labels.app)
      if (fieldParts.length > 1) {
        if (baseType.typeName.startsWith('Record<')) {
          return { typeName: 'string', optional: true, nullable: false };
        }
      }

      return baseType;
    }

    return { typeName: 'string', optional: true, nullable: false };
  }

  private getSpecFieldType(resource: Enhanced<any, any>, fieldParts: string[]): TypeInfo {
    const resourceKind = resource.constructor.name;
    const fieldName = fieldParts[0];
    
    if (!fieldName) {
      return { typeName: 'unknown', optional: true, nullable: false };
    }

    // Common spec fields by resource type
    const specFieldTypes: Record<string, Record<string, TypeInfo>> = {
      'Deployment': {
        'replicas': { typeName: 'number', optional: true, nullable: false },
        'selector': { typeName: 'object', optional: false, nullable: false },
        'template': { typeName: 'object', optional: false, nullable: false },
        'strategy': { typeName: 'object', optional: true, nullable: false }
      },
      'Service': {
        'type': { typeName: 'string', optional: true, nullable: false },
        'ports': { typeName: 'array', optional: false, nullable: false },
        'selector': { typeName: 'Record<string, string>', optional: true, nullable: false },
        'clusterIP': { typeName: 'string', optional: true, nullable: false }
      },
      'ConfigMap': {
        'data': { typeName: 'Record<string, string>', optional: true, nullable: false },
        'binaryData': { typeName: 'Record<string, string>', optional: true, nullable: false }
      }
    };

    const resourceFields = specFieldTypes[resourceKind];
    if (resourceFields && fieldName in resourceFields) {
      const baseType = resourceFields[fieldName];

      // Handle nested access
      if (fieldParts.length > 1 && baseType) {
        if (baseType.typeName.startsWith('Record<')) {
          return { typeName: 'string', optional: true, nullable: false };
        }
        if (baseType.typeName === 'array') {
          return { typeName: 'object', optional: true, nullable: false };
        }
        if (baseType.typeName === 'object') {
          return { typeName: 'unknown', optional: true, nullable: false };
        }
      }

      return baseType || { typeName: 'unknown', optional: true, nullable: false };
    }

    return { typeName: 'unknown', optional: true, nullable: false };
  }

  private getStatusFieldType(resource: Enhanced<any, any>, fieldParts: string[]): TypeInfo {
    const resourceKind = resource.constructor.name;
    const fieldName = fieldParts[0];
    
    if (!fieldName) {
      return { typeName: 'unknown', optional: true, nullable: false };
    }

    // Common status fields by resource type
    const statusFieldTypes: Record<string, Record<string, TypeInfo>> = {
      'Deployment': {
        'replicas': { typeName: 'number', optional: true, nullable: false },
        'readyReplicas': { typeName: 'number', optional: true, nullable: false },
        'availableReplicas': { typeName: 'number', optional: true, nullable: false },
        'unavailableReplicas': { typeName: 'number', optional: true, nullable: false },
        'updatedReplicas': { typeName: 'number', optional: true, nullable: false },
        'conditions': { typeName: 'array', optional: true, nullable: false },
        'observedGeneration': { typeName: 'number', optional: true, nullable: false }
      },
      'Service': {
        'loadBalancer': { typeName: 'object', optional: true, nullable: false },
        'conditions': { typeName: 'array', optional: true, nullable: false }
      },
      'Pod': {
        'phase': { typeName: 'string', optional: true, nullable: false },
        'conditions': { typeName: 'array', optional: true, nullable: false },
        'hostIP': { typeName: 'string', optional: true, nullable: false },
        'podIP': { typeName: 'string', optional: true, nullable: false },
        'startTime': { typeName: 'string', optional: true, nullable: false },
        'containerStatuses': { typeName: 'array', optional: true, nullable: false }
      }
    };

    const resourceFields = statusFieldTypes[resourceKind];
    if (resourceFields && fieldName in resourceFields) {
      const baseType = resourceFields[fieldName];

      // Handle nested access
      if (fieldParts.length > 1 && baseType) {
        if (baseType.typeName === 'object') {
          // Handle specific nested objects
          if (fieldName === 'loadBalancer' && fieldParts[1] === 'ingress') {
            return { typeName: 'array', optional: true, nullable: false };
          }
          return { typeName: 'unknown', optional: true, nullable: false };
        }
        if (baseType.typeName === 'array') {
          // Array access like conditions[0] or length
          if (fieldParts[1] === 'length') {
            return { typeName: 'number', optional: false, nullable: false };
          }
          return { typeName: 'object', optional: true, nullable: false };
        }
      }

      return baseType || { typeName: 'unknown', optional: true, nullable: true };
    }

    // Status fields are generally optional and may be null during resource creation
    return { typeName: 'unknown', optional: true, nullable: true };
  }

  private inferSchemaFieldType(schemaProxy: SchemaProxy<any, any> | undefined, fieldPath: string): TypeInfo {
    if (!schemaProxy) {
      return { typeName: 'unknown', optional: false, nullable: false };
    }

    try {
      // Extract the field from the schema proxy
      const parts = fieldPath.split('.');
      let current: any = schemaProxy;

      for (const part of parts) {
        if (current && typeof current === 'object' && part in current) {
          current = current[part];
        } else {
          return { typeName: 'unknown', optional: true, nullable: false };
        }
      }

      // Infer type from the schema field
      if (current !== undefined) {
        return this.inferTypeFromValue(current);
      }

      return { typeName: 'unknown', optional: true, nullable: false };
    } catch (_error) {
      return { typeName: 'unknown', optional: true, nullable: false };
    }
  }

  private inferTypeFromValue(value: any): TypeInfo {
    if (value === null) {
      return { typeName: 'null', optional: false, nullable: true };
    }

    if (value === undefined) {
      return { typeName: 'undefined', optional: true, nullable: false };
    }

    const type = typeof value;

    switch (type) {
      case 'string':
        return { typeName: 'string', optional: false, nullable: false };
      case 'number':
        return { typeName: 'number', optional: false, nullable: false };
      case 'boolean':
        return { typeName: 'boolean', optional: false, nullable: false };
      case 'object':
        if (Array.isArray(value)) {
          return { typeName: 'array', optional: false, nullable: false };
        }
        return { typeName: 'object', optional: false, nullable: false };
      default:
        return { typeName: 'unknown', optional: false, nullable: false };
    }
  }

  private unifyTypes(type1: TypeInfo, type2: TypeInfo): TypeInfo {
    if (type1.typeName === type2.typeName) return type1;

    // Create union type
    return {
      typeName: `${type1.typeName} | ${type2.typeName}`,
      optional: type1.optional || type2.optional,
      nullable: type1.nullable || type2.nullable,
      unionTypes: [type1, type2]
    };
  }

  private createEmptyMetadata(): TypeInferenceMetadata {
    return {
      functionsUsed: [],
      resourceReferences: [],
      schemaReferences: [],
      usesOptionalChaining: false,
      canReturnNull: false,
      complexityScore: 0
    };
  }

  /**
   * Extract resource references from the expression
   */
  private extractResourceReferences(expression: string, metadata: TypeInferenceMetadata): void {
    // Find all resource references (resources.name.field)
    const resourceMatches = expression.match(/resources\.\w+\.[a-zA-Z0-9_.]+/g);
    if (resourceMatches) {
      metadata.resourceReferences.push(...resourceMatches);
    }

    // Find all schema references (schema.field)
    const schemaMatches = expression.match(/schema\.[a-zA-Z0-9_.]+/g);
    if (schemaMatches) {
      metadata.schemaReferences.push(...schemaMatches);
    }

    // Check for optional chaining
    if (expression.includes('?.')) {
      metadata.usesOptionalChaining = true;
    }
  }
}

/**
 * Type inference context
 */
export interface TypeInferenceContext {
  /** Available resources for type lookup */
  availableResources: Record<string, Enhanced<any, any>>;

  /** Schema proxy for schema type lookup */
  schemaProxy?: SchemaProxy<any, any>;

  /** Factory type affects available functions */
  factoryType: 'direct' | 'kro';
}

/**
 * Expression analysis result
 */
interface ExpressionAnalysisResult {
  type: TypeInfo;
  errors: TypeInferenceError[];
  warnings: TypeInferenceWarning[];
  confidence: number;
  metadata: TypeInferenceMetadata;
}

/**
 * CEL function signature
 */
interface CelFunctionSignature {
  parameters: TypeInfo[];
  returnType: TypeInfo;
}

/**
 * CEL operator signature
 */
interface CelOperatorSignature {
  leftType: TypeInfo;
  rightType: TypeInfo;
  returnType: TypeInfo;
}