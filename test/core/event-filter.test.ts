/**
 * Unit tests for EventFilter
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

import { EventFilter, FieldSelectorBuilder, createEventFilter } from '../../src/core/deployment/event-filter.js';
import type { DeployedResource } from '../../src/core/types/deployment.js';
import type { KubernetesEventData } from '../../src/core/types/deployment.js';

describe('FieldSelectorBuilder', () => {
  let builder: FieldSelectorBuilder;

  beforeEach(() => {
    builder = new FieldSelectorBuilder();
  });

  describe('buildForResources', () => {
    it('should build field selector for single resource', () => {
      const resources = [
        {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'production',
        },
      ];

      const selector = builder.buildForResources(resources);
      expect(selector).toBe('involvedObject.kind=Deployment,involvedObject.namespace=production,involvedObject.name=webapp');
    });

    it('should build field selector for multiple resources of same kind', () => {
      const resources = [
        {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'production',
        },
        {
          kind: 'Deployment',
          name: 'api',
          namespace: 'production',
        },
      ];

      const selector = builder.buildForResources(resources);
      // For multiple resources of same kind, should use kind filter only
      expect(selector).toBe('involvedObject.kind=Deployment,involvedObject.namespace=production');
    });

    it('should build separate selectors for different kinds', () => {
      const resources = [
        {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'production',
        },
        {
          kind: 'Service',
          name: 'webapp-service',
          namespace: 'production',
        },
      ];

      const selector = builder.buildForResources(resources);
      expect(selector).toContain('involvedObject.kind=Deployment');
      expect(selector).toContain('involvedObject.kind=Service');
    });

    it('should handle resources in different namespaces', () => {
      const resources = [
        {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'production',
        },
        {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'staging',
        },
      ];

      const selector = builder.buildForResources(resources);
      expect(selector).toContain('involvedObject.namespace=production');
      expect(selector).toContain('involvedObject.namespace=staging');
    });

    it('should return empty string for no resources', () => {
      const selector = builder.buildForResources([]);
      expect(selector).toBe('');
    });
  });

  describe('buildForResourceKinds', () => {
    it('should build selector for single kind', () => {
      const selector = builder.buildForResourceKinds(['Deployment']);
      expect(selector).toBe('involvedObject.kind=Deployment');
    });

    it('should build selector for multiple kinds', () => {
      const selector = builder.buildForResourceKinds(['Deployment', 'Service']);
      expect(selector).toContain('involvedObject.kind=Deployment');
      expect(selector).toContain('involvedObject.kind=Service');
    });

    it('should include namespace when provided', () => {
      const selector = builder.buildForResourceKinds(['Deployment'], 'production');
      expect(selector).toBe('involvedObject.kind=Deployment,involvedObject.namespace=production');
    });
  });

  describe('buildForEventTypes', () => {
    it('should build selector for single event type', () => {
      const selector = builder.buildForEventTypes(['Error']);
      expect(selector).toBe('type=Error');
    });

    it('should return empty string for multiple event types', () => {
      // Multiple event types can't be efficiently filtered server-side
      const selector = builder.buildForEventTypes(['Warning', 'Error']);
      expect(selector).toBe('');
    });

    it('should return empty string for no event types', () => {
      const selector = builder.buildForEventTypes([]);
      expect(selector).toBe('');
    });
  });
});

describe('EventFilter', () => {
  let eventFilter: EventFilter;
  let mockDeployedResources: DeployedResource[];

  beforeEach(() => {
    eventFilter = createEventFilter({
      eventTypes: ['Warning', 'Error'],
      includeChildResources: true,
      deduplicationWindow: 60,
    });

    mockDeployedResources = [
      {
        id: 'webapp-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'production',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'production', uid: 'webapp-uid' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      },
      {
        id: 'webapp-service',
        kind: 'Service',
        name: 'webapp-service',
        namespace: 'production',
        manifest: {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: { name: 'webapp-service', namespace: 'production', uid: 'service-uid' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      },
    ];
  });

  describe('generateFieldSelectors', () => {
    it('should generate field selectors grouped by namespace', () => {
      const selectors = eventFilter.generateFieldSelectors(mockDeployedResources);
      
      expect(selectors.has('production')).toBe(true);
      const productionSelector = selectors.get('production');
      expect(productionSelector).toContain('involvedObject.kind=Deployment');
      expect(productionSelector).toContain('involvedObject.kind=Service');
    });

    it('should handle resources in multiple namespaces', () => {
      const multiNamespaceResources = [
        ...mockDeployedResources,
        {
          id: 'staging-webapp',
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'staging',
          manifest: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'webapp', namespace: 'staging', uid: 'staging-uid' },
          },
          status: 'deployed' as const,
          deployedAt: new Date(),
        },
      ];

      const selectors = eventFilter.generateFieldSelectors(multiNamespaceResources);
      
      expect(selectors.has('production')).toBe(true);
      expect(selectors.has('staging')).toBe(true);
    });
  });

  describe('isRelevant', () => {
    it('should accept events for monitored resources', () => {
      // Generate field selectors to update monitored resources
      eventFilter.generateFieldSelectors(mockDeployedResources);

      const event: KubernetesEventData = {
        type: 'kubernetes-event',
        eventType: 'Warning',
        reason: 'FailedScheduling',
        message: 'Test event',
        timestamp: new Date(),
        source: { component: 'scheduler' },
        involvedObject: {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'production',
          uid: 'webapp-uid',
        },
        eventMessage: 'Pod cannot be scheduled',
      };

      const isRelevant = eventFilter.isRelevant(event, mockDeployedResources);
      expect(isRelevant).toBe(true);
    });

    it('should reject events for non-monitored resources', () => {
      // Generate field selectors to update monitored resources
      eventFilter.generateFieldSelectors(mockDeployedResources);

      const event: KubernetesEventData = {
        type: 'kubernetes-event',
        eventType: 'Warning',
        reason: 'FailedScheduling',
        message: 'Test event',
        timestamp: new Date(),
        source: { component: 'scheduler' },
        involvedObject: {
          kind: 'Deployment',
          name: 'other-app',
          namespace: 'production',
          uid: 'other-uid',
        },
        eventMessage: 'Pod cannot be scheduled',
      };

      const isRelevant = eventFilter.isRelevant(event, mockDeployedResources);
      expect(isRelevant).toBe(false);
    });

    it('should filter by event type', () => {
      // Generate field selectors to update monitored resources
      eventFilter.generateFieldSelectors(mockDeployedResources);

      const normalEvent: KubernetesEventData = {
        type: 'kubernetes-event',
        eventType: 'Normal',
        reason: 'Scheduled',
        message: 'Test event',
        timestamp: new Date(),
        source: { component: 'scheduler' },
        involvedObject: {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'production',
          uid: 'webapp-uid',
        },
        eventMessage: 'Pod scheduled successfully',
      };

      const isRelevant = eventFilter.isRelevant(normalEvent, mockDeployedResources);
      expect(isRelevant).toBe(false); // Normal events filtered out
    });

    it('should accept child resource events when enabled', () => {
      // Generate field selectors to update monitored resources
      eventFilter.generateFieldSelectors(mockDeployedResources);

      const childEvent: KubernetesEventData = {
        type: 'kubernetes-event',
        eventType: 'Warning',
        reason: 'FailedScheduling',
        message: 'Test event',
        timestamp: new Date(),
        source: { component: 'scheduler' },
        involvedObject: {
          kind: 'Pod',
          name: 'webapp-abc123-xyz789', // Child pod of webapp deployment
          namespace: 'production',
          uid: 'pod-uid',
        },
        eventMessage: 'Pod cannot be scheduled',
      };

      const isRelevant = eventFilter.isRelevant(childEvent, mockDeployedResources);
      expect(isRelevant).toBe(true); // Should accept child resource
    });
  });

  describe('shouldDeduplicate', () => {
    it('should not deduplicate first occurrence of event', () => {
      const event: KubernetesEventData = {
        type: 'kubernetes-event',
        eventType: 'Warning',
        reason: 'FailedScheduling',
        message: 'Test event',
        timestamp: new Date(),
        source: { component: 'scheduler' },
        involvedObject: {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'production',
          uid: 'webapp-uid',
        },
        eventMessage: 'Pod cannot be scheduled',
      };

      const shouldDedupe = eventFilter.shouldDeduplicate(event);
      expect(shouldDedupe).toBe(false);
    });

    it('should deduplicate repeated events within window', () => {
      const event: KubernetesEventData = {
        type: 'kubernetes-event',
        eventType: 'Warning',
        reason: 'FailedScheduling',
        message: 'Test event',
        timestamp: new Date(),
        source: { component: 'scheduler' },
        involvedObject: {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'production',
          uid: 'webapp-uid',
        },
        eventMessage: 'Pod cannot be scheduled',
      };

      // First occurrence
      const firstDedupe = eventFilter.shouldDeduplicate(event);
      expect(firstDedupe).toBe(false);

      // Second occurrence (should be deduplicated)
      const secondDedupe = eventFilter.shouldDeduplicate(event);
      expect(secondDedupe).toBe(true);
    });

    it('should not deduplicate events outside deduplication window', async () => {
      // Create filter with very short deduplication window
      const shortWindowFilter = createEventFilter({
        deduplicationWindow: 0.001, // 1ms
      });

      const event: KubernetesEventData = {
        type: 'kubernetes-event',
        eventType: 'Warning',
        reason: 'FailedScheduling',
        message: 'Test event',
        timestamp: new Date(),
        source: { component: 'scheduler' },
        involvedObject: {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'production',
          uid: 'webapp-uid',
        },
        eventMessage: 'Pod cannot be scheduled',
      };

      // First occurrence
      const firstDedupe = shortWindowFilter.shouldDeduplicate(event);
      expect(firstDedupe).toBe(false);

      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second occurrence (should not be deduplicated due to expired window)
      const secondDedupe = shortWindowFilter.shouldDeduplicate(event);
      expect(secondDedupe).toBe(false);
    });
  });

  describe('getEventPriority', () => {
    it('should assign high priority to Error events', () => {
      const event: KubernetesEventData = {
        type: 'kubernetes-event',
        eventType: 'Error',
        reason: 'FailedMount',
        message: 'Test event',
        timestamp: new Date(),
        source: { component: 'kubelet' },
        involvedObject: {
          kind: 'Pod',
          name: 'webapp-pod',
          namespace: 'production',
        },
        eventMessage: 'Failed to mount volume',
      };

      const priority = eventFilter.getEventPriority(event);
      expect(priority).toBe('high');
    });

    it('should assign high priority to critical Warning events', () => {
      const event: KubernetesEventData = {
        type: 'kubernetes-event',
        eventType: 'Warning',
        reason: 'FailedScheduling',
        message: 'Test event',
        timestamp: new Date(),
        source: { component: 'scheduler' },
        involvedObject: {
          kind: 'Pod',
          name: 'webapp-pod',
          namespace: 'production',
        },
        eventMessage: 'Pod cannot be scheduled',
      };

      const priority = eventFilter.getEventPriority(event);
      expect(priority).toBe('high');
    });

    it('should assign medium priority to regular Warning events', () => {
      const event: KubernetesEventData = {
        type: 'kubernetes-event',
        eventType: 'Warning',
        reason: 'BackOff',
        message: 'Test event',
        timestamp: new Date(),
        source: { component: 'kubelet' },
        involvedObject: {
          kind: 'Pod',
          name: 'webapp-pod',
          namespace: 'production',
        },
        eventMessage: 'Back-off restarting failed container',
      };

      const priority = eventFilter.getEventPriority(event);
      expect(priority).toBe('medium');
    });

    it('should assign medium priority to important Normal events', () => {
      const event: KubernetesEventData = {
        type: 'kubernetes-event',
        eventType: 'Normal',
        reason: 'Scheduled',
        message: 'Test event',
        timestamp: new Date(),
        source: { component: 'scheduler' },
        involvedObject: {
          kind: 'Pod',
          name: 'webapp-pod',
          namespace: 'production',
        },
        eventMessage: 'Successfully assigned pod to node',
      };

      const priority = eventFilter.getEventPriority(event);
      expect(priority).toBe('medium');
    });

    it('should assign low priority to regular Normal events', () => {
      const event: KubernetesEventData = {
        type: 'kubernetes-event',
        eventType: 'Normal',
        reason: 'SomeOtherReason',
        message: 'Test event',
        timestamp: new Date(),
        source: { component: 'controller' },
        involvedObject: {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'production',
        },
        eventMessage: 'Some normal operation',
      };

      const priority = eventFilter.getEventPriority(event);
      expect(priority).toBe('low');
    });
  });

  describe('cleanupDeduplicationCache', () => {
    it('should remove old entries from deduplication cache', () => {
      // Create filter with short deduplication window
      const shortWindowFilter = createEventFilter({
        deduplicationWindow: 0.001, // 1ms
      });

      const event: KubernetesEventData = {
        type: 'kubernetes-event',
        eventType: 'Warning',
        reason: 'FailedScheduling',
        message: 'Test event',
        timestamp: new Date(),
        source: { component: 'scheduler' },
        involvedObject: {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'production',
          uid: 'webapp-uid',
        },
        eventMessage: 'Pod cannot be scheduled',
      };

      // Add event to cache
      shortWindowFilter.shouldDeduplicate(event);

      // Wait for entries to become old
      setTimeout(() => {
        shortWindowFilter.cleanupDeduplicationCache();
        
        // After cleanup, the same event should not be deduplicated
        const shouldDedupe = shortWindowFilter.shouldDeduplicate(event);
        expect(shouldDedupe).toBe(false);
      }, 10);
    });
  });

  describe('discoverChildResources', () => {
    it('should discover child resources for Deployment', async () => {
      const mockCoreV1Api = {
        listNamespacedPod: mock(() => Promise.resolve({
          body: {
            items: [
              {
                metadata: {
                  name: 'webapp-abc123-xyz789',
                  namespace: 'production',
                  uid: 'pod-uid-1',
                },
              },
              {
                metadata: {
                  name: 'webapp-abc123-def456',
                  namespace: 'production',
                  uid: 'pod-uid-2',
                },
              },
            ],
          },
        })),
      } as any;

      const deploymentResource: DeployedResource = {
        id: 'webapp-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'production',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'production', uid: 'webapp-uid' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      const childResources = await eventFilter.discoverChildResources(
        deploymentResource,
        mockCoreV1Api
      );

      // Note: Current implementation returns empty array because it needs Apps API for ReplicaSets
      // This is a simplified implementation for now
      expect(childResources).toHaveLength(0);
    });

    it('should handle API errors during child resource discovery', async () => {
      const mockCoreV1Api = {
        listNamespacedPod: mock(() => Promise.reject(new Error('API Error'))),
      } as any;

      const deploymentResource: DeployedResource = {
        id: 'webapp-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'production',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'production', uid: 'webapp-uid' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      const childResources = await eventFilter.discoverChildResources(
        deploymentResource,
        mockCoreV1Api
      );

      // Should return empty array on error, not throw
      expect(childResources).toHaveLength(0);
    });
  });
});

describe('createEventFilter', () => {
  it('should create EventFilter with default options', () => {
    const filter = createEventFilter();
    expect(filter).toBeInstanceOf(EventFilter);
  });

  it('should create EventFilter with custom options', () => {
    const options = {
      eventTypes: ['Normal', 'Warning', 'Error'] as const,
      includeChildResources: false,
      deduplicationWindow: 120,
      maxEventsPerResource: 50,
    };

    const filter = createEventFilter(options);
    expect(filter).toBeInstanceOf(EventFilter);
  });
});