/**
 * Context-Aware Resource Tracking for Composition Integration
 *
 * Tracks KubernetesRef usage across composition contexts, providing caching
 * and cross-resource reference analysis.
 */

import { extractResourceReferences } from '../../../utils/type-guards.js';
import type { CompositionContext } from '../../composition/context.js';
import type { KubernetesRef } from '../../types/common.js';
import type { KroCompatibleType } from '../../types/serialization.js';
import type { Enhanced } from '../../types.js';
import type { CompositionAnalysisResult } from './types.js';

/**
 * Context-aware resource tracking for composition integration
 */
export class CompositionContextTracker {
  private contextAnalysisCache = new Map<string, CompositionAnalysisResult<KroCompatibleType>>();
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

  /** Delegate to canonical implementation in type-guards.ts */
  public extractKubernetesRefsFromResource(
    resource: Enhanced<unknown, unknown>
  ): KubernetesRef<unknown>[] {
    return extractResourceReferences(resource);
  }
}
