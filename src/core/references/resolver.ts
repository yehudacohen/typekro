/**
 * Reference Resolution System
 *
 * Resolves KubernetesRef and CelExpression objects by querying the Kubernetes API
 * and evaluating expressions against the current resource state.
 */

import type * as k8s from '@kubernetes/client-node';
import { isCelExpression, isKubernetesRef } from '../../utils/index.js';
import { getComponentLogger } from '../logging/index.js';
import type { ResolutionContext } from '../types/deployment.js';
import type { CelEvaluationContext } from '../types/references.js';
import type { CelExpression, DeployedResource, KubernetesRef } from '../types.js';
import { CelEvaluator } from './cel-evaluator.js';

export class ReferenceResolver {
  private cache = new Map<string, any>();
  private celEvaluator: CelEvaluator;
  private logger = getComponentLogger('reference-resolver');

  constructor(
    _kubeClient: k8s.KubeConfig,
    _k8sApi?: k8s.KubernetesObjectApi
  ) {
    // Note: k8sApi parameter is kept for backward compatibility but not currently used
    // In the future, this will be used for cluster resource querying
    this.celEvaluator = new CelEvaluator();
  }

  /**
   * Resolve all references in a resource
   */
  async resolveReferences(resource: any, context: ResolutionContext): Promise<any> {
    // Quick check - if there are no references, return the resource as-is
    if (!this.hasReferences(resource)) {
      return resource;
    }

    // Deep clone the resource to avoid modifying the original
    // JSON.stringify/parse properly handles Enhanced proxies by triggering all getters
    const resolved = JSON.parse(JSON.stringify(resource));
    
    // Preserve non-enumerable properties like readiness evaluators
    if (resource.readinessEvaluator && typeof resource.readinessEvaluator === 'function') {
      Object.defineProperty(resolved, 'readinessEvaluator', {
        value: resource.readinessEvaluator,
        enumerable: false,
        configurable: false,
        writable: false
      });
    }

    await this.traverseAndResolve(resolved, context);
    return resolved;
  }



  /**
   * Quick check if a resource has any references
   */
  private hasReferences(obj: any, visited = new Set<any>()): boolean {
    if (obj === null || obj === undefined) {
      return false;
    }

    // Prevent infinite loops from circular references
    if (visited.has(obj)) {
      return false;
    }

    if (isKubernetesRef(obj) || isCelExpression(obj)) {
      return true;
    }

    if (Array.isArray(obj)) {
      visited.add(obj);
      const result = obj.some((item) => this.hasReferences(item, visited));
      visited.delete(obj);
      return result;
    }

    if (typeof obj === 'object') {
      visited.add(obj);
      const result = Object.values(obj).some((value) => this.hasReferences(value, visited));
      visited.delete(obj);
      return result;
    }

    return false;
  }

  /**
   * Recursively traverse and resolve references
   */
  private async traverseAndResolve(
    obj: any,
    context: ResolutionContext,
    visited = new Set<any>()
  ): Promise<any> {
    if (obj === null || obj === undefined) {
      return obj;
    }

    // Prevent infinite loops from circular references
    if (visited.has(obj)) {
      return obj;
    }

    if (isKubernetesRef(obj)) {
      // Replace with resolved value
      return await this.resolveKubernetesRef(obj, context);
    }

    if (isCelExpression(obj)) {
      // Evaluate CEL expression
      return await this.evaluateCelExpression(obj, context);
    }

    if (Array.isArray(obj)) {
      visited.add(obj);
      for (let i = 0; i < obj.length; i++) {
        obj[i] = await this.traverseAndResolve(obj[i], context, visited);
      }
      visited.delete(obj);
      return obj;
    }

    if (typeof obj === 'object') {
      visited.add(obj);
      for (const [key, value] of Object.entries(obj)) {
        obj[key] = await this.traverseAndResolve(value, context, visited);
      }
      visited.delete(obj);
      return obj;
    }

    return obj;
  }

  /**
   * Resolve a KubernetesRef to its actual value
   */
  private async resolveKubernetesRef(ref: KubernetesRef, context: ResolutionContext): Promise<any> {
    // Check cache first
    const cacheKey = `${ref.resourceId}.${ref.fieldPath}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // First check if resource is in our deployment context
    const deployedResource = this.findDeployedResource(ref.resourceId, context);
    if (deployedResource) {
      const value = this.extractFieldValue(deployedResource.manifest, ref.fieldPath);
      this.cache.set(cacheKey, value);
      return value;
    }

    // Otherwise query from cluster
    try {
      const resource = await this.queryResourceFromCluster(ref, context);
      const value = this.extractFieldValue(resource, ref.fieldPath);
      this.cache.set(cacheKey, value);
      return value;
    } catch (error) {
      throw new ReferenceResolutionError(ref, error as Error);
    }
  }

  /**
   * Evaluate a CEL expression using the proper CEL evaluator
   */
  private async evaluateCelExpression(
    expr: CelExpression,
    context: ResolutionContext
  ): Promise<any> {
    // Check cache first
    const cacheKey = `cel:${expr.expression}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      // Build the resources map for CEL evaluation
      const resourcesMap = new Map<string, any>();

      // Add deployed resources to the map
      for (const deployedResource of context.deployedResources) {
        resourcesMap.set(deployedResource.id, deployedResource.manifest);
      }

      // Create CEL evaluation context
      const celContext: CelEvaluationContext = {
        resources: resourcesMap,
        variables: {
          // Add any additional variables if needed
        },
      };

      // Use the proper CEL evaluator
      const result = await this.celEvaluator.evaluate(expr, celContext);
      this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      throw new CelExpressionError(expr, error as Error);
    }
  }

  /**
   * Find a deployed resource by ID
   */
  private findDeployedResource(
    resourceId: string,
    context: ResolutionContext
  ): DeployedResource | undefined {
    return context.deployedResources.find((r) => r.id === resourceId);
  }

  /**
   * Query a resource from the Kubernetes cluster
   */
  private async queryResourceFromCluster(
    _ref: KubernetesRef,
    _context: ResolutionContext
  ): Promise<any> {
    // For now, we'll need to infer the resource details from the resourceId
    // In a real implementation, we'd need a registry of resource types

    // This is a simplified implementation - in practice, we'd need more sophisticated
    // resource discovery based on the resourceId
    throw new Error(`Cluster resource querying not yet implemented`);
  }

  /**
   * Extract a field value from an object using dot notation
   */
  private extractFieldValue(obj: any, fieldPath: string): any {
    const parts = fieldPath.split('.');
    let current = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }

      // Handle array indices
      if (part.includes('[') && part.includes(']')) {
        const [field, indexStr] = part.split('[');
        if (!indexStr) {
          return undefined;
        }
        const index = parseInt(indexStr.replace(']', ''), 10);

        if (field) {
          current = current[field];
        }

        if (Array.isArray(current) && !Number.isNaN(index)) {
          current = current[index];
        } else {
          return undefined;
        }
      } else {
        current = current[part];
      }
    }

    return current;
  }

  /**
   * Wait for a resource to be ready
   */
  async waitForResourceReady(resourceRef: KubernetesRef, timeout: number = 30000): Promise<any> {
    const startTime = Date.now();
    const readinessLogger = this.logger.child({ resourceId: resourceRef.resourceId });

    while (Date.now() - startTime < timeout) {
      try {
        // This would query the actual resource and check its readiness
        // For now, we'll simulate this
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // In a real implementation, we'd check resource-specific readiness conditions
        // For example, for a Deployment, we'd check status.readyReplicas

        return true; // Simulate success
      } catch (error) {
        // Continue polling on error
        readinessLogger.warn('Waiting for resource readiness', error as Error);
      }
    }

    throw new ResourceReadinessTimeoutError(resourceRef, timeout);
  }

  /**
   * Clear the resolution cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

// Error classes
export class ReferenceResolutionError extends Error {
  constructor(ref: KubernetesRef, cause: Error) {
    super(`Failed to resolve reference ${ref.resourceId}.${ref.fieldPath}: ${cause.message}`);
    this.name = 'ReferenceResolutionError';
    this.cause = cause;
  }
}

export class CelExpressionError extends Error {
  constructor(expr: CelExpression, cause: Error) {
    super(`Failed to evaluate CEL expression '${expr.expression}': ${cause.message}`);
    this.name = 'CelExpressionError';
    this.cause = cause;
  }
}

export class ResourceReadinessTimeoutError extends Error {
  constructor(ref: KubernetesRef, timeout: number) {
    super(
      `Timeout after ${timeout}ms waiting for resource ${ref.resourceId}.${ref.fieldPath} to be ready`
    );
    this.name = 'ResourceReadinessTimeoutError';
  }
}
