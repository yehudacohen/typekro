/**
 * Enhanced Type Optionality Handler for JavaScript to CEL Expression Conversion
 * 
 * This module handles the mismatch between Enhanced type compile-time non-optionality
 * and runtime optionality during field hydration. Enhanced types show fields as
 * non-optional at compile time, but KubernetesRef objects might resolve to undefined
 * during field hydration.
 * 
 * Key Features:
 * - Automatic null-safety detection for Enhanced type KubernetesRef objects
 * - CEL expression generation with has() checks for potentially undefined fields
 * - Support for optional chaining with Enhanced types that appear non-optional
 * - Integration with field hydration timing to handle undefined-to-defined transitions
 * - Context-aware optionality handling based on field hydration state
 */

import type { CelExpression, KubernetesRef } from '../types/common.js';
import type { Enhanced } from '../types/kubernetes.js';
import { ConversionError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import { isKubernetesRef, } from '../../utils/type-guards.js';
import type { SourceMapEntry } from './source-map.js';
import type { AnalysisContext, CelConversionResult } from './analyzer.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../constants/brands.js';

/**
 * Optionality analysis result for a KubernetesRef
 */
export interface OptionalityAnalysisResult {
  /** The KubernetesRef being analyzed */
  kubernetesRef: KubernetesRef<any>;
  
  /** Whether this field might be undefined at runtime */
  potentiallyUndefined: boolean;
  
  /** Whether this field requires null-safety checks */
  requiresNullSafety: boolean;
  
  /** Whether optional chaining was used in the original expression */
  hasOptionalChaining: boolean;
  
  /** The field path being accessed */
  fieldPath: string;
  
  /** The resource ID being referenced */
  resourceId: string;
  
  /** Whether this is a schema reference */
  isSchemaReference: boolean;
  
  /** Confidence level of the optionality analysis (0-1) */
  confidence: number;
  
  /** Reason for the optionality determination */
  reason: string;
  
  /** Suggested CEL expression pattern for null-safety */
  suggestedCelPattern: string | undefined;
}

/**
 * Field hydration state information
 */
export interface FieldHydrationState {
  /** Resource ID */
  resourceId: string;
  
  /** Field path */
  fieldPath: string;
  
  /** Whether the field is currently hydrated */
  isHydrated: boolean;
  
  /** Whether the field is in the process of being hydrated */
  isHydrating: boolean;
  
  /** Whether the field has failed hydration */
  hydrationFailed: boolean;
  
  /** Timestamp of last hydration attempt */
  lastHydrationAttempt?: Date;
  
  /** Expected hydration completion time */
  expectedHydrationTime?: Date;
}

/**
 * Optionality handling context
 */
export interface OptionalityContext extends AnalysisContext {
  /** Current field hydration states */
  hydrationStates?: Map<string, FieldHydrationState>;
  
  /** Whether to be conservative with null-safety (default: true) */
  conservativeNullSafety?: boolean;
  
  /** Whether to use Kro's conditional operators */
  useKroConditionals?: boolean;
  
  /** Whether to generate has() checks for potentially undefined fields */
  generateHasChecks?: boolean;
  
  /** Maximum depth for optionality analysis */
  maxOptionalityDepth?: number;
}

/**
 * Optional chaining pattern information
 */
export interface OptionalChainingPattern {
  /** The KubernetesRef involved in optional chaining */
  kubernetesRef: KubernetesRef<any>;
  
  /** Field path being accessed */
  fieldPath: string;
  
  /** Whether this is an Enhanced type */
  isEnhancedType: boolean;
  
  /** Whether the field appears non-optional at compile time */
  appearsNonOptional: boolean;
  
  /** Whether the field is actually optional at runtime */
  actuallyOptional: boolean;
  
  /** Depth of the chaining (number of dots) */
  chainingDepth: number;
  
  /** Suggested CEL pattern for this optional chaining */
  suggestedCelPattern: string;
}

/**
 * Enhanced type field information
 */
export interface EnhancedTypeFieldInfo {
  /** The KubernetesRef for this field */
  kubernetesRef: KubernetesRef<any>;
  
  /** Field path */
  fieldPath: string;
  
  /** Whether this is an Enhanced type */
  isEnhancedType: boolean;
  
  /** Whether the field appears non-optional at compile time */
  appearsNonOptional: boolean;
  
  /** Whether the field is actually optional at runtime */
  actuallyOptional: boolean;
  
  /** Whether this is a status field */
  isStatusField: boolean;
  
  /** Whether this field requires optional chaining handling */
  requiresOptionalChaining: boolean;
  
  /** Confidence level of the analysis */
  confidence: number;
}

/**
 * Hydration state analysis result
 */
export interface HydrationStateAnalysis {
  /** References that are not yet hydrated */
  unhydratedRefs: KubernetesRef<any>[];
  
  /** References that are fully hydrated */
  hydratedRefs: KubernetesRef<any>[];
  
  /** References that are currently being hydrated */
  hydratingRefs: KubernetesRef<any>[];
  
  /** References that failed hydration */
  failedRefs: KubernetesRef<any>[];
  
  /** Total number of references */
  totalRefs: number;
  
  /** Hydration progress (0-1) */
  hydrationProgress: number;
}

/**
 * Hydration transition plan
 */
export interface HydrationTransitionPlan {
  /** Hydration phases in order */
  phases: HydrationPhase[];
  
  /** Total expected duration for all phases */
  totalDuration: number;
  
  /** Critical fields that must be hydrated for the expression to work */
  criticalFields: string[];
}

/**
 * Hydration phase information
 */
export interface HydrationPhase {
  /** Phase name */
  name: string;
  
  /** Fields expected to be hydrated in this phase */
  fields: KubernetesRef<any>[];
  
  /** Expected duration for this phase (milliseconds) */
  expectedDuration: number;
  
  /** Dependencies that must be satisfied before this phase */
  dependencies: string[];
  
  /** Whether this phase is critical for expression evaluation */
  isCritical: boolean;
}

/**
 * Hydration transition handler
 */
export interface HydrationTransitionHandler {
  /** State transitioning from */
  fromState: HydrationState;
  
  /** State transitioning to */
  toState: HydrationState;
  
  /** Condition that triggers this transition */
  triggerCondition: string;
  
  /** Expression to use during this transition */
  transitionExpression: CelExpression;
  
  /** Priority of this handler (lower = higher priority) */
  priority: number;
}

/**
 * Hydration state
 */
export type HydrationState = 'unhydrated' | 'hydrating' | 'hydrated' | 'failed';

/**
 * Result of undefined-to-defined transition handling
 */
export interface UndefinedToDefinedTransitionResult {
  /** Transition plan for hydration phases */
  transitionPlan: HydrationTransitionPlan;
  
  /** Expressions for each hydration phase */
  phaseExpressions: Map<string, CelExpression>;
  
  /** Watch expressions for monitoring hydration progress */
  watchExpressions: CelExpression[];
  
  /** Fallback expressions for hydration failures */
  fallbackExpressions: Map<string, CelExpression>;
  
  /** Whether the transition handling was successful */
  valid: boolean;
  
  /** Errors encountered during transition handling */
  errors: ConversionError[];
}

/**
 * Options for optionality handling
 */
export interface OptionalityHandlingOptions {
  /** Whether to perform deep optionality analysis */
  deepAnalysis?: boolean;
  
  /** Whether to be conservative with null-safety */
  conservative?: boolean;
  
  /** Whether to use Kro's conditional operators */
  useKroConditionals?: boolean;
  
  /** Whether to generate has() checks */
  generateHasChecks?: boolean;
  
  /** Maximum analysis depth */
  maxDepth?: number;
  
  /** Whether to include detailed reasoning */
  includeReasoning?: boolean;
}

/**
 * Default optionality handling options
 */
const DEFAULT_OPTIONALITY_OPTIONS: Required<OptionalityHandlingOptions> = {
  deepAnalysis: true,
  conservative: true,
  useKroConditionals: true,
  generateHasChecks: true,
  maxDepth: 5,
  includeReasoning: true
};

/**
 * Enhanced Type Optionality Handler
 * 
 * Handles the complexity of Enhanced types that appear non-optional at compile time
 * but may be undefined at runtime during field hydration.
 */
export class EnhancedTypeOptionalityHandler {
  private options: Required<OptionalityHandlingOptions>;
  private logger = getComponentLogger('optionality-handler');

  constructor(options?: OptionalityHandlingOptions) {
    this.options = { ...DEFAULT_OPTIONALITY_OPTIONS, ...options };
  }

  /**
   * Analyze KubernetesRef objects for optionality requirements
   * 
   * This method determines whether KubernetesRef objects in expressions require
   * null-safety handling based on Enhanced type behavior and field hydration timing.
   */
  analyzeOptionalityRequirements(
    expression: any,
    context: OptionalityContext
  ): OptionalityAnalysisResult[] {
    const results: OptionalityAnalysisResult[] = [];
    
    try {
      // Extract all KubernetesRef objects from the expression
      const kubernetesRefs = this.extractKubernetesRefs(expression);
      
      this.logger.debug('Analyzing optionality requirements', {
        expressionType: typeof expression,
        kubernetesRefCount: kubernetesRefs.length,
        contextType: context.type
      });

      for (const ref of kubernetesRefs) {
        const analysis = this.analyzeKubernetesRefOptionality(ref, context);
        results.push(analysis);
      }
      
      return results;
      
    } catch (error) {
      this.logger.error('Failed to analyze optionality requirements', error as Error);
      return [];
    }
  }

  /**
   * Generate CEL expressions with appropriate null-safety checks
   * 
   * This method takes the optionality analysis results and generates CEL expressions
   * that include proper null-safety handling for potentially undefined fields.
   */
  generateNullSafeCelExpression(
    originalExpression: any,
    optionalityResults: OptionalityAnalysisResult[],
    context: OptionalityContext
  ): CelConversionResult {
    try {
      // Determine if any KubernetesRef objects require null-safety
      const requiresNullSafety = optionalityResults.some(result => result.requiresNullSafety);
      
      if (!requiresNullSafety) {
        // No null-safety required, return as-is
        return {
          valid: true,
          celExpression: this.convertToBasicCel(originalExpression, context),
          dependencies: optionalityResults.map(r => r.kubernetesRef),
          sourceMap: [],
          errors: [],
          warnings: [],
          requiresConversion: optionalityResults.length > 0
        };
      }

      // Generate null-safe CEL expression
      const nullSafeCel = this.generateNullSafeExpression(originalExpression, optionalityResults, context);
      
      return {
        valid: true,
        celExpression: nullSafeCel,
        dependencies: optionalityResults.map(r => r.kubernetesRef),
        sourceMap: this.generateSourceMapping(originalExpression, nullSafeCel, context),
        errors: [],
        warnings: [],
        requiresConversion: true
      };
      
    } catch (error) {
      const conversionError = new ConversionError(
        `Failed to generate null-safe CEL expression: ${error instanceof Error ? error.message : String(error)}`,
        String(originalExpression),
        'unknown'
      );
      
      return {
        valid: false,
        celExpression: null,
        dependencies: optionalityResults.map(r => r.kubernetesRef),
        sourceMap: [],
        errors: [conversionError],
        warnings: [],
        requiresConversion: true
      };
    }
  }

  /**
   * Handle optional chaining with Enhanced types
   * 
   * This method specifically handles cases where optional chaining is used with
   * Enhanced types that appear non-optional at compile time.
   */
  handleOptionalChainingWithEnhancedTypes(
    expression: any,
    context: OptionalityContext
  ): CelConversionResult {
    try {
      // Detect optional chaining patterns in the expression
      const optionalChainingAnalysis = this.analyzeOptionalChainingPatterns(expression, context);
      
      if (optionalChainingAnalysis.patterns.length === 0) {
        // No optional chaining detected - analyze for regular optionality
        const optionalityResults = this.analyzeOptionalityRequirements(expression, context);
        return this.generateNullSafeCelExpression(expression, optionalityResults, context);
      }

      // Generate appropriate CEL expressions for optional chaining with Enhanced types
      const celResult = this.generateOptionalChainingCelExpression(
        expression,
        optionalChainingAnalysis,
        context
      );
      
      return celResult;
      
    } catch (error) {
      const conversionError = new ConversionError(
        `Failed to handle optional chaining: ${error instanceof Error ? error.message : String(error)}`,
        String(expression),
        'optional-chaining'
      );
      
      return {
        valid: false,
        celExpression: null,
        dependencies: this.extractKubernetesRefs(expression),
        sourceMap: [],
        errors: [conversionError],
        warnings: [],
        requiresConversion: true
      };
    }
  }

  /**
   * Analyze optional chaining patterns in expressions with Enhanced types
   */
  private analyzeOptionalChainingPatterns(
    expression: any,
    context: OptionalityContext
  ): {
    patterns: OptionalChainingPattern[];
    enhancedTypeFields: EnhancedTypeFieldInfo[];
    requiresSpecialHandling: boolean;
  } {
    const patterns: OptionalChainingPattern[] = [];
    const enhancedTypeFields: EnhancedTypeFieldInfo[] = [];
    
    // Extract KubernetesRef objects that might be involved in optional chaining
    const kubernetesRefs = this.extractKubernetesRefs(expression);
    
    for (const ref of kubernetesRefs) {
      // Check if this KubernetesRef represents an Enhanced type field
      const enhancedFieldInfo = this.analyzeEnhancedTypeField(ref, context);
      
      if (enhancedFieldInfo.isEnhancedType) {
        enhancedTypeFields.push(enhancedFieldInfo);
        
        // Create optional chaining pattern for this Enhanced type field
        const pattern: OptionalChainingPattern = {
          kubernetesRef: ref,
          fieldPath: ref.fieldPath || '',
          isEnhancedType: true,
          appearsNonOptional: enhancedFieldInfo.appearsNonOptional,
          actuallyOptional: enhancedFieldInfo.actuallyOptional,
          chainingDepth: this.calculateChainingDepth(ref.fieldPath || ''),
          suggestedCelPattern: this.generateOptionalChainingCelPattern(ref, context)
        };
        
        patterns.push(pattern);
      }
    }
    
    const requiresSpecialHandling = enhancedTypeFields.some(field => 
      field.appearsNonOptional && field.actuallyOptional
    );
    
    return { patterns, enhancedTypeFields, requiresSpecialHandling };
  }

  /**
   * Analyze Enhanced type field information
   */
  private analyzeEnhancedTypeField(
    kubernetesRef: KubernetesRef<any>,
    context: OptionalityContext
  ): EnhancedTypeFieldInfo {
    const fieldPath = kubernetesRef.fieldPath || '';
    const isStatusField = fieldPath.startsWith('status.');
    
    // Enhanced types in status fields appear non-optional but are actually optional
    const appearsNonOptional = !fieldPath.includes('?') && !fieldPath.includes('|');
    const actuallyOptional = isStatusField || this.isPotentiallyUndefinedAtRuntime(kubernetesRef, context);
    
    return {
      kubernetesRef,
      fieldPath,
      isEnhancedType: true,
      appearsNonOptional,
      actuallyOptional,
      isStatusField,
      requiresOptionalChaining: appearsNonOptional && actuallyOptional,
      confidence: this.calculateOptionalityConfidence(kubernetesRef, context)
    };
  }

  /**
   * Generate CEL expression for optional chaining with Enhanced types
   */
  private generateOptionalChainingCelExpression(
    expression: any,
    optionalChainingAnalysis: {
      patterns: OptionalChainingPattern[];
      enhancedTypeFields: EnhancedTypeFieldInfo[];
      requiresSpecialHandling: boolean;
    },
    context: OptionalityContext
  ): CelConversionResult {
    try {
      if (!optionalChainingAnalysis.requiresSpecialHandling) {
        // No special handling needed - use regular conversion
        const optionalityResults = this.analyzeOptionalityRequirements(expression, context);
        return this.generateNullSafeCelExpression(expression, optionalityResults, context);
      }

      // Generate CEL expression with proper optional chaining support
      let celExpression: string;
      
      if (context.useKroConditionals) {
        // Use Kro's conditional operators for optional chaining
        celExpression = this.generateKroOptionalChainingExpression(
          optionalChainingAnalysis.patterns,
          context
        );
      } else {
        // Use has() checks for optional chaining
        celExpression = this.generateHasCheckOptionalChainingExpression(
          optionalChainingAnalysis.patterns,
          context
        );
      }
      
      const dependencies = optionalChainingAnalysis.patterns.map(p => p.kubernetesRef);
      
      return {
        valid: true,
        celExpression: {
          [CEL_EXPRESSION_BRAND]: true,
          expression: celExpression,
          type: this.inferExpressionType(expression, context)
        } as CelExpression,
        dependencies,
        sourceMap: this.generateSourceMapping(expression, { expression: celExpression } as any, context),
        errors: [],
        warnings: [],
        requiresConversion: true
      };
      
    } catch (error) {
      const conversionError = new ConversionError(
        `Failed to generate optional chaining CEL: ${error instanceof Error ? error.message : String(error)}`,
        String(expression),
        'optional-chaining'
      );
      
      return {
        valid: false,
        celExpression: null,
        dependencies: optionalChainingAnalysis.patterns.map(p => p.kubernetesRef),
        sourceMap: [],
        errors: [conversionError],
        warnings: [],
        requiresConversion: true
      };
    }
  }

  /**
   * Generate Kro CEL expression with ? prefix operator for optional chaining
   * 
   * Kro uses the ? operator as a prefix before field names for optional access
   */
  private generateKroOptionalChainingExpression(
    patterns: OptionalChainingPattern[],
    _context: OptionalityContext
  ): string {
    if (patterns.length === 0) {
      return 'null';
    }
    
    // For Kro, use ? prefix operator for optional field access
    const expressions = patterns.map(pattern => {
      const resourcePath = pattern.kubernetesRef.resourceId === '__schema__' 
        ? `schema.${pattern.fieldPath}`
        : `resources.${pattern.kubernetesRef.resourceId}.${pattern.fieldPath}`;
      
      // Convert field.path.to.value to field.?path.?to.?value (Kro ? prefix syntax)
      const optionalPath = this.convertToKroOptionalSyntax(resourcePath);
      return optionalPath;
    });
    
    // Combine multiple patterns if needed
    if (expressions.length === 1) {
      return expressions[0] || 'null';
    }
    
    // For multiple patterns, use logical AND
    return expressions.join(' && ');
  }

  /**
   * Convert a field path to Kro's ? prefix optional syntax
   * Example: resources.service.status.loadBalancer.ingress[0].ip
   * Becomes: resources.service.status.?loadBalancer.?ingress[0].?ip
   * 
   * The ? operator should be placed before fields that might not exist
   */
  private convertToKroOptionalSyntax(resourcePath: string): string {
    // Split the path into parts, handling array access
    const parts = resourcePath.split('.');
    const result: string[] = [];
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      
      // Ensure part is defined
      if (!part) continue;
      
      // Don't add ? to root parts (resources, schema) or the resource ID
      if (i < 3) {
        result.push(part);
      } else {
        // Add ? prefix for optional access to nested fields that might not exist
        if (part.includes('[')) {
          // Handle array access: field[0] becomes ?field[0]
          result.push(`?${part}`);
        } else {
          result.push(`?${part}`);
        }
      }
    }
    
    return result.join('.');
  }

  /**
   * Generate has() check expression for optional chaining
   */
  private generateHasCheckOptionalChainingExpression(
    patterns: OptionalChainingPattern[],
    _context: OptionalityContext
  ): string {
    if (patterns.length === 0) {
      return 'null';
    }
    
    const expressions: string[] = [];
    
    for (const pattern of patterns) {
      const resourcePath = pattern.kubernetesRef.resourceId === '__schema__' 
        ? `schema.${pattern.fieldPath}`
        : `resources.${pattern.kubernetesRef.resourceId}.${pattern.fieldPath}`;
      
      // Generate nested has() checks for the field path
      const hasChecks = this.generateNestedHasChecksForPath(resourcePath);
      const finalExpression = `${hasChecks.join(' && ')} && ${resourcePath}`;
      
      expressions.push(finalExpression);
    }
    
    return expressions.join(' && ');
  }

  /**
   * Generate nested has() checks for a field path
   */
  private generateNestedHasChecksForPath(resourcePath: string): string[] {
    const checks: string[] = [];
    const parts = resourcePath.split('.');
    
    for (let i = 0; i < parts.length; i++) {
      const partialPath = parts.slice(0, i + 1).join('.');
      checks.push(`has(${partialPath})`);
    }
    
    return checks;
  }

  /**
   * Calculate chaining depth for a field path
   */
  private calculateChainingDepth(fieldPath: string): number {
    return fieldPath.split('.').length;
  }

  /**
   * Generate optional chaining CEL pattern for a KubernetesRef
   */
  private generateOptionalChainingCelPattern(
    kubernetesRef: KubernetesRef<any>,
    context: OptionalityContext
  ): string {
    const resourcePath = kubernetesRef.resourceId === '__schema__' 
      ? `schema.${kubernetesRef.fieldPath}`
      : `resources.${kubernetesRef.resourceId}.${kubernetesRef.fieldPath}`;
    
    if (context.useKroConditionals) {
      // Use Kro's ? prefix operator for optional access
      return this.convertToKroOptionalSyntax(resourcePath);
    }
    
    // Fallback to has() checks for better null safety
    const hasChecks = this.generateNestedHasChecksForPath(resourcePath);
    return `${hasChecks.join(' && ')} ? ${resourcePath} : null`;
  }

  /**
   * Automatically detect null-safety requirements for Enhanced type KubernetesRef objects
   * 
   * This method analyzes Enhanced types and their KubernetesRef objects to determine
   * which fields require null-safety checks despite appearing non-optional at compile time.
   */
  detectNullSafetyRequirements(
    enhancedResources: Record<string, Enhanced<any, any>>,
    context: OptionalityContext
  ): Map<string, OptionalityAnalysisResult[]> {
    const nullSafetyMap = new Map<string, OptionalityAnalysisResult[]>();
    
    try {
      this.logger.debug('Detecting null-safety requirements for Enhanced types', {
        resourceCount: Object.keys(enhancedResources).length,
        contextType: context.type
      });

      for (const [resourceId, enhancedResource] of Object.entries(enhancedResources)) {
        const resourceAnalysis: OptionalityAnalysisResult[] = [];
        
        // Analyze the Enhanced resource for potential KubernetesRef objects
        const potentialRefs = this.extractPotentialKubernetesRefsFromEnhanced(
          enhancedResource,
          resourceId
        );
        
        for (const ref of potentialRefs) {
          const analysis = this.analyzeKubernetesRefOptionality(ref, context);
          
          // Enhanced types require special handling
          if (analysis.potentiallyUndefined) {
            analysis.reason = `Enhanced type field '${analysis.fieldPath}' appears non-optional at compile time but may be undefined at runtime during field hydration`;
            analysis.requiresNullSafety = true;
            analysis.suggestedCelPattern = this.generateEnhancedTypeNullSafetyPattern(ref, context);
          }
          
          resourceAnalysis.push(analysis);
        }
        
        if (resourceAnalysis.length > 0) {
          nullSafetyMap.set(resourceId, resourceAnalysis);
        }
      }
      
      this.logger.debug('Null-safety detection complete', {
        resourcesWithNullSafety: nullSafetyMap.size,
        totalAnalysisResults: Array.from(nullSafetyMap.values()).reduce((sum, arr) => sum + arr.length, 0)
      });
      
      return nullSafetyMap;
      
    } catch (error) {
      this.logger.error('Failed to detect null-safety requirements', error as Error);
      return new Map();
    }
  }

  /**
   * Generate Enhanced type-specific null-safety patterns
   */
  private generateEnhancedTypeNullSafetyPattern(
    kubernetesRef: KubernetesRef<any>,
    context: OptionalityContext
  ): string {
    const resourcePath = kubernetesRef.resourceId === '__schema__' 
      ? `schema.${kubernetesRef.fieldPath}`
      : `resources.${kubernetesRef.resourceId}.${kubernetesRef.fieldPath}`;
    
    // For Enhanced types, we need to be extra careful about null-safety
    if (context.generateHasChecks) {
      // Use has() checks for potentially undefined Enhanced type fields
      if (kubernetesRef.fieldPath?.includes('.')) {
        // For nested fields, check each level
        const pathParts = kubernetesRef.fieldPath.split('.');
        const checks: string[] = [];
        
        for (let i = 0; i < pathParts.length; i++) {
          const partialPath = pathParts.slice(0, i + 1).join('.');
          const fullPath = kubernetesRef.resourceId === '__schema__' 
            ? `schema.${partialPath}`
            : `resources.${kubernetesRef.resourceId}.${partialPath}`;
          checks.push(`has(${fullPath})`);
        }
        
        return `${checks.join(' && ')} && ${resourcePath}`;
      } else {
        return `has(${resourcePath}) && ${resourcePath}`;
      }
    }
    
    if (context.useKroConditionals) {
      // Use Kro's ? prefix operator for Enhanced types
      return this.convertToKroOptionalSyntax(resourcePath);
    }
    
    // Fallback to basic null check
    return `${resourcePath} != null && ${resourcePath}`;
  }

  /**
   * Extract potential KubernetesRef objects from Enhanced resources
   */
  private extractPotentialKubernetesRefsFromEnhanced(
    _enhancedResource: Enhanced<any, any>,
    resourceId: string
  ): KubernetesRef<any>[] {
    const refs: KubernetesRef<any>[] = [];
    
    // Common field paths that might contain KubernetesRef objects in Enhanced types
    const commonFieldPaths = [
      'status.readyReplicas',
      'status.availableReplicas',
      'status.conditions',
      'status.phase',
      'status.podIP',
      'status.hostIP',
      'status.loadBalancer.ingress',
      'spec.replicas',
      'spec.selector',
      'metadata.name',
      'metadata.namespace',
      'metadata.labels',
      'metadata.annotations'
    ];
    
    for (const fieldPath of commonFieldPaths) {
      // Create a potential KubernetesRef for analysis
      const potentialRef: KubernetesRef<any> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId,
        fieldPath,
        type: 'unknown'
      } as KubernetesRef<any>;
      
      refs.push(potentialRef);
    }
    
    return refs;
  }

  /**
   * Integrate with field hydration timing
   * 
   * This method provides integration with TypeKro's field hydration system to
   * handle the transition from undefined to defined values during hydration.
   */
  integrateWithFieldHydrationTiming(
    expression: any,
    hydrationStates: Map<string, FieldHydrationState>,
    context: OptionalityContext
  ): {
    preHydrationExpression: CelExpression | null;
    postHydrationExpression: CelExpression | null;
    hydrationDependentExpression: CelExpression | null;
    transitionHandlers: HydrationTransitionHandler[];
  } {
    try {
      const kubernetesRefs = this.extractKubernetesRefs(expression);
      
      // Analyze hydration states for all references
      const hydrationAnalysis = this.analyzeHydrationStates(kubernetesRefs, hydrationStates);
      
      // Generate expressions for different hydration phases
      const preHydrationExpression = this.generatePreHydrationExpression(
        expression, 
        hydrationAnalysis.unhydratedRefs, 
        context
      );
      
      const postHydrationExpression = this.generatePostHydrationExpression(
        expression, 
        hydrationAnalysis.hydratedRefs, 
        context
      );
      
      const hydrationDependentExpression = this.generateHydrationDependentExpression(
        expression, 
        hydrationAnalysis.hydratingRefs, 
        context
      );

      // Generate transition handlers for undefined-to-defined transitions
      const transitionHandlers = this.generateHydrationTransitionHandlers(
        expression,
        hydrationAnalysis,
        context
      );

      return {
        preHydrationExpression,
        postHydrationExpression,
        hydrationDependentExpression,
        transitionHandlers
      };
      
    } catch (error) {
      this.logger.error('Failed to integrate with field hydration timing', error as Error);
      return {
        preHydrationExpression: null,
        postHydrationExpression: null,
        hydrationDependentExpression: null,
        transitionHandlers: []
      };
    }
  }

  /**
   * Handle undefined-to-defined transitions during field hydration
   * 
   * This method creates handlers for the transition from undefined to defined
   * values as fields are hydrated over time.
   */
  handleUndefinedToDefinedTransitions(
    expression: any,
    hydrationStates: Map<string, FieldHydrationState>,
    context: OptionalityContext
  ): UndefinedToDefinedTransitionResult {
    try {
      const kubernetesRefs = this.extractKubernetesRefs(expression);
      const transitionPlan = this.createTransitionPlan(kubernetesRefs, hydrationStates, context);
      
      return {
        transitionPlan,
        phaseExpressions: this.generatePhaseExpressions(expression, transitionPlan, context),
        watchExpressions: this.generateWatchExpressions(transitionPlan, context),
        fallbackExpressions: this.generateFallbackExpressions(expression, transitionPlan, context),
        valid: true,
        errors: []
      };
      
    } catch (error) {
      const transitionError = new ConversionError(
        `Failed to handle undefined-to-defined transitions: ${error instanceof Error ? error.message : String(error)}`,
        String(expression),
        'unknown'
      );
      
      return {
        transitionPlan: { phases: [], totalDuration: 0, criticalFields: [] },
        phaseExpressions: new Map(),
        watchExpressions: [],
        fallbackExpressions: new Map(),
        valid: false,
        errors: [transitionError]
      };
    }
  }

  /**
   * Analyze hydration states for KubernetesRef objects
   */
  private analyzeHydrationStates(
    kubernetesRefs: KubernetesRef<any>[],
    hydrationStates: Map<string, FieldHydrationState>
  ): HydrationStateAnalysis {
    const unhydratedRefs: KubernetesRef<any>[] = [];
    const hydratedRefs: KubernetesRef<any>[] = [];
    const hydratingRefs: KubernetesRef<any>[] = [];
    const failedRefs: KubernetesRef<any>[] = [];
    
    for (const ref of kubernetesRefs) {
      const stateKey = `${ref.resourceId}:${ref.fieldPath}`;
      const state = hydrationStates.get(stateKey);
      
      if (!state) {
        unhydratedRefs.push(ref);
      } else if (state.hydrationFailed) {
        failedRefs.push(ref);
      } else if (state.isHydrated) {
        hydratedRefs.push(ref);
      } else if (state.isHydrating) {
        hydratingRefs.push(ref);
      } else {
        unhydratedRefs.push(ref);
      }
    }
    
    return {
      unhydratedRefs,
      hydratedRefs,
      hydratingRefs,
      failedRefs,
      totalRefs: kubernetesRefs.length,
      hydrationProgress: hydratedRefs.length / kubernetesRefs.length
    };
  }

  /**
   * Create transition plan for hydration phases
   */
  private createTransitionPlan(
    kubernetesRefs: KubernetesRef<any>[],
    _hydrationStates: Map<string, FieldHydrationState>,
    _context: OptionalityContext
  ): HydrationTransitionPlan {
    const phases: HydrationPhase[] = [];
    const criticalFields: string[] = [];
    
    // Group fields by expected hydration timing
    const immediateFields: KubernetesRef<any>[] = [];
    const earlyFields: KubernetesRef<any>[] = [];
    const lateFields: KubernetesRef<any>[] = [];
    
    for (const ref of kubernetesRefs) {
      const fieldPath = ref.fieldPath || '';
      
      if (ref.resourceId === '__schema__' || fieldPath.startsWith('metadata.') || fieldPath.startsWith('spec.')) {
        immediateFields.push(ref);
      } else if (fieldPath.includes('ready') || fieldPath.includes('available') || fieldPath.includes('replicas')) {
        earlyFields.push(ref);
        if (fieldPath.includes('ready') || fieldPath.includes('available')) {
          criticalFields.push(`${ref.resourceId}.${fieldPath}`);
        }
      } else {
        lateFields.push(ref);
      }
    }
    
    // Create phases
    if (immediateFields.length > 0) {
      phases.push({
        name: 'immediate',
        fields: immediateFields,
        expectedDuration: 0,
        dependencies: [],
        isCritical: false
      });
    }
    
    if (earlyFields.length > 0) {
      phases.push({
        name: 'early',
        fields: earlyFields,
        expectedDuration: 5000, // 5 seconds
        dependencies: immediateFields.map(ref => `${ref.resourceId}.${ref.fieldPath}`),
        isCritical: true
      });
    }
    
    if (lateFields.length > 0) {
      phases.push({
        name: 'late',
        fields: lateFields,
        expectedDuration: 30000, // 30 seconds
        dependencies: [...immediateFields, ...earlyFields].map(ref => `${ref.resourceId}.${ref.fieldPath}`),
        isCritical: false
      });
    }
    
    const totalDuration = phases.reduce((sum, phase) => sum + phase.expectedDuration, 0);
    
    return { phases, totalDuration, criticalFields };
  }

  /**
   * Generate hydration transition handlers
   */
  private generateHydrationTransitionHandlers(
    expression: any,
    hydrationAnalysis: HydrationStateAnalysis,
    context: OptionalityContext
  ): HydrationTransitionHandler[] {
    const handlers: HydrationTransitionHandler[] = [];
    
    // Handler for unhydrated -> hydrating transition
    if (hydrationAnalysis.unhydratedRefs.length > 0) {
      handlers.push({
        fromState: 'unhydrated',
        toState: 'hydrating',
        triggerCondition: this.generateHydrationStartCondition(hydrationAnalysis.unhydratedRefs),
        transitionExpression: this.generateHydrationStartExpression(expression, hydrationAnalysis.unhydratedRefs, context),
        priority: 1
      });
    }
    
    // Handler for hydrating -> hydrated transition
    if (hydrationAnalysis.hydratingRefs.length > 0) {
      handlers.push({
        fromState: 'hydrating',
        toState: 'hydrated',
        triggerCondition: this.generateHydrationCompleteCondition(hydrationAnalysis.hydratingRefs),
        transitionExpression: this.generateHydrationCompleteExpression(expression, hydrationAnalysis.hydratingRefs, context),
        priority: 2
      });
    }
    
    // Handler for hydration failure
    if (hydrationAnalysis.failedRefs.length > 0) {
      handlers.push({
        fromState: 'hydrating',
        toState: 'failed',
        triggerCondition: this.generateHydrationFailureCondition(hydrationAnalysis.failedRefs),
        transitionExpression: this.generateHydrationFailureExpression(expression, hydrationAnalysis.failedRefs, context),
        priority: 3
      });
    }
    
    return handlers;
  }

  /**
   * Generate phase expressions for different hydration phases
   */
  private generatePhaseExpressions(
    expression: any,
    transitionPlan: HydrationTransitionPlan,
    context: OptionalityContext
  ): Map<string, CelExpression> {
    const phaseExpressions = new Map<string, CelExpression>();
    
    for (const phase of transitionPlan.phases) {
      try {
        const phaseExpression = this.generatePhaseSpecificExpression(
          expression,
          phase,
          context
        );
        
        phaseExpressions.set(phase.name, phaseExpression);
      } catch (error) {
        this.logger.warn(`Failed to generate expression for phase ${phase.name}`, error as Error);
      }
    }
    
    return phaseExpressions;
  }

  /**
   * Generate watch expressions for monitoring hydration progress
   */
  private generateWatchExpressions(
    transitionPlan: HydrationTransitionPlan,
    _context: OptionalityContext
  ): CelExpression[] {
    const watchExpressions: CelExpression[] = [];
    
    for (const phase of transitionPlan.phases) {
      for (const field of phase.fields) {
        const resourcePath = field.resourceId === '__schema__' 
          ? `schema.${field.fieldPath}`
          : `resources.${field.resourceId}.${field.fieldPath}`;
        
        const watchExpression: CelExpression = {
          [CEL_EXPRESSION_BRAND]: true,
          expression: `has(${resourcePath})`,
          type: 'boolean'
        } as CelExpression;
        
        watchExpressions.push(watchExpression);
      }
    }
    
    return watchExpressions;
  }

  /**
   * Generate fallback expressions for hydration failures
   */
  private generateFallbackExpressions(
    _expression: any,
    transitionPlan: HydrationTransitionPlan,
    _context: OptionalityContext
  ): Map<string, CelExpression> {
    const fallbackExpressions = new Map<string, CelExpression>();
    
    for (const phase of transitionPlan.phases) {
      const fallbackExpression: CelExpression = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: phase.isCritical ? 'false' : 'null',
        type: phase.isCritical ? 'boolean' : 'null'
      } as CelExpression;
      
      fallbackExpressions.set(phase.name, fallbackExpression);
    }
    
    return fallbackExpressions;
  }

  /**
   * Generate phase-specific expression
   */
  private generatePhaseSpecificExpression(
    _expression: any,
    phase: HydrationPhase,
    _context: OptionalityContext
  ): CelExpression {
    // Generate expression that only uses fields available in this phase
    const availableFields = phase.fields.map(field => {
      const resourcePath = field.resourceId === '__schema__' 
        ? `schema.${field.fieldPath}`
        : `resources.${field.resourceId}.${field.fieldPath}`;
      return resourcePath;
    });
    
    // Create a simplified expression using only available fields
    const phaseExpression = availableFields.length > 0 
      ? availableFields.join(' && ')
      : 'true';
    
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: phaseExpression,
      type: 'boolean'
    } as CelExpression;
  }

  /**
   * Generate condition for hydration start
   */
  private generateHydrationStartCondition(refs: KubernetesRef<any>[]): string {
    const conditions = refs.map(ref => {
      const resourcePath = ref.resourceId === '__schema__' 
        ? `schema.${ref.fieldPath}`
        : `resources.${ref.resourceId}.${ref.fieldPath}`;
      return `!has(${resourcePath})`;
    });
    
    return conditions.join(' && ');
  }

  /**
   * Generate expression for hydration start
   */
  private generateHydrationStartExpression(
    _expression: any,
    _refs: KubernetesRef<any>[],
    _context: OptionalityContext
  ): CelExpression {
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: 'null', // Return null while hydrating
      type: 'null'
    } as CelExpression;
  }

  /**
   * Generate condition for hydration complete
   */
  private generateHydrationCompleteCondition(refs: KubernetesRef<any>[]): string {
    const conditions = refs.map(ref => {
      const resourcePath = ref.resourceId === '__schema__' 
        ? `schema.${ref.fieldPath}`
        : `resources.${ref.resourceId}.${ref.fieldPath}`;
      return `has(${resourcePath})`;
    });
    
    return conditions.join(' && ');
  }

  /**
   * Generate expression for hydration complete
   */
  private generateHydrationCompleteExpression(
    expression: any,
    _refs: KubernetesRef<any>[],
    context: OptionalityContext
  ): CelExpression {
    // Use the original expression since all fields are now available
    return this.convertToBasicCel(expression, context);
  }

  /**
   * Generate condition for hydration failure
   */
  private generateHydrationFailureCondition(_refs: KubernetesRef<any>[]): string {
    // This would typically check for timeout or error conditions
    return 'false'; // Placeholder
  }

  /**
   * Generate expression for hydration failure
   */
  private generateHydrationFailureExpression(
    _expression: any,
    _refs: KubernetesRef<any>[],
    _context: OptionalityContext
  ): CelExpression {
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: 'false', // Return false on failure
      type: 'boolean'
    } as CelExpression;
  }

  /**
   * Analyze a single KubernetesRef for optionality requirements
   */
  private analyzeKubernetesRefOptionality(
    kubernetesRef: KubernetesRef<any>,
    context: OptionalityContext
  ): OptionalityAnalysisResult {
    const isSchemaReference = kubernetesRef.resourceId === '__schema__';
    const fieldPath = kubernetesRef.fieldPath || '';
    
    // Enhanced types appear non-optional at compile time but may be undefined at runtime
    const potentiallyUndefined = this.isPotentiallyUndefinedAtRuntime(kubernetesRef, context);
    const requiresNullSafety = potentiallyUndefined && (context.conservativeNullSafety ?? true);
    
    // Check if optional chaining was used in the original expression
    const hasOptionalChaining = this.hasOptionalChainingInExpression(kubernetesRef, context);
    
    const confidence = this.calculateOptionalityConfidence(kubernetesRef, context);
    const reason = this.determineOptionalityReason(kubernetesRef, context);
    
    const suggestedCelPattern = requiresNullSafety 
      ? this.generateSuggestedCelPattern(kubernetesRef, context)
      : undefined;

    return {
      kubernetesRef,
      potentiallyUndefined,
      requiresNullSafety,
      hasOptionalChaining,
      fieldPath,
      resourceId: kubernetesRef.resourceId,
      isSchemaReference,
      confidence,
      reason,
      suggestedCelPattern
    };
  }

  /**
   * Determine if a KubernetesRef is potentially undefined at runtime
   */
  private isPotentiallyUndefinedAtRuntime(
    kubernetesRef: KubernetesRef<any>,
    context: OptionalityContext
  ): boolean {
    // Schema references are generally available, but some schema fields might be optional
    if (kubernetesRef.resourceId === '__schema__') {
      return this.isSchemaFieldPotentiallyUndefined(kubernetesRef, context);
    }
    
    // Resource status fields are potentially undefined during field hydration
    if (kubernetesRef.fieldPath?.startsWith('status.')) {
      return this.isStatusFieldPotentiallyUndefined(kubernetesRef, context);
    }
    
    // Resource spec fields might be optional
    if (kubernetesRef.fieldPath?.startsWith('spec.')) {
      return this.isSpecFieldPotentiallyUndefined(kubernetesRef, context);
    }
    
    // Resource metadata fields are generally available but some might be optional
    if (kubernetesRef.fieldPath?.startsWith('metadata.')) {
      return this.isMetadataFieldPotentiallyUndefined(kubernetesRef, context);
    }
    
    // Check hydration state if available
    if (context.hydrationStates) {
      const stateKey = `${kubernetesRef.resourceId}:${kubernetesRef.fieldPath}`;
      const state = context.hydrationStates.get(stateKey);
      
      if (state) {
        return !state.isHydrated || state.hydrationFailed;
      }
    }
    
    // Conservative approach: assume potentially undefined for Enhanced types
    return true;
  }

  /**
   * Check if a schema field is potentially undefined
   */
  private isSchemaFieldPotentiallyUndefined(
    kubernetesRef: KubernetesRef<any>,
    context: OptionalityContext
  ): boolean {
    const fieldPath = kubernetesRef.fieldPath || '';
    
    // Common optional schema fields
    const commonOptionalFields = [
      'metadata.labels',
      'metadata.annotations',
      'metadata.namespace',
      'spec.replicas',
      'spec.resources',
      'spec.nodeSelector',
      'spec.tolerations',
      'spec.affinity'
    ];
    
    // Check if this is a commonly optional field
    if (commonOptionalFields.some(optional => fieldPath.startsWith(optional))) {
      return true;
    }
    
    // Check for array access which might be undefined
    if (fieldPath.includes('[') || fieldPath.includes('.length')) {
      return true;
    }
    
    // Schema fields are generally available, but be conservative
    return context.conservativeNullSafety ?? true;
  }

  /**
   * Check if a status field is potentially undefined
   */
  private isStatusFieldPotentiallyUndefined(
    kubernetesRef: KubernetesRef<any>,
    _context: OptionalityContext
  ): boolean {
    const fieldPath = kubernetesRef.fieldPath || '';
    
    // Status fields are almost always potentially undefined during hydration
    const alwaysUndefinedStatusFields = [
      'status.conditions',
      'status.loadBalancer',
      'status.ingress',
      'status.podIP',
      'status.hostIP',
      'status.phase',
      'status.readyReplicas',
      'status.availableReplicas',
      'status.observedGeneration'
    ];
    
    // Check if this is a field that's commonly undefined
    if (alwaysUndefinedStatusFields.some(field => fieldPath.startsWith(field))) {
      return true;
    }
    
    // All status fields are potentially undefined during field hydration
    return true;
  }

  /**
   * Check if a spec field is potentially undefined
   */
  private isSpecFieldPotentiallyUndefined(
    kubernetesRef: KubernetesRef<any>,
    context: OptionalityContext
  ): boolean {
    const fieldPath = kubernetesRef.fieldPath || '';
    
    // Common optional spec fields
    const commonOptionalSpecFields = [
      'spec.replicas',
      'spec.resources',
      'spec.nodeSelector',
      'spec.tolerations',
      'spec.affinity',
      'spec.volumes',
      'spec.volumeMounts',
      'spec.env',
      'spec.ports',
      'spec.selector'
    ];
    
    // Check if this is a commonly optional spec field
    if (commonOptionalSpecFields.some(optional => fieldPath.startsWith(optional))) {
      return true;
    }
    
    // Check for array access
    if (fieldPath.includes('[') || fieldPath.includes('.length')) {
      return true;
    }
    
    // Most spec fields are required, but be conservative for Enhanced types
    return context.conservativeNullSafety ?? false;
  }

  /**
   * Check if a metadata field is potentially undefined
   */
  private isMetadataFieldPotentiallyUndefined(
    kubernetesRef: KubernetesRef<any>,
    context: OptionalityContext
  ): boolean {
    const fieldPath = kubernetesRef.fieldPath || '';
    
    // Common optional metadata fields
    const commonOptionalMetadataFields = [
      'metadata.labels',
      'metadata.annotations',
      'metadata.namespace',
      'metadata.ownerReferences',
      'metadata.finalizers'
    ];
    
    // Check if this is a commonly optional metadata field
    if (commonOptionalMetadataFields.some(optional => fieldPath.startsWith(optional))) {
      return true;
    }
    
    // Core metadata fields like name and uid are generally available
    const coreMetadataFields = [
      'metadata.name',
      'metadata.uid',
      'metadata.creationTimestamp',
      'metadata.generation'
    ];
    
    if (coreMetadataFields.some(core => fieldPath.startsWith(core))) {
      return false;
    }
    
    // Be conservative for other metadata fields
    return context.conservativeNullSafety ?? true;
  }

  /**
   * Check if optional chaining was used in the original expression
   */
  private hasOptionalChainingInExpression(
    _kubernetesRef: KubernetesRef<any>,
    _context: OptionalityContext
  ): boolean {
    // This would need to be determined from the original expression AST
    // For now, return false as a placeholder
    return false;
  }

  /**
   * Calculate confidence level for optionality analysis
   */
  private calculateOptionalityConfidence(
    kubernetesRef: KubernetesRef<any>,
    context: OptionalityContext
  ): number {
    let confidence = 0.8; // Base confidence
    
    // Higher confidence for schema references
    if (kubernetesRef.resourceId === '__schema__') {
      confidence += 0.1;
    }
    
    // Lower confidence for status fields (more likely to be undefined)
    if (kubernetesRef.fieldPath?.startsWith('status.')) {
      confidence -= 0.2;
    }
    
    // Higher confidence if we have hydration state information
    if (context.hydrationStates) {
      confidence += 0.1;
    }
    
    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Determine the reason for optionality determination
   */
  private determineOptionalityReason(
    kubernetesRef: KubernetesRef<any>,
    _context: OptionalityContext
  ): string {
    if (kubernetesRef.resourceId === '__schema__') {
      return 'Schema reference - generally available';
    }
    
    if (kubernetesRef.fieldPath?.startsWith('status.')) {
      return 'Status field - potentially undefined during field hydration';
    }
    
    return 'Enhanced type - appears non-optional at compile time but may be undefined at runtime';
  }

  /**
   * Generate suggested CEL pattern for null-safety
   */
  private generateSuggestedCelPattern(
    kubernetesRef: KubernetesRef<any>,
    context: OptionalityContext
  ): string {
    const resourcePath = kubernetesRef.resourceId === '__schema__' 
      ? `schema.${kubernetesRef.fieldPath}`
      : `resources.${kubernetesRef.resourceId}.${kubernetesRef.fieldPath}`;
    
    if (context.generateHasChecks) {
      return `has(${resourcePath}) && ${resourcePath}`;
    }
    
    if (context.useKroConditionals) {
      return `${resourcePath}?`;
    }
    
    return resourcePath;
  }

  /**
   * Extract KubernetesRef objects from an expression
   */
  private extractKubernetesRefs(expression: any): KubernetesRef<any>[] {
    const refs: KubernetesRef<any>[] = [];
    
    if (isKubernetesRef(expression)) {
      refs.push(expression);
    } else if (Array.isArray(expression)) {
      for (const item of expression) {
        refs.push(...this.extractKubernetesRefs(item));
      }
    } else if (expression && typeof expression === 'object') {
      for (const value of Object.values(expression)) {
        refs.push(...this.extractKubernetesRefs(value));
      }
    }
    
    return refs;
  }

  /**
   * Convert expression to basic CEL without null-safety
   */
  private convertToBasicCel(expression: any, _context: OptionalityContext): CelExpression {
    // This is a placeholder - would need to integrate with the main analyzer
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: String(expression),
      type: 'unknown'
    } as CelExpression;
  }

  /**
   * Generate CEL expressions with has() checks for potentially undefined fields
   * 
   * This method creates comprehensive CEL expressions that include has() checks
   * for all potentially undefined fields in the expression.
   */
  generateCelWithHasChecks(
    expression: any,
    optionalityResults: OptionalityAnalysisResult[],
    context: OptionalityContext
  ): CelExpression {
    try {
      const fieldsRequiringChecks = optionalityResults.filter(result => result.requiresNullSafety);
      
      if (fieldsRequiringChecks.length === 0) {
        return this.convertToBasicCel(expression, context);
      }
      
      // Generate has() checks for each field
      const hasChecks = this.generateHasChecksForFields(fieldsRequiringChecks, context);
      
      // Generate the main expression
      const mainExpression = this.convertExpressionWithKubernetesRefs(expression, optionalityResults, context);
      
      // Combine has() checks with the main expression
      const combinedExpression = this.combineHasChecksWithExpression(hasChecks, mainExpression, context);
      
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: combinedExpression,
        type: this.inferExpressionType(expression, context)
      } as CelExpression;
      
    } catch (error) {
      this.logger.error('Failed to generate CEL with has() checks', error as Error);
      return this.convertToBasicCel(expression, context);
    }
  }

  /**
   * Generate has() checks for fields that require null-safety
   */
  private generateHasChecksForFields(
    fieldsRequiringChecks: OptionalityAnalysisResult[],
    context: OptionalityContext
  ): string[] {
    const hasChecks: string[] = [];
    const processedPaths = new Set<string>();
    
    for (const field of fieldsRequiringChecks) {
      const resourcePath = field.isSchemaReference 
        ? `schema.${field.fieldPath}`
        : `resources.${field.resourceId}.${field.fieldPath}`;
      
      // Avoid duplicate checks for the same path
      if (processedPaths.has(resourcePath)) {
        continue;
      }
      processedPaths.add(resourcePath);
      
      // Generate nested has() checks for complex field paths
      const nestedChecks = this.generateNestedHasChecks(field, context);
      hasChecks.push(...nestedChecks);
    }
    
    return hasChecks;
  }

  /**
   * Generate nested has() checks for complex field paths
   */
  private generateNestedHasChecks(
    field: OptionalityAnalysisResult,
    _context: OptionalityContext
  ): string[] {
    const checks: string[] = [];
    const fieldPath = field.fieldPath;
    
    if (!fieldPath || !fieldPath.includes('.')) {
      // Simple field path
      const resourcePath = field.isSchemaReference 
        ? `schema.${fieldPath}`
        : `resources.${field.resourceId}.${fieldPath}`;
      checks.push(`has(${resourcePath})`);
      return checks;
    }
    
    // Complex field path - check each level
    const pathParts = fieldPath.split('.');
    const basePrefix = field.isSchemaReference ? 'schema' : `resources.${field.resourceId}`;
    
    for (let i = 0; i < pathParts.length; i++) {
      const partialPath = pathParts.slice(0, i + 1).join('.');
      const fullPath = `${basePrefix}.${partialPath}`;
      
      // Skip checks for array indices
      if (!partialPath.includes('[') && !partialPath.includes(']')) {
        checks.push(`has(${fullPath})`);
      }
    }
    
    return checks;
  }

  /**
   * Convert expression with KubernetesRef objects to CEL
   */
  private convertExpressionWithKubernetesRefs(
    expression: any,
    optionalityResults: OptionalityAnalysisResult[],
    context: OptionalityContext
  ): string {
    // This is a simplified conversion - in a real implementation,
    // this would integrate with the main expression analyzer
    
    if (isKubernetesRef(expression)) {
      const result = optionalityResults.find(r => r.kubernetesRef === expression);
      if (result) {
        return result.isSchemaReference 
          ? `schema.${result.fieldPath}`
          : `resources.${result.resourceId}.${result.fieldPath}`;
      }
    }
    
    // Handle different expression types
    if (typeof expression === 'string') {
      return `"${expression}"`;
    }
    
    if (typeof expression === 'number') {
      return String(expression);
    }
    
    if (typeof expression === 'boolean') {
      return String(expression);
    }
    
    if (Array.isArray(expression)) {
      const elements = expression.map(item => 
        this.convertExpressionWithKubernetesRefs(item, optionalityResults, context)
      );
      return `[${elements.join(', ')}]`;
    }
    
    if (expression && typeof expression === 'object') {
      // Handle object expressions
      const properties = Object.entries(expression).map(([key, value]) => {
        const convertedValue = this.convertExpressionWithKubernetesRefs(value, optionalityResults, context);
        return `"${key}": ${convertedValue}`;
      });
      return `{${properties.join(', ')}}`;
    }
    
    return String(expression);
  }

  /**
   * Combine has() checks with the main expression
   */
  private combineHasChecksWithExpression(
    hasChecks: string[],
    mainExpression: string,
    _context: OptionalityContext
  ): string {
    if (hasChecks.length === 0) {
      return mainExpression;
    }
    
    // Remove duplicate checks
    const uniqueChecks = Array.from(new Set(hasChecks));
    
    // Combine all checks with AND operator
    const allChecks = uniqueChecks.join(' && ');
    
    // Combine checks with the main expression
    return `${allChecks} && ${mainExpression}`;
  }

  /**
   * Infer the type of the expression result
   */
  private inferExpressionType(expression: any, _context: OptionalityContext): string {
    if (typeof expression === 'string') {
      return 'string';
    }
    
    if (typeof expression === 'number') {
      return 'number';
    }
    
    if (typeof expression === 'boolean') {
      return 'boolean';
    }
    
    if (Array.isArray(expression)) {
      return 'array';
    }
    
    if (expression && typeof expression === 'object') {
      return 'object';
    }
    
    return 'unknown';
  }

  /**
   * Generate null-safe CEL expression
   */
  private generateNullSafeExpression(
    expression: any,
    optionalityResults: OptionalityAnalysisResult[],
    context: OptionalityContext
  ): CelExpression {
    // Use the enhanced has() check generation
    return this.generateCelWithHasChecks(expression, optionalityResults, context);
  }

  /**
   * Generate source mapping for debugging
   */
  private generateSourceMapping(
    originalExpression: any,
    celExpression: CelExpression,
    context: OptionalityContext
  ): SourceMapEntry[] {
    if (!context.sourceMap) {
      return [];
    }
    
    return [{
      originalExpression: String(originalExpression),
      celExpression: celExpression.expression,
      sourceLocation: {
        line: 0,
        column: 0,
        length: String(originalExpression).length
      },
      context: 'status',
      id: `optionality-${Date.now()}`,
      timestamp: Date.now()
    }];
  }

  /**
   * Generate pre-hydration expression (for unhydrated fields)
   */
  private generatePreHydrationExpression(
    _expression: any,
    _unhydratedRefs: KubernetesRef<any>[],
    _context: OptionalityContext
  ): CelExpression {
    // For pre-hydration, return a safe default or null check
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: 'false', // Safe default before hydration
      type: 'boolean'
    } as CelExpression;
  }

  /**
   * Generate post-hydration expression (for hydrated fields)
   */
  private generatePostHydrationExpression(
    expression: any,
    _hydratedRefs: KubernetesRef<any>[],
    context: OptionalityContext
  ): CelExpression {
    // For post-hydration, can use the fields directly
    return this.convertToBasicCel(expression, context);
  }

  /**
   * Generate hydration-dependent expression (for fields being hydrated)
   */
  private generateHydrationDependentExpression(
    _expression: any,
    hydratingRefs: KubernetesRef<any>[],
    _context: OptionalityContext
  ): CelExpression {
    // For fields being hydrated, use conditional checks
    const conditionalChecks = hydratingRefs.map(ref => {
      const resourcePath = ref.resourceId === '__schema__' 
        ? `schema.${ref.fieldPath}`
        : `resources.${ref.resourceId}.${ref.fieldPath}`;
      return `has(${resourcePath})`;
    }).join(' && ');
    
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: conditionalChecks,
      type: 'boolean'
    } as CelExpression;
  }
}

/**
 * Convenience function to analyze optionality requirements
 */
export function analyzeOptionalityRequirements(
  expression: any,
  context: OptionalityContext,
  options?: OptionalityHandlingOptions
): OptionalityAnalysisResult[] {
  const handler = new EnhancedTypeOptionalityHandler(options);
  return handler.analyzeOptionalityRequirements(expression, context);
}

/**
 * Convenience function to generate null-safe CEL expressions
 */
export function generateNullSafeCelExpression(
  expression: any,
  optionalityResults: OptionalityAnalysisResult[],
  context: OptionalityContext,
  options?: OptionalityHandlingOptions
): CelConversionResult {
  const handler = new EnhancedTypeOptionalityHandler(options);
  return handler.generateNullSafeCelExpression(expression, optionalityResults, context);
}

/**
 * Convenience function to handle optional chaining with Enhanced types
 */
export function handleOptionalChainingWithEnhancedTypes(
  expression: any,
  context: OptionalityContext,
  options?: OptionalityHandlingOptions
): CelConversionResult {
  const handler = new EnhancedTypeOptionalityHandler(options);
  return handler.handleOptionalChainingWithEnhancedTypes(expression, context);
}

/**
 * Convenience function to generate CEL expressions with has() checks
 */
export function generateCelWithHasChecks(
  expression: any,
  optionalityResults: OptionalityAnalysisResult[],
  context: OptionalityContext,
  options?: OptionalityHandlingOptions
): CelExpression {
  const handler = new EnhancedTypeOptionalityHandler(options);
  return handler.generateCelWithHasChecks(expression, optionalityResults, context);
}

/**
 * Convenience function to detect null-safety requirements for Enhanced types
 */
export function detectNullSafetyRequirements(
  enhancedResources: Record<string, Enhanced<any, any>>,
  context: OptionalityContext,
  options?: OptionalityHandlingOptions
): Map<string, OptionalityAnalysisResult[]> {
  const handler = new EnhancedTypeOptionalityHandler(options);
  return handler.detectNullSafetyRequirements(enhancedResources, context);
}

/**
 * Convenience function to integrate with field hydration timing
 */
export function integrateWithFieldHydrationTiming(
  expression: any,
  hydrationStates: Map<string, FieldHydrationState>,
  context: OptionalityContext,
  options?: OptionalityHandlingOptions
): {
  preHydrationExpression: CelExpression | null;
  postHydrationExpression: CelExpression | null;
  hydrationDependentExpression: CelExpression | null;
  transitionHandlers: HydrationTransitionHandler[];
} {
  const handler = new EnhancedTypeOptionalityHandler(options);
  return handler.integrateWithFieldHydrationTiming(expression, hydrationStates, context);
}

/**
 * Convenience function to handle undefined-to-defined transitions
 */
export function handleUndefinedToDefinedTransitions(
  expression: any,
  hydrationStates: Map<string, FieldHydrationState>,
  context: OptionalityContext,
  options?: OptionalityHandlingOptions
): UndefinedToDefinedTransitionResult {
  const handler = new EnhancedTypeOptionalityHandler(options);
  return handler.handleUndefinedToDefinedTransitions(expression, hydrationStates, context);
}