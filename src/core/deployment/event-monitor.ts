/**
 * EventMonitor - Kubernetes Events Monitoring with Server-Side Filtering
 *
 * Monitors Kubernetes events related to deployed resources using efficient
 * server-side filtering to minimize network traffic and improve performance.
 */

import * as k8s from '@kubernetes/client-node';
import { getComponentLogger } from '../logging/index.js';
import type { DeployedResource, DeploymentEvent } from '../types/deployment.js';

/**
 * Configuration options for event monitoring
 */
export interface EventMonitoringOptions {
  /** Namespace to monitor events in */
  namespace?: string;
  /** Types of events to monitor */
  eventTypes?: readonly ('Normal' | 'Warning' | 'Error')[] | ('Normal' | 'Warning' | 'Error')[];
  /** Whether to discover and monitor child resources */
  includeChildResources?: boolean;
  /** Start time for filtering events (only events after this time) */
  startTime?: Date;
  /** Progress callback for delivering events */
  progressCallback?: (event: DeploymentEvent) => void;
  /** Maximum number of watch connections per namespace */
  maxWatchConnections?: number;
  /** Timeout for watch connections in seconds */
  watchTimeoutSeconds?: number;
}

/**
 * Resource identifier for event filtering
 */
export interface ResourceIdentifier {
  kind: string;
  name: string;
  namespace?: string;
  uid?: string;
}

/**
 * Resource relationship tracking
 */
export interface ResourceRelationship {
  parent: ResourceIdentifier;
  children: ResourceIdentifier[];
  discoveredAt: Date;
  relationshipType: 'owns' | 'creates' | 'manages';
}

/**
 * Child resource discovered event
 */
export interface ChildResourceDiscoveredEvent extends DeploymentEvent {
  type: 'child-resource-discovered';
  parentResource: ResourceIdentifier;
  childResource: ResourceIdentifier;
  relationshipType: 'owns' | 'creates' | 'manages';
}

/**
 * Watch connection information
 */
interface WatchConnection {
  kind: string;
  namespace: string;
  fieldSelector: string;
  watcher: k8s.Watch;
  request?: { abort(): void }; // The active watch request
  resources: Set<string>; // Resource names being watched
  lastResourceVersion?: string;
}

/**
 * Kubernetes event extended with additional metadata
 */
export interface KubernetesEventData extends DeploymentEvent {
  type: 'kubernetes-event';
  eventType: 'Normal' | 'Warning' | 'Error';
  reason: string;
  source: {
    component: string;
    host?: string | undefined;
  };
  involvedObject: {
    kind: string;
    name: string;
    namespace?: string | undefined;
    uid?: string | undefined;
  };
  count?: number;
  firstTimestamp?: Date;
  lastTimestamp?: Date;
  eventMessage: string;
}

/**
 * EventMonitor manages Kubernetes event watching with server-side filtering
 */
export class EventMonitor {
  private watchConnections = new Map<string, WatchConnection>();
  private monitoredResources = new Map<string, ResourceIdentifier>();
  private resourceRelationships = new Map<string, ResourceRelationship>();
  private childDiscoveryInProgress = new Set<string>();
  private childDiscoveryTimeouts = new Set<NodeJS.Timeout>();
  private options: Required<EventMonitoringOptions>;
  private logger = getComponentLogger('event-monitor');
  private isMonitoring = false;
  private startResourceVersion?: string;
  private eventsProcessed = 0;
  private appsApi: k8s.AppsV1Api;
  private watchFactory: (config: k8s.KubeConfig) => k8s.Watch;

  constructor(
    private k8sApi: k8s.CoreV1Api,
    private kubeConfig: k8s.KubeConfig,
    options: EventMonitoringOptions = {},
    watchFactory?: (config: k8s.KubeConfig) => k8s.Watch
  ) {
    this.appsApi = kubeConfig.makeApiClient(k8s.AppsV1Api);
    this.watchFactory = watchFactory || ((config: k8s.KubeConfig) => new k8s.Watch(config));
    this.options = {
      namespace: options.namespace || 'default',
      eventTypes: options.eventTypes || ['Warning', 'Error'],
      includeChildResources: options.includeChildResources ?? true,
      startTime: options.startTime || new Date(),
      progressCallback:
        options.progressCallback ||
        (() => {
          /* no-op */
        }),
      maxWatchConnections: options.maxWatchConnections || 10,
      watchTimeoutSeconds: options.watchTimeoutSeconds || 300, // 5 minutes
    };
  }

  /**
   * Start monitoring events for deployed resources
   */
  async startMonitoring(deployedResources: DeployedResource[]): Promise<void> {
    if (this.isMonitoring) {
      this.logger.warn('Event monitoring already started');
      return;
    }

    this.logger.info('Starting event monitoring', {
      resourceCount: deployedResources.length,
      namespace: this.options.namespace,
      eventTypes: this.options.eventTypes,
    });

    try {
      // Get resource version for time-based filtering
      this.startResourceVersion = await this.getResourceVersionForTime(this.options.startTime);

      // Add resources to monitoring
      for (const resource of deployedResources) {
        await this.addResource(resource);
      }

      // If no resources were provided, create a namespace-wide watch connection
      // to capture all events that will be generated during deployment
      if (deployedResources.length === 0) {
        await this.createNamespaceWideWatchConnection();
      }

      this.isMonitoring = true;
      this.logger.info('Event monitoring started successfully', {
        watchConnections: this.watchConnections.size,
        monitoredResources: this.monitoredResources.size,
      });
    } catch (error) {
      this.logger.error('Failed to start event monitoring', error as Error);
      await this.stopMonitoring();
      throw error;
    }
  }

  /**
   * Stop monitoring and clean up all watch connections
   */
  async stopMonitoring(): Promise<void> {
    if (!this.isMonitoring) {
      return;
    }

    this.logger.info('Stopping event monitoring', {
      watchConnections: this.watchConnections.size,
    });

    // Clear all pending child discovery timeouts
    for (const timeoutId of this.childDiscoveryTimeouts) {
      clearTimeout(timeoutId);
    }
    this.childDiscoveryTimeouts.clear();

    // Close all watch connections
    for (const [key, connection] of this.watchConnections) {
      try {
        if (connection.request && typeof connection.request.abort === 'function') {
          connection.request.abort();
        }
        this.logger.debug('Closed watch connection', { key, kind: connection.kind });
      } catch (error) {
        this.logger.warn('Error closing watch connection', error as Error);
      }
    }

    this.watchConnections.clear();
    this.monitoredResources.clear();
    this.resourceRelationships.clear();
    this.childDiscoveryInProgress.clear();
    this.isMonitoring = false;

    this.logger.info('Event monitoring stopped', {
      eventsProcessed: this.eventsProcessed,
    });

    // Reset counter for next monitoring session
    this.eventsProcessed = 0;
  }

  /**
   * Add a resource to monitoring
   */
  async addResource(resource: DeployedResource): Promise<void> {
    const resourceId = this.getResourceId(resource);
    const resourceIdentifier: ResourceIdentifier = {
      kind: resource.kind,
      name: resource.name,
      namespace: resource.namespace || this.options.namespace,
      ...(resource.manifest.metadata?.uid && { uid: resource.manifest.metadata.uid }),
    };

    this.monitoredResources.set(resourceId, resourceIdentifier);

    // Create or update watch connection for this resource
    await this.ensureWatchConnection(resourceIdentifier);

    this.logger.debug('Added resource to monitoring', {
      resourceId,
      kind: resource.kind,
      name: resource.name,
      namespace: resourceIdentifier.namespace,
    });

    // Trigger child resource discovery if enabled and resource has UID
    if (this.options.includeChildResources && resourceIdentifier.uid) {
      // Use setTimeout to avoid blocking the main flow
      const timeoutId = setTimeout(() => {
        this.discoverChildResources(resource).catch((error) => {
          this.logger.warn('Child resource discovery failed', {
            error: error as Error,
            resourceId,
            kind: resource.kind,
            name: resource.name,
          });
        });
        // Clean up timeout reference after execution
        this.childDiscoveryTimeouts.delete(timeoutId);
      }, 1000); // Wait 1 second to allow resource to be fully created

      // Track timeout for cleanup
      this.childDiscoveryTimeouts.add(timeoutId);
    }
  }

  /**
   * Remove a resource from monitoring
   */
  async removeResource(resource: DeployedResource): Promise<void> {
    const resourceId = this.getResourceId(resource);
    const resourceIdentifier = this.monitoredResources.get(resourceId);

    if (!resourceIdentifier) {
      return;
    }

    this.monitoredResources.delete(resourceId);

    // Remove from relationships
    this.resourceRelationships.delete(resourceId);

    // Update or remove watch connection
    await this.updateWatchConnection(resourceIdentifier, 'remove');

    this.logger.debug('Removed resource from monitoring', {
      resourceId,
      kind: resource.kind,
      name: resource.name,
    });
  }

  /**
   * Add additional resources to monitor (for child resource discovery)
   */
  async addResources(resources: DeployedResource[]): Promise<void> {
    for (const resource of resources) {
      await this.addResource(resource);
    }
  }

  /**
   * Discover and monitor child resources created by parent resources
   */
  async discoverChildResources(parentResource: DeployedResource): Promise<void> {
    if (!this.options.includeChildResources) {
      return;
    }

    const parentId = this.getResourceId(parentResource);

    // Prevent concurrent discovery for the same resource
    if (this.childDiscoveryInProgress.has(parentId)) {
      return;
    }

    this.childDiscoveryInProgress.add(parentId);

    try {
      const parentIdentifier = this.monitoredResources.get(parentId);
      if (!parentIdentifier || !parentIdentifier.uid) {
        this.logger.debug('Cannot discover children for resource without UID', {
          parentId,
          kind: parentResource.kind,
          name: parentResource.name,
        });
        return;
      }

      this.logger.debug('Starting child resource discovery', {
        parentId,
        parentKind: parentResource.kind,
        parentName: parentResource.name,
        parentUid: parentIdentifier.uid,
      });

      const childResources = await this.findChildResources(parentIdentifier);

      if (childResources.length > 0) {
        // Create relationship record
        const relationship: ResourceRelationship = {
          parent: parentIdentifier,
          children: childResources,
          discoveredAt: new Date(),
          relationshipType: this.determineRelationshipType(parentResource.kind),
        };

        this.resourceRelationships.set(parentId, relationship);

        // Add child resources to monitoring (only those with UIDs)
        for (const childResource of childResources.filter((r) => r.uid)) {
          const childDeployedResource: DeployedResource = {
            id: `${childResource.kind}-${childResource.name}`,
            kind: childResource.kind,
            name: childResource.name,
            namespace: childResource.namespace || parentResource.namespace,
            status: 'deployed',
            deployedAt: new Date(),
            manifest: {
              apiVersion: this.getApiVersionForKind(childResource.kind),
              kind: childResource.kind,
              metadata: {
                name: childResource.name,
                namespace: childResource.namespace || parentResource.namespace,
                uid: childResource.uid || '',
              },
            },
          };

          await this.addResource(childDeployedResource);

          // Emit child resource discovered event
          const discoveredEvent: ChildResourceDiscoveredEvent = {
            type: 'child-resource-discovered',
            message: `Discovered child resource ${childResource.kind}/${childResource.name}`,
            timestamp: new Date(),
            parentResource: parentIdentifier,
            childResource: childResource,
            relationshipType: relationship.relationshipType,
          };

          this.options.progressCallback(discoveredEvent);

          this.logger.info('Discovered and added child resource to monitoring', {
            parentId,
            childKind: childResource.kind,
            childName: childResource.name,
            relationshipType: relationship.relationshipType,
          });
        }
      }
    } catch (error) {
      this.logger.error('Failed to discover child resources', error as Error, {
        parentId,
        parentKind: parentResource.kind,
        parentName: parentResource.name,
      });
    } finally {
      this.childDiscoveryInProgress.delete(parentId);
    }
  }

  /**
   * Find child resources using owner references
   */
  private async findChildResources(
    parentResource: ResourceIdentifier
  ): Promise<ResourceIdentifier[]> {
    const childResources: ResourceIdentifier[] = [];
    const namespace = parentResource.namespace || this.options.namespace;

    try {
      // Define resource types that commonly have children
      const childResourceTypes = this.getChildResourceTypes(parentResource.kind);

      for (const resourceType of childResourceTypes) {
        try {
          const resources = await this.listResourcesWithOwnerReference(
            resourceType,
            namespace,
            parentResource.uid || ''
          );

          childResources.push(...resources);
        } catch (error) {
          this.logger.debug('Failed to list child resources of type', {
            error: error as Error,
            resourceType,
            parentKind: parentResource.kind,
            parentName: parentResource.name,
          });
          // Continue with other resource types
        }
      }
    } catch (error) {
      this.logger.error('Error during child resource discovery', error as Error, {
        parentKind: parentResource.kind,
        parentName: parentResource.name,
      });
    }

    return childResources;
  }

  /**
   * List resources with specific owner reference
   */
  private async listResourcesWithOwnerReference(
    resourceType: string,
    namespace: string,
    ownerUid: string
  ): Promise<ResourceIdentifier[]> {
    const resources: ResourceIdentifier[] = [];

    try {
      let resourceList: { body: { items: unknown[] } };

      // Handle different resource types
      switch (resourceType) {
        case 'ReplicaSet':
          resourceList = await this.appsApi.listNamespacedReplicaSet(namespace);
          break;
        case 'Pod':
          resourceList = await this.k8sApi.listNamespacedPod(namespace);
          break;
        case 'Service':
          resourceList = await this.k8sApi.listNamespacedService(namespace);
          break;
        case 'ConfigMap':
          resourceList = await this.k8sApi.listNamespacedConfigMap(namespace);
          break;
        case 'Secret':
          resourceList = await this.k8sApi.listNamespacedSecret(namespace);
          break;
        default:
          this.logger.debug('Unsupported child resource type for discovery', { resourceType });
          return resources;
      }

      // Filter by owner reference
      for (const item of resourceList.body.items) {
        const resource = item as {
          metadata?: {
            name?: string;
            namespace?: string;
            uid?: string;
            ownerReferences?: Array<{
              uid: string;
              kind: string;
              name: string;
              controller?: boolean;
            }>;
          };
          kind?: string;
        };

        if (resource.metadata?.ownerReferences) {
          const hasOwnerReference = resource.metadata.ownerReferences.some(
            (ref) => ref.uid === ownerUid
          );

          if (hasOwnerReference && resource.metadata.name && resource.metadata.uid) {
            resources.push({
              kind: resourceType,
              name: resource.metadata.name,
              namespace: resource.metadata.namespace || namespace,
              uid: resource.metadata.uid,
            });
          }
        }
      }
    } catch (error) {
      this.logger.debug('Failed to list resources for owner reference check', {
        error: error as Error,
        resourceType,
        namespace,
        ownerUid,
      });
    }

    return resources;
  }

  /**
   * Get potential child resource types for a parent resource kind
   */
  private getChildResourceTypes(parentKind: string): string[] {
    const childTypeMap: Record<string, string[]> = {
      Deployment: ['ReplicaSet', 'Pod'],
      ReplicaSet: ['Pod'],
      StatefulSet: ['Pod'],
      DaemonSet: ['Pod'],
      Job: ['Pod'],
      CronJob: ['Job', 'Pod'],
      Service: [], // Services don't typically create child resources
      ConfigMap: [], // ConfigMaps don't create child resources
      Secret: [], // Secrets don't create child resources
    };

    return childTypeMap[parentKind] || [];
  }

  /**
   * Determine relationship type based on parent resource kind
   */
  private determineRelationshipType(parentKind: string): 'owns' | 'creates' | 'manages' {
    const relationshipMap: Record<string, 'owns' | 'creates' | 'manages'> = {
      Deployment: 'manages',
      ReplicaSet: 'owns',
      StatefulSet: 'manages',
      DaemonSet: 'manages',
      Job: 'owns',
      CronJob: 'creates',
    };

    return relationshipMap[parentKind] || 'owns';
  }

  /**
   * Get API version for a resource kind
   */
  private getApiVersionForKind(kind: string): string {
    const apiVersionMap: Record<string, string> = {
      Pod: 'v1',
      Service: 'v1',
      ConfigMap: 'v1',
      Secret: 'v1',
      Deployment: 'apps/v1',
      ReplicaSet: 'apps/v1',
      StatefulSet: 'apps/v1',
      DaemonSet: 'apps/v1',
      Job: 'batch/v1',
      CronJob: 'batch/v1',
    };

    return apiVersionMap[kind] || 'v1';
  }

  /**
   * Ensure a watch connection exists for the given resource
   */
  private async ensureWatchConnection(resource: ResourceIdentifier): Promise<void> {
    const connectionKey = this.getConnectionKey(resource);
    let connection = this.watchConnections.get(connectionKey);

    if (!connection) {
      // Create new watch connection
      connection = await this.createWatchConnection(resource);
      this.watchConnections.set(connectionKey, connection);
    } else {
      // Add resource to existing connection
      connection.resources.add(resource.name);
      // Update field selector if needed
      await this.updateConnectionFieldSelector(connection);
    }
  }

  /**
   * Create a new watch connection for a resource kind/namespace combination
   */
  private async createWatchConnection(resource: ResourceIdentifier): Promise<WatchConnection> {
    const namespace = resource.namespace || this.options.namespace;
    const fieldSelector = this.buildFieldSelector([resource]);

    this.logger.debug('Creating watch connection', {
      kind: resource.kind,
      namespace,
      fieldSelector,
    });

    const watcher = this.watchFactory(this.kubeConfig);
    const connection: WatchConnection = {
      kind: resource.kind,
      namespace,
      fieldSelector,
      watcher,
      resources: new Set([resource.name]),
      ...(this.startResourceVersion && { lastResourceVersion: this.startResourceVersion }),
    };

    // Start watching
    await this.startWatchConnection(connection);

    return connection;
  }

  /**
   * Start a watch connection
   */
  private async startWatchConnection(connection: WatchConnection): Promise<void> {
    try {
      const watchOptions: Record<string, unknown> = {
        timeoutSeconds: this.options.watchTimeoutSeconds,
      };

      // Only add fieldSelector if it's not empty
      if (connection.fieldSelector) {
        watchOptions.fieldSelector = connection.fieldSelector;
      }

      if (connection.lastResourceVersion) {
        watchOptions.resourceVersion = connection.lastResourceVersion;
      }

      this.logger.debug('Starting watch connection with options', {
        kind: connection.kind,
        namespace: connection.namespace,
        fieldSelector: connection.fieldSelector || '(none - watch all)',
        watchOptions,
      });

      const request = await connection.watcher.watch(
        `/api/v1/namespaces/${connection.namespace}/events`,
        watchOptions,
        (type: string, apiObj: k8s.CoreV1Event, watchObj: unknown) => {
          this.handleWatchEvent(type, apiObj, watchObj, connection);
        },
        (error: unknown) => {
          this.handleWatchError(error, connection);
        }
      );

      // Ensure the request object has an abort method
      connection.request =
        request && typeof request === 'object' && 'abort' in request
          ? (request as { abort(): void })
          : {
              abort: () => {
                /* no-op for testing */
              },
            };

      this.logger.debug('Watch connection started', {
        kind: connection.kind,
        namespace: connection.namespace,
        resourceCount: connection.resources.size,
      });
    } catch (error) {
      this.logger.error('Failed to start watch connection', error as Error, {
        kind: connection.kind,
        namespace: connection.namespace,
      });
      throw error;
    }
  }

  /**
   * Handle watch events
   */
  private handleWatchEvent(
    type: string,
    event: k8s.CoreV1Event,
    watchObj: unknown,
    connection: WatchConnection
  ): void {
    try {
      // Debug: Log that we received an event
      this.logger.debug('Received watch event', {
        type,
        eventType: event.type,
        reason: event.reason,
        involvedObject: `${event.involvedObject?.kind}/${event.involvedObject?.name}`,
        namespace: event.involvedObject?.namespace,
        connectionKind: connection.kind,
      });
      // Update resource version for reconnection
      if (watchObj && typeof watchObj === 'object' && 'metadata' in watchObj) {
        const metadata = (watchObj as { metadata?: { resourceVersion?: string } }).metadata;
        if (metadata?.resourceVersion) {
          connection.lastResourceVersion = metadata.resourceVersion;
        }
      }

      // Skip if event type is not in our filter
      if (
        event.type &&
        !this.options.eventTypes.includes(event.type as 'Normal' | 'Warning' | 'Error')
      ) {
        return;
      }

      // Convert to our event format
      const kubernetesEvent = this.convertToKubernetesEvent(event);

      // Increment event counter
      this.eventsProcessed++;

      // Emit event via progress callback if available, otherwise log to console
      if (this.options.progressCallback) {
        this.options.progressCallback(kubernetesEvent);
      } else {
        // Fallback to console logging when no progress callback is provided
        this.logger.info('Kubernetes Event', {
          type: event.type,
          reason: event.reason,
          involvedObject: `${event.involvedObject?.kind}/${event.involvedObject?.name}`,
          namespace: event.involvedObject?.namespace,
          message: event.message,
          timestamp: event.lastTimestamp || event.firstTimestamp,
        });
      }

      this.logger.debug('Processed Kubernetes event', {
        eventType: event.type,
        reason: event.reason,
        involvedObject: `${event.involvedObject?.kind}/${event.involvedObject?.name}`,
        message: event.message?.substring(0, 100),
        hasCallback: !!this.options.progressCallback,
      });
    } catch (error) {
      this.logger.error('Error handling watch event', error as Error, {
        eventType: type,
        eventReason: event.reason,
      });
    }
  }

  /**
   * Handle watch errors
   */
  private handleWatchError(error: unknown, _connection: WatchConnection): void {
    this.logger.warn('Watch connection error', error as Error);

    // Implement reconnection logic here
    // For now, just log the error
    // TODO: Add exponential backoff retry logic
  }

  /**
   * Update watch connection when resources are added/removed
   */
  private async updateWatchConnection(
    resource: ResourceIdentifier,
    action: 'add' | 'remove'
  ): Promise<void> {
    const connectionKey = this.getConnectionKey(resource);
    const connection = this.watchConnections.get(connectionKey);

    if (!connection) {
      return;
    }

    if (action === 'add') {
      connection.resources.add(resource.name);
    } else {
      connection.resources.delete(resource.name);
    }

    // If no resources left, remove the connection
    if (connection.resources.size === 0) {
      if (connection.request && typeof connection.request.abort === 'function') {
        connection.request.abort();
      }
      this.watchConnections.delete(connectionKey);
      this.logger.debug('Removed empty watch connection', { connectionKey });
      return;
    }

    // Update field selector
    await this.updateConnectionFieldSelector(connection);
  }

  /**
   * Update the field selector for a connection
   */
  private async updateConnectionFieldSelector(connection: WatchConnection): Promise<void> {
    const resources = Array.from(connection.resources).map((name) => ({
      kind: connection.kind,
      name,
      namespace: connection.namespace,
    }));

    const newFieldSelector = this.buildFieldSelector(resources);

    if (newFieldSelector !== connection.fieldSelector) {
      connection.fieldSelector = newFieldSelector;

      // Restart the watch connection with new field selector
      if (connection.request && typeof connection.request.abort === 'function') {
        connection.request.abort();
      }

      await this.startWatchConnection(connection);

      this.logger.debug('Updated watch connection field selector', {
        kind: connection.kind,
        namespace: connection.namespace,
        fieldSelector: newFieldSelector,
      });
    }
  }

  /**
   * Create a namespace-wide watch connection to capture all events
   * This is used when starting monitoring without specific resources
   */
  private async createNamespaceWideWatchConnection(): Promise<void> {
    const namespace = this.options.namespace || 'default';
    const connectionKey = `namespace-wide-${namespace}`;

    if (this.watchConnections.has(connectionKey)) {
      return; // Already exists
    }

    this.logger.debug('Creating namespace-wide watch connection', {
      namespace,
    });

    const watcher = this.watchFactory(this.kubeConfig);
    const connection: WatchConnection = {
      kind: '*', // Special marker for namespace-wide connection
      namespace,
      fieldSelector: '', // Empty selector watches all events in namespace
      watcher,
      resources: new Set(),
      ...(this.startResourceVersion && { lastResourceVersion: this.startResourceVersion }),
    };

    this.watchConnections.set(connectionKey, connection);
    await this.startWatchConnection(connection);

    this.logger.debug('Created namespace-wide watch connection', {
      namespace,
    });
  }

  /**
   * Build field selector for resources
   */
  private buildFieldSelector(resources: ResourceIdentifier[]): string {
    if (resources.length === 0) {
      return '';
    }

    // Group by kind for efficient filtering
    const resourcesByKind = new Map<string, string[]>();
    for (const resource of resources) {
      const names = resourcesByKind.get(resource.kind) || [];
      names.push(resource.name);
      resourcesByKind.set(resource.kind, names);
    }

    // Build field selector
    const selectors: string[] = [];

    for (const [kind, names] of resourcesByKind) {
      if (names.length === 1) {
        // Single resource
        selectors.push(`involvedObject.kind=${kind},involvedObject.name=${names[0]}`);
      } else {
        // Multiple resources of same kind - need separate selectors
        // Note: Kubernetes doesn't support OR in field selectors, so we'll use the kind filter
        // and do name filtering client-side for now
        selectors.push(`involvedObject.kind=${kind}`);
      }
    }

    return selectors.join(',');
  }

  /**
   * Convert Kubernetes event to our event format
   */
  private convertToKubernetesEvent(event: k8s.CoreV1Event): KubernetesEventData {
    return {
      type: 'kubernetes-event',
      eventType: (event.type as 'Normal' | 'Warning' | 'Error') || 'Normal',
      reason: event.reason || 'Unknown',
      message: `[${event.involvedObject?.kind}/${event.involvedObject?.name}] ${event.reason}: ${event.message}`,
      timestamp: new Date(),
      source: {
        component: event.source?.component || 'unknown',
        ...(event.source?.host && { host: event.source.host }),
      },
      involvedObject: {
        kind: event.involvedObject?.kind || 'Unknown',
        name: event.involvedObject?.name || 'unknown',
        ...(event.involvedObject?.namespace && { namespace: event.involvedObject.namespace }),
        ...(event.involvedObject?.uid && { uid: event.involvedObject.uid }),
      },
      ...(event.count && { count: event.count }),
      ...(event.firstTimestamp && { firstTimestamp: new Date(event.firstTimestamp) }),
      ...(event.lastTimestamp && { lastTimestamp: new Date(event.lastTimestamp) }),
      eventMessage: event.message || '',
    };
  }

  /**
   * Get resource version for time-based filtering
   */
  private async getResourceVersionForTime(_time: Date): Promise<string> {
    try {
      // Get a recent event to establish current resource version
      const eventList = await this.k8sApi.listNamespacedEvent(
        this.options.namespace,
        undefined, // pretty
        undefined, // allowWatchBookmarks
        undefined, // continue
        undefined, // fieldSelector
        undefined, // labelSelector
        1 // limit to 1 event
      );

      return eventList.body.metadata?.resourceVersion || '0';
    } catch (error) {
      this.logger.warn('Failed to get resource version for time filtering', error as Error);
      // Don't throw - continue with default resource version
      return '0';
    }
  }

  /**
   * Get unique resource identifier
   */
  private getResourceId(resource: DeployedResource): string {
    return `${resource.kind}/${resource.name}/${resource.namespace || this.options.namespace}`;
  }

  /**
   * Get connection key for watch connection pooling
   */
  private getConnectionKey(resource: ResourceIdentifier): string {
    return `${resource.kind}/${resource.namespace || this.options.namespace}`;
  }
}

/**
 * Create an EventMonitor instance
 */
export function createEventMonitor(
  kubeConfig: k8s.KubeConfig,
  options: EventMonitoringOptions = {},
  watchFactory?: (config: k8s.KubeConfig) => k8s.Watch
): EventMonitor {
  const k8sApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
  return new EventMonitor(k8sApi, kubeConfig, options, watchFactory);
}
