/**
 * Compile-Time Type Definitions for Expression Compatibility
 *
 * This module provides all type definitions used by the compile-time
 * type checking system for JavaScript to CEL expression conversion.
 */

import type { Enhanced } from '../../types/kubernetes.js';
import type { SchemaProxy } from '../../types/serialization.js';
// Import error/warning classes and their type discriminants from compile-time-errors.
// Note: one-directional import (types → errors) with no reverse dependency.
import type { CompileTimeError, CompileTimeWarning } from './compile-time-errors.js';
import type { TypeInfo } from './type-safety.js';

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

// CompileTimeErrorType and CompileTimeWarningType are defined in compile-time-errors.ts
// and re-exported from the barrel index. They are imported above for use in this file.

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
  compilerOptions?: Record<string, unknown> | undefined;
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
