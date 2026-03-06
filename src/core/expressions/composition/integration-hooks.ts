/**
 * Integration Hooks for kubernetesComposition API
 *
 * Provides lifecycle hooks for composition execution, integrating expression analysis,
 * context tracking, scope management, and KubernetesRef validation.
 */

import { isKubernetesRef } from '../../../utils/type-guards.js';
import type { CompositionContext } from '../../composition/context.js';
import { getCurrentCompositionContext } from '../../composition/context.js';
import { getComponentLogger } from '../../logging/index.js';
import type { KubernetesRef } from '../../types/common.js';
import type {
  KroCompatibleType,
  MagicAssignableShape,
  SchemaProxy,
} from '../../types/serialization.js';
import type { Enhanced } from '../../types.js';
import { hasResourceId } from '../../types.js';
import { CompositionContextTracker } from './context-tracker.js';
import { CompositionExpressionAnalyzer } from './expression-analyzer.js';
import { MagicProxyScopeManager } from './scope-manager.js';

/**
 * Integration hooks for kubernetesComposition API
 */
export class CompositionIntegrationHooks {
  private analyzer: CompositionExpressionAnalyzer;
  private contextTracker: CompositionContextTracker;
  private scopeManager: MagicProxyScopeManager;
  private logger = getComponentLogger('composition-integration');

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
        this.logger.debug(`Composition requires CEL conversion`, {
          contextId,
          kubernetesRefsDetected: analysisResult.conversionMetadata.kubernetesRefsDetected,
        });
      }
    } catch (error: unknown) {
      // Non-fatal error - composition can continue without pre-analysis
      this.logger.warn('Composition pre-analysis failed (non-fatal)', {
        error: error instanceof Error ? error.message : String(error),
      });
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
          this.logger.debug('Cross-resource references detected', {
            count: trackingResult.crossResourceReferences.length,
          });
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
      this.logger.debug('Resource contains KubernetesRef objects', {
        resourceId,
        refCount: refs.length,
      });

      // Validate scope for each KubernetesRef
      for (const ref of refs) {
        const validation = this.scopeManager.validateKubernetesRefScope(ref);
        if (!validation.isValid) {
          this.logger.warn('KubernetesRef validation failed', {
            resourceId,
            error: validation.error,
          });
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
          this.logger.warn('Auto-registered resource contains invalid KubernetesRef', {
            resourceId,
            error: validation.error,
          });
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
      this.logger.warn('Magic proxy access to out-of-scope resource', {
        resourceId: proxyAccess.resourceId,
        fieldPath: proxyAccess.fieldPath,
      });
    }

    // Track KubernetesRef creation from magic proxy access
    if (proxyAccess.accessType === 'read' && isKubernetesRef(proxyAccess.value)) {
      const validation = this.scopeManager.validateKubernetesRefScope(
        proxyAccess.value as KubernetesRef<unknown>
      );

      if (!validation.isValid) {
        this.logger.warn('Magic proxy created invalid KubernetesRef', { error: validation.error });
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
    } catch (error: unknown) {
      this.logger.error(
        'Factory function failed in composition context',
        error instanceof Error ? error : undefined,
        { factoryName }
      );
      throw error;
    }
  }

  /**
   * Generate a resource ID from a resource object
   */
  private generateResourceIdFromResource(resource: Enhanced<unknown, unknown>): string {
    // Try to extract ID from common resource properties
    if (hasResourceId(resource) && resource.__resourceId) {
      return resource.__resourceId;
    }

    if (resource.metadata?.name) {
      const kind = resource.kind || 'resource';
      return `${kind.toLowerCase()}-${String(resource.metadata.name)}`;
    }

    if (resource.kind) {
      return `${String(resource.kind).toLowerCase()}-${Date.now()}`;
    }

    return `resource-${Date.now()}`;
  }
}

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
  } catch (error: unknown) {
    // If analysis fails, assume it might use KubernetesRef objects to be safe
    const logger = getComponentLogger('composition-integration');
    logger.debug('Composition analysis failed, assuming KubernetesRef usage', { err: error });
    return true;
  }
}
