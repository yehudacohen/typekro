import type * as k8s from '@kubernetes/client-node';
import { getComponentLogger } from '../logging/index.js';
import type { DeployedResource, Enhanced, KubernetesResource } from '../types.js';

/**
 * Options for status hydration
 */
export interface StatusHydrationOptions {
  /** Enable caching of status queries to reduce API calls */
  enableCaching?: boolean;
  /** Cache TTL in milliseconds */
  cacheTtl?: number;
  /** Maximum number of retries for failed status queries */
  maxRetries?: number;
  /** Timeout for individual status queries in milliseconds */
  queryTimeout?: number;
}

/**
 * Cache entry for status data
 */
interface StatusCacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

/**
 * StatusHydrator populates Enhanced proxy status fields with live cluster data
 * after resources are confirmed ready by ResourceReadinessChecker
 */
export class StatusHydrator {
  private statusCache = new Map<string, StatusCacheEntry<unknown>>();
  private readonly defaultOptions: Required<StatusHydrationOptions> = {
    enableCaching: true,
    cacheTtl: 30000, // 30 seconds
    maxRetries: 3,
    queryTimeout: 10000, // 10 seconds
  };

  private mergedOptions: Required<StatusHydrationOptions>;
  private logger = getComponentLogger('status-hydrator');

  constructor(
    private k8sApi: k8s.KubernetesObjectApi,
    options: StatusHydrationOptions = {}
  ) {
    this.mergedOptions = { ...this.defaultOptions, ...options };
  }

  /**
   * Hydrate status fields for a single resource
   */
  async hydrateStatus<TSpec, TStatus extends Record<string, unknown>>(
    enhanced: Enhanced<TSpec, TStatus>,
    deployedResource?: DeployedResource
  ): Promise<{ success: boolean; resourceId: string; hydratedFields: string[]; error?: Error }> {
    try {
      const resourceId = enhanced.metadata?.name || 'unknown';
      const hydratedFields: string[] = [];

      // Create a DeployedResource from Enhanced if not provided
      const resource = deployedResource || {
        id: resourceId,
        kind: enhanced.kind || 'Unknown',
        name: resourceId,
        namespace: enhanced.metadata?.namespace || 'default',
        manifest: enhanced as KubernetesResource,
        status: 'deployed' as const,
        deployedAt: new Date(),
      };

      const cacheKey = this.getCacheKey(resource);

      // Check cache first if enabled
      if (this.mergedOptions.enableCaching) {
        const cached = this.getFromCache<TStatus>(cacheKey);
        if (cached) {
          // Populate Enhanced proxy with cached data
          this.populateEnhancedStatus(enhanced, cached, hydratedFields);
          return { success: true, resourceId, hydratedFields };
        }
      }

      // Query live status from cluster
      const liveStatus = await this.queryResourceStatus(resource);

      if (!liveStatus) {
        return {
          success: false,
          resourceId,
          hydratedFields: [],
          error: new Error('Resource not found'),
        };
      }

      // Extract status data
      const status = liveStatus.status as TStatus;

      if (!status) {
        return {
          success: false,
          resourceId,
          hydratedFields: [],
          error: new Error('No status found'),
        };
      }

      // Populate Enhanced proxy with live status data
      this.populateEnhancedStatus(enhanced, status, hydratedFields);

      // Cache the result
      if (this.mergedOptions.enableCaching) {
        this.setCache(cacheKey, status);
      }

      return { success: true, resourceId, hydratedFields };
    } catch (error) {
      const resourceId = enhanced.metadata?.name || 'unknown';
      this.logger.error('Failed to hydrate status', error as Error, { resourceId });
      return {
        success: false,
        resourceId,
        hydratedFields: [],
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Hydrate status using already-fetched live resource data
   * This method is used by DirectDeploymentEngine to avoid duplicate API calls
   */
  async hydrateStatusFromLiveData<TSpec, TStatus>(
    enhanced: Enhanced<TSpec, TStatus>,
    liveResourceData: KubernetesResource<TSpec, TStatus>,
    deployedResource: DeployedResource
  ): Promise<{ success: boolean; resourceId: string; hydratedFields: string[]; error?: Error }> {
    try {
      const resourceId = enhanced.metadata?.name || 'unknown';
      const hydratedFields: string[] = [];

      // Extract status data from pre-fetched live resource
      const status = liveResourceData.status;

      if (!status) {
        return {
          success: false,
          resourceId,
          hydratedFields: [],
          error: new Error('No status found'),
        };
      }

      // Populate Enhanced proxy with live status data
      this.populateEnhancedStatus(enhanced, status, hydratedFields);

      // Cache the result if caching is enabled
      if (this.mergedOptions.enableCaching) {
        const cacheKey = this.getCacheKey(deployedResource);
        this.setCache(cacheKey, status);
      }

      return { success: true, resourceId, hydratedFields };
    } catch (error) {
      const resourceId = enhanced.metadata?.name || 'unknown';
      return {
        success: false,
        resourceId,
        hydratedFields: [],
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Populate Enhanced proxy status fields with live data
   */
  private populateEnhancedStatus<TSpec, TStatus extends Record<string, unknown>>(
    enhanced: Enhanced<TSpec, TStatus>,
    status: TStatus,
    hydratedFields: string[]
  ): void {
    const resourceId =
      (enhanced as { __resourceId?: string }).__resourceId || enhanced.metadata?.name || 'unknown';
    const statusLogger = this.logger.child({ resourceId });

    statusLogger.debug('Populating enhanced status', {
      hasStatus: !!enhanced.status,
      statusFields: Object.keys(status || {}),
    });

    // Use type assertion to access the internal status object
    const statusProxy = enhanced.status as Record<string, unknown>;

    // Get all keys from the live status object
    const allLiveStatusKeys = Object.keys(status || {});

    for (const field of allLiveStatusKeys) {
      // Check if the field exists on the live status
      if (status[field] !== undefined) {
        try {
          // Assign the value directly to the proxy.
          // The proxy's setter will handle it.
          statusProxy[field] = status[field];
          hydratedFields.push(field);
          statusLogger.debug('Status field hydrated', { field, value: status[field] });
        } catch (error) {
          statusLogger.debug('Failed to set status field', {
            field,
            error: (error as Error).message,
          });
        }
      }
    }
  }

  /**
   * Hydrate all status fields in an Enhanced proxy
   */
  async hydrateEnhancedProxy<TSpec, TStatus>(
    enhancedProxy: Enhanced<TSpec, TStatus>,
    deployedResources: DeployedResource[]
  ): Promise<void> {
    const proxyName = enhancedProxy.metadata?.name || 'unknown';
    const proxyLogger = this.logger.child({ proxyName });

    try {
      // Find the primary resource for this Enhanced proxy
      const primaryResource = deployedResources.find(
        (r) => r.id === enhancedProxy.metadata?.name || r.name === enhancedProxy.metadata?.name
      );

      if (!primaryResource) {
        proxyLogger.warn('No deployed resource found for Enhanced proxy');
        return;
      }

      // Hydrate the primary resource status
      const result = await this.hydrateStatus(enhancedProxy, primaryResource);

      if (!result.success) {
        proxyLogger.warn('Status hydration failed', { error: result.error?.message });
      }
    } catch (error) {
      proxyLogger.error('Failed to hydrate Enhanced proxy status', error as Error);
    }
  }

  /**
   * Query live resource status from the cluster
   */
  private async queryResourceStatus(
    deployedResource: DeployedResource
  ): Promise<KubernetesResource | null> {
    const { manifest, kind, name, namespace } = deployedResource;
    const { apiVersion } = manifest;
    const queryLogger = this.logger.child({ kind, name, namespace });

    if (!name || !namespace) {
      queryLogger.warn('Invalid resource metadata for status query', {
        resourceId: deployedResource.id,
      });
      return null;
    }

    try {
      // Use the Kubernetes API to get the current resource state
      const response = await this.k8sApi.read({
        apiVersion,
        kind,
        metadata: {
          name,
          namespace,
        },
      });

      return response.body as KubernetesResource;
    } catch (error: unknown) {
      const apiError = error as { statusCode?: number };
      if (apiError.statusCode === 404) {
        queryLogger.warn('Resource not found');
      } else {
        queryLogger.error('Failed to query resource status', error as Error);
      }
      return null;
    }
  }

  /**
   * Generate cache key for a deployed resource
   */
  private getCacheKey(deployedResource: DeployedResource): string {
    return `${deployedResource.manifest.apiVersion}:${deployedResource.kind}:${deployedResource.namespace}:${deployedResource.name}`;
  }

  /**
   * Get data from cache if valid
   */
  private getFromCache<T>(key: string): T | null {
    const entry = this.statusCache.get(key);
    if (!entry) {
      return null;
    }

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.statusCache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  /**
   * Set data in cache
   */
  private setCache<T>(key: string, data: T): void {
    this.statusCache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: this.mergedOptions.cacheTtl,
    });
  }

  /**
   * Clear the status cache
   */
  clearCache(): void {
    this.statusCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.statusCache.size,
      keys: Array.from(this.statusCache.keys()),
    };
  }
}

/**
 * Hydrates status fields by combining Kro-resolved dynamic fields with static fields
 */
export async function hydrateStatus<T extends Record<string, unknown>>(
  kroStatus: Record<string, unknown>,
  staticFields: Record<string, unknown>
): Promise<T> {
  // Evaluate static fields (resolve any CEL expressions that don't require Kubernetes resources)
  const evaluatedStaticFields: Record<string, unknown> = {};

  for (const [fieldName, fieldValue] of Object.entries(staticFields)) {
    // For now, just use direct values since static fields shouldn't have CEL expressions
    evaluatedStaticFields[fieldName] = fieldValue;
  }

  // Merge Kro-resolved status with evaluated static fields
  // Dynamic fields (from Kro) take precedence over static fields
  const hydratedStatus = {
    ...evaluatedStaticFields,
    ...kroStatus,
  };

  return hydratedStatus as T;
}
