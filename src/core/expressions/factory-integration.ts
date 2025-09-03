/**
 * Factory Integration for Expression Analysis
 * 
 * This module provides integration between factory functions and the expression
 * analysis system, enabling automatic detection and conversion of KubernetesRef
 * objects in factory configurations.
 */

import { getComponentLogger } from '../logging/index.js';
import type { KubernetesRef, MagicAssignable } from '../types/index.js';
import { isKubernetesRef, isCelExpression } from '../../utils/type-guards.js';
import { ResourceAnalyzer } from './resource-analyzer.js';
import { ExpressionContextDetector } from './context-detector.js';
import { ContextAwareCelGenerator } from './context-aware-generator.js';
import { 
  MagicProxyDetector, 
  type MagicProxyDetectionResult,
  type MagicProxyDetectionConfig 
} from './magic-proxy-detector.js';
import { 
  CelConversionEngine,
  type CelConversionConfig,
} from './cel-conversion-engine.js';
import type { 
  ExpressionAnalysisResult,
  FactoryAnalysisResult,
  FactoryExpressionContext
} from './types.js';

export type { 
  ExpressionAnalysisResult,
  FactoryExpressionContext,
  FactoryAnalysisResult
};

export interface FactoryAnalysisConfig {
  /** Whether to enable expression analysis for this factory */
  enableAnalysis?: boolean;
  
  /** Factory type for analysis context */
  factoryType?: 'direct' | 'kro';
  
  /** Whether to include detailed debug information */
  includeDebugInfo?: boolean;
  
  /** Maximum depth for recursive analysis */
  maxDepth?: number;
  
  /** Whether to validate expression types */
  validateTypes?: boolean;
}

const logger = getComponentLogger('factory-integration');

/**
 * Configuration for factory expression analysis
 */
export interface FactoryAnalysisConfig {
  /** Whether to enable expression analysis for this factory */
  enableAnalysis?: boolean;
  /** Factory type for context-aware analysis */
  factoryType?: 'direct' | 'kro';
  /** Whether to preserve static values without analysis */
  preserveStatic?: boolean;
  /** Maximum depth for recursive analysis */
  maxDepth?: number;
}

/**
 * Result of factory configuration analysis
 */
export interface FactoryConfigAnalysisResult {
  /** Whether the configuration contains KubernetesRef objects */
  hasKubernetesRefs: boolean;
  /** Analysis results for each field containing KubernetesRef objects */
  fieldAnalysis: Record<string, ExpressionAnalysisResult>;
  /** Suggested optimizations */
  optimizations: string[];
  /** Performance metrics */
  metrics: {
    analysisTimeMs: number;
    fieldsAnalyzed: number;
    referencesFound: number;
  };
  /** Magic proxy detection results */
  magicProxyDetection?: MagicProxyDetectionResult;
}

/**
 * Factory Expression Analyzer
 * 
 * Analyzes factory configurations for KubernetesRef objects and provides
 * context-aware expression handling recommendations.
 */
export class FactoryExpressionAnalyzer {
  private resourceAnalyzer: ResourceAnalyzer;
  private contextDetector: ExpressionContextDetector;
  private contextAwareGenerator: ContextAwareCelGenerator;
  private magicProxyDetector: MagicProxyDetector;
  private celConversionEngine: CelConversionEngine;

  constructor() {
    this.resourceAnalyzer = new ResourceAnalyzer();
    this.contextDetector = new ExpressionContextDetector();
    this.contextAwareGenerator = new ContextAwareCelGenerator();
    this.magicProxyDetector = new MagicProxyDetector();
    this.celConversionEngine = new CelConversionEngine();
  }

  /**
   * Analyze a factory configuration for KubernetesRef objects
   * 
   * @param config - Factory configuration object
   * @param context - Analysis context
   * @param options - Analysis options
   * @returns Analysis result
   */
  analyzeFactoryConfig<T extends Record<string, any>>(
    config: T,
    context: FactoryExpressionContext,
    options: FactoryAnalysisConfig = {}
  ): FactoryConfigAnalysisResult {
    const startTime = performance.now();
    
    logger.debug('Analyzing factory configuration', { 
      factoryType: context.factoryType,
      configKeys: Object.keys(config)
    });

    const result: FactoryConfigAnalysisResult = {
      hasKubernetesRefs: false,
      fieldAnalysis: {},
      optimizations: [],
      metrics: {
        analysisTimeMs: 0,
        fieldsAnalyzed: 0,
        referencesFound: 0
      }
    };

    // Skip analysis if disabled
    if (options.enableAnalysis === false) {
      result.metrics.analysisTimeMs = performance.now() - startTime;
      return result;
    }

    // Use enhanced magic proxy detection
    const detectionConfig: MagicProxyDetectionConfig = {
      maxDepth: options.maxDepth || 10,
      includeDetailedPaths: true,
      analyzeReferenceSources: true,
      trackMetrics: true
    };

    const magicProxyResult = this.magicProxyDetector.detectKubernetesRefs(config, detectionConfig);
    result.magicProxyDetection = magicProxyResult;
    result.hasKubernetesRefs = magicProxyResult.hasKubernetesRefs;
    result.metrics.referencesFound = magicProxyResult.stats.totalReferences;

    // Analyze each field in the configuration using enhanced detection
    this.analyzeConfigFieldsWithMagicProxy(config, context, result, magicProxyResult, options.maxDepth || 10);

    // Generate optimizations based on analysis
    this.generateOptimizations(result, context);

    result.metrics.analysisTimeMs = performance.now() - startTime;
    
    logger.debug('Factory configuration analysis complete', {
      hasKubernetesRefs: result.hasKubernetesRefs,
      fieldsAnalyzed: result.metrics.fieldsAnalyzed,
      referencesFound: result.metrics.referencesFound,
      analysisTimeMs: result.metrics.analysisTimeMs
    });

    return result;
  }

  /**
   * Process a factory configuration value, handling KubernetesRef objects appropriately
   * 
   * @param value - Configuration value to process
   * @param context - Factory context
   * @param fieldPath - Path to the field being processed
   * @param options - Processing options
   * @returns Processed value
   */
  processFactoryValue<T>(
    value: MagicAssignable<T>,
    context: FactoryExpressionContext,
    fieldPath: string,
    options: { enableCelConversion?: boolean } = {}
  ): T {
    logger.debug('Processing factory value', {
      fieldPath,
      factoryType: context.factoryType,
      valueType: typeof value,
      enableCelConversion: options.enableCelConversion
    });

    // Check if the value needs CEL conversion
    if (options.enableCelConversion && this.celConversionEngine.needsConversion(value)) {
      const conversionConfig: CelConversionConfig = {
        factoryType: context.factoryType,
        enableOptimization: true,
        preserveStatic: true,
        includeDebugInfo: false
      };

      const conversionResult = this.celConversionEngine.convertValue(value, context, conversionConfig);
      
      if (conversionResult.wasConverted) {
        logger.debug('CEL conversion applied', {
          fieldPath,
          strategy: conversionResult.strategy,
          referencesConverted: conversionResult.metrics.referencesConverted
        });
        return conversionResult.converted as T;
      }
    }

    // Handle KubernetesRef objects based on factory type
    if (isKubernetesRef(value)) {
      logger.debug('Processing KubernetesRef in factory configuration', {
        fieldPath,
        factoryType: context.factoryType,
        resourceId: (value as KubernetesRef<T>).resourceId,
        refFieldPath: (value as KubernetesRef<T>).fieldPath
      });

      // For direct factories, preserve the reference for runtime resolution
      // For Kro factories, the serialization system will handle CEL conversion
      return value as T;
    }

    // Handle CelExpression objects - preserve them as-is for serialization
    if (isCelExpression(value)) {
      logger.debug('Processing CelExpression in factory configuration', {
        fieldPath,
        factoryType: context.factoryType,
        expression: (value as any).expression
      });

      // Preserve CelExpression objects as-is - the serialization system will convert them to ${expression} format
      return value as T;
    }

    // Handle arrays and objects recursively
    if (Array.isArray(value)) {
      return value.map((item, index) => 
        this.processFactoryValue(item, context, `${fieldPath}[${index}]`, options)
      ) as T;
    }

    if (value && typeof value === 'object' && value.constructor === Object) {
      const processed: Record<string, any> = {};
      for (const [key, val] of Object.entries(value)) {
        processed[key] = this.processFactoryValue(val, context, `${fieldPath}.${key}`, options);
      }
      return processed as T;
    }

    // Return static values as-is
    return value as T;
  }

  /**
   * Create an enhanced factory function that includes expression analysis
   * 
   * @param originalFactory - Original factory function
   * @param factoryName - Name of the factory for logging
   * @returns Enhanced factory function
   */
  enhanceFactory<TConfig, TResource>(
    originalFactory: (config: TConfig) => TResource,
    factoryName: string
  ): (config: TConfig, options?: FactoryAnalysisConfig) => TResource {
    return (config: TConfig, options: FactoryAnalysisConfig = {}) => {
      const context: FactoryExpressionContext = {
        factoryType: options.factoryType || 'kro',
        factoryName,
        analysisEnabled: options.enableAnalysis !== false
      };

      // Analyze the configuration if analysis is enabled
      if (context.analysisEnabled) {
        const analysis = this.analyzeFactoryConfig(
          config as Record<string, any>,
          context,
          options
        );

        // Log analysis results for debugging
        if (analysis.hasKubernetesRefs) {
          logger.debug('Factory configuration contains KubernetesRef objects', {
            factoryName,
            referencesFound: analysis.metrics.referencesFound,
            optimizations: analysis.optimizations
          });
        }
      }

      // Call the original factory function
      return originalFactory(config);
    };
  }

  private analyzeConfigFields(
    config: Record<string, any>,
    context: FactoryExpressionContext,
    result: FactoryConfigAnalysisResult,
    maxDepth: number,
    currentPath = '',
    currentDepth = 0
  ): void {
    if (currentDepth >= maxDepth) {
      return;
    }

    for (const [key, value] of Object.entries(config)) {
      const fieldPath = currentPath ? `${currentPath}.${key}` : key;
      result.metrics.fieldsAnalyzed++;

      if (isKubernetesRef(value)) {
        result.hasKubernetesRefs = true;
        result.metrics.referencesFound++;

        // Analyze the KubernetesRef
        const analysisContext = {
          factoryType: context.factoryType || 'kro',
          type: 'resource' as const,
          availableReferences: {},
          resourceContext: {
            resourceId: (value as KubernetesRef<any>).resourceId,
            fieldPath: (value as KubernetesRef<any>).fieldPath
          },
          resourceId: 'factory-config',
          resourceConfig: { [key]: value }
        };

        const analysis = this.resourceAnalyzer.analyzeResourceConfig(
          'factory-config',
          { [key]: value },
          analysisContext
        );

        result.fieldAnalysis[fieldPath] = {
          hasKubernetesRefs: true,
          staticFields: [],
          kubernetesRefFields: [fieldPath],
          celExpressionFields: [],
          analysisDetails: analysis
        };
      } else if (Array.isArray(value)) {
        // Recursively analyze array elements
        value.forEach((item, index) => {
          if (typeof item === 'object' && item !== null) {
            this.analyzeConfigFields(
              { [index]: item },
              context,
              result,
              maxDepth,
              `${fieldPath}[${index}]`,
              currentDepth + 1
            );
          }
        });
      } else if (value && typeof value === 'object' && value.constructor === Object) {
        // Recursively analyze nested objects
        this.analyzeConfigFields(
          value,
          context,
          result,
          maxDepth,
          fieldPath,
          currentDepth + 1
        );
      }
    }
  }

  private analyzeConfigFieldsWithMagicProxy(
    _config: Record<string, any>,
    _context: FactoryExpressionContext,
    result: FactoryConfigAnalysisResult,
    magicProxyResult: MagicProxyDetectionResult,
    _maxDepth: number
  ): void {
    // Use the magic proxy detection results to create field analysis
    for (const refInfo of magicProxyResult.references) {
      const fieldPath = refInfo.path;
      
      if (!result.fieldAnalysis[fieldPath]) {
        result.fieldAnalysis[fieldPath] = {
          hasKubernetesRefs: true,
          staticFields: [],
          kubernetesRefFields: [fieldPath],
          celExpressionFields: [],
          analysisDetails: {
            source: refInfo.source,
            resourceId: refInfo.resourceId,
            fieldPath: refInfo.fieldPath,
            isNested: refInfo.isNested,
            nestingDepth: refInfo.nestingDepth
          }
        };
      }
    }

    // Count fields analyzed
    result.metrics.fieldsAnalyzed = magicProxyResult.metrics.propertiesScanned;
  }

  private generateOptimizations(
    result: FactoryConfigAnalysisResult,
    context: FactoryExpressionContext
  ): void {
    if (!result.hasKubernetesRefs) {
      result.optimizations.push('Configuration contains only static values - no expression analysis needed');
      return;
    }

    if (context.factoryType === 'direct') {
      result.optimizations.push('Direct factory detected - KubernetesRef objects will be resolved at runtime');
    } else {
      result.optimizations.push('Kro factory detected - KubernetesRef objects will be converted to CEL expressions');
    }

    // Enhanced optimizations based on magic proxy detection
    if (result.magicProxyDetection) {
      const detection = result.magicProxyDetection;
      
      if (detection.stats.schemaReferences > 0) {
        result.optimizations.push(`Found ${detection.stats.schemaReferences} schema references - these will be resolved during serialization`);
      }
      
      if (detection.stats.resourceReferences > 0) {
        result.optimizations.push(`Found ${detection.stats.resourceReferences} resource references - these create dependencies`);
      }
      
      if (detection.stats.nestedReferences > 0) {
        result.optimizations.push(`Found ${detection.stats.nestedReferences} nested references - consider flattening for better performance`);
      }
      
      if (detection.stats.maxNestingDepth > 5) {
        result.optimizations.push(`Deep nesting detected (depth: ${detection.stats.maxNestingDepth}) - consider restructuring for better maintainability`);
      }
    }

    if (result.metrics.referencesFound > 10) {
      result.optimizations.push('High number of references detected - consider caching analysis results');
    }

    if (result.metrics.analysisTimeMs > 100) {
      result.optimizations.push('Analysis took significant time - consider enabling lazy analysis for complex configurations');
    }
  }
}

/**
 * Global factory expression analyzer instance
 */
export const factoryExpressionAnalyzer = new FactoryExpressionAnalyzer();

/**
 * Utility function to enhance a factory function with expression analysis
 * 
 * @param factory - Original factory function
 * @param name - Factory name for logging
 * @returns Enhanced factory function
 */
export function withExpressionAnalysis<TConfig, TResource>(
  factory: (config: TConfig) => TResource,
  name: string
): (config: TConfig, options?: FactoryAnalysisConfig) => TResource {
  return factoryExpressionAnalyzer.enhanceFactory(factory, name);
}

/**
 * Utility function to analyze a factory configuration
 * 
 * @param config - Factory configuration
 * @param context - Analysis context
 * @param options - Analysis options
 * @returns Analysis result
 */
export function analyzeFactoryConfig<T extends Record<string, any>>(
  config: T,
  context: FactoryExpressionContext,
  options?: FactoryAnalysisConfig
): FactoryConfigAnalysisResult {
  return factoryExpressionAnalyzer.analyzeFactoryConfig(config, context, options);
}

/**
 * Utility function to process a factory value with KubernetesRef handling
 * 
 * @param value - Value to process
 * @param context - Factory context
 * @param fieldPath - Field path for logging
 * @returns Processed value
 */
export function processFactoryValue<T>(
  value: MagicAssignable<T>,
  context: FactoryExpressionContext,
  fieldPath: string
): T {
  return factoryExpressionAnalyzer.processFactoryValue(value, context, fieldPath);
}