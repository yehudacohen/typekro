/**
 * Conditional Expression Processor for JavaScript to CEL Conversion
 * 
 * This module provides functionality to process conditional expressions like
 * includeWhen and readyWhen that contain KubernetesRef objects, converting
 * them to appropriate CEL expressions for different deployment strategies.
 */

import { getComponentLogger } from '../logging/index.js';
import type { KubernetesRef, CelExpression } from '../types/index.js';
import { isKubernetesRef } from '../../utils/type-guards.js';
import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';
import { 
  MagicProxyDetector,
  type MagicProxyDetectionResult 
} from './magic-proxy-detector.js';
import type { FactoryExpressionContext } from './types.js';
import { 
  ExpressionContextDetector,
  type ContextDetectionResult 
} from './context-detector.js';

const logger = getComponentLogger('conditional-expression-processor');

/**
 * Configuration for conditional expression processing
 */
export interface ConditionalExpressionConfig {
  /** Factory type for context-aware conversion */
  factoryType?: 'direct' | 'kro';
  /** Whether to enable strict validation */
  strictValidation?: boolean;
  /** Whether to include debug information */
  includeDebugInfo?: boolean;
  /** Maximum depth for recursive analysis */
  maxDepth?: number;
}

/**
 * Result of conditional expression processing
 */
export interface ConditionalExpressionResult<T = any> {
  /** Processed expression */
  expression: T;
  /** Whether processing was performed */
  wasProcessed: boolean;
  /** Original expression before processing */
  original: any;
  /** Type of conditional expression */
  conditionalType: 'includeWhen' | 'readyWhen' | 'custom' | 'unknown';
  /** Context detection result */
  contextResult: ContextDetectionResult;
  /** Validation errors if any */
  validationErrors: string[];
  /** Performance metrics */
  metrics: {
    processingTimeMs: number;
    referencesProcessed: number;
    expressionsGenerated: number;
  };
  /** Debug information if enabled */
  debugInfo?: {
    detectedReferences: KubernetesRef<any>[];
    processingSteps: string[];
  };
}

/**
 * Conditional Expression Processor
 * 
 * Processes conditional expressions containing KubernetesRef objects and converts
 * them to appropriate CEL expressions for different deployment contexts.
 */
export class ConditionalExpressionProcessor {
  private magicProxyDetector: MagicProxyDetector;
  private contextDetector: ExpressionContextDetector;

  constructor() {
    this.magicProxyDetector = new MagicProxyDetector();
    this.contextDetector = new ExpressionContextDetector();
  }

  /**
   * Process an includeWhen expression containing KubernetesRef objects
   * 
   * @param expression - The includeWhen expression to process
   * @param context - Factory context
   * @param config - Processing configuration
   * @returns Processing result
   */
  processIncludeWhenExpression<T>(
    expression: T,
    context: FactoryExpressionContext,
    config: ConditionalExpressionConfig = {}
  ): ConditionalExpressionResult<T> {
    const startTime = performance.now();
    
    logger.debug('Processing includeWhen expression', {
      factoryType: context.factoryType,
      factoryName: context.factoryName,
      expressionType: typeof expression
    });

    const result: ConditionalExpressionResult<T> = {
      expression,
      wasProcessed: false,
      original: expression,
      conditionalType: 'includeWhen',
      contextResult: this.contextDetector.detectContextFromFunction('includeWhen', [expression], {
        factoryType: context.factoryType,
        functionContext: 'includeWhen'
      }),
      validationErrors: [],
      metrics: {
        processingTimeMs: 0,
        referencesProcessed: 0,
        expressionsGenerated: 0
      },
      ...(config.includeDebugInfo ? {
        debugInfo: {
          detectedReferences: [],
          processingSteps: []
        }
      } : {})
    };

    // Detect KubernetesRef objects in the expression
    const detection = this.magicProxyDetector.detectKubernetesRefs(expression, {
      maxDepth: config.maxDepth || 10,
      includeDetailedPaths: true,
      analyzeReferenceSources: true
    });

    if (config.includeDebugInfo && result.debugInfo) {
      result.debugInfo.detectedReferences = detection.references.map(ref => ref.ref);
      result.debugInfo.processingSteps.push(`Detected ${detection.references.length} KubernetesRef objects`);
    }

    // Validate the expression for includeWhen context (regardless of KubernetesRef presence)
    const validationErrors = this.validateIncludeWhenExpression(expression, detection, config);
    result.validationErrors = validationErrors;

    if (config.includeDebugInfo && result.debugInfo) {
      result.debugInfo.processingSteps.push(`Validation errors: ${validationErrors.length}`);
    }

    // If no KubernetesRef objects found, return as-is (but with validation results)
    if (!detection.hasKubernetesRefs) {
      result.metrics.processingTimeMs = performance.now() - startTime;
      return result;
    }

    if (validationErrors.length > 0 && config.strictValidation) {
      result.metrics.processingTimeMs = performance.now() - startTime;
      return result;
    }

    // Process the expression based on factory type
    const processed = this.processConditionalExpression(
      expression,
      detection,
      context,
      'includeWhen',
      config,
      result
    );

    result.expression = processed;
    result.wasProcessed = true;
    result.metrics.referencesProcessed = detection.references.length;
    result.metrics.processingTimeMs = performance.now() - startTime;

    logger.debug('includeWhen expression processing completed', {
      wasProcessed: result.wasProcessed,
      referencesProcessed: result.metrics.referencesProcessed,
      processingTimeMs: result.metrics.processingTimeMs
    });

    return result;
  }

  /**
   * Process a readyWhen expression containing KubernetesRef objects
   * 
   * @param expression - The readyWhen expression to process
   * @param context - Factory context
   * @param config - Processing configuration
   * @returns Processing result
   */
  processReadyWhenExpression<T>(
    expression: T,
    context: FactoryExpressionContext,
    config: ConditionalExpressionConfig = {}
  ): ConditionalExpressionResult<T> {
    const startTime = performance.now();
    
    logger.debug('Processing readyWhen expression', {
      factoryType: context.factoryType,
      factoryName: context.factoryName,
      expressionType: typeof expression
    });

    const result: ConditionalExpressionResult<T> = {
      expression,
      wasProcessed: false,
      original: expression,
      conditionalType: 'readyWhen',
      contextResult: this.contextDetector.detectContextFromFunction('readyWhen', [expression], {
        factoryType: context.factoryType,
        functionContext: 'readyWhen'
      }),
      validationErrors: [],
      metrics: {
        processingTimeMs: 0,
        referencesProcessed: 0,
        expressionsGenerated: 0
      },
      ...(config.includeDebugInfo ? {
        debugInfo: {
          detectedReferences: [],
          processingSteps: []
        }
      } : {})
    };

    // Detect KubernetesRef objects in the expression
    const detection = this.magicProxyDetector.detectKubernetesRefs(expression, {
      maxDepth: config.maxDepth || 10,
      includeDetailedPaths: true,
      analyzeReferenceSources: true
    });

    if (config.includeDebugInfo && result.debugInfo) {
      result.debugInfo.detectedReferences = detection.references.map(ref => ref.ref);
      result.debugInfo.processingSteps.push(`Detected ${detection.references.length} KubernetesRef objects`);
    }

    // Validate the expression for readyWhen context (regardless of KubernetesRef presence)
    const validationErrors = this.validateReadyWhenExpression(expression, detection, config);
    result.validationErrors = validationErrors;

    // If no KubernetesRef objects found, return as-is (but with validation results)
    if (!detection.hasKubernetesRefs) {
      result.metrics.processingTimeMs = performance.now() - startTime;
      return result;
    }
    result.validationErrors = validationErrors;

    if (validationErrors.length > 0 && config.strictValidation) {
      result.metrics.processingTimeMs = performance.now() - startTime;
      return result;
    }

    // Process the expression based on factory type
    const processed = this.processConditionalExpression(
      expression,
      detection,
      context,
      'readyWhen',
      config,
      result
    );

    result.expression = processed;
    result.wasProcessed = true;
    result.metrics.referencesProcessed = detection.references.length;
    result.metrics.processingTimeMs = performance.now() - startTime;

    logger.debug('readyWhen expression processing completed', {
      wasProcessed: result.wasProcessed,
      referencesProcessed: result.metrics.referencesProcessed,
      processingTimeMs: result.metrics.processingTimeMs
    });

    return result;
  }

  /**
   * Process a custom conditional expression containing KubernetesRef objects
   * 
   * @param expression - The conditional expression to process
   * @param context - Factory context
   * @param config - Processing configuration
   * @returns Processing result
   */
  processCustomConditionalExpression<T>(
    expression: T,
    context: FactoryExpressionContext,
    config: ConditionalExpressionConfig = {}
  ): ConditionalExpressionResult<T> {
    const startTime = performance.now();
    
    logger.debug('Processing custom conditional expression', {
      factoryType: context.factoryType,
      factoryName: context.factoryName,
      expressionType: typeof expression
    });

    const result: ConditionalExpressionResult<T> = {
      expression,
      wasProcessed: false,
      original: expression,
      conditionalType: 'custom',
      contextResult: this.contextDetector.detectContextFromFunction('conditional', [expression], {
        factoryType: context.factoryType,
        functionContext: 'conditional'
      }),
      validationErrors: [],
      metrics: {
        processingTimeMs: 0,
        referencesProcessed: 0,
        expressionsGenerated: 0
      },
      ...(config.includeDebugInfo ? {
        debugInfo: {
          detectedReferences: [],
          processingSteps: []
        }
      } : {})
    };

    // Detect KubernetesRef objects in the expression
    const detection = this.magicProxyDetector.detectKubernetesRefs(expression, {
      maxDepth: config.maxDepth || 10,
      includeDetailedPaths: true,
      analyzeReferenceSources: true
    });

    if (config.includeDebugInfo && result.debugInfo) {
      result.debugInfo.detectedReferences = detection.references.map(ref => ref.ref);
      result.debugInfo.processingSteps.push(`Detected ${detection.references.length} KubernetesRef objects`);
    }

    // Validate the expression for conditional context (regardless of KubernetesRef presence)
    const validationErrors = this.validateCustomConditionalExpression(expression, detection, config);
    result.validationErrors = validationErrors;

    // If no KubernetesRef objects found, return as-is (but with validation results)
    if (!detection.hasKubernetesRefs) {
      result.metrics.processingTimeMs = performance.now() - startTime;
      return result;
    }
    result.validationErrors = validationErrors;

    if (validationErrors.length > 0 && config.strictValidation) {
      result.metrics.processingTimeMs = performance.now() - startTime;
      return result;
    }

    // Process the expression based on factory type
    const processed = this.processConditionalExpression(
      expression,
      detection,
      context,
      'custom',
      config,
      result
    );

    result.expression = processed;
    result.wasProcessed = true;
    result.metrics.referencesProcessed = detection.references.length;
    result.metrics.processingTimeMs = performance.now() - startTime;

    logger.debug('Custom conditional expression processing completed', {
      wasProcessed: result.wasProcessed,
      referencesProcessed: result.metrics.referencesProcessed,
      processingTimeMs: result.metrics.processingTimeMs
    });

    return result;
  }

  /**
   * Core conditional expression processing logic
   */
  private processConditionalExpression<T>(
    expression: T,
    detection: MagicProxyDetectionResult,
    context: FactoryExpressionContext,
    conditionalType: 'includeWhen' | 'readyWhen' | 'custom',
    config: ConditionalExpressionConfig,
    result: ConditionalExpressionResult<T>
  ): T {
    // Handle direct KubernetesRef objects
    if (isKubernetesRef(expression)) {
      if (config.includeDebugInfo && result.debugInfo) {
        result.debugInfo.processingSteps.push('Processing direct KubernetesRef');
      }
      
      if (context.factoryType === 'kro') {
        // For Kro factories, convert to CEL expression
        const celExpr = this.convertKubernetesRefToConditionalCel(expression, conditionalType, context);
        result.metrics.expressionsGenerated = 1;
        return celExpr as T;
      } else {
        // For direct factories, preserve the reference
        return expression;
      }
    }

    // Handle boolean expressions with KubernetesRef objects
    if (this.isBooleanExpressionWithRefs(expression, detection)) {
      if (config.includeDebugInfo && result.debugInfo) {
        result.debugInfo.processingSteps.push('Processing boolean expression with KubernetesRef objects');
      }
      return this.processBooleanExpression(expression, detection, context, conditionalType, result) as T;
    }

    // Handle complex conditional expressions
    if (this.isComplexConditionalExpression(expression, detection)) {
      if (config.includeDebugInfo && result.debugInfo) {
        result.debugInfo.processingSteps.push('Processing complex conditional expression');
      }
      return this.processComplexConditionalExpression(expression, detection, context, conditionalType, result) as T;
    }

    // Handle objects and arrays recursively
    if (expression && typeof expression === 'object') {
      if (config.includeDebugInfo && result.debugInfo) {
        result.debugInfo.processingSteps.push('Processing object/array with nested KubernetesRef objects');
      }
      return this.processObjectWithConditionalRefs(expression, detection, context, conditionalType, config, result) as T;
    }

    // Fallback: return as-is
    return expression;
  }

  /**
   * Convert a KubernetesRef to a conditional CEL expression
   */
  private convertKubernetesRefToConditionalCel<T>(
    ref: KubernetesRef<T>,
    conditionalType: 'includeWhen' | 'readyWhen' | 'custom',
    context: FactoryExpressionContext
  ): CelExpression<T> {
    const celExpression = this.generateConditionalCelFromRef(ref, conditionalType, context);
    
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: celExpression,
      type: 'boolean' // Conditional expressions should evaluate to boolean
    } as CelExpression<T>;
  }

  /**
   * Generate CEL expression from KubernetesRef for conditional context
   */
  private generateConditionalCelFromRef(
    ref: KubernetesRef<any>,
    conditionalType: 'includeWhen' | 'readyWhen' | 'custom',
    _context: FactoryExpressionContext
  ): string {
    const resourceId = ref.resourceId;
    const fieldPath = ref.fieldPath;

    // Handle schema references
    if (resourceId === '__schema__') {
      return `schema.${fieldPath}`;
    }

    // Handle resource references based on conditional type
    switch (conditionalType) {
      case 'includeWhen':
        // includeWhen expressions typically reference schema fields for configuration
        return `${resourceId}.${fieldPath}`;
      
      case 'readyWhen':
        // readyWhen expressions typically reference resource status fields
        return `${resourceId}.${fieldPath}`;
      default:
        // Custom conditional expressions use standard resource references
        return `${resourceId}.${fieldPath}`;
    }
  }

  /**
   * Check if expression is a boolean expression with KubernetesRef objects
   */
  private isBooleanExpressionWithRefs(expression: any, detection: MagicProxyDetectionResult): boolean {
    // This is a simplified check - in a real implementation, we'd parse the expression
    return typeof expression === 'string' && 
           detection.hasKubernetesRefs && 
           /[><=!]=?|&&|\|\||true|false/.test(expression);
  }

  /**
   * Check if expression is a complex conditional expression
   */
  private isComplexConditionalExpression(expression: any, detection: MagicProxyDetectionResult): boolean {
    return typeof expression === 'string' && 
           detection.hasKubernetesRefs && 
           expression.includes('?') && expression.includes(':');
  }

  /**
   * Process boolean expressions with KubernetesRef objects
   */
  private processBooleanExpression<T>(
    expression: T,
    _detection: MagicProxyDetectionResult,
    _context: FactoryExpressionContext,
    _conditionalType: 'includeWhen' | 'readyWhen' | 'custom',
    result: ConditionalExpressionResult<T>
  ): T {
    // For now, return as-is since boolean expression parsing is complex
    // In a full implementation, this would parse the boolean expression and convert
    // embedded KubernetesRef objects to CEL expressions
    if (result.debugInfo) {
      result.debugInfo.processingSteps.push('Boolean expression processing not fully implemented');
    }
    return expression;
  }

  /**
   * Process complex conditional expressions with KubernetesRef objects
   */
  private processComplexConditionalExpression<T>(
    expression: T,
    _detection: MagicProxyDetectionResult,
    _context: FactoryExpressionContext,
    _conditionalType: 'includeWhen' | 'readyWhen' | 'custom',
    result: ConditionalExpressionResult<T>
  ): T {
    // For now, return as-is since complex conditional parsing is complex
    // In a full implementation, this would parse the conditional expression and convert
    // embedded KubernetesRef objects to CEL expressions
    if (result.debugInfo) {
      result.debugInfo.processingSteps.push('Complex conditional expression processing not fully implemented');
    }
    return expression;
  }

  /**
   * Process objects and arrays with conditional KubernetesRef objects
   */
  private processObjectWithConditionalRefs<T>(
    value: T,
    detection: MagicProxyDetectionResult,
    context: FactoryExpressionContext,
    conditionalType: 'includeWhen' | 'readyWhen' | 'custom',
    config: ConditionalExpressionConfig,
    result: ConditionalExpressionResult<T>
  ): T {
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (isKubernetesRef(item)) {
          result.metrics.expressionsGenerated++;
          return context.factoryType === 'kro' 
            ? this.convertKubernetesRefToConditionalCel(item, conditionalType, context)
            : item;
        }
        
        // Recursively process nested items
        if (this.magicProxyDetector.containsKubernetesRefs(item)) {
          const nestedResult = this.processConditionalExpression(item, detection, context, conditionalType, config, result);
          return nestedResult;
        }
        
        return item;
      }) as T;
    }

    if (value && typeof value === 'object' && value.constructor === Object) {
      const processed: Record<string, any> = {};
      
      for (const [key, val] of Object.entries(value)) {
        if (isKubernetesRef(val)) {
          result.metrics.expressionsGenerated++;
          processed[key] = context.factoryType === 'kro' 
            ? this.convertKubernetesRefToConditionalCel(val, conditionalType, context)
            : val;
        } else if (this.magicProxyDetector.containsKubernetesRefs(val)) {
          const nestedResult = this.processConditionalExpression(val, detection, context, conditionalType, config, result);
          processed[key] = nestedResult;
        } else {
          processed[key] = val;
        }
      }
      
      return processed as T;
    }

    return value;
  }

  /**
   * Validate includeWhen expression
   */
  private validateIncludeWhenExpression(
    expression: any,
    _detection: MagicProxyDetectionResult,
    _config: ConditionalExpressionConfig
  ): string[] {
    const errors: string[] = [];

    // includeWhen expressions should evaluate to boolean
    if (typeof expression === 'string' && !this.looksLikeBooleanExpression(expression)) {
      errors.push('includeWhen expressions should evaluate to boolean values');
    }

    // Check for common patterns that might not work in conditional context
    if (typeof expression === 'string' && expression.includes('||') && !expression.includes('&&')) {
      errors.push('includeWhen expressions with only OR operators may not behave as expected');
    }

    return errors;
  }

  /**
   * Validate readyWhen expression
   */
  private validateReadyWhenExpression(
    expression: any,
    detection: MagicProxyDetectionResult,
    _config: ConditionalExpressionConfig
  ): string[] {
    const errors: string[] = [];

    // readyWhen expressions should evaluate to boolean
    if (typeof expression === 'string' && !this.looksLikeBooleanExpression(expression)) {
      errors.push('readyWhen expressions should evaluate to boolean values');
    }

    // readyWhen expressions should typically reference status fields
    const hasStatusReferences = detection.references.some(ref => 
      ref.fieldPath.includes('status')
    );
    
    if (!hasStatusReferences && detection.references.length > 0) {
      errors.push('readyWhen expressions should typically reference resource status fields');
    }

    return errors;
  }

  /**
   * Validate custom conditional expression
   */
  private validateCustomConditionalExpression(
    expression: any,
    _detection: MagicProxyDetectionResult,
    _config: ConditionalExpressionConfig
  ): string[] {
    const errors: string[] = [];

    // Custom conditional expressions should be well-formed
    if (typeof expression === 'string' && expression.includes('?') && !expression.includes(':')) {
      errors.push('Conditional expressions with ? must also include :');
    }

    return errors;
  }

  /**
   * Check if expression looks like it evaluates to boolean
   */
  private looksLikeBooleanExpression(expression: string): boolean {
    return /[><=!]=?|&&|\|\||true|false|ready|available|enabled|disabled/.test(expression.toLowerCase());
  }
}

/**
 * Global conditional expression processor instance
 */
export const conditionalExpressionProcessor = new ConditionalExpressionProcessor();

/**
 * Utility function to process includeWhen expressions
 */
export function processIncludeWhen<T>(
  expression: T,
  context: FactoryExpressionContext,
  config?: ConditionalExpressionConfig
): ConditionalExpressionResult<T> {
  return conditionalExpressionProcessor.processIncludeWhenExpression(expression, context, config);
}

/**
 * Utility function to process readyWhen expressions
 */
export function processReadyWhen<T>(
  expression: T,
  context: FactoryExpressionContext,
  config?: ConditionalExpressionConfig
): ConditionalExpressionResult<T> {
  return conditionalExpressionProcessor.processReadyWhenExpression(expression, context, config);
}

/**
 * Utility function to process custom conditional expressions
 */
export function processCustomConditional<T>(
  expression: T,
  context: FactoryExpressionContext,
  config?: ConditionalExpressionConfig
): ConditionalExpressionResult<T> {
  return conditionalExpressionProcessor.processCustomConditionalExpression(expression, context, config);
}