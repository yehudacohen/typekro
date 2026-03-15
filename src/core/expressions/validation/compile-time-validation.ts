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
export {
  CompileTimeError,
  type CompileTimeErrorType,
  CompileTimeWarning,
  type CompileTimeWarningType,
} from './compile-time-errors.js';
// Types
export type {
  CompatibilityIssueType,
  CompileTimeTypeInfo,
  CompileTimeValidationContext,
  CompileTimeValidationMetadata,
  CompileTimeValidationResult,
  KubernetesRefUsageContext,
  TypeCompatibilityIssue,
  TypeConstraint,
} from './compile-time-types.js';
