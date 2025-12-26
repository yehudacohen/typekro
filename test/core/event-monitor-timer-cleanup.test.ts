/**
 * Test for EventMonitor timer cleanup to prevent race conditions
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type EventMonitor, createEventMonitor } from '../../src/core/deployment/event-monitor.js';
import type { DeployedResource } from '../../src/core/types/deployment.js';

describe('EventMonitor Timer Cleanup', () => {
  let eventMonitor: EventMonitor;
  let mockKubeConfig: k8s.KubeConfig;
  let mockWatch: any;

  beforeEach(() => {
    // Mock KubeConfig
    mockKubeConfig = {
      makeApiClient: mock(() => ({
        listNamespacedEvent: mock(() => Promise.resolve({ body: { items: [] } })),
        listNamespacedReplicaSet: mock(() => Promise.resolve({ body: { items: [] } })),
        listNamespacedPod: mock(() => Promise.resolve({ body: { items: [] } })),
      })),
    } as any;

    // Mock Watch
    mockWatch = {
      watch: mock(() => Promise.resolve()),
    };

    eventMonitor = createEventMonitor(
      mockKubeConfig,
      {
        namespace: 'test-namespace',
        eventTypes: ['Warning', 'Error'],
        includeChildResources: true, // Enable child discovery to trigger timers
      },
      mock(() => mockWatch)
    );
  });

  afterEach(async () => {
    if (eventMonitor) {
      await eventMonitor.stopMonitoring();
    }
  });

  it('should cancel pending child discovery timers during cleanup', async () => {
    // Create a resource with UID to trigger child discovery timer
    const deployedResource: DeployedResource = {
      id: 'test-deployment-id',
      kind: 'Deployment',
      name: 'test-deployment',
      namespace: 'test-namespace',
      manifest: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'test-deployment',
          namespace: 'test-namespace',
          uid: 'test-uid-123', // This will trigger setTimeout for child discovery
          resourceVersion: '12345',
          creationTimestamp: new Date(),
        },
        spec: {},
      },
      status: 'deployed',
      deployedAt: new Date(),
    };

    // Start monitoring - this will create timers for child discovery
    await eventMonitor.startMonitoring([deployedResource]);

    // Stop monitoring immediately (before 1-second timer fires)
    // This should cancel the pending timer and prevent race conditions
    const stopPromise = eventMonitor.stopMonitoring();

    // The stop should complete quickly without waiting for timers
    const startTime = Date.now();
    await stopPromise;
    const endTime = Date.now();

    // Should complete in well under 1000ms (the timer delay)
    expect(endTime - startTime).toBeLessThan(500);
  });

  it('should handle multiple resources with timers during cleanup', async () => {
    // Create multiple resources with UIDs to trigger multiple timers
    const deployedResources: DeployedResource[] = [
      {
        id: 'deployment-1-id',
        kind: 'Deployment',
        name: 'deployment-1',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: {
            name: 'deployment-1',
            namespace: 'test-namespace',
            uid: 'uid-1',
            resourceVersion: '1',
            creationTimestamp: new Date(),
          },
          spec: {},
        },
        status: 'deployed',
        deployedAt: new Date(),
      },
      {
        id: 'service-1-id',
        kind: 'Service',
        name: 'service-1',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name: 'service-1',
            namespace: 'test-namespace',
            uid: 'uid-2',
            resourceVersion: '2',
            creationTimestamp: new Date(),
          },
          spec: {},
        },
        status: 'deployed',
        deployedAt: new Date(),
      },
      {
        id: 'pod-1-id',
        kind: 'Pod',
        name: 'pod-1',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: {
            name: 'pod-1',
            namespace: 'test-namespace',
            uid: 'uid-3',
            resourceVersion: '3',
            creationTimestamp: new Date(),
          },
          spec: {},
        },
        status: 'deployed',
        deployedAt: new Date(),
      },
    ];

    // Start monitoring - this will create multiple timers
    await eventMonitor.startMonitoring(deployedResources);

    // Stop monitoring immediately
    const startTime = Date.now();
    await eventMonitor.stopMonitoring();
    const endTime = Date.now();

    // Should complete quickly even with multiple timers
    expect(endTime - startTime).toBeLessThan(500);
  });

  it('should not interfere with normal operation when no timers are pending', async () => {
    // Create a resource without UID (no timer will be created)
    const deployedResource: DeployedResource = {
      id: 'test-deployment-id',
      kind: 'Deployment',
      name: 'test-deployment',
      namespace: 'test-namespace',
      manifest: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'test-deployment',
          namespace: 'test-namespace',
          // No UID - no timer will be created
          resourceVersion: '12345',
          creationTimestamp: new Date(),
        },
        spec: {},
      },
      status: 'deployed',
      deployedAt: new Date(),
    };

    await eventMonitor.startMonitoring([deployedResource]);
    
    // This should work normally without any timer cleanup needed
    await expect(eventMonitor.stopMonitoring()).resolves.toBeUndefined();
  });
});