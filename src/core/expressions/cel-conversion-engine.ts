/**
 * CEL Conversion Engine for Factory Integration
 * 
 * This module provides automatic conversion of JavaScript expressions containing
 * KubernetesRef objects to appropriate CEL expressions for different deployment
 * strategies.
 */

import { getComponentLogger } from '../logging/index.js';
import type { KubernetesRef, CelExpression } from '../types/index.js';
import { isKubernetesRef } from '../../utils/type-guards.js';
import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';
import { 
  MagicProxyDetector,
  type MagicProxyDetectionResult,
  type MagicProxyRefInfo 
} from './magic-proxy-detector.js';
import type { FactoryExpressionContext } from './types.js';
import { getCurrentCompositionContext } from '../../factories/shared.js';

const logger = getComponentLogger('cel-conversion-engine');

/**
 * Configuration for CEL conversion
 */
export interface CelConversionConfig {
  /** Factory type for context-aware conversion */
  factoryType?: 'direct' | 'kro';
  /** Whether to enable optimization */
  enableOptimization?: boolean;
  /** Whether to preserve static values */
  preserveStatic?: boolean;
  /** Whether to include debug information */
  includeDebugInfo?: boolean;
  /** Maximum depth for recursive conversion */
  maxDepth?: number;
}

/**
 * Result of CEL conversion
 */
export interface CelConversionResult<T = any> {
  /** Converted value */
  converted: T;
  /** Whether conversion was performed */
  wasConverted: boolean;
  /** Original value before conversion */
  original: any;
  /** Conversion strategy used */
  strategy: 'direct' | 'cel-expression' | 'template-literal' | 'static';
  /** Performance metrics */
  metrics: {
    conversionTimeMs: number;
    referencesConverted: number;
    expressionsGenerated: number;
  };
  /** Warnings generated during conversion */
  warnings: string[];
  /** Debug information if enabled */
  debugInfo?: {
    detectedReferences: MagicProxyRefInfo[];
    conversionSteps: string[];
  };
}

/**
 * CEL Conversion Engine
 * 
 * Automatically converts JavaScript expressions containing KubernetesRef objects
 * to appropriate CEL expressions based on the factory type and usage context.
 */
export class CelConversionEngine {
  private magicProxyDetector: MagicProxyDetector;

  constructor() {
    this.magicProxyDetector = new MagicProxyDetector();
  }

  /**
   * Convert a value containing KubernetesRef objects to appropriate format
   * 
   * @param value - Value to convert
   * @param context - Factory context
   * @param config - Conversion configuration
   * @returns Conversion result
   */
  convertValue<T>(
    value: T,
    context: FactoryExpressionContext,
    config: CelConversionConfig = {}
  ): CelConversionResult<T> {
    const startTime = performance.now();
    
    logger.debug('Starting CEL conversion', {
      factoryType: context.factoryType,
      factoryName: context.factoryName,
      valueType: typeof value
    });

    const result: CelConversionResult<T> = {
      converted: value,
      wasConverted: false,
      original: value,
      strategy: 'static',
      metrics: {
        conversionTimeMs: 0,
        referencesConverted: 0,
        expressionsGenerated: 0
      },
      warnings: [],
      debugInfo: {
        detectedReferences: [],
        conversionSteps: []
      }
    };

    // Detect KubernetesRef objects in the value
    const detection = this.magicProxyDetector.detectKubernetesRefs(value, {
      maxDepth: config.maxDepth || 10,
      includeDetailedPaths: true,
      analyzeReferenceSources: true,
      trackMetrics: true
    });

    if (config.includeDebugInfo) {
      result.debugInfo!.detectedReferences = detection.references;
      result.debugInfo?.conversionSteps.push(`Detected ${detection.references.length} KubernetesRef objects`);
    }

    // If no KubernetesRef objects found, return as-is
    if (!detection.hasKubernetesRefs) {
      result.strategy = 'static';
      result.metrics.conversionTimeMs = performance.now() - startTime;
      return result;
    }

    // Convert based on factory type and value structure
    const converted = this.performConversion(value, detection, context, config, result);
    
    result.converted = converted;
    result.wasConverted = true;
    result.metrics.referencesConverted = detection.references.length;
    result.metrics.conversionTimeMs = performance.now() - startTime;

    logger.debug('CEL conversion completed', {
      wasConverted: result.wasConverted,
      strategy: result.strategy,
      referencesConverted: result.metrics.referencesConverted,
      conversionTimeMs: result.metrics.conversionTimeMs
    });

    return result;
  }

  /**
   * Convert a simple KubernetesRef to CEL expression
   * 
   * @param ref - KubernetesRef to convert
   * @param context - Factory context
   * @returns CEL expression
   */
  convertKubernetesRefToCel<T>(
    ref: KubernetesRef<T>,
    context: FactoryExpressionContext
  ): CelExpression<T> {
    const celExpression = this.generateCelFromRef(ref, context);
    
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: celExpression,
      type: 'unknown' // Type will be inferred during serialization
    } as CelExpression<T>;
  }

  /**
   * Check if a value needs CEL conversion
   * 
   * @param value - Value to check
   * @param maxDepth - Maximum depth to check
   * @returns Whether conversion is needed
   */
  needsConversion(value: any, maxDepth = 10): boolean {
    return this.magicProxyDetector.containsKubernetesRefs(value, maxDepth);
  }

  private performConversion<T>(
    value: T,
    detection: MagicProxyDetectionResult,
    context: FactoryExpressionContext,
    config: CelConversionConfig,
    result: CelConversionResult<T>
  ): T {
    // Handle direct KubernetesRef objects
    if (isKubernetesRef(value)) {
      result.strategy = 'direct';
      
      // Check if this is an external reference
      if (this.isExternalReference(value)) {
        if (config.includeDebugInfo) {
          result.debugInfo?.conversionSteps.push('Skipping conversion for external reference');
        }
        // External references should not be converted to CEL expressions
        // They will be handled by the serialization layer
        return value;
      }
      
      if (config.includeDebugInfo) {
        result.debugInfo?.conversionSteps.push('Converting direct KubernetesRef to CEL expression');
      }
      
      if (context.factoryType === 'kro') {
        // For Kro factories, convert to CEL expression
        const celExpr = this.convertKubernetesRefToCel(value, context);
        result.metrics.expressionsGenerated = 1;
        return celExpr as T;
      } else {
        // For direct factories, preserve the reference
        return value;
      }
    }

    // Handle template literals with KubernetesRef objects
    if (this.isTemplateLiteralWithRefs(value, detection)) {
      result.strategy = 'template-literal';
      if (config.includeDebugInfo) {
        result.debugInfo?.conversionSteps.push('Converting template literal with KubernetesRef objects');
      }
      return this.convertTemplateLiteral(value, detection, context, result) as T;
    }

    // Handle objects and arrays recursively
    if (value && typeof value === 'object') {
      result.strategy = 'cel-expression';
      if (config.includeDebugInfo) {
        result.debugInfo?.conversionSteps.push('Converting object/array with nested KubernetesRef objects');
      }
      return this.convertObjectWithRefs(value, detection, context, config, result) as T;
    }

    // Fallback: return as-is
    return value;
  }

  /**
   * Check if a KubernetesRef comes from an external reference
   * External references are not registered in the current composition context
   */
  private isExternalReference(ref: KubernetesRef<any>): boolean {
    const resourceId = ref.resourceId;
    
    // Schema references are never external
    if (resourceId === '__schema__') {
      return false;
    }
    
    // Check if the resource exists in the current composition context
    const context = getCurrentCompositionContext();
    if (!context) {
      // If no composition context, we can't determine if it's external
      // In this case, proceed with normal CEL conversion
      return false;
    }
    
    // If the resource is not registered in the current context, it's external
    return !(resourceId in context.resources);
  }

  private generateCelFromRef(ref: KubernetesRef<any>, _context: FactoryExpressionContext): string {
    const resourceId = ref.resourceId;
    const fieldPath = ref.fieldPath;

    // Handle schema references
    if (resourceId === '__schema__') {
      return `schema.${fieldPath}`;
    }

    // Handle resource references - don't include 'resources.' prefix
    // The final YAML serialization will wrap this with ${} to create ${resourceId.fieldPath}
    return `${resourceId}.${fieldPath}`;
  }

  private isTemplateLiteralWithRefs(value: any, detection: MagicProxyDetectionResult): boolean {
    // This is a simplified check - in a real implementation, we'd need to parse
    // the template literal structure to detect embedded KubernetesRef objects
    return typeof value === 'string' && detection.hasKubernetesRefs;
  }

  private convertTemplateLiteral<T>(
    value: T,
    _detection: MagicProxyDetectionResult,
    _context: FactoryExpressionContext,
    result: CelConversionResult<T>
  ): T {
    // For now, return as-is since template literal parsing is complex
    // In a full implementation, this would parse the template and convert
    // embedded KubernetesRef objects to CEL expressions
    result.warnings.push('Template literal conversion not fully implemented');
    return value;
  }

  private convertObjectWithRefs<T>(
    value: T,
    _detection: MagicProxyDetectionResult,
    context: FactoryExpressionContext,
    config: CelConversionConfig,
    result: CelConversionResult<T>
  ): T {
    if (Array.isArray(value)) {
      return value.map((item, _index) => {
        if (isKubernetesRef(item)) {
          // Check if this is an external reference
          if (this.isExternalReference(item)) {
            // External references should not be converted
            return item;
          }
          
          result.metrics.expressionsGenerated++;
          return context.factoryType === 'kro' 
            ? this.convertKubernetesRefToCel(item, context)
            : item;
        }
        
        // Recursively convert nested items
        if (this.magicProxyDetector.containsKubernetesRefs(item)) {
          const nestedResult = this.convertValue(item, context, config);
          if (nestedResult.wasConverted) {
            result.metrics.expressionsGenerated += nestedResult.metrics.expressionsGenerated;
          }
          return nestedResult.converted;
        }
        
        return item;
      }) as T;
    }

    if (value && typeof value === 'object' && value.constructor === Object) {
      const converted: Record<string, any> = {};
      
      for (const [key, val] of Object.entries(value)) {
        if (isKubernetesRef(val)) {
          // Check if this is an external reference
          if (this.isExternalReference(val)) {
            // External references should not be converted
            converted[key] = val;
          } else {
            result.metrics.expressionsGenerated++;
            converted[key] = context.factoryType === 'kro' 
              ? this.convertKubernetesRefToCel(val, context)
              : val;
          }
        } else if (this.magicProxyDetector.containsKubernetesRefs(val)) {
          const nestedResult = this.convertValue(val, context, config);
          if (nestedResult.wasConverted) {
            result.metrics.expressionsGenerated += nestedResult.metrics.expressionsGenerated;
          }
          converted[key] = nestedResult.converted;
        } else {
          converted[key] = val;
        }
      }
      
      return converted as T;
    }

    return value;
  }
}

/**
 * Global CEL conversion engine instance
 */
export const celConversionEngine = new CelConversionEngine();

/**
 * Utility function to convert a value with KubernetesRef objects
 * 
 * @param value - Value to convert
 * @param context - Factory context
 * @param config - Conversion configuration
 * @returns Conversion result
 */
export function convertToCel<T>(
  value: T,
  context: FactoryExpressionContext,
  config?: CelConversionConfig
): CelConversionResult<T> {
  return celConversionEngine.convertValue(value, context, config);
}

/**
 * Utility function to convert a KubernetesRef to CEL expression
 * 
 * @param ref - KubernetesRef to convert
 * @param context - Factory context
 * @returns CEL expression
 */
export function kubernetesRefToCel<T>(
  ref: KubernetesRef<T>,
  context: FactoryExpressionContext
): CelExpression<T> {
  return celConversionEngine.convertKubernetesRefToCel(ref, context);
}

/**
 * Utility function to check if a value needs CEL conversion
 * 
 * @param value - Value to check
 * @param maxDepth - Maximum depth to check
 * @returns Whether conversion is needed
 */
export function needsCelConversion(value: any, maxDepth?: number): boolean {
  return celConversionEngine.needsConversion(value, maxDepth);
}