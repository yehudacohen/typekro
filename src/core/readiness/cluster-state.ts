/**
 * Cluster State Access System
 *
 * Provides access to live cluster state for readiness evaluators.
 * This enables custom readiness evaluation logic that needs to check
 * the actual state of resources in the Kubernetes cluster.
 */

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
