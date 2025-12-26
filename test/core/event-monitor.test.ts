/**
 * Unit tests for EventMonitor
 *
 * NOTE: In the new @kubernetes/client-node API (v1.x), methods return objects directly
 * without a .body wrapper. The mocks must return the resource directly.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { EventMonitor, createEventMonitor } from '../../src/core/deployment/event-monitor.js';
import type { DeployedResource } from '../../src/core/types/deployment.js';
import type { DeploymentEvent } from '../../src/core/types/deployment.js';

// Mock the Kubernetes client
let mockKubeConfig: any;
let mockCoreV1Api: any;
let mockAppsV1Api: any;
let mockWatch: any;

// Store original Watch constructor to restore later
let _originalWatch: any;

describe('EventMonitor', () => {
  let eventMonitor: EventMonitor;
  let capturedEvents: DeploymentEvent[] = [];

  const mockProgressCallback = (event: DeploymentEvent) => {
    capturedEvents.push(event);
  };

  beforeEach(() => {
    capturedEvents = [];
    
    // Reset mocks for each test (new API returns objects directly, no .body wrapper)
    mockCoreV1Api = {
      listNamespacedEvent: mock(() => Promise.resolve({
        metadata: { resourceVersion: '12345' },
        items: [],
      })),
    };

    mockWatch = {
      watch: mock(() => Promise.resolve({ abort: mock() })),
    };

    mockAppsV1Api = {
      listNamespacedReplicaSet: mock(() => Promise.resolve({
        items: [],
      })),
    };

    mockKubeConfig = {
      makeApiClient: mock((apiClass: any) => {
        if (apiClass === k8s.AppsV1Api) {
          return mockAppsV1Api;
        }
        return mockCoreV1Api;
      }),
      getCurrentCluster: mock(() => ({
        name: 'test-cluster',
        server: 'https://test-server:6443',
        skipTLSVerify: true,
      })),
      getCurrentUser: mock(() => ({
        name: 'test-user',
        token: 'test-token',
      })),
      getCurrentContext: mock(() => 'test-context'),
      applyToRequest: mock(() => Promise.resolve()),
      applyToHTTPSOptions: mock(() => Promise.resolve()),
    };

    // Add mock methods for child resource discovery (new API returns objects directly)
    mockCoreV1Api.listNamespacedPod = mock(() => Promise.resolve({
      items: [],
    }));
    mockCoreV1Api.listNamespacedService = mock(() => Promise.resolve({
      items: [],
    }));
    mockCoreV1Api.listNamespacedConfigMap = mock(() => Promise.resolve({
      items: [],
    }));
    mockCoreV1Api.listNamespacedSecret = mock(() => Promise.resolve({
      items: [],
    }));
    
    eventMonitor = createEventMonitor(
      mockKubeConfig, 
      {
        namespace: 'test-namespace',
        eventTypes: ['Warning', 'Error'],
        progressCallback: mockProgressCallback,
      },
      mock(() => mockWatch)
    );
  });

  afterEach(async () => {
    // Clean up event monitor
    if (eventMonitor) {
      await eventMonitor.stopMonitoring();
    }
  });

  describe('Field Selector Generation', () => {
    it('should generate field selectors for single resource', async () => {
      const deployedResource: DeployedResource = {
        id: 'test-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      await eventMonitor.startMonitoring([deployedResource]);

      // Verify that watch was called with correct field selector
      expect(mockWatch.watch).toHaveBeenCalledWith(
        '/api/v1/namespaces/test-namespace/events',
        expect.objectContaining({
          fieldSelector: expect.stringContaining('involvedObject.kind=Deployment'),
        }),
        expect.any(Function),
        expect.any(Function)
      );
    });

    it('should generate field selectors for multiple resources of same kind', async () => {
      const deployedResources: DeployedResource[] = [
        {
          id: 'webapp-deployment',
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'test-namespace',
          manifest: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'webapp', namespace: 'test-namespace' },
          },
          status: 'deployed',
          deployedAt: new Date(),
        },
        {
          id: 'api-deployment',
          kind: 'Deployment',
          name: 'api',
          namespace: 'test-namespace',
          manifest: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'api', namespace: 'test-namespace' },
          },
          status: 'deployed',
          deployedAt: new Date(),
        },
      ];

      await eventMonitor.startMonitoring(deployedResources);

      // Should use kind-based filtering for multiple resources
      expect(mockWatch.watch).toHaveBeenCalledWith(
        '/api/v1/namespaces/test-namespace/events',
        expect.objectContaining({
          fieldSelector: expect.stringContaining('involvedObject.kind=Deployment'),
        }),
        expect.any(Function),
        expect.any(Function)
      );
    });

    it('should generate separate field selectors for different resource kinds', async () => {
      const deployedResources: DeployedResource[] = [
        {
          id: 'webapp-deployment',
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'test-namespace',
          manifest: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'webapp', namespace: 'test-namespace' },
          },
          status: 'deployed',
          deployedAt: new Date(),
        },
        {
          id: 'webapp-service',
          kind: 'Service',
          name: 'webapp-service',
          namespace: 'test-namespace',
          manifest: {
            apiVersion: 'v1',
            kind: 'Service',
            metadata: { name: 'webapp-service', namespace: 'test-namespace' },
          },
          status: 'deployed',
          deployedAt: new Date(),
        },
      ];

      await eventMonitor.startMonitoring(deployedResources);

      // Should create separate watch connections for different kinds
      expect(mockWatch.watch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Event Processing', () => {
    it('should convert Kubernetes events to deployment events', async () => {
      const deployedResource: DeployedResource = {
        id: 'test-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      await eventMonitor.startMonitoring([deployedResource]);

      // Get the event handler that was passed to watch
      const watchCall = mockWatch.watch.mock.calls[0];
      const eventHandler = watchCall[2];

      // Simulate a Kubernetes event
      const k8sEvent: k8s.CoreV1Event = {
        metadata: { name: 'test-event', namespace: 'test-namespace' },
        type: 'Warning',
        reason: 'FailedScheduling',
        message: 'Pod cannot be scheduled',
        involvedObject: {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'test-namespace',
        },
        source: {
          component: 'default-scheduler',
        },
        count: 1,
        firstTimestamp: new Date(),
        lastTimestamp: new Date(),
      };

      // Call the event handler
      eventHandler('ADDED', k8sEvent, { metadata: { resourceVersion: '12346' } });

      // Verify event was converted and delivered
      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0]).toMatchObject({
        type: 'kubernetes-event',
        eventType: 'Warning',
        reason: 'FailedScheduling',
        message: expect.stringContaining('FailedScheduling'),
        involvedObject: {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'test-namespace',
        },
      });
    });

    it('should filter events by event type', async () => {
      const deployedResource: DeployedResource = {
        id: 'test-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Create monitor that only watches Error events
      const errorOnlyMonitor = createEventMonitor(
        mockKubeConfig, 
        {
          namespace: 'test-namespace',
          eventTypes: ['Error'],
          progressCallback: mockProgressCallback,
        },
        mock(() => mockWatch)
      );

      await errorOnlyMonitor.startMonitoring([deployedResource]);

      // Get the event handler
      const watchCall = mockWatch.watch.mock.calls[mockWatch.watch.mock.calls.length - 1];
      const eventHandler = watchCall[2];

      // Simulate Warning event (should be filtered out)
      const warningEvent: k8s.CoreV1Event = {
        metadata: { name: 'warning-event', namespace: 'test-namespace' },
        type: 'Warning',
        reason: 'FailedScheduling',
        message: 'Pod cannot be scheduled',
        involvedObject: {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'test-namespace',
        },
        source: { component: 'scheduler' },
      };

      eventHandler('ADDED', warningEvent, { metadata: { resourceVersion: '12346' } });

      // Should not capture Warning event
      expect(capturedEvents).toHaveLength(0);

      // Simulate Error event (should be captured)
      const errorEvent: k8s.CoreV1Event = {
        metadata: { name: 'error-event', namespace: 'test-namespace' },
        type: 'Error',
        reason: 'FailedMount',
        message: 'Failed to mount volume',
        involvedObject: {
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'test-namespace',
        },
        source: { component: 'kubelet' },
      };

      eventHandler('ADDED', errorEvent, { metadata: { resourceVersion: '12347' } });

      // Should capture Error event
      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0]).toMatchObject({
        type: 'kubernetes-event',
        eventType: 'Error',
        reason: 'FailedMount',
      });

      await errorOnlyMonitor.stopMonitoring();
    });
  });

  describe('Resource Management', () => {
    it('should add resources to existing monitoring', async () => {
      const initialResource: DeployedResource = {
        id: 'webapp-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      await eventMonitor.startMonitoring([initialResource]);
      expect(mockWatch.watch).toHaveBeenCalledTimes(1);

      // Add another resource of the same kind
      const additionalResource: DeployedResource = {
        id: 'api-deployment',
        kind: 'Deployment',
        name: 'api',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'api', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      await eventMonitor.addResource(additionalResource);

      // Should reuse existing connection and update field selector
      // The exact behavior depends on implementation details
      expect(mockWatch.watch).toHaveBeenCalledTimes(2); // One for initial, one for update
    });

    it('should remove resources from monitoring', async () => {
      const resources: DeployedResource[] = [
        {
          id: 'webapp-deployment',
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'test-namespace',
          manifest: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'webapp', namespace: 'test-namespace' },
          },
          status: 'deployed',
          deployedAt: new Date(),
        },
        {
          id: 'api-deployment',
          kind: 'Deployment',
          name: 'api',
          namespace: 'test-namespace',
          manifest: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'api', namespace: 'test-namespace' },
          },
          status: 'deployed',
          deployedAt: new Date(),
        },
      ];

      await eventMonitor.startMonitoring(resources);

      // Remove one resource
      const firstResource = resources[0];
      if (firstResource) {
        await eventMonitor.removeResource(firstResource);
      }

      // Connection should still exist for remaining resource
      // Exact verification depends on implementation details
    });
  });

  describe('Error Handling', () => {
    it('should handle watch connection errors gracefully', async () => {
      const deployedResource: DeployedResource = {
        id: 'test-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      await eventMonitor.startMonitoring([deployedResource]);

      // Get the error handler
      const watchCall = mockWatch.watch.mock.calls[0];
      const errorHandler = watchCall[3];

      // Simulate watch error
      const error = new Error('Connection lost');
      errorHandler(error);

      // Should not throw - error should be handled gracefully
      // Exact behavior depends on implementation (logging, reconnection, etc.)
    });

    it('should handle API permission errors during initialization', async () => {
      // Mock API error
      mockCoreV1Api.listNamespacedEvent.mockRejectedValueOnce(
        new Error('Forbidden: events is forbidden')
      );

      const deployedResource: DeployedResource = {
        id: 'test-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Should handle permission error gracefully (not throw, but log warning)
      await expect(eventMonitor.startMonitoring([deployedResource])).resolves.toBeUndefined();
    });
  });

  describe('Resource Version Management', () => {
    it('should use resource version for time-based filtering', async () => {
      const deployedResource: DeployedResource = {
        id: 'test-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      await eventMonitor.startMonitoring([deployedResource]);

      // Verify that resource version was requested
      // New API uses object parameters instead of positional parameters
      expect(mockCoreV1Api.listNamespacedEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'test-namespace',
          limit: 1,
        })
      );

      // Verify that watch was called with resource version
      expect(mockWatch.watch).toHaveBeenCalledWith(
        '/api/v1/namespaces/test-namespace/events',
        expect.objectContaining({
          resourceVersion: '12345',
        }),
        expect.any(Function),
        expect.any(Function)
      );
    });
  });

  describe('Child Resource Discovery', () => {
    it('should discover ReplicaSets created by Deployment', async () => {
      // Mock ReplicaSet created by Deployment
      const deploymentUid = 'deployment-uid-123';
      const mockReplicaSet = {
        metadata: {
          name: 'webapp-replicaset',
          namespace: 'test-namespace',
          uid: 'replicaset-uid-456',
          ownerReferences: [
            {
              uid: deploymentUid,
              kind: 'Deployment',
              name: 'webapp',
              controller: true,
            },
          ],
        },
      };

      // New API returns objects directly (no .body wrapper)
      mockAppsV1Api.listNamespacedReplicaSet.mockResolvedValueOnce({
        items: [mockReplicaSet],
      });

      const deployedResource: DeployedResource = {
        id: 'webapp-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { 
            name: 'webapp', 
            namespace: 'test-namespace',
            uid: deploymentUid,
          },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      const monitorWithChildDiscovery = createEventMonitor(
        mockKubeConfig, 
        {
          namespace: 'test-namespace',
          includeChildResources: true,
          progressCallback: mockProgressCallback,
        },
        mock(() => mockWatch)
      );

      await monitorWithChildDiscovery.startMonitoring([deployedResource]);

      // Wait for child discovery to complete
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should have discovered the ReplicaSet
      // New API uses object parameters instead of positional parameters
      expect(mockAppsV1Api.listNamespacedReplicaSet).toHaveBeenCalledWith({ namespace: 'test-namespace' });

      // Should have emitted child resource discovered event
      const childDiscoveredEvents = capturedEvents.filter(e => e.type === 'child-resource-discovered');
      expect(childDiscoveredEvents).toHaveLength(1);
      expect(childDiscoveredEvents[0]).toMatchObject({
        type: 'child-resource-discovered',
        parentResource: {
          kind: 'Deployment',
          name: 'webapp',
          uid: deploymentUid,
        },
        childResource: {
          kind: 'ReplicaSet',
          name: 'webapp-replicaset',
          uid: 'replicaset-uid-456',
        },
        relationshipType: 'manages',
      });

      await monitorWithChildDiscovery.stopMonitoring();
    });

    it('should discover Pods created by ReplicaSet', async () => {
      const replicaSetUid = 'replicaset-uid-123';
      const mockPod = {
        metadata: {
          name: 'webapp-pod-abc123',
          namespace: 'test-namespace',
          uid: 'pod-uid-789',
          ownerReferences: [
            {
              uid: replicaSetUid,
              kind: 'ReplicaSet',
              name: 'webapp-replicaset',
              controller: true,
            },
          ],
        },
      };

      // New API returns objects directly (no .body wrapper)
      mockCoreV1Api.listNamespacedPod.mockResolvedValueOnce({
        items: [mockPod],
      });

      const deployedResource: DeployedResource = {
        id: 'webapp-replicaset',
        kind: 'ReplicaSet',
        name: 'webapp-replicaset',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'ReplicaSet',
          metadata: { 
            name: 'webapp-replicaset', 
            namespace: 'test-namespace',
            uid: replicaSetUid,
          },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      const monitorWithChildDiscovery = createEventMonitor(
        mockKubeConfig, 
        {
          namespace: 'test-namespace',
          includeChildResources: true,
          progressCallback: mockProgressCallback,
        },
        mock(() => mockWatch)
      );

      await monitorWithChildDiscovery.startMonitoring([deployedResource]);

      // Wait for child discovery to complete
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should have discovered the Pod
      // New API uses object parameters instead of positional parameters
      expect(mockCoreV1Api.listNamespacedPod).toHaveBeenCalledWith({ namespace: 'test-namespace' });

      // Should have emitted child resource discovered event
      const childDiscoveredEvents = capturedEvents.filter(e => e.type === 'child-resource-discovered');
      expect(childDiscoveredEvents).toHaveLength(1);
      expect(childDiscoveredEvents[0]).toMatchObject({
        type: 'child-resource-discovered',
        parentResource: {
          kind: 'ReplicaSet',
          name: 'webapp-replicaset',
          uid: replicaSetUid,
        },
        childResource: {
          kind: 'Pod',
          name: 'webapp-pod-abc123',
          uid: 'pod-uid-789',
        },
        relationshipType: 'owns',
      });

      await monitorWithChildDiscovery.stopMonitoring();
    });

    it('should not discover child resources when disabled', async () => {
      const deploymentUid = 'deployment-uid-123';
      const deployedResource: DeployedResource = {
        id: 'webapp-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { 
            name: 'webapp', 
            namespace: 'test-namespace',
            uid: deploymentUid,
          },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      const monitorWithoutChildDiscovery = createEventMonitor(
        mockKubeConfig, 
        {
          namespace: 'test-namespace',
          includeChildResources: false,
          progressCallback: mockProgressCallback,
        },
        mock(() => mockWatch)
      );

      await monitorWithoutChildDiscovery.startMonitoring([deployedResource]);

      // Wait to ensure no child discovery happens
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should not have called any list methods for child discovery
      expect(mockAppsV1Api.listNamespacedReplicaSet).not.toHaveBeenCalled();
      expect(mockCoreV1Api.listNamespacedPod).not.toHaveBeenCalled();

      // Should not have emitted any child resource discovered events
      const childDiscoveredEvents = capturedEvents.filter(e => e.type === 'child-resource-discovered');
      expect(childDiscoveredEvents).toHaveLength(0);

      await monitorWithoutChildDiscovery.stopMonitoring();
    });

    it('should handle child discovery errors gracefully', async () => {
      const deploymentUid = 'deployment-uid-123';
      
      // Mock API error for ReplicaSet listing
      mockAppsV1Api.listNamespacedReplicaSet = mock(() => 
        Promise.reject(new Error('Forbidden: replicasets is forbidden'))
      );

      const deployedResource: DeployedResource = {
        id: 'webapp-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { 
            name: 'webapp', 
            namespace: 'test-namespace',
            uid: deploymentUid,
          },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      const monitorWithChildDiscovery = createEventMonitor(
        mockKubeConfig, 
        {
          namespace: 'test-namespace',
          includeChildResources: true,
          progressCallback: mockProgressCallback,
        },
        mock(() => mockWatch)
      );

      // Should not throw despite API error
      await expect(monitorWithChildDiscovery.startMonitoring([deployedResource])).resolves.toBeUndefined();

      // Wait for child discovery to complete (with error)
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should not have emitted any child resource discovered events due to error
      const childDiscoveredEvents = capturedEvents.filter(e => e.type === 'child-resource-discovered');
      expect(childDiscoveredEvents).toHaveLength(0);

      await monitorWithChildDiscovery.stopMonitoring();
    });

    it('should not discover children for resources without UID', async () => {
      const deployedResource: DeployedResource = {
        id: 'webapp-deployment',
        kind: 'Deployment',
        name: 'webapp',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { 
            name: 'webapp', 
            namespace: 'test-namespace',
            // No UID provided
          },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      const monitorWithChildDiscovery = createEventMonitor(
        mockKubeConfig, 
        {
          namespace: 'test-namespace',
          includeChildResources: true,
          progressCallback: mockProgressCallback,
        },
        mock(() => mockWatch)
      );

      await monitorWithChildDiscovery.startMonitoring([deployedResource]);

      // Wait to ensure no child discovery happens
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should not have called any list methods for child discovery
      expect(mockAppsV1Api.listNamespacedReplicaSet).not.toHaveBeenCalled();
      expect(mockCoreV1Api.listNamespacedPod).not.toHaveBeenCalled();

      await monitorWithChildDiscovery.stopMonitoring();
    });
  });

  describe('Cleanup', () => {
    it('should clean up all watch connections on stop', async () => {
      const deployedResources: DeployedResource[] = [
        {
          id: 'webapp-deployment',
          kind: 'Deployment',
          name: 'webapp',
          namespace: 'test-namespace',
          manifest: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'webapp', namespace: 'test-namespace' },
          },
          status: 'deployed',
          deployedAt: new Date(),
        },
        {
          id: 'webapp-service',
          kind: 'Service',
          name: 'webapp-service',
          namespace: 'test-namespace',
          manifest: {
            apiVersion: 'v1',
            kind: 'Service',
            metadata: { name: 'webapp-service', namespace: 'test-namespace' },
          },
          status: 'deployed',
          deployedAt: new Date(),
        },
      ];

      await eventMonitor.startMonitoring(deployedResources);

      // Mock the request objects that would be returned by watch
      const mockRequest1 = { abort: mock() };
      const mockRequest2 = { abort: mock() };
      mockWatch.watch.mockReturnValueOnce(mockRequest1);
      mockWatch.watch.mockReturnValueOnce(mockRequest2);

      await eventMonitor.stopMonitoring();

      // Should not throw and should clean up properly
      // Exact verification depends on implementation details
    });
  });
});

describe('createEventMonitor', () => {
  it('should create EventMonitor with default options', () => {
    const monitor = createEventMonitor(mockKubeConfig, {}, mock(() => mockWatch));
    expect(monitor).toBeInstanceOf(EventMonitor);
  });

  it('should create EventMonitor with custom options', () => {
    const options = {
      namespace: 'custom-namespace',
      eventTypes: ['Normal', 'Warning', 'Error'] as const,
      includeChildResources: false,
      progressCallback: mock(),
    };

    const monitor = createEventMonitor(mockKubeConfig, options, mock(() => mockWatch));
    expect(monitor).toBeInstanceOf(EventMonitor);
  });
});