/**
 * Type definitions for the Status Builder Analyzer.
 *
 * These types define the interfaces for status builder function analysis,
 * field-level analysis results, and status field handling strategies.
 */

import type { Node as ESTreeNode, ReturnStatement } from 'estree';
import type { ConversionError } from '../../errors.js';
import type { CelExpression, KubernetesRef } from '../../types/common.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { SchemaProxy } from '../../types/serialization.js';
import type { SourceMapEntry } from '../analysis/source-map.js';
import type {
  FieldHydrationState,
  OptionalityAnalysisResult,
} from '../magic-proxy/optionality-types.js';

/**
 * Status builder function type for analysis
 */
export type StatusBuilderFunction<TSpec extends object = Record<string, unknown>, TStatus = unknown> = (
  schema: SchemaProxy<TSpec, Record<string, unknown>>,
  resources: Record<string, Enhanced<unknown, unknown>>
) => TStatus;

/**
 * Status field analysis result
 */
export interface StatusFieldAnalysisResult {
  /** Field name in the status object */
  fieldName: string;

  /** Original JavaScript expression */
  originalExpression: unknown;

  /** Converted CEL expression */
  celExpression: CelExpression | null;

  /** KubernetesRef dependencies detected */
  dependencies: KubernetesRef<unknown>[];

  /** Whether the expression requires conversion */
  requiresConversion: boolean;

  /** Whether the expression is valid */
  valid: boolean;

  /** Conversion errors */
  errors: ConversionError[];

  /** Source mapping entries */
  sourceMap: SourceMapEntry[];

  /** Optionality analysis results */
  optionalityAnalysis: OptionalityAnalysisResult[];

  /** Type information */
  inferredType: string | undefined;

  /** Confidence level of the analysis */
  confidence: number;

  /** Static value for object expressions that can be evaluated at compile time */
  staticValue?: unknown;

  /** Warnings about patterns that may produce unexpected results */
  warnings: string[];
}

/**
 * Status builder analysis result
 */
export interface StatusBuilderAnalysisResult {
  /** Analysis results for each status field */
  fieldAnalysis: Map<string, StatusFieldAnalysisResult>;

  /** Overall status mappings (field name -> CEL expression or static value) */
  statusMappings: Record<string, unknown>;

  /** All KubernetesRef dependencies found */
  allDependencies: KubernetesRef<unknown>[];

  /** All resource references */
  resourceReferences: KubernetesRef<unknown>[];

  /** All schema references */
  schemaReferences: KubernetesRef<unknown>[];

  /** Overall source mapping */
  sourceMap: SourceMapEntry[];

  /** All errors encountered */
  errors: ConversionError[];

  /** Whether the analysis was successful */
  valid: boolean;

  /** Warnings about patterns that may produce unexpected results (e.g., ||/&& with KubernetesRef) */
  warnings: string[];

  /** Original status builder function source */
  originalSource: string;

  /** Parsed AST of the status builder */
  ast?: ESTreeNode;

  /** Return statement analysis */
  returnStatement?: ReturnStatementAnalysis;
}

/**
 * Return statement analysis
 */
export interface ReturnStatementAnalysis {
  /** The return statement node */
  node: ReturnStatement;

  /** Whether it returns an object expression */
  returnsObject: boolean;

  /** Properties in the returned object */
  properties: PropertyAnalysis[];

  /** Source location information */
  sourceLocation: {
    line: number;
    column: number;
    length: number;
  };
}

/**
 * Property analysis for object expressions
 */
export interface PropertyAnalysis {
  /** Property name */
  name: string;

  /** Property value node */
  valueNode: ESTreeNode;

  /** Property value as string */
  valueSource: string;

  /** Whether the property contains KubernetesRef objects */
  containsKubernetesRefs: boolean;

  /** Source location */
  sourceLocation: {
    line: number;
    column: number;
    length: number;
  };
}

/**
 * Status field handling information
 */
export interface StatusFieldHandlingInfo {
  /** The KubernetesRef being handled */
  kubernetesRef: KubernetesRef<unknown>;

  /** Whether this field requires hydration */
  requiresHydration: boolean;

  /** Whether this field is optional */
  isOptional: boolean;

  /** Handling strategy for this field */
  strategy: StatusHandlingStrategy;

  /** Priority for evaluation (lower = higher priority) */
  priority: number;

  /** Category of the status field */
  fieldCategory: StatusFieldCategory;

  /** Expected availability timing */
  expectedAvailability: FieldAvailabilityEstimate;
}

/**
 * Status handling strategy
 */
export type StatusHandlingStrategy =
  | 'direct-access' // Direct field access, no special handling
  | 'null-safety-only' // Add null-safety checks only
  | 'hydration-required' // Field requires hydration
  | 'hydration-with-null-safety'; // Field requires hydration and null-safety

/**
 * Status field category
 */
export type StatusFieldCategory =
  | 'readiness-indicator' // Fields indicating readiness (ready, available)
  | 'condition-status' // Kubernetes conditions
  | 'replica-status' // Replica counts and status
  | 'network-status' // Network-related status (loadBalancer, ingress)
  | 'lifecycle-status' // Lifecycle status (phase, state)
  | 'general-status'; // Other status fields

/**
 * Field availability estimate
 */
export type FieldAvailabilityEstimate =
  | 'immediate' // Available immediately (metadata, spec)
  | 'delayed' // Available after some processing (most status fields)
  | 'very-delayed'; // Available after external resources (loadBalancer)

/**
 * Options for status builder analysis
 */
export interface StatusBuilderAnalysisOptions {
  /** Whether to perform deep analysis */
  deepAnalysis?: boolean;

  /** Whether to include source mapping */
  includeSourceMapping?: boolean;

  /** Whether to validate resource references */
  validateReferences?: boolean;

  /** Whether to perform optionality analysis */
  performOptionalityAnalysis?: boolean;

  /** Factory type for CEL generation */
  factoryType?: 'direct' | 'kro';

  /** Maximum analysis depth */
  maxDepth?: number;

  /** Field hydration states for optionality analysis */
  hydrationStates?: Map<string, FieldHydrationState>;

  /** Whether to use conservative null-safety */
  conservativeNullSafety?: boolean;
}
