/**
 * Composition-Aware Expression Analyzer
 *
 * Integrates with kubernetesComposition API to analyze composition functions
 * for KubernetesRef usage and CEL conversion needs.
 */

import { extractResourceReferences } from '../../../utils/type-guards.js';
import type { CompositionContext } from '../../composition/context.js';
import { getCurrentCompositionContext } from '../../composition/context.js';
import { CompositionExecutionError, ensureError } from '../../errors.js';
import type { KubernetesRef } from '../../types/common.js';
import type {
  KroCompatibleType,
  MagicAssignableShape,
  SchemaProxy,
} from '../../types/serialization.js';
import type { Enhanced } from '../../types.js';
import { MagicAssignableAnalyzer } from '../magic-proxy/magic-assignable-analyzer.js';
import { CompositionContextTracker } from './context-tracker.js';
import { MagicProxyScopeManager } from './scope-manager.js';
import type {
  CompositionAnalysisResult,
  CompositionPattern,
  PatternAnalysisConfig,
} from './types.js';

export type { CompositionAnalysisResult, CompositionPattern, PatternAnalysisConfig };

/**
 * Composition-aware expression analyzer that integrates with kubernetesComposition
 */
export class CompositionExpressionAnalyzer {
  private magicAssignableAnalyzer: MagicAssignableAnalyzer;
  private patternConfigs: Map<CompositionPattern, PatternAnalysisConfig>;
  private contextTracker: CompositionContextTracker;
  private scopeManager: MagicProxyScopeManager;

  constructor() {
    this.magicAssignableAnalyzer = new MagicAssignableAnalyzer();
    this.contextTracker = new CompositionContextTracker();
    this.scopeManager = new MagicProxyScopeManager();

    // Initialize pattern-specific configurations
    this.patternConfigs = new Map([
      [
        'imperative',
        {
          pattern: 'imperative',
          allowSideEffects: true,
          trackResourceCreation: true,
          validateScope: true,
          convertToCel: true,
        },
      ],
      [
        'declarative',
        {
          pattern: 'declarative',
          allowSideEffects: false,
          trackResourceCreation: false,
          validateScope: false,
          convertToCel: true,
        },
      ],
    ]);
  }

  /**
   * Detect the composition pattern being used
   */
  detectCompositionPattern(
    compositionFn: { toString(): string },
    context?: CompositionContext
  ): CompositionPattern {
    // If there's an active composition context, it's imperative
    if (context || getCurrentCompositionContext()) {
      return 'imperative';
    }

    // Analyze function signature and behavior
    const fnString = compositionFn.toString();

    // Look for imperative patterns
    const imperativeIndicators = [
      /\.add\w+\(/, // .addResource, .addService, etc.
      /register\w+\(/, // registerResource, etc.
      /create\w+\(/, // createResource, etc.
      /simple\w+\(/, // simpleDeployment, simpleService, etc.
    ];

    const hasImperativeIndicators = imperativeIndicators.some((pattern) => pattern.test(fnString));

    return hasImperativeIndicators ? 'imperative' : 'declarative';
  }

  /**
   * Analyze composition function with pattern awareness
   */
  analyzeCompositionFunctionWithPattern<
    TSpec extends KroCompatibleType,
    TStatus extends KroCompatibleType,
  >(
    compositionFn: (spec: TSpec) => MagicAssignableShape<TStatus>,
    schemaProxy: SchemaProxy<TSpec, TStatus>,
    pattern?: CompositionPattern,
    context?: CompositionContext
  ): CompositionAnalysisResult<TStatus> & {
    pattern: CompositionPattern;
    patternSpecificMetadata: {
      sideEffectsDetected: boolean;
      resourceCreationTracked: boolean;
      scopeValidationPerformed: boolean;
    };
  } {
    // Detect pattern if not provided
    const detectedPattern = pattern || this.detectCompositionPattern(compositionFn, context);
    const config = this.patternConfigs.get(detectedPattern)!;

    // Track side effects if this is an imperative pattern
    let sideEffectsDetected = false;
    let resourceCreationTracked = false;
    let scopeValidationPerformed = false;

    if (config.trackResourceCreation && context) {
      const resourcesBefore = new Set(Object.keys(context.resources));

      // Execute the base analysis
      const baseResult = this.analyzeCompositionFunction(compositionFn, schemaProxy, context);

      // Check for side effects
      const resourcesAfter = Object.keys(context.resources);
      sideEffectsDetected = resourcesAfter.some((id) => !resourcesBefore.has(id));
      resourceCreationTracked = true;

      // Perform scope validation if enabled
      if (config.validateScope) {
        // This would be handled by the scope manager
        scopeValidationPerformed = true;
      }

      return {
        ...baseResult,
        pattern: detectedPattern,
        patternSpecificMetadata: {
          sideEffectsDetected,
          resourceCreationTracked,
          scopeValidationPerformed,
        },
      };
    } else {
      // Execute the base analysis without side effect tracking
      const baseResult = this.analyzeCompositionFunction(compositionFn, schemaProxy, context);

      return {
        ...baseResult,
        pattern: detectedPattern,
        patternSpecificMetadata: {
          sideEffectsDetected,
          resourceCreationTracked,
          scopeValidationPerformed,
        },
      };
    }
  }

  /**
   * Process composition based on detected pattern
   */
  processCompositionByPattern<TStatus extends KroCompatibleType>(
    statusShape: MagicAssignableShape<TStatus>,
    pattern: CompositionPattern,
    factoryType: 'direct' | 'kro' = 'kro'
  ): MagicAssignableShape<TStatus> {
    const config = this.patternConfigs.get(pattern)!;

    if (!config.convertToCel) {
      // Pattern doesn't require CEL conversion
      return statusShape;
    }

    // Use the standard processing logic
    return this.processCompositionStatus(statusShape, factoryType);
  }

  /**
   * Validate composition pattern compatibility
   */
  validatePatternCompatibility(
    pattern: CompositionPattern,
    factoryType: 'direct' | 'kro',
    context?: CompositionContext
  ): {
    isCompatible: boolean;
    warnings: string[];
    recommendations: string[];
  } {
    const warnings: string[] = [];
    const recommendations: string[] = [];
    let isCompatible = true;

    const config = this.patternConfigs.get(pattern)!;

    // Check imperative pattern with direct factory
    if (pattern === 'imperative' && factoryType === 'direct') {
      if (!context) {
        warnings.push(
          'Imperative pattern without composition context may not work correctly with direct factory'
        );
        recommendations.push('Ensure kubernetesComposition is used with proper context management');
      }
    }

    // Check declarative pattern with side effects
    if (pattern === 'declarative' && config.allowSideEffects && context) {
      const resourceCount = Object.keys(context.resources).length;
      if (resourceCount > 0) {
        warnings.push('Declarative pattern detected but resources found in composition context');
        recommendations.push(
          'Consider using imperative pattern (kubernetesComposition) for side-effect based resource creation'
        );
      }
    }

    // Check CEL conversion compatibility
    if (factoryType === 'kro' && !config.convertToCel) {
      isCompatible = false;
      warnings.push(
        `Pattern '${pattern}' is not compatible with Kro factory (CEL conversion required)`
      );
      recommendations.push('Use direct factory or enable CEL conversion for this pattern');
    }

    return {
      isCompatible,
      warnings,
      recommendations,
    };
  }

  /**
   * Get pattern-specific analysis recommendations
   */
  getPatternRecommendations(
    pattern: CompositionPattern,
    analysisResult: CompositionAnalysisResult<KroCompatibleType>
  ): string[] {
    const recommendations: string[] = [];

    if (pattern === 'imperative') {
      if (analysisResult.kubernetesRefs.length === 0) {
        recommendations.push(
          'Consider using declarative pattern (toResourceGraph) for static compositions without KubernetesRef objects'
        );
      }

      if (analysisResult.referencedResources.length > 10) {
        recommendations.push(
          'Large number of resource references detected - consider breaking into smaller compositions'
        );
      }
    }

    if (pattern === 'declarative') {
      if (analysisResult.kubernetesRefs.length > 0) {
        recommendations.push(
          'KubernetesRef objects detected - imperative pattern (kubernetesComposition) might be more suitable'
        );
      }
    }

    return recommendations;
  }

  /**
   * Analyze a composition function for KubernetesRef usage and expression conversion needs
   */
  analyzeCompositionFunction<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
    compositionFn: (spec: TSpec) => MagicAssignableShape<TStatus>,
    schemaProxy: SchemaProxy<TSpec, TStatus>,
    context?: CompositionContext
  ): CompositionAnalysisResult<TStatus> {
    const _startTime = Date.now();

    try {
      // Execute the composition function to capture the returned status shape
      const statusShape = compositionFn(schemaProxy.spec as TSpec);

      // Create analysis context
      const analysisContext = {
        type: 'status' as const,
        availableReferences: context?.resources || {},
        schemaProxy,
        factoryType: 'kro' as const,
      };

      // Analyze the status shape for KubernetesRef objects
      const analysisResult = this.magicAssignableAnalyzer.analyzeMagicAssignableShape(
        statusShape,
        analysisContext
      );

      // Extract referenced resources from the composition context if available
      const referencedResources = this.extractReferencedResources(context);

      // Determine if CEL conversion is needed
      const requiresCelConversion = analysisResult.dependencies.length > 0;

      const conversionMetadata = {
        expressionsAnalyzed: Object.keys(analysisResult.fieldResults).length,
        kubernetesRefsDetected: analysisResult.dependencies.length,
        celExpressionsGenerated: requiresCelConversion
          ? Object.keys(analysisResult.fieldResults).length
          : 0,
      };

      return {
        statusShape,
        kubernetesRefs: analysisResult.dependencies,
        referencedResources,
        requiresCelConversion,
        conversionMetadata,
      };
    } catch (error: unknown) {
      throw new CompositionExecutionError(
        `Failed to analyze composition function: ${ensureError(error).message}`,
        'unknown',
        'validation',
        undefined,
        ensureError(error)
      );
    }
  }

  /**
   * Analyze a composition function's resource creation patterns
   */
  analyzeResourceCreation<TSpec extends KroCompatibleType>(
    compositionFn: (spec: TSpec) => unknown,
    schemaProxy: SchemaProxy<TSpec, KroCompatibleType>,
    context?: CompositionContext
  ): {
    resourcesCreated: string[];
    kubernetesRefsInResources: KubernetesRef<unknown>[];
    requiresCelConversion: boolean;
  } {
    const currentContext = context || getCurrentCompositionContext();

    if (!currentContext) {
      return {
        resourcesCreated: [],
        kubernetesRefsInResources: [],
        requiresCelConversion: false,
      };
    }

    // Track resources before execution
    const resourcesBefore = new Set(Object.keys(currentContext.resources));

    try {
      // Execute the composition function to trigger resource creation
      compositionFn(schemaProxy.spec as TSpec);

      // Find newly created resources
      const resourcesAfter = Object.keys(currentContext.resources);
      const resourcesCreated = resourcesAfter.filter((id) => !resourcesBefore.has(id));

      // Analyze newly created resources for KubernetesRef objects
      const kubernetesRefsInResources: KubernetesRef<unknown>[] = [];

      for (const resourceId of resourcesCreated) {
        const resource = currentContext.resources[resourceId];
        if (resource) {
          const refs = this.extractKubernetesRefsFromResource(resource);
          kubernetesRefsInResources.push(...refs);
        }
      }

      return {
        resourcesCreated,
        kubernetesRefsInResources,
        requiresCelConversion: kubernetesRefsInResources.length > 0,
      };
    } catch (error: unknown) {
      throw new CompositionExecutionError(
        `Failed to analyze resource creation: ${ensureError(error).message}`,
        'unknown',
        'resource-creation',
        undefined,
        ensureError(error)
      );
    }
  }

  /**
   * Process a composition's status shape for CEL conversion
   */
  processCompositionStatus<TStatus extends KroCompatibleType>(
    statusShape: MagicAssignableShape<TStatus>,
    factoryType: 'direct' | 'kro' = 'kro'
  ): MagicAssignableShape<TStatus> {
    if (factoryType === 'direct') {
      // For direct factory, leave expressions as-is for runtime evaluation
      return statusShape;
    }

    // Create analysis context
    const analysisContext = {
      type: 'status' as const,
      availableReferences: {},
      factoryType,
    };

    // For Kro factory, convert KubernetesRef-containing expressions to CEL
    return this.magicAssignableAnalyzer.analyzeMagicAssignableShape(statusShape, analysisContext)
      .processedShape as MagicAssignableShape<TStatus>;
  }

  /**
   * Enhanced status building with comprehensive KubernetesRef handling
   */
  buildCompositionStatus<TStatus extends KroCompatibleType>(
    statusShape: MagicAssignableShape<TStatus>,
    context: CompositionContext,
    factoryType: 'direct' | 'kro' = 'kro'
  ): {
    processedStatus: MagicAssignableShape<TStatus>;
    kubernetesRefs: KubernetesRef<unknown>[];
    dependencies: string[];
    requiresCelConversion: boolean;
    conversionMetadata: {
      fieldsProcessed: number;
      kubernetesRefsFound: number;
      celExpressionsGenerated: number;
      crossResourceReferences: number;
    };
  } {
    // Create analysis context
    const analysisContext = {
      type: 'status' as const,
      availableReferences: context.resources,
      factoryType,
    };

    // Analyze the status shape for KubernetesRef objects
    const analysisResult = this.magicAssignableAnalyzer.analyzeMagicAssignableShape(
      statusShape,
      analysisContext
    );

    // Track context for dependency analysis
    const contextTracking = this.contextTracker.trackCompositionContext(context);

    // Extract dependencies from KubernetesRef objects
    const dependencies = new Set<string>();
    let crossResourceReferences = 0;

    for (const ref of analysisResult.dependencies) {
      if (ref.resourceId !== '__schema__') {
        dependencies.add(ref.resourceId);

        // Check if this is a cross-resource reference
        if (contextTracking.resourcesWithKubernetesRefs.includes(ref.resourceId)) {
          crossResourceReferences++;
        }
      }
    }

    // Process the status shape based on factory type
    let processedStatus: MagicAssignableShape<TStatus>;
    let celExpressionsGenerated = 0;

    if (factoryType === 'direct') {
      // For direct factory, leave expressions as-is for runtime evaluation
      processedStatus = statusShape;
    } else {
      // For Kro factory, convert KubernetesRef-containing expressions to CEL
      processedStatus = analysisResult.processedShape as MagicAssignableShape<TStatus>;
      celExpressionsGenerated = Object.keys(analysisResult.fieldResults).length;
    }

    return {
      processedStatus,
      kubernetesRefs: analysisResult.dependencies,
      dependencies: Array.from(dependencies),
      requiresCelConversion: analysisResult.dependencies.length > 0,
      conversionMetadata: {
        fieldsProcessed: Object.keys(analysisResult.fieldResults).length,
        kubernetesRefsFound: analysisResult.dependencies.length,
        celExpressionsGenerated,
        crossResourceReferences,
      },
    };
  }

  /**
   * Validate status shape for composition compatibility
   */
  validateStatusShape<TStatus extends KroCompatibleType>(
    statusShape: MagicAssignableShape<TStatus>,
    context?: CompositionContext
  ): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Create analysis context
      const analysisContext = {
        type: 'status' as const,
        availableReferences: context?.resources || {},
        factoryType: 'kro' as const,
      };

      // Analyze the status shape
      const analysisResult = this.magicAssignableAnalyzer.analyzeMagicAssignableShape(
        statusShape,
        analysisContext
      );

      // Validate each KubernetesRef
      for (const ref of analysisResult.dependencies) {
        const scopeValidation = this.scopeManager.validateKubernetesRefScope(ref);

        if (!scopeValidation.isValid) {
          errors.push(`Invalid KubernetesRef scope: ${scopeValidation.error}`);
        }

        // Check if the referenced resource exists in the context
        if (context && ref.resourceId !== '__schema__' && !context.resources[ref.resourceId]) {
          warnings.push(`Referenced resource '${ref.resourceId}' not found in composition context`);
        }
      }

      // Check for circular dependencies
      if (context) {
        const contextTracking = this.contextTracker.trackCompositionContext(context);

        // Simple circular dependency detection
        const resourceGraph = new Map<string, Set<string>>();

        for (const crossRef of contextTracking.crossResourceReferences) {
          if (!resourceGraph.has(crossRef.sourceResource)) {
            resourceGraph.set(crossRef.sourceResource, new Set());
          }
          resourceGraph.get(crossRef.sourceResource)?.add(crossRef.targetResource);
        }

        // Check for cycles using DFS
        const visited = new Set<string>();
        const recursionStack = new Set<string>();

        const hasCycle = (node: string): boolean => {
          if (recursionStack.has(node)) {
            return true;
          }
          if (visited.has(node)) {
            return false;
          }

          visited.add(node);
          recursionStack.add(node);

          const neighbors = resourceGraph.get(node) || new Set();
          for (const neighbor of neighbors) {
            if (hasCycle(neighbor)) {
              return true;
            }
          }

          recursionStack.delete(node);
          return false;
        };

        for (const resource of resourceGraph.keys()) {
          if (hasCycle(resource)) {
            errors.push(`Circular dependency detected involving resource '${resource}'`);
            break;
          }
        }
      }
    } catch (error: unknown) {
      errors.push(`Status shape validation failed: ${ensureError(error).message}`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Extract referenced resources from composition context
   */
  private extractReferencedResources(context?: CompositionContext): string[] {
    if (!context) {
      const currentContext = getCurrentCompositionContext();
      if (!currentContext) {
        return [];
      }
      context = currentContext;
    }

    return Object.keys(context.resources);
  }

  /** Delegate to canonical implementation in type-guards.ts */
  public extractKubernetesRefsFromResource(
    resource: Enhanced<unknown, unknown>
  ): KubernetesRef<unknown>[] {
    return extractResourceReferences(resource);
  }
}
