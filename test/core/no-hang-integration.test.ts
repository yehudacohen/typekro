/**
 * Integration test to verify that stopMonitoring prevents hanging
 *
 * This test simulates the real-world scenario where:
 * 1. Event monitoring is started
 * 2. Connections are established
 * 3. stopMonitoring is called (simulating process exit)
 * 4. The process should exit cleanly without hanging
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
// @ts-ignore - vi from vitest used for mocking
import { vi } from 'vitest';
import type * as k8s from '@kubernetes/client-node';
import { EventMonitor } from '../../src/core/deployment/event-monitor.js';
import type { DeployedResource } from '../../src/core/types/deployment.js';

describe('No Hang Integration Test', () => {
  let eventMonitor: EventMonitor;
  let mockK8sApi: k8s.CoreV1Api;
  let mockKubeConfig: k8s.KubeConfig;

  beforeEach(() => {
    // Create realistic mocks that simulate actual Kubernetes client behavior
    mockK8sApi = {
      getAPIResources: vi.fn().mockResolvedValue({ body: { resources: [] } }),
      listNamespacedEvent: vi.fn().mockResolvedValue({ body: { items: [] } }),
    } as any;

    mockKubeConfig = {
      makeApiClient: vi.fn().mockReturnValue(mockK8sApi),
      getCurrentContext: vi.fn().mockReturnValue('test-context'),
      getCurrentCluster: vi.fn().mockReturnValue({ server: 'https://test-server' }),
      getCurrentUser: vi.fn().mockReturnValue({ name: 'test-user' }),
    } as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should complete stopMonitoring quickly without hanging', async () => {
    // Create a realistic watch factory that simulates actual behavior
    const mockWatchFactory = () => {
      const mockSocket = {
        destroyed: false,
        unref: vi.fn(),
        destroy: vi.fn(),
        removeAllListeners: vi.fn(),
        on: vi.fn(),
      };

      const mockRequest = {
        abort: vi.fn(),
        removeAllListeners: vi.fn(),
        req: { socket: mockSocket },
        on: vi.fn(),
      };

      return {
        watch: vi
          .fn()
          .mockImplementation(async (_path: any, _options: any, _onEvent: any, _onError: any) => {
            // Simulate the watch connection being established
            return mockRequest;
          }),
        removeAllListeners: vi.fn(),
      } as any as k8s.Watch;
    };

    eventMonitor = new EventMonitor(
      mockK8sApi,
      mockKubeConfig,
      {
        namespace: 'test-namespace',
        eventTypes: ['Warning', 'Error'],
        includeChildResources: false, // Disable to avoid timer complications
      },
      mockWatchFactory
    );

    // Start monitoring with multiple resources to create multiple connections
    const testResources: DeployedResource[] = [
      {
        id: 'test-deployment-1',
        kind: 'Deployment',
        name: 'test-app-1',
        namespace: 'test-namespace',
        status: 'deployed',
        deployedAt: new Date(),
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'test-app-1', namespace: 'test-namespace' },
        },
      },
      {
        id: 'test-service-1',
        kind: 'Service',
        name: 'test-svc-1',
        namespace: 'test-namespace',
        status: 'deployed',
        deployedAt: new Date(),
        manifest: {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: { name: 'test-svc-1', namespace: 'test-namespace' },
        },
      },
    ];

    await eventMonitor.startMonitoring(testResources);

    // Verify monitoring is active
    expect((eventMonitor as any).isMonitoring).toBe(true);
    expect((eventMonitor as any).watchConnections.size).toBeGreaterThan(0);

    // Measure time for stopMonitoring - it should complete quickly
    const startTime = Date.now();

    await eventMonitor.stopMonitoring();

    const endTime = Date.now();
    const cleanupTime = endTime - startTime;

    // stopMonitoring should complete in well under 100ms
    expect(cleanupTime).toBeLessThan(100);

    // Verify cleanup was thorough
    expect((eventMonitor as any).isMonitoring).toBe(false);
    expect((eventMonitor as any).watchConnections.size).toBe(0);
    expect((eventMonitor as any).monitoredResources.size).toBe(0);
    expect((eventMonitor as any).activeTimers.size).toBe(0);
  });

  it('should handle cleanup even when sockets are in various states', async () => {
    let socketCount = 0;

    const mockWatchFactory = () => {
      socketCount++;

      // Create different socket states to test robustness
      const mockSocket = {
        destroyed: socketCount % 2 === 0, // Every other socket is destroyed
        unref: vi.fn(),
        destroy: vi.fn(),
        removeAllListeners: vi.fn(),
        on: vi.fn(),
      };

      // Sometimes make methods throw errors
      if (socketCount === 2) {
        mockSocket.unref.mockImplementation(() => {
          throw new Error('ECONNRESET');
        });
      }

      const mockRequest = {
        abort: vi.fn(),
        removeAllListeners: vi.fn(),
        req: socketCount % 3 === 0 ? {} : { socket: mockSocket }, // Sometimes no socket
        on: vi.fn(),
      };

      return {
        watch: vi.fn().mockResolvedValue(mockRequest),
        removeAllListeners: vi.fn(),
      } as any as k8s.Watch;
    };

    eventMonitor = new EventMonitor(
      mockK8sApi,
      mockKubeConfig,
      {
        namespace: 'test-namespace',
        includeChildResources: false,
      },
      mockWatchFactory
    );

    // Create multiple resources to test various socket states
    const testResources: DeployedResource[] = Array.from({ length: 5 }, (_, i) => ({
      id: `test-resource-${i}`,
      kind: 'Deployment',
      name: `test-app-${i}`,
      namespace: 'test-namespace',
      status: 'deployed',
      deployedAt: new Date(),
      manifest: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: `test-app-${i}`, namespace: 'test-namespace' },
      },
    }));

    await eventMonitor.startMonitoring(testResources);

    // stopMonitoring should handle all socket states gracefully
    await eventMonitor.stopMonitoring();

    // Verify complete cleanup
    expect((eventMonitor as any).isMonitoring).toBe(false);
    expect((eventMonitor as any).watchConnections.size).toBe(0);
  });

  it('should be safe to call stopMonitoring before startMonitoring', async () => {
    eventMonitor = new EventMonitor(mockK8sApi, mockKubeConfig, { namespace: 'test-namespace' });

    // Should be safe to call stopMonitoring on uninitialized monitor
    await eventMonitor.stopMonitoring();

    expect((eventMonitor as any).isMonitoring).toBe(false);
  });

  it('should be safe to call stopMonitoring after stopMonitoring', async () => {
    const mockWatchFactory = () =>
      ({
        watch: vi.fn().mockResolvedValue({
          abort: vi.fn(),
          removeAllListeners: vi.fn(),
          on: vi.fn(),
        }),
        removeAllListeners: vi.fn(),
      }) as any as k8s.Watch;

    eventMonitor = new EventMonitor(
      mockK8sApi,
      mockKubeConfig,
      { namespace: 'test-namespace' },
      mockWatchFactory
    );

    const testResource: DeployedResource = {
      id: 'test-deployment',
      kind: 'Deployment',
      name: 'test-app',
      namespace: 'test-namespace',
      status: 'deployed',
      deployedAt: new Date(),
      manifest: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test-app', namespace: 'test-namespace' },
      },
    };

    await eventMonitor.startMonitoring([testResource]);
    await eventMonitor.stopMonitoring();

    // Should be safe to call stopMonitoring again after normal stop
    await eventMonitor.stopMonitoring();

    expect((eventMonitor as any).isMonitoring).toBe(false);
  });
});
