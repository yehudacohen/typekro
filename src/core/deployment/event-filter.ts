/**
 * EventFilter - Server-side and Client-side Event Filtering
 *
 * Provides both server-side field selector generation and client-side
 * filtering for complex relationships that cannot be expressed server-side.
 */

import type * as k8s from '@kubernetes/client-node';
import { getComponentLogger } from '../logging/index.js';
import type { DeployedResource } from '../types/deployment.js';
import type { KubernetesEventData } from './event-monitor.js';

/**
 * Event filtering options
 */
export interface EventFilterOptions {
  /** Event types to include */
  eventTypes?: readonly ('Normal' | 'Warning' | 'Error')[] | ('Normal' | 'Warning' | 'Error')[];
  /** Whether to include child resources */
  includeChildResources?: boolean;
  /** Deduplication window in seconds */
  deduplicationWindow?: number;
  /** Maximum events per resource per minute */
  maxEventsPerResource?: number;
}

/**
 * Resource relationship information
 */
export interface ResourceRelationship {
  parent: ResourceIdentifier;
  children: ResourceIdentifier[];
  discoveredAt: Date;
  relationshipType: 'owns' | 'creates' | 'manages';
}

/**
 * Resource identifier
 */
export interface ResourceIdentifier {
  kind: string;
  name: string;
  namespace?: string;
  uid?: string;
}

/**
 * Event deduplication key
 */
interface EventDeduplicationKey {
  involvedObjectUid: string;
  reason: string;
  message: string;
}

/**
 * Deduplication entry
 */
interface DeduplicationEntry {
  key: EventDeduplicationKey;
  firstSeen: Date;
  lastSeen: Date;
  count: number;
  lastEvent: KubernetesEventData;
}

/**
 * Field selector builder for server-side filtering
 */
export class FieldSelectorBuilder {
  private logger = getComponentLogger('field-selector-builder');

  /**
   * Build field selector for specific resources
   */
  buildForResources(resources: ResourceIdentifier[]): string {
    if (resources.length === 0) {
      return '';
    }

    // Group resources by kind and namespace for efficient filtering
    const resourceGroups = this.groupResourcesByKindAndNamespace(resources);
    const selectors: string[] = [];

    for (const [key, resourceList] of resourceGroups) {
      const [kindRaw, namespaceRaw] = key.split('/');
      const kind = kindRaw || 'unknown';
      const namespace = namespaceRaw || 'default';
      const selector = this.buildSelectorForResourceGroup(kind, namespace, resourceList);
      if (selector) {
        selectors.push(selector);
      }
    }

    return selectors.join(',');
  }

  /**
   * Build field selector for resource kinds (broader filtering)
   */
  buildForResourceKinds(kinds: string[], namespace?: string): string {
    const selectors: string[] = [];

    for (const kind of kinds) {
      let selector = `involvedObject.kind=${kind}`;
      if (namespace) {
        selector += `,involvedObject.namespace=${namespace}`;
      }
      selectors.push(selector);
    }

    return selectors.join(',');
  }

  /**
   * Build field selector for time-based filtering
   */
  buildForTimeRange(startTime?: Date, endTime?: Date): string {
    const selectors: string[] = [];

    if (startTime) {
      // Note: Kubernetes doesn't support time-based field selectors directly
      // We'll use resource version for time-based filtering instead
      this.logger.debug('Time-based filtering requires resource version management');
    }

    if (endTime) {
      this.logger.debug('End time filtering not directly supported via field selectors');
    }

    return selectors.join(',');
  }

  /**
   * Build field selector for event types
   */
  buildForEventTypes(eventTypes: ('Normal' | 'Warning' | 'Error')[]): string {
    if (eventTypes.length === 0) {
      return '';
    }

    // Kubernetes field selectors don't support OR operations for the same field
    // So we can't filter by multiple event types server-side efficiently
    // This will need to be done client-side
    this.logger.debug('Event type filtering requires client-side processing for multiple types');

    if (eventTypes.length === 1) {
      return `type=${eventTypes[0]}`;
    }

    return ''; // Multiple types require client-side filtering
  }

  /**
   * Group resources by kind and namespace
   */
  private groupResourcesByKindAndNamespace(
    resources: ResourceIdentifier[]
  ): Map<string, ResourceIdentifier[]> {
    const groups = new Map<string, ResourceIdentifier[]>();

    for (const resource of resources) {
      const key = `${resource.kind}/${resource.namespace || 'default'}`;
      const group = groups.get(key) || [];
      group.push(resource);
      groups.set(key, group);
    }

    return groups;
  }

  /**
   * Build selector for a group of resources of the same kind/namespace
   */
  private buildSelectorForResourceGroup(
    kind: string,
    namespace: string,
    resources: ResourceIdentifier[]
  ): string {
    const baseSelector = `involvedObject.kind=${kind},involvedObject.namespace=${namespace}`;

    if (resources.length === 1) {
      // Single resource - can filter by name server-side
      return `${baseSelector},involvedObject.name=${resources[0]?.name || 'unknown'}`;
    } else if (resources.length <= 5) {
      // Small number of resources - use kind filter and do name filtering client-side
      // This is more efficient than multiple watch connections for small numbers
      return baseSelector;
    } else {
      // Large number of resources - use kind filter only
      // Client-side filtering will handle name matching
      return baseSelector;
    }
  }
}

/**
 * EventFilter handles both server-side and client-side event filtering
 */
export class EventFilter {
  private options: Required<EventFilterOptions>;
  private logger = getComponentLogger('event-filter');
  private fieldSelectorBuilder = new FieldSelectorBuilder();
  private deduplicationCache = new Map<string, DeduplicationEntry>();

  private monitoredResources = new Set<string>();

  constructor(options: EventFilterOptions = {}) {
    this.options = {
      eventTypes: options.eventTypes || ['Warning', 'Error'],
      includeChildResources: options.includeChildResources ?? true,
      deduplicationWindow: options.deduplicationWindow || 60, // 1 minute
      maxEventsPerResource: options.maxEventsPerResource || 100,
    };
  }

  /**
   * Generate server-side field selectors for resources
   */
  generateFieldSelectors(resources: DeployedResource[]): Map<string, string> {
    const resourceIdentifiers = resources
      .filter((r) => r.manifest.metadata?.uid) // Only include resources with UIDs
      .map((r) => ({
        kind: r.kind,
        name: r.name,
        namespace: r.namespace,
        uid: r.manifest.metadata?.uid!, // Safe to use ! since we filtered above
      }));

    // Update monitored resources
    this.updateMonitoredResources(resourceIdentifiers);

    // Generate field selectors grouped by namespace and kind
    const selectorsByNamespace = new Map<string, string>();
    const resourcesByNamespace = this.groupResourcesByNamespace(resourceIdentifiers);

    for (const [namespace, namespaceResources] of resourcesByNamespace) {
      const selector = this.fieldSelectorBuilder.buildForResources(namespaceResources);
      if (selector) {
        selectorsByNamespace.set(namespace, selector);
      }
    }

    this.logger.debug('Generated field selectors', {
      namespaces: Array.from(selectorsByNamespace.keys()),
      totalResources: resourceIdentifiers.length,
    });

    return selectorsByNamespace;
  }

  /**
   * Check if an event is relevant to monitored resources (client-side filtering)
   */
  isRelevant(event: KubernetesEventData, deployedResources: DeployedResource[]): boolean {
    // Check event type filter
    if (!this.options.eventTypes.includes(event.eventType)) {
      return false;
    }

    // Check if event is for a monitored resource
    const eventResourceId = this.getResourceId(
      event.involvedObject.kind,
      event.involvedObject.name,
      event.involvedObject.namespace
    );

    if (this.monitoredResources.has(eventResourceId)) {
      return true;
    }

    // Check child resources if enabled
    if (this.options.includeChildResources) {
      return this.isChildResourceEvent(event, deployedResources);
    }

    return false;
  }

  /**
   * Check if event should be deduplicated
   */
  shouldDeduplicate(event: KubernetesEventData): boolean {
    const deduplicationKey = this.getDeduplicationKey(event);
    const keyString = this.serializeDeduplicationKey(deduplicationKey);

    const now = new Date();
    const existing = this.deduplicationCache.get(keyString);

    if (!existing) {
      // First occurrence - add to cache
      this.deduplicationCache.set(keyString, {
        key: deduplicationKey,
        firstSeen: now,
        lastSeen: now,
        count: 1,
        lastEvent: event,
      });
      return false; // Don't deduplicate first occurrence
    }

    // Check if within deduplication window
    const timeSinceFirst = now.getTime() - existing.firstSeen.getTime();
    const windowMs = this.options.deduplicationWindow * 1000;

    if (timeSinceFirst > windowMs) {
      // Outside window - reset entry
      this.deduplicationCache.set(keyString, {
        key: deduplicationKey,
        firstSeen: now,
        lastSeen: now,
        count: 1,
        lastEvent: event,
      });
      return false;
    }

    // Within window - update entry and deduplicate
    existing.lastSeen = now;
    existing.count++;
    existing.lastEvent = event;

    // Deduplicate if we've seen this event multiple times recently
    return existing.count > 1;
  }

  /**
   * Get event priority for filtering and display
   */
  getEventPriority(event: KubernetesEventData): 'high' | 'medium' | 'low' {
    // Error events are always high priority
    if (event.eventType === 'Error') {
      return 'high';
    }

    // Warning events are medium priority, but some reasons are high priority
    if (event.eventType === 'Warning') {
      const highPriorityReasons = [
        'Failed',
        'FailedMount',
        'FailedScheduling',
        'FailedCreatePodSandBox',
        'FailedPostStartHook',
        'FailedPreStopHook',
        'Unhealthy',
        'ProbeWarning',
      ];

      if (highPriorityReasons.some((reason) => event.reason.includes(reason))) {
        return 'high';
      }

      return 'medium';
    }

    // Normal events are generally low priority
    if (event.eventType === 'Normal') {
      const mediumPriorityReasons = [
        'Scheduled',
        'Pulled',
        'Created',
        'Started',
        'Killing',
        'ScalingReplicaSet',
      ];

      if (mediumPriorityReasons.some((reason) => event.reason.includes(reason))) {
        return 'medium';
      }

      return 'low';
    }

    return 'low';
  }

  /**
   * Discover child resources from owner references
   */
  async discoverChildResources(
    parentResource: DeployedResource,
    k8sApi: k8s.CoreV1Api
  ): Promise<ResourceIdentifier[]> {
    const childResources: ResourceIdentifier[] = [];

    try {
      // This is a simplified implementation
      // In a full implementation, we would query various resource types
      // and check their ownerReferences to find children

      if (parentResource.kind === 'Deployment') {
        // Find ReplicaSets owned by this Deployment
        const replicaSets = await this.findReplicaSetsForDeployment(parentResource, k8sApi);
        childResources.push(...replicaSets);

        // Find Pods owned by the ReplicaSets
        for (const replicaSet of replicaSets) {
          const pods = await this.findPodsForReplicaSet(replicaSet, k8sApi);
          childResources.push(...pods);
        }
      }

      this.logger.debug('Discovered child resources', {
        parent: `${parentResource.kind}/${parentResource.name}`,
        childCount: childResources.length,
      });
    } catch (error) {
      this.logger.warn('Failed to discover child resources', error as Error);
    }

    return childResources;
  }

  /**
   * Clean up old deduplication entries
   */
  cleanupDeduplicationCache(): void {
    const now = new Date();
    const windowMs = this.options.deduplicationWindow * 1000;
    let cleanedCount = 0;

    for (const [key, entry] of this.deduplicationCache) {
      const age = now.getTime() - entry.lastSeen.getTime();
      if (age > windowMs * 2) {
        // Keep entries for 2x the window
        this.deduplicationCache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug('Cleaned up deduplication cache', {
        cleanedEntries: cleanedCount,
        remainingEntries: this.deduplicationCache.size,
      });
    }
  }

  /**
   * Update monitored resources set
   */
  private updateMonitoredResources(resources: ResourceIdentifier[]): void {
    this.monitoredResources.clear();
    for (const resource of resources) {
      const resourceId = this.getResourceId(resource.kind, resource.name, resource.namespace);
      this.monitoredResources.add(resourceId);
    }
  }

  /**
   * Group resources by namespace
   */
  private groupResourcesByNamespace(
    resources: ResourceIdentifier[]
  ): Map<string, ResourceIdentifier[]> {
    const groups = new Map<string, ResourceIdentifier[]>();

    for (const resource of resources) {
      const namespace = resource.namespace || 'default';
      const group = groups.get(namespace) || [];
      group.push(resource);
      groups.set(namespace, group);
    }

    return groups;
  }

  /**
   * Check if event is for a child resource
   */
  private isChildResourceEvent(
    event: KubernetesEventData,
    deployedResources: DeployedResource[]
  ): boolean {
    // This is a simplified implementation
    // In practice, we would maintain a comprehensive mapping of parent-child relationships

    // Check if this could be a child resource based on naming patterns
    for (const resource of deployedResources) {
      if (resource.kind === 'Deployment' && event.involvedObject.kind === 'ReplicaSet') {
        // ReplicaSet names typically start with deployment name
        if (event.involvedObject.name.startsWith(`${resource.name}-`)) {
          return true;
        }
      }

      if (resource.kind === 'Deployment' && event.involvedObject.kind === 'Pod') {
        // Pod names typically start with deployment name
        if (event.involvedObject.name.startsWith(`${resource.name}-`)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get deduplication key for event
   */
  private getDeduplicationKey(event: KubernetesEventData): EventDeduplicationKey {
    return {
      involvedObjectUid:
        event.involvedObject.uid || `${event.involvedObject.kind}/${event.involvedObject.name}`,
      reason: event.reason,
      message: event.eventMessage,
    };
  }

  /**
   * Serialize deduplication key to string
   */
  private serializeDeduplicationKey(key: EventDeduplicationKey): string {
    return `${key.involvedObjectUid}:${key.reason}:${key.message}`;
  }

  /**
   * Get resource identifier string
   */
  private getResourceId(kind: string, name: string, namespace?: string): string {
    return `${kind}/${name}/${namespace || 'default'}`;
  }

  /**
   * Find ReplicaSets for a Deployment (simplified implementation)
   */
  private async findReplicaSetsForDeployment(
    _deployment: DeployedResource,
    _k8sApi: k8s.CoreV1Api
  ): Promise<ResourceIdentifier[]> {
    // This would require the Apps API, not Core API
    // For now, return empty array
    // TODO: Implement proper ReplicaSet discovery
    return [];
  }

  /**
   * Find Pods for a ReplicaSet (simplified implementation)
   */
  private async findPodsForReplicaSet(
    replicaSet: ResourceIdentifier,
    k8sApi: k8s.CoreV1Api
  ): Promise<ResourceIdentifier[]> {
    try {
      // In the new API, methods take request objects and return objects directly
      const pods = await k8sApi.listNamespacedPod({
        namespace: replicaSet.namespace || 'default',
        labelSelector: `app=${replicaSet.name}`,
      });

      return pods.items
        .filter(
          (pod: k8s.V1Pod) => pod.metadata?.name && pod.metadata?.namespace && pod.metadata?.uid
        )
        .map((pod: k8s.V1Pod) => ({
          kind: 'Pod',
          name: pod.metadata?.name!,
          namespace: pod.metadata?.namespace!,
          uid: pod.metadata?.uid!,
        }));
    } catch (error) {
      this.logger.warn('Failed to find pods for ReplicaSet', error as Error);
      return [];
    }
  }
}

/**
 * Create an EventFilter instance
 */
export function createEventFilter(options: EventFilterOptions = {}): EventFilter {
  return new EventFilter(options);
}
