/**
 * Compile-Time Type Checking for Expression Compatibility
 * 
 * This module provides compile-time type checking capabilities for JavaScript
 * expressions that will be converted to CEL. It integrates with TypeScript's
 * type system to validate expressions before runtime conversion.
 */

import type { KubernetesRef } from '../types/common.js';
import type { Enhanced } from '../types/kubernetes.js';
import type { SchemaProxy } from '../types/serialization.js';
import type { TypeInfo, } from './type-safety.js';

/**
 * Compile-time validation result
 */
export interface CompileTimeValidationResult {
  /** Whether the expression passes compile-time validation */
  valid: boolean;

  /** Compile-time type information */
  compileTimeType?: CompileTimeTypeInfo;

  /** Runtime type information (inferred) */
  runtimeType?: TypeInfo;

  /** Type compatibility issues */
  compatibilityIssues: TypeCompatibilityIssue[];

  /** Compile-time errors */
  errors: CompileTimeError[];

  /** Compile-time warnings */
  warnings: CompileTimeWarning[];

  /** Suggestions for fixing issues */
  suggestions: string[];

  /** Metadata about the validation */
  metadata: CompileTimeValidationMetadata;
}

/**
 * Compile-time type information
 */
export interface CompileTimeTypeInfo {
  /** TypeScript type name */
  typeName: string;

  /** Whether the type is a union type */
  isUnion: boolean;

  /** Union type members if applicable */
  unionMembers?: string[];

  /** Whether the type is generic */
  isGeneric: boolean;

  /** Generic type parameters */
  genericParams?: string[];

  /** Whether the type is optional */
  optional: boolean;

  /** Whether the type can be null */
  nullable: boolean;

  /** Whether the type can be undefined */
  undefinable: boolean;

  /** Type constraints */
  constraints?: TypeConstraint[];

  /** Source location of the type */
  sourceLocation?: { file: string; line: number; column: number };
}

/**
 * Type compatibility issue
 */
export interface TypeCompatibilityIssue {
  /** Type of compatibility issue */
  type: CompatibilityIssueType;

  /** Description of the issue */
  description: string;

  /** Expected type */
  expectedType: CompileTimeTypeInfo;

  /** Actual type */
  actualType: CompileTimeTypeInfo;

  /** Severity of the issue */
  severity: 'error' | 'warning' | 'info';

  /** Location where the issue occurs */
  location?: { line: number; column: number };

  /** Suggested fix */
  suggestedFix?: string;
}

/**
 * Compile-time error
 */
export class CompileTimeError extends Error {
  constructor(
    message: string,
    public readonly errorType: CompileTimeErrorType,
    public readonly expression: string,
    public readonly location?: { line: number; column: number }
  ) {
    super(message);
    this.name = 'CompileTimeError';
  }

  static forTypeIncompatibility(
    expression: string,
    expectedType: string,
    actualType: string,
    location?: { line: number; column: number }
  ): CompileTimeError {
    return new CompileTimeError(
      `Type '${actualType}' is not assignable to type '${expectedType}'`,
      'TYPE_INCOMPATIBILITY',
      expression,
      location
    );
  }

  static forUnsupportedSyntax(
    expression: string,
    syntaxFeature: string,
    location?: { line: number; column: number }
  ): CompileTimeError {
    return new CompileTimeError(
      `Unsupported syntax feature: ${syntaxFeature}`,
      'UNSUPPORTED_SYNTAX',
      expression,
      location
    );
  }

  static forGenericConstraintViolation(
    expression: string,
    constraint: string,
    actualType: string,
    location?: { line: number; column: number }
  ): CompileTimeError {
    return new CompileTimeError(
      `Type '${actualType}' does not satisfy constraint '${constraint}'`,
      'GENERIC_CONSTRAINT_VIOLATION',
      expression,
      location
    );
  }
}

/**
 * Compile-time warning
 */
export class CompileTimeWarning {
  constructor(
    public readonly message: string,
    public readonly warningType: CompileTimeWarningType,
    public readonly expression: string,
    public readonly location?: { line: number; column: number }
  ) { }

  static forPotentialRuntimeError(
    expression: string,
    reason: string,
    location?: { line: number; column: number }
  ): CompileTimeWarning {
    return new CompileTimeWarning(
      `Potential runtime error: ${reason}`,
      'POTENTIAL_RUNTIME_ERROR',
      expression,
      location
    );
  }

  static forPerformanceImpact(
    expression: string,
    impact: string,
    location?: { line: number; column: number }
  ): CompileTimeWarning {
    return new CompileTimeWarning(
      `Performance impact: ${impact}`,
      'PERFORMANCE_IMPACT',
      expression,
      location
    );
  }

  static forDeprecatedFeature(
    expression: string,
    feature: string,
    replacement?: string,
    location?: { line: number; column: number }
  ): CompileTimeWarning {
    const message = replacement
      ? `Deprecated feature '${feature}', use '${replacement}' instead`
      : `Deprecated feature '${feature}'`;

    return new CompileTimeWarning(
      message,
      'DEPRECATED_FEATURE',
      expression,
      location
    );
  }
}

/**
 * Validation metadata
 */
export interface CompileTimeValidationMetadata {
  /** TypeScript version used for validation */
  typescriptVersion?: string;

  /** Compilation target */
  target?: string;

  /** Whether strict mode is enabled */
  strictMode: boolean;

  /** Whether null checks are enabled */
  strictNullChecks: boolean;

  /** Time taken for validation (ms) */
  validationTime: number;

  /** Number of type checks performed */
  typeChecksPerformed: number;

  /** Complexity score of the expression */
  complexityScore: number;
}

/**
 * Type constraint
 */
export interface TypeConstraint {
  /** Type of constraint */
  type: 'extends' | 'keyof' | 'typeof' | 'conditional';

  /** Constraint expression */
  expression: string;

  /** Whether the constraint is satisfied */
  satisfied: boolean;
}

/**
 * Enum types
 */
export type CompatibilityIssueType =
  | 'TYPE_MISMATCH'
  | 'NULLABILITY_MISMATCH'
  | 'OPTIONALITY_MISMATCH'
  | 'GENERIC_PARAMETER_MISMATCH'
  | 'UNION_TYPE_INCOMPATIBILITY'
  | 'CONSTRAINT_VIOLATION';

export type CompileTimeErrorType =
  | 'TYPE_INCOMPATIBILITY'
  | 'UNSUPPORTED_SYNTAX'
  | 'GENERIC_CONSTRAINT_VIOLATION'
  | 'CIRCULAR_TYPE_REFERENCE'
  | 'MISSING_TYPE_INFORMATION';

export type CompileTimeWarningType =
  | 'POTENTIAL_RUNTIME_ERROR'
  | 'PERFORMANCE_IMPACT'
  | 'DEPRECATED_FEATURE'
  | 'TYPE_ASSERTION_USED'
  | 'IMPLICIT_ANY';

/**
 * Compile-time type checker
 */
export class CompileTimeTypeChecker {
  private typeCache = new Map<string, CompileTimeTypeInfo>();
  private validationCache = new Map<string, CompileTimeValidationResult>();

  /**
   * Validate expression compatibility at compile time
   */
  validateExpressionCompatibility(
    expression: string,
    context: CompileTimeValidationContext
  ): CompileTimeValidationResult {
    const startTime = Date.now();

    // Check cache first
    const cacheKey = this.createCacheKey(expression, context);
    const cached = this.validationCache.get(cacheKey);
    if (cached && !context.skipCache) {
      return cached;
    }

    const errors: CompileTimeError[] = [];
    const warnings: CompileTimeWarning[] = [];
    const compatibilityIssues: TypeCompatibilityIssue[] = [];
    const suggestions: string[] = [];

    try {
      // Extract compile-time type information
      const compileTimeType = this.extractCompileTimeType(expression, context);

      // Infer runtime type
      const runtimeType = this.inferRuntimeType(expression, context);

      // Check compatibility between compile-time and runtime types
      const compatibility = this.checkTypeCompatibility(compileTimeType, runtimeType, context);
      compatibilityIssues.push(...compatibility.issues);

      // Validate against expected type if provided
      if (context.expectedType) {
        const expectedCompatibility = this.validateAgainstExpectedType(
          compileTimeType,
          context.expectedType,
          context
        );
        compatibilityIssues.push(...expectedCompatibility.issues);
        errors.push(...expectedCompatibility.errors);
        warnings.push(...expectedCompatibility.warnings);
      }

      // Check for unsupported syntax
      const syntaxValidation = this.validateSyntaxSupport(expression, context);
      errors.push(...syntaxValidation.errors);
      warnings.push(...syntaxValidation.warnings);

      // Check for potential runtime issues
      const runtimeValidation = this.validateRuntimeSafety(expression, compileTimeType, context);
      warnings.push(...runtimeValidation.warnings);
      suggestions.push(...runtimeValidation.suggestions);

      // Generate suggestions for issues
      suggestions.push(...this.generateSuggestions(compatibilityIssues, errors, warnings));

      const validationTime = Date.now() - startTime;

      const result: CompileTimeValidationResult = {
        valid: errors.length === 0 && compatibilityIssues.filter(i => i.severity === 'error').length === 0,
        compileTimeType,
        runtimeType,
        compatibilityIssues,
        errors,
        warnings,
        suggestions,
        metadata: {
          strictMode: context.strictMode || false,
          strictNullChecks: context.strictNullChecks || false,
          validationTime,
          typeChecksPerformed: 1,
          complexityScore: this.calculateComplexityScore(expression)
        }
      };

      // Cache the result
      this.validationCache.set(cacheKey, result);
      return result;
    } catch (_error) {
      const validationError = CompileTimeError.forTypeIncompatibility(
        expression,
        'unknown',
        'unknown'
      );

      const result: CompileTimeValidationResult = {
        valid: false,
        compatibilityIssues,
        errors: [validationError],
        warnings,
        suggestions,
        metadata: {
          strictMode: context.strictMode || false,
          strictNullChecks: context.strictNullChecks || false,
          validationTime: Date.now() - startTime,
          typeChecksPerformed: 0,
          complexityScore: 0
        }
      };

      this.validationCache.set(cacheKey, result);
      return result;
    }
  }

  /**
   * Validate multiple expressions for compatibility
   */
  validateExpressionsCompatibility(
    expressions: string[],
    context: CompileTimeValidationContext
  ): CompileTimeValidationResult[] {
    return expressions.map(expr => this.validateExpressionCompatibility(expr, context));
  }

  /**
   * Validate that a KubernetesRef type is compatible with its usage
   */
  validateKubernetesRefCompatibility(
    ref: KubernetesRef<any>,
    usageContext: KubernetesRefUsageContext,
    validationContext: CompileTimeValidationContext
  ): CompileTimeValidationResult {
    const _expression = `${ref.resourceId}.${ref.fieldPath}`;

    // Extract the compile-time type of the KubernetesRef
    const compileTimeType = this.extractKubernetesRefType(ref, usageContext);

    // Check if the usage is compatible with the type
    const compatibility = this.validateKubernetesRefUsage(ref, usageContext, validationContext);

    return {
      valid: compatibility.valid,
      compileTimeType,
      ...(compatibility.runtimeType && { runtimeType: compatibility.runtimeType }),
      compatibilityIssues: compatibility.issues,
      errors: compatibility.errors,
      warnings: compatibility.warnings,
      suggestions: compatibility.suggestions,
      metadata: {
        strictMode: validationContext.strictMode || false,
        strictNullChecks: validationContext.strictNullChecks || false,
        validationTime: 0,
        typeChecksPerformed: 1,
        complexityScore: 1
      }
    };
  }

  /**
   * Extract compile-time type information from expression
   */
  private extractCompileTimeType(
    expression: string,
    _context: CompileTimeValidationContext
  ): CompileTimeTypeInfo {
    // This would integrate with TypeScript compiler API
    // For now, provide a basic implementation

    // Check for literal types
    if (expression.match(/^["'].*["']$/)) {
      return {
        typeName: 'string',
        isUnion: false,
        isGeneric: false,
        optional: false,
        nullable: false,
        undefinable: false
      };
    }

    if (expression.match(/^\d+(\.\d+)?$/)) {
      return {
        typeName: 'number',
        isUnion: false,
        isGeneric: false,
        optional: false,
        nullable: false,
        undefinable: false
      };
    }

    if (expression === 'true' || expression === 'false') {
      return {
        typeName: 'boolean',
        isUnion: false,
        isGeneric: false,
        optional: false,
        nullable: false,
        undefinable: false
      };
    }

    // Check for boolean expressions
    if (this.isBooleanExpression(expression)) {
      return {
        typeName: 'boolean',
        isUnion: false,
        isGeneric: false,
        optional: false,
        nullable: false,
        undefinable: false
      };
    }

    // Check for numeric expressions
    if (this.isNumericExpression(expression)) {
      return {
        typeName: 'number',
        isUnion: false,
        isGeneric: false,
        optional: false,
        nullable: false,
        undefinable: false
      };
    }

    // Check for resource references
    if (expression.includes('resources.') || expression.includes('schema.')) {
      return {
        typeName: 'KubernetesRef<unknown>',
        isUnion: false,
        isGeneric: true,
        genericParams: ['unknown'],
        optional: false,
        nullable: false,
        undefinable: false
      };
    }

    // Default to unknown
    return {
      typeName: 'unknown',
      isUnion: false,
      isGeneric: false,
      optional: false,
      nullable: false,
      undefinable: false
    };
  }

  /**
   * Infer runtime type from compile-time information
   */
  private inferRuntimeType(
    expression: string,
    context: CompileTimeValidationContext
  ): TypeInfo {
    // Convert compile-time type to runtime type
    const compileTimeType = this.extractCompileTimeType(expression, context);

    return {
      typeName: compileTimeType.typeName,
      optional: compileTimeType.optional,
      nullable: compileTimeType.nullable
    };
  }

  /**
   * Check compatibility between compile-time and runtime types
   */
  private checkTypeCompatibility(
    compileTimeType: CompileTimeTypeInfo,
    runtimeType: TypeInfo,
    _context: CompileTimeValidationContext
  ): { issues: TypeCompatibilityIssue[] } {
    const issues: TypeCompatibilityIssue[] = [];

    // Check basic type compatibility
    if (compileTimeType.typeName !== runtimeType.typeName &&
      !this.areTypesCompatible(compileTimeType.typeName, runtimeType.typeName)) {
      issues.push({
        type: 'TYPE_MISMATCH',
        description: `Compile-time type '${compileTimeType.typeName}' does not match runtime type '${runtimeType.typeName}'`,
        expectedType: compileTimeType,
        actualType: this.convertRuntimeToCompileTime(runtimeType),
        severity: 'error'
      });
    }

    // Check nullability compatibility
    if (compileTimeType.nullable !== runtimeType.nullable) {
      issues.push({
        type: 'NULLABILITY_MISMATCH',
        description: `Nullability mismatch between compile-time and runtime types`,
        expectedType: compileTimeType,
        actualType: this.convertRuntimeToCompileTime(runtimeType),
        severity: 'warning'
      });
    }

    // Check optionality compatibility
    if (compileTimeType.optional !== runtimeType.optional) {
      issues.push({
        type: 'OPTIONALITY_MISMATCH',
        description: `Optionality mismatch between compile-time and runtime types`,
        expectedType: compileTimeType,
        actualType: this.convertRuntimeToCompileTime(runtimeType),
        severity: 'warning'
      });
    }

    return { issues };
  }

  /**
   * Validate against expected type
   */
  private validateAgainstExpectedType(
    actualType: CompileTimeTypeInfo,
    expectedType: CompileTimeTypeInfo,
    _context: CompileTimeValidationContext
  ): { issues: TypeCompatibilityIssue[]; errors: CompileTimeError[]; warnings: CompileTimeWarning[] } {
    const issues: TypeCompatibilityIssue[] = [];
    const errors: CompileTimeError[] = [];
    const warnings: CompileTimeWarning[] = [];

    if (!this.areTypesCompatible(actualType.typeName, expectedType.typeName)) {
      issues.push({
        type: 'TYPE_MISMATCH',
        description: `Type '${actualType.typeName}' is not assignable to type '${expectedType.typeName}'`,
        expectedType,
        actualType,
        severity: 'error',
        suggestedFix: `Convert to ${expectedType.typeName} or adjust the expected type`
      });

      errors.push(CompileTimeError.forTypeIncompatibility(
        '',
        expectedType.typeName,
        actualType.typeName
      ));
    }

    return { issues, errors, warnings };
  }

  /**
   * Validate syntax support
   */
  private validateSyntaxSupport(
    expression: string,
    _context: CompileTimeValidationContext
  ): { errors: CompileTimeError[]; warnings: CompileTimeWarning[] } {
    const errors: CompileTimeError[] = [];
    const warnings: CompileTimeWarning[] = [];

    // Check for unsupported syntax features
    const unsupportedFeatures = [
      { pattern: /async\s+/, feature: 'async/await' },
      { pattern: /yield\s+/, feature: 'generators' },
      { pattern: /class\s+/, feature: 'class declarations' },
      { pattern: /function\*/, feature: 'generator functions' }
    ];

    for (const { pattern, feature } of unsupportedFeatures) {
      if (pattern.test(expression)) {
        errors.push(CompileTimeError.forUnsupportedSyntax(expression, feature));
      }
    }

    // Check for potentially problematic features
    const problematicFeatures = [
      { pattern: /eval\(/, feature: 'eval() usage' },
      { pattern: /new Function/, feature: 'Function constructor' },
      { pattern: /with\s*\(/, feature: 'with statements' }
    ];

    for (const { pattern, feature } of problematicFeatures) {
      if (pattern.test(expression)) {
        warnings.push(CompileTimeWarning.forPotentialRuntimeError(
          expression,
          `${feature} may cause runtime issues`
        ));
      }
    }

    return { errors, warnings };
  }

  /**
   * Validate runtime safety
   */
  private validateRuntimeSafety(
    expression: string,
    compileTimeType: CompileTimeTypeInfo,
    _context: CompileTimeValidationContext
  ): { warnings: CompileTimeWarning[]; suggestions: string[] } {
    const warnings: CompileTimeWarning[] = [];
    const suggestions: string[] = [];

    // Check for potential null/undefined access
    if (expression.includes('.') && !expression.includes('?.')) {
      // For expressions like "obj.prop.nested", assume the intermediate objects could be null
      const propertyAccesses = expression.split('.').length - 1;
      if (propertyAccesses > 1) {
        warnings.push(CompileTimeWarning.forPotentialRuntimeError(
          expression,
          'Property access on potentially null/undefined value'
        ));
        suggestions.push('Consider using optional chaining (?.) for safer property access');
      }
      
      if (compileTimeType.nullable || compileTimeType.undefinable) {
        warnings.push(CompileTimeWarning.forPotentialRuntimeError(
          expression,
          'Property access on potentially null/undefined value'
        ));
        suggestions.push('Consider using optional chaining (?.) for safer property access');
      }
    }

    // Check for performance implications
    if (expression.includes('find(') || expression.includes('filter(')) {
      warnings.push(CompileTimeWarning.forPerformanceImpact(
        expression,
        'Array methods may have performance implications in CEL'
      ));
      suggestions.push('Consider using simpler expressions when possible');
    }

    return { warnings, suggestions };
  }

  /**
   * Extract KubernetesRef type information
   */
  private extractKubernetesRefType(
    ref: KubernetesRef<any>,
    _usageContext: KubernetesRefUsageContext
  ): CompileTimeTypeInfo {
    return {
      typeName: `KubernetesRef<${ref._type || 'unknown'}>`,
      isUnion: false,
      isGeneric: true,
      genericParams: [String(ref._type || 'unknown')],
      optional: false,
      nullable: false,
      undefinable: false
    };
  }

  /**
   * Validate KubernetesRef usage
   */
  private validateKubernetesRefUsage(
    ref: KubernetesRef<any>,
    usageContext: KubernetesRefUsageContext,
    _validationContext: CompileTimeValidationContext
  ): {
    valid: boolean;
    runtimeType?: TypeInfo;
    issues: TypeCompatibilityIssue[];
    errors: CompileTimeError[];
    warnings: CompileTimeWarning[];
    suggestions: string[];
  } {
    const issues: TypeCompatibilityIssue[] = [];
    const errors: CompileTimeError[] = [];
    const warnings: CompileTimeWarning[] = [];
    const suggestions: string[] = [];

    // Validate that the resource exists
    if (!usageContext.availableResources[ref.resourceId] && ref.resourceId !== '__schema__') {
      errors.push(CompileTimeError.forTypeIncompatibility(
        `${ref.resourceId}.${ref.fieldPath}`,
        'Enhanced<any, any>',
        'undefined'
      ));
    }

    // Validate field path
    if (ref.fieldPath.includes('..') || ref.fieldPath.startsWith('.') || ref.fieldPath.endsWith('.')) {
      errors.push(CompileTimeError.forUnsupportedSyntax(
        `${ref.resourceId}.${ref.fieldPath}`,
        'invalid field path syntax'
      ));
    }

    return {
      valid: errors.length === 0,
      runtimeType: { typeName: String(ref._type || 'unknown'), optional: false, nullable: false },
      issues,
      errors,
      warnings,
      suggestions
    };
  }

  /**
   * Utility methods
   */
  private areTypesCompatible(type1: string, type2: string): boolean {
    if (type1 === type2) return true;
    if (type1 === 'any' || type2 === 'any') return true;
    if (type1 === 'unknown' || type2 === 'unknown') return true;

    // Handle basic type compatibility
    const compatibilityMap: Record<string, string[]> = {
      'string': ['string', 'String'],
      'number': ['number', 'Number'],
      'boolean': ['boolean', 'Boolean'],
      'null': ['null', 'undefined'],
      'undefined': ['undefined', 'null']
    };

    return compatibilityMap[type1]?.includes(type2) || false;
  }

  private convertRuntimeToCompileTime(runtimeType: TypeInfo): CompileTimeTypeInfo {
    return {
      typeName: runtimeType.typeName,
      isUnion: false,
      isGeneric: false,
      optional: runtimeType.optional,
      nullable: runtimeType.nullable,
      undefinable: runtimeType.optional
    };
  }

  private generateSuggestions(
    issues: TypeCompatibilityIssue[],
    errors: CompileTimeError[],
    _warnings: CompileTimeWarning[]
  ): string[] {
    const suggestions: string[] = [];

    // Generate suggestions based on issues
    for (const issue of issues) {
      if (issue.suggestedFix) {
        suggestions.push(issue.suggestedFix);
      }
    }

    // Generate suggestions based on errors
    for (const error of errors) {
      if (error.errorType === 'TYPE_INCOMPATIBILITY') {
        suggestions.push('Consider adding type assertions or converting the value to the expected type');
      }
    }

    return [...new Set(suggestions)]; // Remove duplicates
  }

  private calculateComplexityScore(expression: string): number {
    let score = 0;

    // Basic complexity factors
    score += (expression.match(/\./g) || []).length; // Property access
    score += (expression.match(/\(/g) || []).length; // Function calls
    score += (expression.match(/\?/g) || []).length; // Conditional operators
    score += (expression.match(/&&|\|\|/g) || []).length; // Logical operators

    return Math.min(10, score);
  }

  private createCacheKey(expression: string, context: CompileTimeValidationContext): string {
    return `${expression}:${JSON.stringify({
      strictMode: context.strictMode,
      strictNullChecks: context.strictNullChecks,
      expectedType: context.expectedType?.typeName
    })}`;
  }

  private isBooleanExpression(expression: string): boolean {
    // Boolean operators
    const booleanOperators = ['&&', '||', '!', '==', '!=', '===', '!==', '>', '<', '>=', '<='];
    return booleanOperators.some(op => expression.includes(op));
  }

  private isNumericExpression(expression: string): boolean {
    // Numeric operators
    const numericOperators = ['+', '-', '*', '/', '%'];
    return numericOperators.some(op => expression.includes(op)) &&
      !expression.includes('"') && !expression.includes("'");
  }

  /**
   * Clear validation cache
   */
  clearCache(): void {
    this.typeCache.clear();
    this.validationCache.clear();
  }
}

/**
 * Compile-time validation context
 */
export interface CompileTimeValidationContext {
  /** Whether strict mode is enabled */
  strictMode?: boolean;

  /** Whether strict null checks are enabled */
  strictNullChecks?: boolean;

  /** Expected type for the expression */
  expectedType?: CompileTimeTypeInfo;

  /** Available type definitions */
  availableTypes?: Record<string, CompileTimeTypeInfo>;

  /** Whether to skip cache lookup */
  skipCache?: boolean;

  /** TypeScript compiler options */
  compilerOptions?: any;
}

/**
 * KubernetesRef usage context
 */
export interface KubernetesRefUsageContext {
  /** Available resources */
  availableResources: Record<string, Enhanced<any, any>>;

  /** Schema proxy if available */
  schemaProxy?: SchemaProxy<any, any>;

  /** How the KubernetesRef is being used */
  usageType: 'property-access' | 'method-call' | 'comparison' | 'template-literal';

  /** Expected result type of the usage */
  expectedResultType?: CompileTimeTypeInfo;
}