/**
 * Context-Aware CEL Generation Strategies
 * 
 * This module provides context-specific CEL generation strategies for converting
 * KubernetesRef objects to appropriate CEL expressions based on the usage context.
 */

import type { CelExpression, KubernetesRef } from '../types/common.js';
import type { Enhanced } from '../types/kubernetes.js';
import type { SchemaProxy } from '../types/serialization.js';
import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';
import { ConversionError } from '../errors.js';
import type { 
  ExpressionContext, 
  CelGenerationStrategy, 
  ContextDetectionResult,
} from './context-detector.js';

/**
 * Context-aware CEL generation configuration
 */
export interface CelGenerationConfig {
  /** Factory type being used */
  factoryType: 'direct' | 'kro';
  
  /** Available resources for reference validation */
  availableResources?: Record<string, Enhanced<any, any>>;
  
  /** Schema proxy for schema field references */
  schemaProxy?: SchemaProxy<any, any>;
  
  /** Whether to use strict type checking */
  strictTypeChecking?: boolean;
  
  /** Whether to optimize for performance */
  optimizeForPerformance?: boolean;
  
  /** Whether to include debug information */
  includeDebugInfo?: boolean;
}

/**
 * CEL generation result
 */
export interface CelGenerationResult {
  /** Generated CEL expression */
  celExpression: CelExpression;
  
  /** Strategy used for generation */
  strategy: CelGenerationStrategy;
  
  /** Context that was detected/used */
  context: ExpressionContext;
  
  /** Dependencies that were resolved */
  dependencies: KubernetesRef<any>[];
  
  /** Any warnings generated during conversion */
  warnings: string[];
  
  /** Debug information (if enabled) */
  debugInfo?: CelGenerationDebugInfo;
}

/**
 * Debug information for CEL generation
 */
export interface CelGenerationDebugInfo {
  /** Original KubernetesRef objects */
  originalRefs: KubernetesRef<any>[];
  
  /** Transformation steps applied */
  transformationSteps: string[];
  
  /** Context detection details */
  contextDetection: ContextDetectionResult;
  
  /** Performance metrics */
  performanceMetrics?: {
    generationTimeMs: number;
    cacheHits: number;
    cacheMisses: number;
  };
}

/**
 * Context-aware CEL generator
 */
export class ContextAwareCelGenerator {
  
  /**
   * Generate CEL expression from KubernetesRef objects based on context
   */
  generateCelExpression(
    kubernetesRefs: KubernetesRef<any>[],
    context: ExpressionContext,
    strategy: CelGenerationStrategy,
    config: CelGenerationConfig
  ): CelGenerationResult {
    const startTime = performance.now();
    const warnings: string[] = [];
    const debugInfo: CelGenerationDebugInfo = {
      originalRefs: [...kubernetesRefs],
      transformationSteps: [],
      contextDetection: {} as ContextDetectionResult // Will be filled by caller if needed
    };
    
    try {
      let celExpression: CelExpression;
      
      // Apply context-specific generation strategy
      switch (strategy) {
        case 'status-expression':
          celExpression = this.generateStatusExpression(kubernetesRefs, config, debugInfo);
          break;
          
        case 'resource-reference':
          celExpression = this.generateResourceReference(kubernetesRefs, config, debugInfo);
          break;
          
        case 'conditional-check':
          celExpression = this.generateConditionalCheck(kubernetesRefs, config, debugInfo);
          break;
          
        case 'readiness-check':
          celExpression = this.generateReadinessCheck(kubernetesRefs, config, debugInfo);
          break;
          
        case 'template-interpolation':
          celExpression = this.generateTemplateInterpolation(kubernetesRefs, config, debugInfo);
          break;
          
        case 'direct-evaluation':
          celExpression = this.generateDirectEvaluation(kubernetesRefs, config, debugInfo);
          break;
          
        default:
          throw new ConversionError(
            `Unsupported CEL generation strategy: ${strategy}`,
            kubernetesRefs.map(ref => `${ref.resourceId}.${ref.fieldPath}`).join(', '),
            'unknown'
          );
      }
      
      // Add performance metrics if debug info is enabled
      if (config.includeDebugInfo) {
        debugInfo.performanceMetrics = {
          generationTimeMs: performance.now() - startTime,
          cacheHits: 0, // Would be filled by cache layer
          cacheMisses: 0 // Would be filled by cache layer
        };
      }
      
      return {
        celExpression,
        strategy,
        context,
        dependencies: kubernetesRefs,
        warnings,
        ...(config.includeDebugInfo ? { debugInfo } : {})
      };
      
    } catch (error) {
      throw new ConversionError(
        `Failed to generate CEL expression using ${strategy} strategy: ${error instanceof Error ? error.message : String(error)}`,
        kubernetesRefs.map(ref => `${ref.resourceId}.${ref.fieldPath}`).join(', '),
        'unknown'
      );
    }
  }
  
  /**
   * Generate status expression CEL for status builders
   */
  private generateStatusExpression(
    kubernetesRefs: KubernetesRef<any>[],
    config: CelGenerationConfig,
    debugInfo: CelGenerationDebugInfo
  ): CelExpression {
    debugInfo.transformationSteps.push('Generating status expression');
    
    if (kubernetesRefs.length === 1) {
      const ref = kubernetesRefs[0];
      if (!ref) {
        throw new ConversionError('Invalid KubernetesRef array', 'undefined', 'unknown');
      }
      debugInfo.transformationSteps.push(`Single reference: ${ref.resourceId}.${ref.fieldPath}`);
      
      // Generate appropriate CEL based on factory type
      if (config.factoryType === 'kro') {
        // For Kro factory, generate CEL expressions for runtime evaluation
        const expression = this.generateKroStatusReference(ref);
        debugInfo.transformationSteps.push(`Kro status reference: ${expression}`);
        
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression,
          _type: ref._type
        } as CelExpression;
      } else {
        // For direct factory, generate CEL expressions that will be resolved at deployment time
        const expression = this.generateDirectStatusReference(ref);
        debugInfo.transformationSteps.push(`Direct status reference: ${expression}`);
        
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression,
          _type: ref._type
        } as CelExpression;
      }
    } else {
      // Multiple references - need to combine them appropriately
      debugInfo.transformationSteps.push(`Multiple references: ${kubernetesRefs.length}`);
      
      const expressions = kubernetesRefs.map(ref => {
        if (config.factoryType === 'kro') {
          return this.generateKroStatusReference(ref);
        } else {
          return this.generateDirectStatusReference(ref);
        }
      });
      
      // For now, just concatenate them (this would be improved based on actual usage patterns)
      const combinedExpression = expressions.join(' + ');
      debugInfo.transformationSteps.push(`Combined expression: ${combinedExpression}`);
      
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: combinedExpression,
        _type: 'string' // Default to string for combined expressions
      } as CelExpression;
    }
  }
  
  /**
   * Generate resource reference CEL for resource builders
   */
  private generateResourceReference(
    kubernetesRefs: KubernetesRef<any>[],
    config: CelGenerationConfig,
    debugInfo: CelGenerationDebugInfo
  ): CelExpression {
    debugInfo.transformationSteps.push('Generating resource reference');
    
    if (kubernetesRefs.length === 1) {
      const ref = kubernetesRefs[0];
      if (!ref) {
        throw new ConversionError('Invalid KubernetesRef array', 'undefined', 'unknown');
      }
      debugInfo.transformationSteps.push(`Single resource reference: ${ref.resourceId}.${ref.fieldPath}`);
      
      // Resource references in resource builders are typically schema references
      if (ref.resourceId === '__schema__') {
        const expression = `schema.${ref.fieldPath}`;
        debugInfo.transformationSteps.push(`Schema reference: ${expression}`);
        
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression,
          _type: ref._type
        } as CelExpression;
      } else {
        // Cross-resource references in resource builders
        const expression = config.factoryType === 'kro' 
          ? `resources.${ref.resourceId}.${ref.fieldPath}`
          : `resources.${ref.resourceId}.${ref.fieldPath}`;
        
        debugInfo.transformationSteps.push(`Cross-resource reference: ${expression}`);
        
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression,
          _type: ref._type
        } as CelExpression;
      }
    } else {
      // Multiple resource references - combine appropriately
      debugInfo.transformationSteps.push(`Multiple resource references: ${kubernetesRefs.length}`);
      
      const expressions = kubernetesRefs.map(ref => {
        if (ref.resourceId === '__schema__') {
          return `schema.${ref.fieldPath}`;
        } else {
          return `resources.${ref.resourceId}.${ref.fieldPath}`;
        }
      });
      
      // For resource builders, multiple references are typically concatenated or used in templates
      const combinedExpression = expressions.length > 1 
        ? `'${expressions.join(' + ')}'` // Template-like combination
        : expressions[0];
      
      debugInfo.transformationSteps.push(`Combined resource reference: ${combinedExpression}`);
      
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: combinedExpression,
        _type: 'string'
      } as CelExpression;
    }
  }
  
  /**
   * Generate conditional check CEL for conditional expressions
   */
  private generateConditionalCheck(
    kubernetesRefs: KubernetesRef<any>[],
    _config: CelGenerationConfig,
    debugInfo: CelGenerationDebugInfo
  ): CelExpression {
    debugInfo.transformationSteps.push('Generating conditional check');
    
    if (kubernetesRefs.length === 1) {
      const ref = kubernetesRefs[0];
      if (!ref) {
        throw new ConversionError('Invalid KubernetesRef array', 'undefined', 'unknown');
      }
      debugInfo.transformationSteps.push(`Single conditional reference: ${ref.resourceId}.${ref.fieldPath}`);
      
      // Conditional checks typically evaluate to boolean
      const baseExpression = ref.resourceId === '__schema__' 
        ? `schema.${ref.fieldPath}`
        : `resources.${ref.resourceId}.${ref.fieldPath}`;
      
      // Add appropriate boolean conversion based on field type
      let expression: string;
      if (ref._type === 'boolean') {
        expression = baseExpression;
      } else if (ref._type === 'number') {
        expression = `${baseExpression} > 0`;
      } else if (ref._type === 'string') {
        expression = `${baseExpression} != ""`;
      } else {
        // Default to existence check
        expression = `has(${baseExpression})`;
      }
      
      debugInfo.transformationSteps.push(`Conditional expression: ${expression}`);
      
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression,
        _type: 'boolean'
      } as CelExpression;
    } else {
      // Multiple references in conditional - combine with AND logic by default
      debugInfo.transformationSteps.push(`Multiple conditional references: ${kubernetesRefs.length}`);
      
      const conditions = kubernetesRefs.map(ref => {
        const baseExpression = ref.resourceId === '__schema__' 
          ? `schema.${ref.fieldPath}`
          : `resources.${ref.resourceId}.${ref.fieldPath}`;
        
        // Convert to boolean condition
        if (ref._type === 'boolean') {
          return baseExpression;
        } else if (ref._type === 'number') {
          return `${baseExpression} > 0`;
        } else if (ref._type === 'string') {
          return `${baseExpression} != ""`;
        } else {
          return `has(${baseExpression})`;
        }
      });
      
      const combinedExpression = conditions.join(' && ');
      debugInfo.transformationSteps.push(`Combined conditional: ${combinedExpression}`);
      
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: combinedExpression,
        _type: 'boolean'
      } as CelExpression;
    }
  }
  
  /**
   * Generate readiness check CEL for readiness expressions
   */
  private generateReadinessCheck(
    kubernetesRefs: KubernetesRef<any>[],
    _config: CelGenerationConfig,
    debugInfo: CelGenerationDebugInfo
  ): CelExpression {
    debugInfo.transformationSteps.push('Generating readiness check');
    
    // Readiness checks are similar to conditional checks but with readiness-specific logic
    if (kubernetesRefs.length === 1) {
      const ref = kubernetesRefs[0];
      if (!ref) {
        throw new ConversionError('Invalid KubernetesRef array', 'undefined', 'unknown');
      }
      debugInfo.transformationSteps.push(`Single readiness reference: ${ref.resourceId}.${ref.fieldPath}`);
      
      const baseExpression = ref.resourceId === '__schema__' 
        ? `schema.${ref.fieldPath}`
        : `resources.${ref.resourceId}.${ref.fieldPath}`;
      
      // Readiness-specific checks
      let expression: string;
      if (ref.fieldPath.includes('readyReplicas')) {
        expression = `${baseExpression} > 0`;
      } else if (ref.fieldPath.includes('ready')) {
        expression = baseExpression; // Assume it's already boolean
      } else if (ref.fieldPath.includes('status')) {
        expression = `${baseExpression} == "Ready"`;
      } else if (ref.fieldPath.includes('conditions')) {
        expression = `${baseExpression}.find(c, c.type == "Ready").status == "True"`;
      } else {
        // Default readiness check
        expression = `has(${baseExpression}) && ${baseExpression} != ""`;
      }
      
      debugInfo.transformationSteps.push(`Readiness expression: ${expression}`);
      
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression,
        _type: 'boolean'
      } as CelExpression;
    } else {
      // Multiple readiness references - all must be ready
      debugInfo.transformationSteps.push(`Multiple readiness references: ${kubernetesRefs.length}`);
      
      const readinessChecks = kubernetesRefs.map(ref => {
        const baseExpression = ref.resourceId === '__schema__' 
          ? `schema.${ref.fieldPath}`
          : `resources.${ref.resourceId}.${ref.fieldPath}`;
        
        // Apply readiness-specific logic
        if (ref.fieldPath.includes('readyReplicas')) {
          return `${baseExpression} > 0`;
        } else if (ref.fieldPath.includes('ready')) {
          return baseExpression;
        } else if (ref.fieldPath.includes('status')) {
          return `${baseExpression} == "Ready"`;
        } else {
          return `has(${baseExpression})`;
        }
      });
      
      const combinedExpression = readinessChecks.join(' && ');
      debugInfo.transformationSteps.push(`Combined readiness check: ${combinedExpression}`);
      
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: combinedExpression,
        _type: 'boolean'
      } as CelExpression;
    }
  }
  
  /**
   * Generate template interpolation CEL for template literals
   */
  private generateTemplateInterpolation(
    kubernetesRefs: KubernetesRef<any>[],
    _config: CelGenerationConfig,
    debugInfo: CelGenerationDebugInfo
  ): CelExpression {
    debugInfo.transformationSteps.push('Generating template interpolation');
    
    // Template interpolations convert KubernetesRef objects to string expressions
    const interpolations = kubernetesRefs.map(ref => {
      const baseExpression = ref.resourceId === '__schema__' 
        ? `schema.${ref.fieldPath}`
        : `resources.${ref.resourceId}.${ref.fieldPath}`;
      
      // Ensure string conversion
      if (ref._type === 'string') {
        return baseExpression;
      } else {
        return `string(${baseExpression})`;
      }
    });
    
    debugInfo.transformationSteps.push(`Template interpolations: ${interpolations.join(', ')}`);
    
    // For template literals, we typically have a pattern like: `prefix${ref1}middle${ref2}suffix`
    // For now, just concatenate the interpolations
    const expression = interpolations.length === 1 
      ? interpolations[0]
      : interpolations.join(' + ');
    
    debugInfo.transformationSteps.push(`Template expression: ${expression}`);
    
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: 'string'
    } as CelExpression;
  }
  
  /**
   * Generate direct evaluation CEL (pass-through for direct factory)
   */
  private generateDirectEvaluation(
    kubernetesRefs: KubernetesRef<any>[],
    _config: CelGenerationConfig,
    debugInfo: CelGenerationDebugInfo
  ): CelExpression {
    debugInfo.transformationSteps.push('Generating direct evaluation');
    
    // For direct evaluation, we generate CEL expressions that will be resolved at deployment time
    if (kubernetesRefs.length === 1) {
      const ref = kubernetesRefs[0];
      if (!ref) {
        throw new ConversionError('Invalid KubernetesRef array', 'undefined', 'unknown');
      }
      const expression = ref.resourceId === '__schema__' 
        ? `schema.${ref.fieldPath}`
        : `resources.${ref.resourceId}.${ref.fieldPath}`;
      
      debugInfo.transformationSteps.push(`Direct evaluation: ${expression}`);
      
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression,
        _type: ref._type
      } as CelExpression;
    } else {
      // Multiple references - create a structure that preserves all references
      const expressions = kubernetesRefs.map(ref => 
        ref.resourceId === '__schema__' 
          ? `schema.${ref.fieldPath}`
          : `resources.${ref.resourceId}.${ref.fieldPath}`
      );
      
      const combinedExpression = `[${expressions.join(', ')}]`;
      debugInfo.transformationSteps.push(`Direct evaluation array: ${combinedExpression}`);
      
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: combinedExpression,
        _type: 'array'
      } as CelExpression;
    }
  }
  
  /**
   * Generate Kro-specific status reference
   */
  private generateKroStatusReference(ref: KubernetesRef<any>): string {
    if (ref.resourceId === '__schema__') {
      return `schema.${ref.fieldPath}`;
    } else {
      return `resources.${ref.resourceId}.${ref.fieldPath}`;
    }
  }
  
  /**
   * Generate direct factory status reference
   */
  private generateDirectStatusReference(ref: KubernetesRef<any>): string {
    // For direct factory, the references will be resolved before CEL evaluation
    if (ref.resourceId === '__schema__') {
      return `schema.${ref.fieldPath}`;
    } else {
      return `resources.${ref.resourceId}.${ref.fieldPath}`;
    }
  }
}

/**
 * Context-specific CEL generation utilities
 */
export class CelGenerationUtils {
  
  /**
   * Determine the best CEL generation strategy for a given context
   */
  static determineBestStrategy(
    context: ExpressionContext,
    _kubernetesRefs: KubernetesRef<any>[],
    factoryType: 'direct' | 'kro'
  ): CelGenerationStrategy {
    // Context-based strategy selection
    switch (context) {
      case 'status-builder':
        return 'status-expression';
      case 'resource-builder':
        return 'resource-reference';
      case 'conditional':
        return 'conditional-check';
      case 'readiness':
        return 'readiness-check';
      case 'template-literal':
        return 'template-interpolation';
      case 'field-hydration':
        return factoryType === 'direct' ? 'direct-evaluation' : 'status-expression';
      default:
        return 'direct-evaluation';
    }
  }
  
  /**
   * Validate that KubernetesRef objects are appropriate for the given context
   */
  static validateRefsForContext(
    kubernetesRefs: KubernetesRef<any>[],
    context: ExpressionContext,
    availableResources?: Record<string, Enhanced<any, any>>
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    for (const ref of kubernetesRefs) {
      // Validate resource exists
      if (ref.resourceId !== '__schema__' && availableResources) {
        if (!availableResources[ref.resourceId]) {
          errors.push(`Resource '${ref.resourceId}' is not available in this context`);
        }
      }
      
      // Context-specific validations
      switch (context) {
        case 'conditional':
        case 'readiness':
          // These contexts should typically reference status fields
          if (!ref.fieldPath.includes('status') && !ref.fieldPath.includes('ready')) {
            errors.push(`Conditional/readiness context should reference status fields, got: ${ref.fieldPath}`);
          }
          break;
          
        case 'resource-builder':
          // Resource builders typically reference spec fields or schema
          if (ref.resourceId !== '__schema__' && !ref.fieldPath.includes('spec')) {
            errors.push(`Resource builder context should reference spec fields or schema, got: ${ref.resourceId}.${ref.fieldPath}`);
          }
          break;
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  /**
   * Optimize CEL expression for performance
   */
  static optimizeCelExpression(
    celExpression: CelExpression,
    context: ExpressionContext
  ): CelExpression {
    let optimizedExpression = celExpression.expression;
    
    // Context-specific optimizations
    switch (context) {
      case 'conditional':
      case 'readiness':
        // Optimize boolean expressions
        optimizedExpression = optimizedExpression
          .replace(/\s*==\s*true/g, '')  // Remove redundant == true
          .replace(/\s*!=\s*false/g, '') // Remove redundant != false
          .replace(/has\(([^)]+)\)\s*&&\s*\1\s*!=\s*""/g, 'has($1)'); // Simplify existence checks
        break;
        
      case 'template-literal':
        // Optimize string concatenations
        optimizedExpression = optimizedExpression
          .replace(/\s*\+\s*""\s*\+\s*/g, ' + ') // Remove empty string concatenations
          .replace(/string\(([^)]+)\)\s*\+\s*string\(([^)]+)\)/g, 'string($1) + string($2)'); // Combine string conversions
        break;
    }
    
    return {
      ...celExpression,
      expression: optimizedExpression
    };
  }
}

/**
 * Default context-aware CEL generator instance
 */
export const contextAwareCelGenerator = new ContextAwareCelGenerator();