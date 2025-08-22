/**
 * Cluster State Access System
 *
 * Provides access to live cluster state for readiness evaluators.
 * This enables custom readiness evaluation logic that needs to check
 * the actual state of resources in the Kubernetes cluster.
 */

import * as k8s from '@kubernetes/client-node';

/**
 * Resource identifier for cluster state queries
 */
export interface ResourceIdentifier {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
}

/**
 * Options for cluster state operations
 */
export interface ClusterStateOptions {
  /** Timeout for the operation in milliseconds */
  timeout?: number;
  /** Whether to include managed fields in the response */
  includeManagedFields?: boolean;
  /** Label selector for list operations */
  labelSelector?: string;
  /** Field selector for list operations */
  fieldSelector?: string;
}

/**
 * Result of a cluster state query
 */
export interface ClusterStateResult<T = any> {
  /** The resource data, if found */
  resource?: T;
  /** Whether the resource exists */
  exists: boolean;
  /** Error message if the operation failed */
  error?: string;
  /** HTTP status code from the API server */
  statusCode?: number;
}

/**
 * Result of a list operation
 */
export interface ClusterStateListResult<T = any> {
  /** Array of matching resources */
  items: T[];
  /** Total number of items (may be more than returned if paginated) */
  totalItems: number;
  /** Error message if the operation failed */
  error?: string;
  /** HTTP status code from the API server */
  statusCode?: number;
}

/**
 * Condition check result
 */
export interface ConditionCheckResult {
  /** Whether the condition is met */
  satisfied: boolean;
  /** The actual condition object, if found */
  condition?: {
    type: string;
    status: string;
    reason?: string;
    message?: string;
    lastTransitionTime?: string;
  };
  /** Error message if the check failed */
  error?: string;
}

/**
 * Interface for accessing live cluster state
 *
 * This interface provides methods for readiness evaluators to query
 * the current state of resources in the Kubernetes cluster.
 */
export interface ClusterStateAccessor {
  /**
   * Get a specific resource from the cluster
   *
   * @param identifier Resource to retrieve
   * @param options Query options
   * @returns Promise resolving to the resource state
   */
  getResource<T = any>(
    identifier: ResourceIdentifier,
    options?: ClusterStateOptions
  ): Promise<ClusterStateResult<T>>;

  /**
   * List resources matching the given criteria
   *
   * @param identifier Resource type and namespace to list
   * @param options Query options including selectors
   * @returns Promise resolving to the list of resources
   */
  listResources<T = any>(
    identifier: Omit<ResourceIdentifier, 'name'>,
    options?: ClusterStateOptions
  ): Promise<ClusterStateListResult<T>>;

  /**
   * Check if a resource has a specific condition
   *
   * @param identifier Resource to check
   * @param conditionType Type of condition to check (e.g., 'Ready', 'Available')
   * @param expectedStatus Expected status of the condition (e.g., 'True', 'False')
   * @param options Query options
   * @returns Promise resolving to the condition check result
   */
  checkResourceCondition(
    identifier: ResourceIdentifier,
    conditionType: string,
    expectedStatus?: string,
    options?: ClusterStateOptions
  ): Promise<ConditionCheckResult>;

  /**
   * Check if multiple resources are ready
   *
   * @param identifiers Array of resources to check
   * @param options Query options
   * @returns Promise resolving to readiness status for each resource
   */
  checkMultipleResourcesReady(
    identifiers: ResourceIdentifier[],
    options?: ClusterStateOptions
  ): Promise<Record<string, boolean>>;

  /**
   * Wait for a resource to meet a specific condition
   *
   * @param identifier Resource to wait for
   * @param conditionType Type of condition to wait for
   * @param expectedStatus Expected status of the condition
   * @param options Query options including timeout
   * @returns Promise that resolves when condition is met or times out
   */
  waitForCondition(
    identifier: ResourceIdentifier,
    conditionType: string,
    expectedStatus: string,
    options?: ClusterStateOptions
  ): Promise<ConditionCheckResult>;

  /**
   * Get the current namespace context
   *
   * @returns The current namespace, or undefined if not set
   */
  getCurrentNamespace(): string | undefined;

  /**
   * Set the default namespace for operations
   *
   * @param namespace Namespace to use as default
   */
  setDefaultNamespace(namespace: string): void;

  /**
   * Check if the cluster is accessible
   *
   * @returns Promise resolving to true if cluster is accessible
   */
  isClusterAccessible(): Promise<boolean>;
}

/**
 * Error thrown when cluster state operations fail
 */
export class ClusterStateError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly resource?: ResourceIdentifier,
    public readonly statusCode?: number,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ClusterStateError';
  }

  static resourceNotFound(resource: ResourceIdentifier): ClusterStateError {
    return new ClusterStateError(
      `Resource not found: ${resource.kind}/${resource.name}${resource.namespace ? ` in namespace ${resource.namespace}` : ''}`,
      'getResource',
      resource,
      404
    );
  }

  static timeout(
    operation: string,
    timeout: number,
    resource?: ResourceIdentifier
  ): ClusterStateError {
    return new ClusterStateError(
      `Operation '${operation}' timed out after ${timeout}ms${resource ? ` for ${resource.kind}/${resource.name}` : ''}`,
      operation,
      resource
    );
  }

  static apiError(
    operation: string,
    statusCode: number,
    message: string,
    resource?: ResourceIdentifier
  ): ClusterStateError {
    return new ClusterStateError(
      `API error during '${operation}': ${message}`,
      operation,
      resource,
      statusCode
    );
  }

  static clusterNotAccessible(cause?: Error): ClusterStateError {
    return new ClusterStateError(
      'Cluster is not accessible. Check your kubeconfig and network connectivity.',
      'isClusterAccessible',
      undefined,
      undefined,
      cause
    );
  }
}

/**
 * Default implementation of ClusterStateAccessor using Kubernetes client
 */
export class KubernetesClusterStateAccessor implements ClusterStateAccessor {
  private defaultNamespace: string | undefined;

  constructor(
    private k8sApi: k8s.KubernetesObjectApi,
    private coreApi: k8s.CoreV1Api,
    defaultNamespace?: string
  ) {
    this.defaultNamespace = defaultNamespace;
  }

  /**
   * Create a ClusterStateAccessor from a KubeConfig
   */
  static fromKubeConfig(
    kubeConfig: k8s.KubeConfig,
    defaultNamespace?: string
  ): KubernetesClusterStateAccessor {
    const k8sApi = k8s.KubernetesObjectApi.makeApiClient(kubeConfig);
    const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
    return new KubernetesClusterStateAccessor(k8sApi, coreApi, defaultNamespace);
  }

  async getResource<T = any>(
    identifier: ResourceIdentifier,
    options: ClusterStateOptions = {}
  ): Promise<ClusterStateResult<T>> {
    try {
      const namespace = identifier.namespace || this.defaultNamespace;

      const timeoutPromise = options.timeout
        ? this.createTimeoutPromise(options.timeout, 'getResource', identifier)
        : null;

      const resourcePromise = this.k8sApi.read({
        apiVersion: identifier.apiVersion,
        kind: identifier.kind,
        metadata: {
          name: identifier.name,
          namespace: namespace || 'default',
        },
      });

      const result = timeoutPromise
        ? await Promise.race([resourcePromise, timeoutPromise])
        : await resourcePromise;

      return {
        resource: result.body as T,
        exists: true,
        statusCode: result.response.statusCode || 200,
      };
    } catch (error: any) {
      if (error.statusCode === 404) {
        return {
          exists: false,
          error: `Resource not found: ${identifier.kind}/${identifier.name}`,
          statusCode: 404,
        };
      }

      return {
        exists: false,
        error: error.message || 'Unknown error occurred',
        statusCode: error.statusCode,
      };
    }
  }

  async listResources<T = any>(
    identifier: Omit<ResourceIdentifier, 'name'>,
    options: ClusterStateOptions = {}
  ): Promise<ClusterStateListResult<T>> {
    try {
      const namespace = identifier.namespace || this.defaultNamespace;

      const timeoutPromise = options.timeout
        ? this.createTimeoutPromise(
            options.timeout,
            'listResources',
            identifier as ResourceIdentifier
          )
        : null;

      const resourcePromise = this.k8sApi.list(
        identifier.apiVersion,
        identifier.kind,
        namespace,
        undefined, // pretty
        undefined, // exact
        undefined, // export
        options.fieldSelector,
        options.labelSelector
      );

      const result = timeoutPromise
        ? await Promise.race([resourcePromise, timeoutPromise])
        : await resourcePromise;

      const items = (result.body as any)?.items || [];

      return {
        items: items as T[],
        totalItems: items.length,
        statusCode: result.response.statusCode || 200,
      };
    } catch (error: any) {
      return {
        items: [],
        totalItems: 0,
        error: error.message || 'Unknown error occurred',
        statusCode: error.statusCode,
      };
    }
  }

  async checkResourceCondition(
    identifier: ResourceIdentifier,
    conditionType: string,
    expectedStatus?: string,
    options: ClusterStateOptions = {}
  ): Promise<ConditionCheckResult> {
    try {
      const resourceResult = await this.getResource(identifier, options);

      if (!resourceResult.exists || !resourceResult.resource) {
        return {
          satisfied: false,
          error: resourceResult.error || 'Resource not found',
        };
      }

      const resource = resourceResult.resource as any;
      const conditions = resource.status?.conditions;

      if (!conditions || !Array.isArray(conditions)) {
        return {
          satisfied: false,
          error: 'Resource has no status conditions',
        };
      }

      const condition = conditions.find((c: any) => c.type === conditionType);

      if (!condition) {
        return {
          satisfied: false,
          error: `Condition '${conditionType}' not found`,
        };
      }

      const satisfied = expectedStatus
        ? condition.status === expectedStatus
        : condition.status === 'True';

      return {
        satisfied,
        condition: {
          type: condition.type,
          status: condition.status,
          reason: condition.reason,
          message: condition.message,
          lastTransitionTime: condition.lastTransitionTime,
        },
      };
    } catch (error: any) {
      return {
        satisfied: false,
        error: error.message || 'Unknown error occurred',
      };
    }
  }

  async checkMultipleResourcesReady(
    identifiers: ResourceIdentifier[],
    options: ClusterStateOptions = {}
  ): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    // Execute all checks in parallel for better performance
    const checks = identifiers.map(async (identifier) => {
      const key = `${identifier.kind}/${identifier.name}${identifier.namespace ? `@${identifier.namespace}` : ''}`;

      try {
        const conditionResult = await this.checkResourceCondition(
          identifier,
          'Ready',
          'True',
          options
        );
        results[key] = conditionResult.satisfied;
      } catch (_error) {
        results[key] = false;
      }
    });

    await Promise.all(checks);
    return results;
  }

  async waitForCondition(
    identifier: ResourceIdentifier,
    conditionType: string,
    expectedStatus: string,
    options: ClusterStateOptions = {}
  ): Promise<ConditionCheckResult> {
    const timeout = options.timeout || 300000; // 5 minutes default
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds

    while (Date.now() - startTime < timeout) {
      const result = await this.checkResourceCondition(
        identifier,
        conditionType,
        expectedStatus,
        options
      );

      if (result.satisfied) {
        return result;
      }

      // If there's an error other than condition not being met, return it
      if (
        result.error &&
        !result.error.includes('not found') &&
        !result.error.includes('status conditions')
      ) {
        return result;
      }

      // Wait before next check
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw ClusterStateError.timeout('waitForCondition', timeout, identifier);
  }

  getCurrentNamespace(): string | undefined {
    return this.defaultNamespace;
  }

  setDefaultNamespace(namespace: string): void {
    this.defaultNamespace = namespace;
  }

  async isClusterAccessible(): Promise<boolean> {
    try {
      // Try to get cluster version as a simple connectivity test
      await this.coreApi.listNamespace();
      return true;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Create a timeout promise that rejects after the specified time
   */
  private createTimeoutPromise(
    timeout: number,
    operation: string,
    resource?: ResourceIdentifier
  ): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(ClusterStateError.timeout(operation, timeout, resource));
      }, timeout);
    });
  }
}

/**
 * Factory function to create a ClusterStateAccessor from various sources
 */
export class ClusterStateAccessorFactory {
  /**
   * Create from KubeConfig
   */
  static fromKubeConfig(
    kubeConfig: k8s.KubeConfig,
    defaultNamespace?: string
  ): ClusterStateAccessor {
    return KubernetesClusterStateAccessor.fromKubeConfig(kubeConfig, defaultNamespace);
  }

  /**
   * Create from kubeconfig file path
   */
  static fromKubeConfigFile(
    kubeconfigPath?: string,
    defaultNamespace?: string
  ): ClusterStateAccessor {
    const kubeConfig = new k8s.KubeConfig();

    if (kubeconfigPath) {
      kubeConfig.loadFromFile(kubeconfigPath);
    } else {
      kubeConfig.loadFromDefault();
    }

    return ClusterStateAccessorFactory.fromKubeConfig(kubeConfig, defaultNamespace);
  }

  /**
   * Create from cluster (for in-cluster usage)
   */
  static fromCluster(defaultNamespace?: string): ClusterStateAccessor {
    const kubeConfig = new k8s.KubeConfig();
    kubeConfig.loadFromCluster();
    return ClusterStateAccessorFactory.fromKubeConfig(kubeConfig, defaultNamespace);
  }

  /**
   * Create a mock accessor for testing
   */
  static createMock(mockData: Record<string, any> = {}): ClusterStateAccessor {
    return new MockClusterStateAccessor(mockData);
  }
}

/**
 * Mock implementation for testing
 */
export class MockClusterStateAccessor implements ClusterStateAccessor {
  private defaultNamespace?: string;

  constructor(private mockData: Record<string, any> = {}) {}

  async getResource<T = any>(identifier: ResourceIdentifier): Promise<ClusterStateResult<T>> {
    const key = this.getResourceKey(identifier);
    const resource = this.mockData[key];

    return {
      resource: resource as T,
      exists: !!resource,
      error: resource ? undefined : 'Resource not found',
      statusCode: resource ? 200 : 404,
    } as ClusterStateResult<T>;
  }

  async listResources<T = any>(
    identifier: Omit<ResourceIdentifier, 'name'>
  ): Promise<ClusterStateListResult<T>> {
    const prefix = `${identifier.kind}/${identifier.namespace || 'default'}/`;
    const items = Object.keys(this.mockData)
      .filter((key) => key.startsWith(prefix))
      .map((key) => this.mockData[key])
      .filter(Boolean) as T[];

    return {
      items,
      totalItems: items.length,
      statusCode: 200,
    };
  }

  async checkResourceCondition(
    identifier: ResourceIdentifier,
    conditionType: string,
    expectedStatus?: string
  ): Promise<ConditionCheckResult> {
    const resourceResult = await this.getResource(identifier);

    if (!resourceResult.exists || !resourceResult.resource) {
      return {
        satisfied: false,
        error: 'Resource not found',
      };
    }

    const resource = resourceResult.resource as any;
    const conditions = resource.status?.conditions || [];
    const condition = conditions.find((c: any) => c.type === conditionType);

    if (!condition) {
      return {
        satisfied: false,
        error: `Condition '${conditionType}' not found`,
      };
    }

    const satisfied = expectedStatus
      ? condition.status === expectedStatus
      : condition.status === 'True';

    return {
      satisfied,
      condition,
    };
  }

  async checkMultipleResourcesReady(
    identifiers: ResourceIdentifier[]
  ): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const identifier of identifiers) {
      const key = `${identifier.kind}/${identifier.name}${identifier.namespace ? `@${identifier.namespace}` : ''}`;
      const conditionResult = await this.checkResourceCondition(identifier, 'Ready', 'True');
      results[key] = conditionResult.satisfied;
    }

    return results;
  }

  async waitForCondition(
    identifier: ResourceIdentifier,
    conditionType: string,
    expectedStatus: string
  ): Promise<ConditionCheckResult> {
    // For mock, just return the current condition check
    return this.checkResourceCondition(identifier, conditionType, expectedStatus);
  }

  getCurrentNamespace(): string | undefined {
    return this.defaultNamespace;
  }

  setDefaultNamespace(namespace: string): void {
    this.defaultNamespace = namespace;
  }

  async isClusterAccessible(): Promise<boolean> {
    return true; // Mock is always accessible
  }

  /**
   * Add mock data for testing
   */
  addMockResource(identifier: ResourceIdentifier, resource: any): void {
    const key = this.getResourceKey(identifier);
    this.mockData[key] = resource;
  }

  /**
   * Clear all mock data
   */
  clearMockData(): void {
    this.mockData = {};
  }

  private getResourceKey(identifier: ResourceIdentifier): string {
    return `${identifier.kind}/${identifier.namespace || 'default'}/${identifier.name}`;
  }
}
