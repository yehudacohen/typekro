/**
 * Shared types for the expression analysis system
 *
 * These types are extracted from analyzer.ts to break circular dependencies:
 * - analyzer.ts → cache.ts → analyzer.ts (cycle 6)
 * - analyzer.ts → factory-pattern-handler.ts → analyzer.ts (cycle 7)
 *
 * Both cache.ts and factory-pattern-handler.ts import AnalysisContext and
 * CelConversionResult. By placing these interfaces in a separate file,
 * all three modules can import from here without creating cycles.
 */

import type { ConversionError } from '../../errors.js';
import type { CelExpression, KubernetesRef } from '../../types/common.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { SchemaProxy } from '../../types/serialization.js';
import type {
  CompileTimeValidationContext,
  CompileTimeValidationResult,
} from '../validation/compile-time-validation.js';
import type {
  ResourceValidationResult,
  ValidationContext,
} from '../validation/resource-validation.js';
import type { TypeInfo, TypeRegistry, TypeValidationResult } from '../validation/type-safety.js';
import type { SourceMapBuilder, SourceMapEntry } from './source-map.js';

/**
 * Context information for analyzing JavaScript expressions
 */
export interface AnalysisContext {
  /** Type of context where the expression is being analyzed */
  type: 'status' | 'resource' | 'condition' | 'readiness';

  /** Available resource references from magic proxy system */
  // biome-ignore lint/suspicious/noExplicitAny: Enhanced requires flexible spec/status types for analysis contexts
  availableReferences: Record<string, Enhanced<any, any>>;

  /** Schema proxy for schema field references */
  // biome-ignore lint/suspicious/noExplicitAny: SchemaProxy requires flexible spec/status types
  schemaProxy?: SchemaProxy<any, any>;

  /** Factory pattern being used (affects CEL generation strategy) */
  factoryType: 'direct' | 'kro';

  /** Source mapping builder for debugging */
  sourceMap?: SourceMapBuilder;

  /** Additional dependencies detected during analysis */
  dependencies?: KubernetesRef<unknown>[];

  /** Original source text for accurate source location tracking */
  sourceText?: string;

  /** Type registry for type validation */
  typeRegistry?: TypeRegistry;

  /** Expected result type for validation */
  expectedType?: TypeInfo;

  /** Whether to perform strict type checking */
  strictTypeChecking?: boolean;

  /** Whether to validate resource references */
  validateResourceReferences?: boolean;

  /** Validation context for resource references */
  validationContext?: ValidationContext;

  /** Whether to perform compile-time type checking */
  compileTimeTypeChecking?: boolean;

  /** Compile-time validation context */
  compileTimeContext?: CompileTimeValidationContext;
}

/**
 * Callback type for AST node → CelExpression conversion.
 * Used by extracted converter modules to recursively delegate back to the analyzer.
 */
export type ConvertNodeFn = (
  node: import('estree').Node,
  context: AnalysisContext
) => CelExpression;

/**
 * Generic validation warning
 */
export interface ValidationWarning {
  /** Warning message */
  message: string;

  /** Warning type/category */
  type: string;

  /** Optional suggestion for fixing the warning */
  suggestion?: string;
}

/**
 * Result of CEL conversion analysis
 */
export interface CelConversionResult {
  /** Whether the conversion was successful */
  valid: boolean;

  /** Generated CEL expression (null if conversion failed) */
  celExpression: CelExpression | null;

  /** KubernetesRef dependencies detected in the expression */
  dependencies: KubernetesRef<unknown>[];

  /** Source mapping entries for debugging */
  sourceMap: SourceMapEntry[];

  /** Conversion errors encountered */
  errors: ConversionError[];

  /** Whether the expression actually requires conversion (contains KubernetesRef objects) */
  requiresConversion: boolean;

  /** Type validation result */
  typeValidation?: TypeValidationResult | undefined;

  /** Inferred result type of the expression */
  inferredType?: TypeInfo | undefined;

  /** Resource validation results */
  resourceValidation?: ResourceValidationResult[] | undefined;

  /** Compile-time validation result */
  compileTimeValidation?: CompileTimeValidationResult | undefined;

  /** Aggregated warnings from all validation results */
  warnings: ValidationWarning[];
}
