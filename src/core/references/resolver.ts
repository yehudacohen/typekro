/**
 * Reference Resolution System
 *
 * Resolves KubernetesRef and CelExpression objects by querying the Kubernetes API
 * and evaluating expressions against the current resource state.
 */

import * as k8s from '@kubernetes/client-node';
import { isCelExpression, isKubernetesRef } from '../../utils/index.js';
import { ResourceReadinessChecker } from '../deployment/readiness.js';
import { getComponentLogger } from '../logging/index.js';
import type { ResolutionContext } from '../types/deployment.js';
import { ResourceReadinessTimeoutError } from '../types/deployment.js';
import type { CelEvaluationContext } from '../types/references.js';
import type {
  CelExpression,
  DeployedResource,
  KubernetesRef,
  KubernetesResource,
} from '../types.js';
import { CelEvaluator } from './cel-evaluator.js';

// =============================================================================
// TYPE DEFINITIONS FOR IMPROVED TYPE SAFETY
// =============================================================================

/**
 * Structured resource identifier with proper typing
 */
interface ResourceIdentifier {
  readonly kind: string;
  readonly apiVersion: string;
  readonly name: string;
  readonly namespace?: string;
}

/**
 * Resource type information for inference
 */
interface ResourceTypeInfo {
  readonly kind: string;
  readonly apiVersion: string;
}

/**
 * Type-safe mapping of Kubernetes kinds to their default API versions
 */
type KubernetesKindMap = {
  readonly [K in string]: string;
};

/**
 * Cache statistics interface
 */
interface CacheStatistics {
  readonly size: number;
  readonly keys: readonly string[];
}

export const DeploymentMode = {
  KRO: 'kro',
  DIRECT: 'direct',
} as const;

export type DeploymentMode = (typeof DeploymentMode)[keyof typeof DeploymentMode];

export class ReferenceResolver {
  private cache = new Map<string, unknown>();
  private celEvaluator: CelEvaluator;
  private logger = getComponentLogger('reference-resolver');
  private kubeClient: k8s.KubeConfig;
  private k8sApi: k8s.KubernetesObjectApi;
  private deploymentMode: DeploymentMode;

  constructor(
    kubeClient: k8s.KubeConfig,
    deploymentMode: DeploymentMode = DeploymentMode.DIRECT,
    k8sApi?: k8s.KubernetesObjectApi
  ) {
    this.kubeClient = kubeClient;
    this.deploymentMode = deploymentMode;
    this.k8sApi = k8sApi || kubeClient.makeApiClient(k8s.KubernetesObjectApi);
    this.celEvaluator = new CelEvaluator();
  }

  /**
   * Resolve all references in a resource
   */
  async resolveReferences(resource: any, context: ResolutionContext): Promise<any> {
    // Quick check - if there are no references, return the resource as-is
    if (!this.hasReferences(resource)) {
      this.logger.trace('No references found in resource, returning as-is', {
        resourceId: resource.id,
      });
      return resource;
    }

    this.logger.trace('Cloning resource and resolving references', { resourceId: resource.id });
    // Deep clone the resource to avoid modifying the original
    // JSON.stringify/parse properly handles Enhanced proxies by triggering all getters
    const resolved = JSON.parse(JSON.stringify(resource));
    // Restore Symbol brands that were lost during JSON serialization
    this.restoreBrands(resolved);

    // FIX: Preserve the non-enumerable readinessEvaluator which is lost during JSON serialization.
    if (resource.readinessEvaluator && typeof resource.readinessEvaluator === 'function') {
      this.logger.trace('Preserving readiness evaluator on cloned resource', {
        resourceId: resource.id,
      });
      Object.defineProperty(resolved, 'readinessEvaluator', {
        value: resource.readinessEvaluator,
        enumerable: false,
        configurable: false,
        writable: false,
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
   * Restore Symbol brands that were lost during JSON serialization
   */
  private restoreBrands(obj: any, visited = new Set<any>()): void {
    if (obj === null || obj === undefined || typeof obj !== 'object') {
      return;
    }

    // Prevent infinite loops from circular references
    if (visited.has(obj)) {
      return;
    }

    // Check if this looks like a KubernetesRef (has resourceId and fieldPath)
    if (
      obj.resourceId &&
      obj.fieldPath &&
      typeof obj.resourceId === 'string' &&
      typeof obj.fieldPath === 'string'
    ) {
      // Restore the KubernetesRef brand
      Object.defineProperty(obj, Symbol.for('TypeKro.KubernetesRef'), {
        value: true,
        enumerable: false,
      });
    }

    // Check if this looks like a CelExpression (has expression property)
    if (obj.expression && typeof obj.expression === 'string') {
      // Restore the CelExpression brand
      Object.defineProperty(obj, Symbol.for('TypeKro.CelExpression'), {
        value: true,
        enumerable: false,
      });
    }

    // Recursively restore brands in nested objects
    if (Array.isArray(obj)) {
      visited.add(obj);
      for (const item of obj) {
        this.restoreBrands(item, visited);
      }
      visited.delete(obj);
    } else {
      visited.add(obj);
      for (const value of Object.values(obj)) {
        this.restoreBrands(value, visited);
      }
      visited.delete(obj);
    }
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
      // Handle CEL expressions based on deployment mode
      if (this.deploymentMode === DeploymentMode.KRO) {
        // In Kro mode, convert CEL expressions to CEL strings for Kro controller
        return this.convertCelExpressionToString(obj, context);
      } else {
        // In direct mode, evaluate CEL expressions locally
        return await this.evaluateCelExpression(obj, context);
      }
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
   * Resolve a KubernetesRef to its actual value or CEL string based on deployment mode
   */
  private async resolveKubernetesRef<T = unknown>(
    ref: KubernetesRef<T>,
    context: ResolutionContext
  ): Promise<T | string> {
    // In Kro mode, convert KubernetesRef to CEL string for Kro controller
    if (this.deploymentMode === DeploymentMode.KRO) {
      return this.convertKubernetesRefToString(ref, context);
    }

    // In direct mode, resolve the reference to actual value
    // Check cache first
    const cacheKey = `${ref.resourceId}.${ref.fieldPath}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) as T;
    }

    // First check if resource is in our deployment context
    const deployedResource = this.findDeployedResource(ref.resourceId, context);
    if (deployedResource) {
      const value = this.extractFieldValue<T>(deployedResource.manifest, ref.fieldPath);
      this.cache.set(cacheKey, value);
      return value as T;
    }

    // Otherwise query from cluster
    try {
      const resource = await this.queryResourceFromCluster(ref, context);
      const value = this.extractFieldValue<T>(resource, ref.fieldPath);
      this.cache.set(cacheKey, value);
      return value as T;
    } catch (error) {
      throw new ReferenceResolutionError(ref, error as Error);
    }
  }

  /**
   * Convert a KubernetesRef to a CEL string for Kro controller evaluation
   */
  private convertKubernetesRefToString(ref: KubernetesRef, context: ResolutionContext): string {
    this.logger.debug('Converting KubernetesRef to CEL string for Kro mode', {
      resourceId: ref.resourceId,
      fieldPath: ref.fieldPath,
      deploymentId: context.deploymentId,
    });

    // Convert KubernetesRef to Kro-compatible CEL string format
    // Format: ${resourceId.fieldPath}
    return `\${${ref.resourceId}.${ref.fieldPath}}`;
  }

  /**
   * Convert a CEL expression to a CEL string for Kro controller evaluation
   */
  private convertCelExpressionToString(expr: CelExpression, context: ResolutionContext): string {
    this.logger.debug('Converting CEL expression to string for Kro mode', {
      expression: expr.expression,
      deploymentId: context.deploymentId,
    });

    // Convert CEL expression to Kro-compatible CEL string format
    // The expression should be wrapped in ${...} for Kro
    return `\${${expr.expression}}`;
  }

  /**
   * Evaluate a CEL expression using runtime CEL evaluation
   *
   * This method performs ACTUAL CEL expression evaluation using the cel-js library.
   * It's only used in Direct mode deployment where TypeKro must resolve CEL expressions
   * to concrete values before creating Kubernetes manifests.
   *
   * In Kro mode, CEL expressions are converted to strings and evaluated by the Kro operator.
   */
  private async evaluateCelExpression<T = unknown>(
    expr: CelExpression<T>,
    context: ResolutionContext
  ): Promise<T> {
    // Check cache first
    const cacheKey = `cel:${expr.expression}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) as T;
    }

    try {
      // Build the resources map for CEL evaluation
      const resourcesMap = new Map<string, unknown>();

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
      return result as T;
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
  private async queryResourceFromCluster<T = unknown>(
    ref: KubernetesRef<T>,
    context: ResolutionContext
  ): Promise<KubernetesResource> {
    const queryLogger = this.logger.child({
      resourceId: ref.resourceId,
      fieldPath: ref.fieldPath,
    });

    try {
      // Parse the resource ID to extract resource information
      const resourceInfo = this.parseResourceId(ref.resourceId);
      queryLogger.debug('Parsed resource info', { resourceInfo });

      // Build the resource reference for the Kubernetes API
      const resourceRef: k8s.KubernetesObject = {
        apiVersion: resourceInfo.apiVersion,
        kind: resourceInfo.kind,
        metadata: {
          name: resourceInfo.name,
          namespace: resourceInfo.namespace || context.namespace || 'default',
        } as k8s.V1ObjectMeta,
      };

      queryLogger.debug('Querying cluster resource', { resourceRef });

      // Query the resource from the cluster
      const response = await this.k8sApi.read(resourceRef as any);
      const resource = response.body;

      queryLogger.debug('Successfully retrieved cluster resource', {
        resourceName: resource.metadata?.name,
        resourceKind: resource.kind,
      });

      // Convert k8s.KubernetesObject to our KubernetesResource type
      const kubernetesResource: KubernetesResource = {
        apiVersion: resource.apiVersion || '',
        kind: resource.kind || '',
        metadata: resource.metadata || {},
        spec: (resource as any).spec,
        status: (resource as any).status,
        ...(resource.metadata?.name && { id: resource.metadata.name }),
      };

      return kubernetesResource;
    } catch (error) {
      const k8sError = error as { statusCode?: number; message?: string };

      if (k8sError.statusCode === 404) {
        queryLogger.warn('Resource not found in cluster', {
          resourceId: ref.resourceId,
          error: k8sError.message,
        });
        throw new ReferenceResolutionError(
          ref,
          new Error(`Resource '${ref.resourceId}' not found in cluster`)
        );
      }

      queryLogger.error('Failed to query cluster resource', error as Error, {
        resourceId: ref.resourceId,
        statusCode: k8sError.statusCode,
      });

      throw new ReferenceResolutionError(
        ref,
        new Error(
          `Failed to query cluster resource '${ref.resourceId}': ${k8sError.message || error}`
        )
      );
    }
  }

  /**
   * Parse a resource ID to extract Kubernetes resource information
   * Supports formats like:
   * - "my-deployment" (assumes Deployment in apps/v1)
   * - "my-service" (assumes Service in v1)
   * - "my-configmap" (assumes ConfigMap in v1)
   * - Custom format: "kind:apiVersion:name" or "kind:name"
   */
  private parseResourceId(resourceId: string): ResourceIdentifier {
    // Handle custom format: "kind:apiVersion:name" or "kind:name"
    if (resourceId.includes(':')) {
      const parts = resourceId.split(':');
      if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
        return {
          kind: parts[0],
          apiVersion: parts[1],
          name: parts[2],
        };
      } else if (parts.length === 2 && parts[0] && parts[1]) {
        return {
          kind: parts[0],
          apiVersion: this.getDefaultApiVersion(parts[0]),
          name: parts[1],
        };
      }
    }

    // Infer resource type from common naming patterns
    const inferredType = this.inferResourceTypeFromName(resourceId);

    return {
      kind: inferredType.kind,
      apiVersion: inferredType.apiVersion,
      name: resourceId,
    };
  }

  /**
   * Infer Kubernetes resource type from resource name patterns
   */
  private inferResourceTypeFromName(name: string): ResourceTypeInfo {
    // Common naming patterns for different resource types
    if (name.includes('-deployment') || name.includes('-deploy')) {
      return { kind: 'Deployment', apiVersion: 'apps/v1' };
    }
    if (name.includes('-service') || name.includes('-svc')) {
      return { kind: 'Service', apiVersion: 'v1' };
    }
    if (name.includes('-configmap') || name.includes('-config')) {
      return { kind: 'ConfigMap', apiVersion: 'v1' };
    }
    if (name.includes('-secret')) {
      return { kind: 'Secret', apiVersion: 'v1' };
    }
    if (name.includes('-ingress')) {
      return { kind: 'Ingress', apiVersion: 'networking.k8s.io/v1' };
    }
    if (name.includes('-pvc') || name.includes('-volume')) {
      return { kind: 'PersistentVolumeClaim', apiVersion: 'v1' };
    }
    if (name.includes('-job')) {
      return { kind: 'Job', apiVersion: 'batch/v1' };
    }
    if (name.includes('-cronjob')) {
      return { kind: 'CronJob', apiVersion: 'batch/v1' };
    }

    // Default to Deployment if no pattern matches
    return { kind: 'Deployment', apiVersion: 'apps/v1' };
  }

  /**
   * Get default API version for a given Kubernetes kind
   */
  private getDefaultApiVersion(kind: string): string {
    const defaultApiVersions: KubernetesKindMap = {
      Pod: 'v1',
      Service: 'v1',
      ConfigMap: 'v1',
      Secret: 'v1',
      Namespace: 'v1',
      PersistentVolumeClaim: 'v1',
      PersistentVolume: 'v1',
      Deployment: 'apps/v1',
      StatefulSet: 'apps/v1',
      DaemonSet: 'apps/v1',
      ReplicaSet: 'apps/v1',
      Job: 'batch/v1',
      CronJob: 'batch/v1',
      Ingress: 'networking.k8s.io/v1',
      NetworkPolicy: 'networking.k8s.io/v1',
      ServiceAccount: 'v1',
      Role: 'rbac.authorization.k8s.io/v1',
      RoleBinding: 'rbac.authorization.k8s.io/v1',
      ClusterRole: 'rbac.authorization.k8s.io/v1',
      ClusterRoleBinding: 'rbac.authorization.k8s.io/v1',
      HorizontalPodAutoscaler: 'autoscaling/v2',
      CustomResourceDefinition: 'apiextensions.k8s.io/v1',
    } as const;

    return defaultApiVersions[kind] ?? 'v1';
  }

  /**
   * Extract a field value from an object using dot notation
   */
  private extractFieldValue<T = unknown>(obj: unknown, fieldPath: string): T | undefined {
    const parts = fieldPath.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }

      // Type guard to ensure we can access properties
      if (typeof current !== 'object') {
        return undefined;
      }

      const currentObj = current as Record<string, unknown>;

      // Handle array indices
      if (part.includes('[') && part.includes(']')) {
        const [field, indexStr] = part.split('[');
        if (!indexStr) {
          return undefined;
        }
        const index = parseInt(indexStr.replace(']', ''), 10);

        if (field) {
          current = currentObj[field];
        }

        if (
          Array.isArray(current) &&
          !Number.isNaN(index) &&
          index >= 0 &&
          index < current.length
        ) {
          current = current[index];
        } else {
          return undefined;
        }
      } else {
        current = currentObj[part];
      }
    }

    return current as T;
  }

  /**
   * Wait for a resource to be ready
   */
  async waitForResourceReady<T = unknown>(
    resourceRef: KubernetesRef<T>,
    timeout: number = 30000
  ): Promise<boolean> {
    const readinessLogger = this.logger.child({ resourceId: resourceRef.resourceId });

    try {
      // First, query the resource from the cluster to get its current state
      const resource = await this.queryResourceFromCluster(resourceRef, {
        deployedResources: [],
        kubeClient: this.kubeClient,
        timeout,
      });

      // Create a DeployedResource object for the readiness checker
      const deployedResource: DeployedResource = {
        id: resourceRef.resourceId,
        kind: resource.kind || 'Unknown',
        name: resource.metadata?.name || resourceRef.resourceId,
        namespace: resource.metadata?.namespace || 'default',
        manifest: resource,
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Use the existing ResourceReadinessChecker for actual readiness checking
      const readinessChecker = new ResourceReadinessChecker(this.k8sApi);

      // Create deployment options for the readiness checker
      const deploymentOptions = {
        mode: 'direct' as const,
        timeout,
      };

      // Use the real readiness checker instead of simulation
      await readinessChecker.waitForResourceReady(deployedResource, deploymentOptions, (event) => {
        readinessLogger.debug('Readiness check progress', {
          type: event.type,
          message: event.message,
        });
      });

      readinessLogger.info('Resource is ready', {
        resourceId: resourceRef.resourceId,
        kind: resource.kind,
        name: resource.metadata?.name,
      });

      return true;
    } catch (error) {
      readinessLogger.error('Resource readiness check failed', error as Error, {
        resourceId: resourceRef.resourceId,
        timeout,
      });

      if (error instanceof ResourceReadinessTimeoutError) {
        throw error;
      }

      // Create a minimal DeployedResource for the error
      const errorResource: DeployedResource = {
        id: resourceRef.resourceId,
        kind: 'Unknown',
        name: resourceRef.resourceId,
        namespace: 'default',
        manifest: {} as any,
        status: 'failed',
        deployedAt: new Date(),
      };
      throw new ResourceReadinessTimeoutError(errorResource, timeout);
    }
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
  getCacheStats(): CacheStatistics {
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
