/**
 * Compile-Time Type Checking for Expression Compatibility
 *
 * Barrel re-export for backward compatibility. All implementations have been
 * decomposed into:
 * - compile-time-types.ts — Type definitions and interfaces
 * - compile-time-errors.ts — Error and warning classes
 * - compile-time-checker.ts — Main CompileTimeTypeChecker class
 */

// Main checker class
export { CompileTimeTypeChecker } from './compile-time-checker.js';

// Error and warning classes
export { CompileTimeError, CompileTimeWarning } from './compile-time-errors.js';
// Types
export type {
  CompatibilityIssueType,
  CompileTimeErrorType,
  CompileTimeTypeInfo,
  CompileTimeValidationContext,
  CompileTimeValidationMetadata,
  CompileTimeValidationResult,
  CompileTimeWarningType,
  KubernetesRefUsageContext,
  TypeCompatibilityIssue,
  TypeConstraint,
} from './compile-time-types.js';
