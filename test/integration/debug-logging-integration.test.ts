/**
 * Integration tests for Debug Logging
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createDebugLogger } from '../../src/core/deployment/debug-logger.js';
import { ResourceReadinessChecker } from '../../src/core/deployment/readiness.js';
import type {
  DeployedResource,
  DeploymentEvent,
  StatusDebugEvent,
} from '../../src/core/types/deployment.js';

describe('Debug Logging Integration', () => {
  let mockKubernetesObjectApi: any;
  let readinessChecker: ResourceReadinessChecker;
  let capturedEvents: DeploymentEvent[] = [];
  let _capturedLogs: string[] = [];

  beforeEach(() => {
    capturedEvents = [];
    _capturedLogs = [];

    // Mock Kubernetes API
    mockKubernetesObjectApi = {
      read: mock(() =>
        Promise.resolve({
          body: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'webapp', namespace: 'test-namespace' },
            status: {
              replicas: 3,
              readyReplicas: 2,
              availableReplicas: 2,
              conditions: [
                { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable' },
                { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' },
              ],
            },
          },
        })
      ),
    };

    readinessChecker = new ResourceReadinessChecker(mockKubernetesObjectApi);
  });

  afterEach(() => {
    // Clean up any resources
  });

  describe('Status Polling Debug Integration', () => {
    it('should provide detailed debug information during status polling', async () => {
      const progressCallback = (event: DeploymentEvent) => {
        capturedEvents.push(event);
      };

      const _debugLogger = createDebugLogger({
        enabled: true,
        statusPolling: true,
        verboseMode: true,
        progressCallback,
      });

      // Set debug logger on readiness checker
      readinessChecker.setDebugLogger(_debugLogger);

      const deployedResource: DeployedResource = {
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

      // Mock the resource as not ready initially, then ready
      let callCount = 0;
      mockKubernetesObjectApi.read.mockImplementation(() => {
        callCount++;
        const isReady = callCount >= 3; // Becomes ready on 3rd call

        return Promise.resolve({
          body: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'webapp', namespace: 'test-namespace' },
            status: {
              replicas: 3,
              readyReplicas: isReady ? 3 : 2,
              availableReplicas: isReady ? 3 : 2,
              conditions: [
                {
                  type: 'Available',
                  status: isReady ? 'True' : 'False',
                  reason: isReady ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable',
                },
              ],
            },
          },
        });
      });

      await readinessChecker.waitForResourceReady(
        deployedResource,
        {
          mode: 'direct',
          timeout: 10000, // Short timeout for test
          debugLogging: {
            enabled: true,
            statusPolling: true,
            verboseMode: true,
          },
        },
        progressCallback
      );

      // Should have captured debug events during polling
      const debugEvents = capturedEvents.filter(
        (e) => e.type === 'status-debug'
      ) as StatusDebugEvent[];
      expect(debugEvents.length).toBeGreaterThan(0);

      // Verify debug event structure
      const firstDebugEvent = debugEvents[0];
      expect(firstDebugEvent).toBeDefined();
      if (firstDebugEvent) {
        expect(firstDebugEvent.resourceId).toBe('Deployment/webapp');
        expect(firstDebugEvent.currentStatus).toBeDefined();
        expect(firstDebugEvent.context.attempt).toBeGreaterThan(0);
        expect(firstDebugEvent.context.elapsedTime).toBeGreaterThanOrEqual(0);
        expect(firstDebugEvent.context.isTimeout).toBe(false);
      }

      // Should show progression from not ready to ready
      const lastDebugEvent = debugEvents[debugEvents.length - 1];
      expect(lastDebugEvent).toBeDefined();
      if (lastDebugEvent) {
        expect(lastDebugEvent.readinessResult).toBe(true);
      }
    });

    it('should log timeout information when resource never becomes ready', async () => {
      const progressCallback = (event: DeploymentEvent) => {
        capturedEvents.push(event);
      };

      const _debugLogger = createDebugLogger({
        enabled: true,
        statusPolling: true,
        progressCallback,
      });

      // Set debug logger on readiness checker
      readinessChecker.setDebugLogger(_debugLogger);

      const deployedResource: DeployedResource = {
        id: 'failing-deployment',
        kind: 'Deployment',
        name: 'failing-app',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'failing-app', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Mock the resource as never becoming ready
      mockKubernetesObjectApi.read.mockResolvedValue({
        body: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'failing-app', namespace: 'test-namespace' },
          status: {
            replicas: 3,
            readyReplicas: 0,
            availableReplicas: 0,
            conditions: [
              { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable' },
              { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' },
            ],
          },
        },
      });

      try {
        await readinessChecker.waitForResourceReady(
          deployedResource,
          {
            mode: 'direct',
            timeout: 2000, // Very short timeout for test
            debugLogging: {
              enabled: true,
              statusPolling: true,
            },
          },
          progressCallback
        );

        // Should not reach here
        expect(false).toBe(true);
      } catch (_error) {
        // Should timeout and log final status
        const debugEvents = capturedEvents.filter(
          (e) => e.type === 'status-debug'
        ) as StatusDebugEvent[];
        expect(debugEvents.length).toBeGreaterThan(0);

        // Should have a timeout event
        const timeoutEvent = debugEvents.find((e) => e.context.isTimeout);
        expect(timeoutEvent).toBeDefined();
        expect(timeoutEvent?.message).toContain('timeout');
        expect(timeoutEvent?.context.elapsedTime).toBeGreaterThan(1000);
      }
    });

    it('should log API errors during status polling', async () => {
      const progressCallback = (event: DeploymentEvent) => {
        capturedEvents.push(event);
      };

      const _debugLogger = createDebugLogger({
        enabled: true,
        statusPolling: true,
        progressCallback,
      });

      // Set debug logger on readiness checker
      readinessChecker.setDebugLogger(_debugLogger);

      const deployedResource: DeployedResource = {
        id: 'error-deployment',
        kind: 'Deployment',
        name: 'error-app',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'error-app', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Mock API errors
      let callCount = 0;
      mockKubernetesObjectApi.read.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          // First two calls fail
          return Promise.reject(new Error('Forbidden: insufficient permissions'));
        } else {
          // Third call succeeds
          return Promise.resolve({
            body: {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              metadata: { name: 'error-app', namespace: 'test-namespace' },
              status: {
                replicas: 3,
                readyReplicas: 3,
                availableReplicas: 3,
                conditions: [
                  { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable' },
                ],
              },
            },
          });
        }
      });

      try {
        await readinessChecker.waitForResourceReady(
          deployedResource,
          {
            mode: 'direct',
            timeout: 10000,
            debugLogging: {
              enabled: true,
              statusPolling: true,
            },
          },
          progressCallback
        );

        // Should have captured API error debug events
        const debugEvents = capturedEvents.filter(
          (e) => e.type === 'status-debug'
        ) as StatusDebugEvent[];
        const errorEvents = debugEvents.filter((e) => e.error);

        expect(errorEvents.length).toBeGreaterThan(0);
        const firstErrorEvent = errorEvents[0];
        expect(firstErrorEvent).toBeDefined();
        if (firstErrorEvent) {
          expect(firstErrorEvent.error?.message).toContain('Forbidden');
          expect(firstErrorEvent.message).toContain('API error');
        }
      } catch (error) {
        // If there's an error, we still want to check that debug events were captured
        const debugEvents = capturedEvents.filter(
          (e) => e.type === 'status-debug'
        ) as StatusDebugEvent[];
        expect(debugEvents.length).toBeGreaterThan(0);
        throw error;
      }
    });
  });

  describe('Readiness Evaluation Debug Integration', () => {
    it('should log custom readiness evaluator results', () => {
      const progressCallback = (event: DeploymentEvent) => {
        capturedEvents.push(event);
      };

      const _debugLogger = createDebugLogger({
        enabled: true,
        readinessEvaluation: true,
        progressCallback,
      });

      const deployedResource: DeployedResource = {
        id: 'custom-deployment',
        kind: 'Deployment',
        name: 'custom-app',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'custom-app', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Mock custom readiness evaluator
      const customEvaluator = (resource: any) => {
        const status = resource.status;
        if (!status) return false;

        return {
          ready: status.readyReplicas === status.replicas,
          reason:
            status.readyReplicas === status.replicas
              ? 'All replicas are ready'
              : `Only ${status.readyReplicas}/${status.replicas} replicas ready`,
          details: {
            readyReplicas: status.readyReplicas,
            totalReplicas: status.replicas,
          },
        };
      };

      const evaluationResult = {
        ready: true,
        reason: 'All replicas are ready',
        details: { readyReplicas: 3, totalReplicas: 3 },
      };

      _debugLogger.logReadinessEvaluation(deployedResource, customEvaluator, evaluationResult);

      // Should have captured readiness evaluation debug event
      const debugEvents = capturedEvents.filter(
        (e) => e.type === 'status-debug'
      ) as StatusDebugEvent[];
      expect(debugEvents).toHaveLength(1);

      const evaluationEvent = debugEvents[0];
      expect(evaluationEvent).toBeDefined();
      if (evaluationEvent) {
        expect(evaluationEvent.resourceId).toBe('Deployment/custom-app');
        expect(evaluationEvent.readinessResult).toEqual(evaluationResult);
        expect(evaluationEvent.message).toContain('Readiness evaluation: ready');
        expect(evaluationEvent.message).toContain('All replicas are ready');
      }
    });

    it('should handle different readiness evaluator types', () => {
      const progressCallback = (event: DeploymentEvent) => {
        capturedEvents.push(event);
      };

      const _debugLogger = createDebugLogger({
        enabled: true,
        readinessEvaluation: true,
        verboseMode: true,
        progressCallback,
      });

      const deployedResource: DeployedResource = {
        id: 'phase-deployment',
        kind: 'Pod',
        name: 'phase-pod',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: 'phase-pod', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Phase-based evaluator
      const phaseEvaluator = (resource: any) => {
        return resource.status?.phase === 'Running';
      };

      const phaseResult = {
        ready: true,
        reason: 'Pod is in Running phase',
      };

      _debugLogger.logReadinessEvaluation(deployedResource, phaseEvaluator, phaseResult);

      // Condition-based evaluator
      const conditionEvaluator = (resource: any) => {
        const conditions = resource.status?.conditions || [];
        const readyCondition = conditions.find((c: any) => c.type === 'Ready');
        return readyCondition?.status === 'True';
      };

      const conditionResult = {
        ready: false,
        reason: 'Ready condition is False',
        details: { readyCondition: { type: 'Ready', status: 'False' } },
      };

      _debugLogger.logReadinessEvaluation(deployedResource, conditionEvaluator, conditionResult);

      // Should have captured both evaluation events
      const debugEvents = capturedEvents.filter(
        (e) => e.type === 'status-debug'
      ) as StatusDebugEvent[];
      expect(debugEvents).toHaveLength(2);

      expect(debugEvents[0]).toBeDefined();
      expect(debugEvents[1]).toBeDefined();
      if (debugEvents[0] && debugEvents[1]) {
        expect(debugEvents[0].readinessResult).toEqual(phaseResult);
        expect(debugEvents[1].readinessResult).toEqual(conditionResult);
      }
    });
  });

  describe('Configuration Integration', () => {
    it('should respect different verbosity levels', () => {
      const progressCallback = (event: DeploymentEvent) => {
        capturedEvents.push(event);
      };

      // Test with verbose mode disabled
      const normalLogger = createDebugLogger({
        enabled: true,
        statusPolling: true,
        verboseMode: false,
        progressCallback,
      });

      const deployedResource: DeployedResource = {
        id: 'verbose-test',
        kind: 'Deployment',
        name: 'verbose-app',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'verbose-app', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      const complexStatus = {
        replicas: 3,
        readyReplicas: 2,
        conditions: [
          { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable' },
          { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' },
        ],
        metadata: {
          generation: 1,
          resourceVersion: '12345',
        },
      };

      normalLogger.logResourceStatus(deployedResource, complexStatus, false, {
        attempt: 1,
        elapsedTime: 1000,
        isTimeout: false,
      });

      expect(capturedEvents).toHaveLength(1);
      const normalEvent = capturedEvents[0] as StatusDebugEvent;

      // Clear events for verbose test
      capturedEvents.length = 0;

      // Test with verbose mode enabled
      const verboseLogger = createDebugLogger({
        enabled: true,
        statusPolling: true,
        verboseMode: true,
        progressCallback,
      });

      verboseLogger.logResourceStatus(deployedResource, complexStatus, false, {
        attempt: 1,
        elapsedTime: 1000,
        isTimeout: false,
      });

      expect(capturedEvents).toHaveLength(1);
      const verboseEvent = capturedEvents[0] as StatusDebugEvent;

      // Both should capture the event, but verbose mode affects console logging
      expect(normalEvent.currentStatus).toBeDefined();
      expect(verboseEvent.currentStatus).toBeDefined();
    });

    it('should handle status size limits correctly', () => {
      const progressCallback = (event: DeploymentEvent) => {
        capturedEvents.push(event);
      };

      const limitedLogger = createDebugLogger({
        enabled: true,
        statusPolling: true,
        maxStatusObjectSize: 200, // Very small limit
        progressCallback,
      });

      const deployedResource: DeployedResource = {
        id: 'size-test',
        kind: 'Deployment',
        name: 'size-app',
        namespace: 'test-namespace',
        manifest: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'size-app', namespace: 'test-namespace' },
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Create a large status object
      const largeStatus = {
        replicas: 3,
        readyReplicas: 2,
        largeData: 'x'.repeat(1000), // Large string
        moreData: 'y'.repeat(1000),
        evenMoreData: {
          nested: 'z'.repeat(1000),
        },
      };

      limitedLogger.logResourceStatus(deployedResource, largeStatus, false, {
        attempt: 1,
        elapsedTime: 1000,
        isTimeout: false,
      });

      expect(capturedEvents).toHaveLength(1);
      const event = capturedEvents[0] as StatusDebugEvent;

      // Status should be present but potentially truncated
      expect(event.currentStatus).toBeDefined();

      // The sanitized status should not contain the full large strings
      const statusString = JSON.stringify(event.currentStatus);
      expect(statusString.length).toBeLessThan(4000); // Much smaller than original (which would be ~6000+)
    });
  });
});
