/**
 * Compile-Time Error and Warning Classes
 *
 * This module provides error and warning classes for the compile-time
 * type checking system for JavaScript to CEL expression conversion.
 */

import { TypeKroError } from '../../errors.js';
import type { CompileTimeErrorType, CompileTimeWarningType } from './compile-time-types.js';

/**
 * Compile-time error
 */
export class CompileTimeError extends TypeKroError {
  constructor(
    message: string,
    public readonly errorType: CompileTimeErrorType,
    public readonly expression: string,
    public readonly location?: { line: number; column: number }
  ) {
    super(message, 'COMPILE_TIME_ERROR', {
      errorType,
      expression,
      location,
    });
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
  ) {}

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

    return new CompileTimeWarning(message, 'DEPRECATED_FEATURE', expression, location);
  }
}
