/**
 * Composition Integration for JavaScript to CEL Expression Conversion
 *
 * This module provides integration between the kubernetesComposition API and the
 * JavaScript to CEL expression conversion system. It handles KubernetesRef detection
 * and conversion within imperative composition patterns.
 */

import type { CompositionContext } from '../../factories/shared.js';
import { getCurrentCompositionContext } from '../../factories/shared.js';
import type { KubernetesRef } from '../types/common.js';
import type {
  MagicAssignableShape,
  KroCompatibleType,
  SchemaProxy,
} from '../types/serialization.js';
import type { Enhanced } from '../types.js';
import { isKubernetesRef } from '../../utils/type-guards.js';
import { MagicAssignableAnalyzer } from './magic-assignable-analyzer.js';
import { CelConversionEngine } from './cel-conversion-engine.js';

/**
 * Analysis result for imperative composition functions
 */
export interface CompositionAnalysisResult<TStatus extends KroCompatibleType> {
  /** The analyzed status shape with conversion metadata */
  statusShape: MagicAssignableShape<TStatus>;
  /** KubernetesRef objects found in the composition */
  kubernetesRefs: KubernetesRef<unknown>[];
  /** Resources referenced by the composition */
  referencedResources: string[];
  /** Whether the composition requires CEL conversion */
  requiresCelConversion: boolean;
  /** Conversion metadata for debugging */
  conversionMetadata: {
    expressionsAnalyzed: number;
    kubernetesRefsDetected: number;
    celExpressionsGenerated: number;
  };
}

/**
 * Composition pattern types
 */
export type CompositionPattern = 'imperative' | 'declarative';

/**
 * Pattern-specific analysis configuration
 */
export interface PatternAnalysisConfig {
  pattern: CompositionPattern;
  allowSideEffects: boolean;
  trackResourceCreation: boolean;
  validateScope: boolean;
  convertTocel: boolean;
}

/**
 * Composition-aware expression analyzer that integrates with kubernetesComposition
 */
export class CompositionExpressionAnalyzer {
  private magicAssignableAnalyzer: MagicAssignableAnalyzer;
  private celEngine: CelConversionEngine;
  private patternConfigs: Map<CompositionPattern, PatternAnalysisConfig>;
  private contextTracker: CompositionContextTracker;
  private scopeManager: MagicProxyScopeManager;

  constructor() {
    this.magicAssignableAnalyzer = new MagicAssignableAnalyzer();
    this.celEngine = new CelConversionEngine();
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
          convertTocel: true,
        },
      ],
      [
        'declarative',
        {
          pattern: 'declarative',
          allowSideEffects: false,
          trackResourceCreation: false,
          validateScope: false,
          convertTocel: true,
        },
      ],
    ]);
  }

  /**
   * Detect the composition pattern being used
   */
  detectCompositionPattern(
    compositionFn: Function,
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

    if (!config.convertTocel) {
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
    if (factoryType === 'kro' && !config.convertTocel) {
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
    analysisResult: CompositionAnalysisResult<any>
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
    } catch (error) {
      throw new Error(
        `Failed to analyze composition function: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Analyze a composition function's resource creation patterns
   */
  analyzeResourceCreation<TSpec extends KroCompatibleType>(
    compositionFn: (spec: TSpec) => unknown,
    schemaProxy: SchemaProxy<TSpec, any>,
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
    } catch (error) {
      throw new Error(
        `Failed to analyze resource creation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Process a composition's status shape for CEL conversion
   */
  processCompositionStatus<TStatus extends KroCompatibleType>(
    statusShape: TStatus | MagicAssignableShape<TStatus>,
    factoryType: 'direct' | 'kro' = 'kro'
  ): MagicAssignableShape<TStatus> {
    if (factoryType === 'direct') {
      // For direct factory, leave expressions as-is for runtime evaluation
      return statusShape as MagicAssignableShape<TStatus>;
    }

    // Create analysis context
    const analysisContext = {
      type: 'status' as const,
      availableReferences: {},
      factoryType,
    };

    // For Kro factory, convert KubernetesRef-containing expressions to CEL
    return this.magicAssignableAnalyzer.analyzeMagicAssignableShape(
      statusShape as MagicAssignableShape<TStatus>,
      analysisContext
    ).processedShape as MagicAssignableShape<TStatus>;
  }

  /**
   * Enhanced status building with comprehensive KubernetesRef handling
   */
  buildCompositionStatus<TStatus extends KroCompatibleType>(
    statusShape: TStatus | MagicAssignableShape<TStatus>,
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
      statusShape as MagicAssignableShape<TStatus>,
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
      processedStatus = statusShape as MagicAssignableShape<TStatus>;
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
    } catch (error) {
      errors.push(
        `Status shape validation failed: ${error instanceof Error ? error.message : String(error)}`
      );
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

  /**
   * Extract KubernetesRef objects from a resource
   */
  public extractKubernetesRefsFromResource(
    resource: Enhanced<unknown, unknown>
  ): KubernetesRef<unknown>[] {
    const refs: KubernetesRef<unknown>[] = [];

    const traverse = (obj: unknown): void => {
      if (isKubernetesRef(obj)) {
        refs.push(obj as KubernetesRef<unknown>);
        return;
      }

      if (Array.isArray(obj)) {
        obj.forEach(traverse);
      } else if (obj && typeof obj === 'object') {
        Object.values(obj).forEach(traverse);
      }
    };

    traverse(resource);
    return refs;
  }
}

/**
 * Context-aware resource tracking for composition integration
 */
export class CompositionContextTracker {
  private contextAnalysisCache = new Map<string, CompositionAnalysisResult<any>>();
  public resourceKubernetesRefCache = new Map<string, KubernetesRef<unknown>[]>();

  /**
   * Track KubernetesRef usage in a composition context
   */
  trackCompositionContext(context: CompositionContext): {
    totalKubernetesRefs: number;
    resourcesWithKubernetesRefs: string[];
    crossResourceReferences: Array<{
      sourceResource: string;
      targetResource: string;
      fieldPath: string;
    }>;
  } {
    const allKubernetesRefs: KubernetesRef<unknown>[] = [];
    const resourcesWithKubernetesRefs: string[] = [];
    const crossResourceReferences: Array<{
      sourceResource: string;
      targetResource: string;
      fieldPath: string;
    }> = [];

    // Analyze all resources in the context
    for (const [resourceId, resource] of Object.entries(context.resources)) {
      const refs = this.extractKubernetesRefsFromResource(resource);

      if (refs.length > 0) {
        resourcesWithKubernetesRefs.push(resourceId);
        allKubernetesRefs.push(...refs);

        // Cache the refs for this resource
        this.resourceKubernetesRefCache.set(resourceId, refs);

        // Identify cross-resource references
        for (const ref of refs) {
          if (ref.resourceId !== resourceId && ref.resourceId !== '__schema__') {
            crossResourceReferences.push({
              sourceResource: resourceId,
              targetResource: ref.resourceId,
              fieldPath: ref.fieldPath,
            });
          }
        }
      }
    }

    return {
      totalKubernetesRefs: allKubernetesRefs.length,
      resourcesWithKubernetesRefs,
      crossResourceReferences,
    };
  }

  /**
   * Get cached KubernetesRef objects for a resource
   */
  getCachedResourceKubernetesRefs(resourceId: string): KubernetesRef<unknown>[] {
    return this.resourceKubernetesRefCache.get(resourceId) || [];
  }

  /**
   * Clear caches for a specific context
   */
  clearContextCache(contextId: string): void {
    this.contextAnalysisCache.delete(contextId);
  }

  /**
   * Extract KubernetesRef objects from a resource
   */
  public extractKubernetesRefsFromResource(
    resource: Enhanced<unknown, unknown>
  ): KubernetesRef<unknown>[] {
    const refs: KubernetesRef<unknown>[] = [];

    const traverse = (obj: unknown, path: string = ''): void => {
      if (isKubernetesRef(obj)) {
        refs.push(obj as KubernetesRef<unknown>);
        return;
      }

      if (Array.isArray(obj)) {
        obj.forEach((item, index) => traverse(item, `${path}[${index}]`));
      } else if (obj && typeof obj === 'object') {
        Object.entries(obj).forEach(([key, value]) => {
          const newPath = path ? `${path}.${key}` : key;
          traverse(value, newPath);
        });
      }
    };

    traverse(resource);
    return refs;
  }
}

/**
 * Nested composition scope information
 */
export interface NestedCompositionScope {
  contextId: string;
  resourceIds: Set<string>;
  schemaProxy?: SchemaProxy<any, any> | undefined;
  parentScope?: NestedCompositionScope | undefined;
  childScopes: NestedCompositionScope[];
  depth: number;
  mergedResourceIds?: string[] | undefined;
}

/**
 * Magic proxy scoping manager for composition contexts with nested composition support
 */
export class MagicProxyScopeManager {
  private scopeStack: NestedCompositionScope[] = [];
  private scopeRegistry = new Map<string, NestedCompositionScope>();

  /**
   * Enter a new composition scope
   */
  enterScope(contextId: string, schemaProxy?: SchemaProxy<any, any>): void {
    const parentScope = this.getCurrentScope();
    const depth = parentScope ? parentScope.depth + 1 : 0;

    const newScope: NestedCompositionScope = {
      contextId,
      resourceIds: new Set(),
      schemaProxy,
      parentScope,
      childScopes: [],
      depth,
    };

    // Link to parent scope
    if (parentScope) {
      parentScope.childScopes.push(newScope);
    }

    this.scopeStack.push(newScope);
    this.scopeRegistry.set(contextId, newScope);
  }

  /**
   * Exit the current composition scope
   */
  exitScope(): void {
    const exitingScope = this.scopeStack.pop();
    if (exitingScope) {
      this.scopeRegistry.delete(exitingScope.contextId);
    }
  }

  /**
   * Register a resource in the current scope
   */
  registerResource(resourceId: string): void {
    const currentScope = this.getCurrentScope();
    if (currentScope) {
      currentScope.resourceIds.add(resourceId);
    }
  }

  /**
   * Register merged resources from a nested composition
   */
  registerMergedResources(contextId: string, mergedResourceIds: string[]): void {
    const scope = this.scopeRegistry.get(contextId);
    if (scope) {
      scope.mergedResourceIds = mergedResourceIds;

      // Also register these resources in the current scope for accessibility
      const currentScope = this.getCurrentScope();
      if (currentScope && currentScope !== scope) {
        mergedResourceIds.forEach((id) => currentScope.resourceIds.add(id));
      }
    }
  }

  /**
   * Get the current scope
   */
  getCurrentScope(): NestedCompositionScope | undefined {
    return this.scopeStack[this.scopeStack.length - 1];
  }

  /**
   * Get a scope by context ID
   */
  getScope(contextId: string): NestedCompositionScope | undefined {
    return this.scopeRegistry.get(contextId);
  }

  /**
   * Check if a resource is accessible in the current scope (including parent scopes)
   */
  isResourceAccessible(resourceId: string): boolean {
    const currentScope = this.getCurrentScope();
    if (!currentScope) {
      return false;
    }

    // Check current scope and all parent scopes
    let scope: NestedCompositionScope | undefined = currentScope;
    while (scope) {
      if (scope.resourceIds.has(resourceId)) {
        return true;
      }

      // Check merged resources from nested compositions
      if (scope.mergedResourceIds?.includes(resourceId)) {
        return true;
      }

      scope = scope.parentScope;
    }

    return false;
  }

  /**
   * Check if a resource is in the current scope only
   */
  isResourceInCurrentScope(resourceId: string): boolean {
    const currentScope = this.getCurrentScope();
    return currentScope ? currentScope.resourceIds.has(resourceId) : false;
  }

  /**
   * Get all accessible resources (current scope + parent scopes)
   */
  getAccessibleResources(): string[] {
    const currentScope = this.getCurrentScope();
    if (!currentScope) {
      return [];
    }

    const accessibleResources = new Set<string>();

    // Collect resources from current scope and all parent scopes
    let scope: NestedCompositionScope | undefined = currentScope;
    while (scope) {
      scope.resourceIds.forEach((id) => accessibleResources.add(id));

      // Add merged resources from nested compositions
      if (scope.mergedResourceIds) {
        scope.mergedResourceIds.forEach((id) => accessibleResources.add(id));
      }

      scope = scope.parentScope;
    }

    return Array.from(accessibleResources);
  }

  /**
   * Get resources in the current scope only
   */
  getCurrentScopeResources(): string[] {
    const currentScope = this.getCurrentScope();
    return currentScope ? Array.from(currentScope.resourceIds) : [];
  }

  /**
   * Get the scope hierarchy as a string for debugging
   */
  getScopeHierarchy(): string {
    const currentScope = this.getCurrentScope();
    if (!currentScope) {
      return 'No active scope';
    }

    const hierarchy: string[] = [];
    let scope: NestedCompositionScope | undefined = currentScope;

    while (scope) {
      hierarchy.unshift(
        `${scope.contextId} (depth: ${scope.depth}, resources: ${scope.resourceIds.size})`
      );
      scope = scope.parentScope;
    }

    return hierarchy.join(' -> ');
  }

  /**
   * Validate KubernetesRef scope with nested composition support
   */
  validateKubernetesRefScope(kubernetesRef: KubernetesRef<unknown>): {
    isValid: boolean;
    error?: string;
    scopeInfo?: {
      foundInScope: string;
      scopeDepth: number;
    };
  } {
    const currentScope = this.getCurrentScope();

    if (!currentScope) {
      return { isValid: false, error: 'No active composition scope' };
    }

    // Schema references are always valid
    if (kubernetesRef.resourceId === '__schema__') {
      return { isValid: true };
    }

    // Check accessibility in nested scope hierarchy
    let scope: NestedCompositionScope | undefined = currentScope;
    while (scope) {
      if (scope.resourceIds.has(kubernetesRef.resourceId)) {
        return {
          isValid: true,
          scopeInfo: {
            foundInScope: scope.contextId,
            scopeDepth: scope.depth,
          },
        };
      }

      // Check merged resources from nested compositions
      if (scope.mergedResourceIds?.includes(kubernetesRef.resourceId)) {
        return {
          isValid: true,
          scopeInfo: {
            foundInScope: scope.contextId,
            scopeDepth: scope.depth,
          },
        };
      }

      scope = scope.parentScope;
    }

    return {
      isValid: false,
      error: `Resource '${kubernetesRef.resourceId}' is not accessible in the current composition scope hierarchy`,
    };
  }

  /**
   * Get nested composition statistics
   */
  getNestedCompositionStats(): {
    totalScopes: number;
    maxDepth: number;
    currentDepth: number;
    totalResources: number;
    resourcesByScope: Record<string, number>;
  } {
    const currentScope = this.getCurrentScope();
    const stats = {
      totalScopes: this.scopeRegistry.size,
      maxDepth: 0,
      currentDepth: currentScope?.depth || 0,
      totalResources: 0,
      resourcesByScope: {} as Record<string, number>,
    };

    for (const [contextId, scope] of this.scopeRegistry) {
      stats.maxDepth = Math.max(stats.maxDepth, scope.depth);
      stats.totalResources += scope.resourceIds.size;
      stats.resourcesByScope[contextId] = scope.resourceIds.size;

      if (scope.mergedResourceIds) {
        stats.totalResources += scope.mergedResourceIds.length;
      }
    }

    return stats;
  }
}

/**
 * Integration hooks for kubernetesComposition API
 */
export class CompositionIntegrationHooks {
  private analyzer: CompositionExpressionAnalyzer;
  private contextTracker: CompositionContextTracker;
  private scopeManager: MagicProxyScopeManager;

  constructor() {
    this.analyzer = new CompositionExpressionAnalyzer();
    this.contextTracker = new CompositionContextTracker();
    this.scopeManager = new MagicProxyScopeManager();
  }

  /**
   * Hook called before composition execution to set up expression analysis
   */
  beforeCompositionExecution<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
    compositionFn: (spec: TSpec) => MagicAssignableShape<TStatus>,
    schemaProxy: SchemaProxy<TSpec, TStatus>,
    contextId: string
  ): void {
    // Enter the composition scope
    this.scopeManager.enterScope(contextId, schemaProxy);

    // Pre-analyze the composition for optimization opportunities
    try {
      const analysisResult = this.analyzer.analyzeCompositionFunction(compositionFn, schemaProxy);

      // Store analysis result for later use during serialization
      if (analysisResult.requiresCelConversion) {
        console.debug(
          `Composition ${contextId} requires CEL conversion: ${analysisResult.conversionMetadata.kubernetesRefsDetected} KubernetesRef objects detected`
        );
      }
    } catch (error) {
      // Non-fatal error - composition can continue without pre-analysis
      console.warn(
        `Composition pre-analysis failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Hook called after composition execution to process results
   */
  afterCompositionExecution<TStatus extends KroCompatibleType>(
    statusShape: MagicAssignableShape<TStatus>,
    factoryType: 'direct' | 'kro' = 'kro',
    context?: CompositionContext
  ): MagicAssignableShape<TStatus> {
    try {
      // Track the composition context if provided
      if (context) {
        const trackingResult = this.contextTracker.trackCompositionContext(context);

        if (trackingResult.crossResourceReferences.length > 0) {
          console.debug(
            `Composition has ${trackingResult.crossResourceReferences.length} cross-resource references that may require CEL conversion`
          );
        }
      }

      // Process the status shape
      const processedStatus = this.analyzer.processCompositionStatus(statusShape, factoryType);

      return processedStatus;
    } finally {
      // Exit the composition scope
      this.scopeManager.exitScope();
    }
  }

  /**
   * Hook called during resource creation to analyze KubernetesRef usage
   */
  onResourceCreation(
    resourceId: string,
    resource: Enhanced<unknown, unknown>,
    _context?: CompositionContext
  ): void {
    // Register the resource in the current scope
    this.scopeManager.registerResource(resourceId);

    // Analyze KubernetesRef usage
    const refs =
      this.contextTracker.getCachedResourceKubernetesRefs(resourceId) ||
      this.contextTracker.extractKubernetesRefsFromResource(resource);

    if (refs.length > 0) {
      console.debug(
        `Resource ${resourceId} contains ${refs.length} KubernetesRef objects that may require CEL conversion`
      );

      // Validate scope for each KubernetesRef
      for (const ref of refs) {
        const validation = this.scopeManager.validateKubernetesRefScope(ref);
        if (!validation.isValid) {
          console.warn(
            `KubernetesRef validation failed for resource ${resourceId}: ${validation.error}`
          );
        }
      }
    }
  }

  /**
   * Get the current magic proxy scope manager
   */
  getScopeManager(): MagicProxyScopeManager {
    return this.scopeManager;
  }

  /**
   * Get the context tracker
   */
  getContextTracker(): CompositionContextTracker {
    return this.contextTracker;
  }

  /**
   * Handle auto-registration of resources with KubernetesRef tracking
   */
  handleAutoRegistration(
    resourceId: string,
    resource: Enhanced<unknown, unknown>,
    context: CompositionContext
  ): void {
    // Register the resource in the current scope
    this.scopeManager.registerResource(resourceId);

    // Track KubernetesRef objects in the auto-registered resource
    const refs = this.contextTracker.extractKubernetesRefsFromResource(resource);

    if (refs.length > 0) {
      // Validate that all referenced resources are accessible
      for (const ref of refs) {
        const validation = this.scopeManager.validateKubernetesRefScope(ref);

        if (!validation.isValid) {
          console.warn(
            `Auto-registered resource '${resourceId}' contains invalid KubernetesRef: ${validation.error}`
          );
        }
      }

      // Cache the KubernetesRef objects for later use
      this.contextTracker.resourceKubernetesRefCache.set(resourceId, refs);
    }

    // Update the composition context
    context.addResource(resourceId, resource);
  }

  /**
   * Handle side-effect based resource creation with magic proxy integration
   */
  handleSideEffectCreation<T extends Enhanced<unknown, unknown>>(
    resourceFactory: () => T,
    resourceId?: string,
    context?: CompositionContext
  ): T {
    const activeContext = context || getCurrentCompositionContext();

    if (!activeContext) {
      // No active composition context - create resource normally
      return resourceFactory();
    }

    // Track resources before creation
    const resourcesBefore = new Set(Object.keys(activeContext.resources));

    // Create the resource
    const resource = resourceFactory();

    // Determine the actual resource ID
    const actualResourceId = resourceId || this.generateResourceIdFromResource(resource);

    // Check if new resources were created as side effects
    const resourcesAfter = Object.keys(activeContext.resources);
    const newResources = resourcesAfter.filter((id) => !resourcesBefore.has(id));

    // Handle each new resource
    for (const newResourceId of newResources) {
      const newResource = activeContext.resources[newResourceId];
      if (newResource) {
        this.handleAutoRegistration(newResourceId, newResource, activeContext);
      }
    }

    // Handle the main resource if it wasn't already registered
    if (!activeContext.resources[actualResourceId]) {
      this.handleAutoRegistration(actualResourceId, resource, activeContext);
    }

    return resource;
  }

  /**
   * Track magic proxy usage during composition execution
   */
  trackMagicProxyUsage(proxyAccess: {
    resourceId: string;
    fieldPath: string;
    accessType: 'read' | 'write';
    value?: unknown;
  }): void {
    const currentScope = this.scopeManager.getCurrentScope();

    if (!currentScope) {
      return;
    }

    // Validate that the accessed resource is in scope
    if (
      proxyAccess.resourceId !== '__schema__' &&
      !this.scopeManager.isResourceAccessible(proxyAccess.resourceId)
    ) {
      console.warn(
        `Magic proxy access to out-of-scope resource: ${proxyAccess.resourceId}.${proxyAccess.fieldPath}`
      );
    }

    // Track KubernetesRef creation from magic proxy access
    if (proxyAccess.accessType === 'read' && isKubernetesRef(proxyAccess.value)) {
      const validation = this.scopeManager.validateKubernetesRefScope(
        proxyAccess.value as KubernetesRef<unknown>
      );

      if (!validation.isValid) {
        console.warn(`Magic proxy created invalid KubernetesRef: ${validation.error}`);
      }
    }
  }

  /**
   * Ensure compatibility with existing factory functions
   */
  ensureFactoryCompatibility<T extends Enhanced<unknown, unknown>>(
    factoryFn: () => T,
    factoryName: string
  ): T {
    const currentScope = this.scopeManager.getCurrentScope();

    if (!currentScope) {
      // No active composition - use factory normally
      return factoryFn();
    }

    try {
      // Execute factory with side-effect tracking
      return this.handleSideEffectCreation(factoryFn, undefined, getCurrentCompositionContext());
    } catch (error) {
      console.error(
        `Factory function '${factoryName}' failed in composition context: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Generate a resource ID from a resource object
   */
  private generateResourceIdFromResource(resource: Enhanced<unknown, unknown>): string {
    // Try to extract ID from common resource properties
    const resourceObj = resource as any;

    if (resourceObj.__resourceId) {
      return resourceObj.__resourceId;
    }

    if (resourceObj.metadata?.name) {
      const kind = resourceObj.kind || 'resource';
      return `${kind.toLowerCase()}-${resourceObj.metadata.name}`;
    }

    if (resourceObj.kind) {
      return `${resourceObj.kind.toLowerCase()}-${Date.now()}`;
    }

    return `resource-${Date.now()}`;
  }
}

/**
 * Global composition integration instance
 */
export const compositionIntegration = new CompositionIntegrationHooks();

/**
 * Utility function to check if a composition function uses KubernetesRef objects
 */
export function compositionUsesKubernetesRefs<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  compositionFn: (spec: TSpec) => MagicAssignableShape<TStatus>,
  schemaProxy: SchemaProxy<TSpec, TStatus>
): boolean {
  const analyzer = new CompositionExpressionAnalyzer();

  try {
    const result = analyzer.analyzeCompositionFunction(compositionFn, schemaProxy);
    return result.requiresCelConversion;
  } catch {
    // If analysis fails, assume it might use KubernetesRef objects to be safe
    return true;
  }
}

/**
 * Utility function to get composition analysis metadata
 */
export function getCompositionAnalysis<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  compositionFn: (spec: TSpec) => MagicAssignableShape<TStatus>,
  schemaProxy: SchemaProxy<TSpec, TStatus>
): CompositionAnalysisResult<TStatus> {
  const analyzer = new CompositionExpressionAnalyzer();
  return analyzer.analyzeCompositionFunction(compositionFn, schemaProxy);
}
