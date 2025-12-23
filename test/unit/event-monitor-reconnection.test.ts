/**
 * Test suite for EventMonitor reconnection logic
 *
 * Tests the exponential backoff with jitter reconnection mechanism
 * implemented in the EventMonitor class.
 */

import { describe, expect, it, mock, spyOn } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { EventMonitor } from '../../src/core/deployment/event-monitor.js';

describe('EventMonitor Reconnection Logic', () => {
  // Mock KubeConfig
  const createMockKubeConfig = () => {
    const mockKubeConfig = {
      makeApiClient: mock(() => ({
        listNamespacedEvent: mock(() =>
          Promise.resolve({ metadata: { resourceVersion: '12345' }, items: [] })
        ),
        listNamespacedPod: mock(() => Promise.resolve({ items: [] })),
        listNamespacedService: mock(() => Promise.resolve({ items: [] })),
        listNamespacedConfigMap: mock(() => Promise.resolve({ items: [] })),
        listNamespacedSecret: mock(() => Promise.resolve({ items: [] })),
      })),
    } as unknown as k8s.KubeConfig;
    return mockKubeConfig;
  };

  // Mock CoreV1Api
  const createMockCoreV1Api = () => {
    return {
      listNamespacedEvent: mock(() =>
        Promise.resolve({ metadata: { resourceVersion: '12345' }, items: [] })
      ),
      listNamespacedPod: mock(() => Promise.resolve({ items: [] })),
      listNamespacedService: mock(() => Promise.resolve({ items: [] })),
      listNamespacedConfigMap: mock(() => Promise.resolve({ items: [] })),
      listNamespacedSecret: mock(() => Promise.resolve({ items: [] })),
    } as unknown as k8s.CoreV1Api;
  };

  // Mock Watch factory
  const createMockWatchFactory = (options?: {
    shouldFail?: boolean;
    failCount?: number;
    onWatch?: () => void;
  }) => {
    let failuresRemaining = options?.failCount ?? 0;

    return (_config: k8s.KubeConfig): k8s.Watch => ({
      config: _config,
      requestTimeoutMs: 0,
      watch: mock(
        (
          _path: string,
          _options: any,
          _eventCallback: (type: string, obj: any, watchObj: any) => void,
          errorCallback: (error: Error) => void
        ) => {
          options?.onWatch?.();

          if (options?.shouldFail && failuresRemaining > 0) {
            failuresRemaining--;
            // Simulate connection error after a short delay
            setTimeout(() => {
              errorCallback(new Error('Connection reset'));
            }, 10);
          }

          return Promise.resolve({
            abort: mock(() => {}),
          });
        }
      ),
    } as unknown as k8s.Watch);
  };

  describe('calculateReconnectDelay', () => {
    it('should calculate exponential backoff delay', () => {
      const mockKubeConfig = createMockKubeConfig();
      const mockCoreV1Api = createMockCoreV1Api();

      const monitor = new EventMonitor(mockCoreV1Api, mockKubeConfig, {
        reconnectBaseDelay: 1000,
        reconnectMaxDelay: 30000,
        reconnectJitter: 0, // Disable jitter for predictable testing
      });

      // Access private method for testing
      const monitorPrivate = monitor as any;

      // Attempt 1: 1000 * 2^0 = 1000ms
      expect(monitorPrivate.calculateReconnectDelay(1)).toBe(1000);

      // Attempt 2: 1000 * 2^1 = 2000ms
      expect(monitorPrivate.calculateReconnectDelay(2)).toBe(2000);

      // Attempt 3: 1000 * 2^2 = 4000ms
      expect(monitorPrivate.calculateReconnectDelay(3)).toBe(4000);

      // Attempt 4: 1000 * 2^3 = 8000ms
      expect(monitorPrivate.calculateReconnectDelay(4)).toBe(8000);

      // Attempt 5: 1000 * 2^4 = 16000ms
      expect(monitorPrivate.calculateReconnectDelay(5)).toBe(16000);
    });

    it('should cap delay at maxReconnectDelay', () => {
      const mockKubeConfig = createMockKubeConfig();
      const mockCoreV1Api = createMockCoreV1Api();

      const monitor = new EventMonitor(mockCoreV1Api, mockKubeConfig, {
        reconnectBaseDelay: 1000,
        reconnectMaxDelay: 10000,
        reconnectJitter: 0,
      });

      const monitorPrivate = monitor as any;

      // Attempt 10: 1000 * 2^9 = 512000ms, but capped at 10000ms
      expect(monitorPrivate.calculateReconnectDelay(10)).toBe(10000);

      // Attempt 15: would be huge, but capped at 10000ms
      expect(monitorPrivate.calculateReconnectDelay(15)).toBe(10000);
    });

    it('should apply jitter within expected range', () => {
      const mockKubeConfig = createMockKubeConfig();
      const mockCoreV1Api = createMockCoreV1Api();

      const monitor = new EventMonitor(mockCoreV1Api, mockKubeConfig, {
        reconnectBaseDelay: 1000,
        reconnectMaxDelay: 30000,
        reconnectJitter: 0.2, // ±20%
      });

      const monitorPrivate = monitor as any;

      // Run multiple times to test jitter range
      const delays: number[] = [];
      for (let i = 0; i < 100; i++) {
        delays.push(monitorPrivate.calculateReconnectDelay(1));
      }

      // Base delay is 1000ms, jitter is ±20%, so range is 800-1200ms
      const minDelay = Math.min(...delays);
      const maxDelay = Math.max(...delays);

      expect(minDelay).toBeGreaterThanOrEqual(800);
      expect(maxDelay).toBeLessThanOrEqual(1200);

      // Verify there's actual variation (jitter is working)
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });

    it('should handle zero jitter', () => {
      const mockKubeConfig = createMockKubeConfig();
      const mockCoreV1Api = createMockCoreV1Api();

      const monitor = new EventMonitor(mockCoreV1Api, mockKubeConfig, {
        reconnectBaseDelay: 1000,
        reconnectMaxDelay: 30000,
        reconnectJitter: 0,
      });

      const monitorPrivate = monitor as any;

      // With zero jitter, delay should be exactly the exponential value
      const delay1 = monitorPrivate.calculateReconnectDelay(1);
      const delay2 = monitorPrivate.calculateReconnectDelay(1);

      expect(delay1).toBe(1000);
      expect(delay2).toBe(1000);
    });
  });

  describe('Reconnection Options', () => {
    it('should use default reconnection options', () => {
      const mockKubeConfig = createMockKubeConfig();
      const mockCoreV1Api = createMockCoreV1Api();

      const monitor = new EventMonitor(mockCoreV1Api, mockKubeConfig, {});

      const monitorPrivate = monitor as any;

      expect(monitorPrivate.options.maxReconnectAttempts).toBe(10);
      expect(monitorPrivate.options.reconnectBaseDelay).toBe(1000);
      expect(monitorPrivate.options.reconnectMaxDelay).toBe(30000);
      expect(monitorPrivate.options.reconnectJitter).toBe(0.2);
    });

    it('should allow custom reconnection options', () => {
      const mockKubeConfig = createMockKubeConfig();
      const mockCoreV1Api = createMockCoreV1Api();

      const monitor = new EventMonitor(mockCoreV1Api, mockKubeConfig, {
        maxReconnectAttempts: 5,
        reconnectBaseDelay: 500,
        reconnectMaxDelay: 15000,
        reconnectJitter: 0.1,
      });

      const monitorPrivate = monitor as any;

      expect(monitorPrivate.options.maxReconnectAttempts).toBe(5);
      expect(monitorPrivate.options.reconnectBaseDelay).toBe(500);
      expect(monitorPrivate.options.reconnectMaxDelay).toBe(15000);
      expect(monitorPrivate.options.reconnectJitter).toBe(0.1);
    });
  });

  describe('WatchConnection State', () => {
    it('should initialize watch connection with reconnection state', async () => {
      const mockKubeConfig = createMockKubeConfig();
      const mockCoreV1Api = createMockCoreV1Api();
      const mockWatchFactory = createMockWatchFactory();

      const monitor = new EventMonitor(
        mockCoreV1Api,
        mockKubeConfig,
        { namespace: 'test-ns' },
        mockWatchFactory
      );

      const monitorPrivate = monitor as any;

      // Start monitoring to create watch connections
      await monitor.startMonitoring([
        {
          id: 'test-deployment',
          kind: 'Deployment',
          name: 'test-app',
          namespace: 'test-ns',
          status: 'deployed',
          deployedAt: new Date(),
          manifest: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'test-app', namespace: 'test-ns' },
          },
        },
      ]);

      // Check that watch connections have reconnection state
      const connections = monitorPrivate.watchConnections;
      expect(connections.size).toBeGreaterThan(0);

      for (const [_key, connection] of connections) {
        expect(connection.reconnectAttempts).toBe(0);
        expect(connection.isReconnecting).toBe(false);
      }

      await monitor.stopMonitoring();
    });
  });

  describe('Degraded Monitoring Event', () => {
    it('should emit degraded monitoring event when max retries exceeded', async () => {
      const mockKubeConfig = createMockKubeConfig();
      const mockCoreV1Api = createMockCoreV1Api();

      const progressEvents: any[] = [];
      const progressCallback = (event: any) => {
        progressEvents.push(event);
      };

      const monitor = new EventMonitor(mockCoreV1Api, mockKubeConfig, {
        namespace: 'test-ns',
        maxReconnectAttempts: 2,
        reconnectBaseDelay: 10, // Very short for testing
        progressCallback,
      });

      const monitorPrivate = monitor as any;

      // Simulate a connection that has exceeded max attempts
      const mockConnection = {
        kind: 'Deployment',
        namespace: 'test-ns',
        fieldSelector: '',
        watcher: {},
        resources: new Set(['test-app']),
        reconnectAttempts: 2, // Already at max
        isReconnecting: false,
      };

      // Set monitoring to true to allow reconnection logic to run
      monitorPrivate.isMonitoring = true;

      // Call attemptReconnection which should emit degraded event
      await monitorPrivate.attemptReconnection(mockConnection);

      // Check that degraded event was emitted
      const degradedEvent = progressEvents.find(
        (e) => e.type === 'progress' && e.message.includes('degraded')
      );

      expect(degradedEvent).toBeDefined();
      expect(degradedEvent.message).toContain('Event monitoring degraded');
      expect(degradedEvent.message).toContain('Deployment');
      expect(degradedEvent.message).toContain('test-ns');
    });
  });

  describe('Reconnection Prevention', () => {
    it('should not reconnect when monitoring is stopped', async () => {
      const mockKubeConfig = createMockKubeConfig();
      const mockCoreV1Api = createMockCoreV1Api();

      const monitor = new EventMonitor(mockCoreV1Api, mockKubeConfig, {
        namespace: 'test-ns',
        maxReconnectAttempts: 10,
      });

      const monitorPrivate = monitor as any;

      // Ensure monitoring is stopped
      monitorPrivate.isMonitoring = false;

      const mockConnection = {
        kind: 'Deployment',
        namespace: 'test-ns',
        fieldSelector: '',
        watcher: {},
        resources: new Set(['test-app']),
        reconnectAttempts: 0,
        isReconnecting: false,
      };

      // Call attemptReconnection
      await monitorPrivate.attemptReconnection(mockConnection);

      // Connection should not have been modified
      expect(mockConnection.reconnectAttempts).toBe(0);
      expect(mockConnection.isReconnecting).toBe(false);
    });

    it('should not reconnect when already reconnecting', async () => {
      const mockKubeConfig = createMockKubeConfig();
      const mockCoreV1Api = createMockCoreV1Api();

      const monitor = new EventMonitor(mockCoreV1Api, mockKubeConfig, {
        namespace: 'test-ns',
        maxReconnectAttempts: 10,
      });

      const monitorPrivate = monitor as any;
      monitorPrivate.isMonitoring = true;

      const mockConnection = {
        kind: 'Deployment',
        namespace: 'test-ns',
        fieldSelector: '',
        watcher: {},
        resources: new Set(['test-app']),
        reconnectAttempts: 1,
        isReconnecting: true, // Already reconnecting
      };

      // Call attemptReconnection
      await monitorPrivate.attemptReconnection(mockConnection);

      // Reconnect attempts should not have increased
      expect(mockConnection.reconnectAttempts).toBe(1);
    });
  });

  describe('TimeoutError Handling', () => {
    it('should reset reconnect attempts on TimeoutError before calling attemptReconnection', () => {
      const mockKubeConfig = createMockKubeConfig();
      const mockCoreV1Api = createMockCoreV1Api();

      const monitor = new EventMonitor(mockCoreV1Api, mockKubeConfig, {
        namespace: 'test-ns',
      });

      const monitorPrivate = monitor as any;
      monitorPrivate.isMonitoring = true;

      const mockConnection = {
        kind: 'Deployment',
        namespace: 'test-ns',
        fieldSelector: '',
        watcher: {},
        resources: new Set(['test-app']),
        reconnectAttempts: 5, // Had some previous attempts
        isReconnecting: false,
      };

      // Create a TimeoutError
      const timeoutError = new Error('Timeout');
      timeoutError.name = 'TimeoutError';

      // Track what reconnectAttempts was when attemptReconnection was called
      let reconnectAttemptsWhenCalled: number | undefined;
      const originalAttemptReconnection = monitorPrivate.attemptReconnection.bind(monitorPrivate);
      monitorPrivate.attemptReconnection = (conn: any) => {
        reconnectAttemptsWhenCalled = conn.reconnectAttempts;
        // Don't actually call the original to avoid async complications
      };

      // Call handleWatchError with TimeoutError
      monitorPrivate.handleWatchError(timeoutError, mockConnection);

      // Reconnect attempts should have been reset to 0 BEFORE attemptReconnection was called
      expect(reconnectAttemptsWhenCalled).toBe(0);

      // Restore original method
      monitorPrivate.attemptReconnection = originalAttemptReconnection;
    });

    it('should ignore AbortError during cleanup', () => {
      const mockKubeConfig = createMockKubeConfig();
      const mockCoreV1Api = createMockCoreV1Api();

      const monitor = new EventMonitor(mockCoreV1Api, mockKubeConfig, {
        namespace: 'test-ns',
      });

      const monitorPrivate = monitor as any;
      monitorPrivate.isMonitoring = false; // Monitoring stopped (cleanup)

      const mockConnection = {
        kind: 'Deployment',
        namespace: 'test-ns',
        fieldSelector: '',
        watcher: {},
        resources: new Set(['test-app']),
        reconnectAttempts: 0,
        isReconnecting: false,
      };

      // Create an AbortError
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';

      // Spy on attemptReconnection to verify it's NOT called
      const attemptReconnectionSpy = spyOn(monitorPrivate, 'attemptReconnection');

      // Call handleWatchError with AbortError during cleanup
      monitorPrivate.handleWatchError(abortError, mockConnection);

      // attemptReconnection should NOT have been called
      expect(attemptReconnectionSpy).not.toHaveBeenCalled();
    });
  });
});
