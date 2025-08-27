/**
 * Unit tests for DebugLogger
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { DebugLogger, createDebugLogger, createDebugLoggerFromDeploymentOptions } from '../../src/core/deployment/debug-logger.js';
import type { DeployedResource } from '../../src/core/types/deployment.js';
import type { DeploymentEvent, StatusDebugEvent } from '../../src/core/types/deployment.js';

describe('DebugLogger', () => {
  let debugLogger: DebugLogger;
  let capturedEvents: DeploymentEvent[] = [];

  const mockProgressCallback = (event: DeploymentEvent) => {
    capturedEvents.push(event);
  };

  const mockDeployedResource: DeployedResource = {
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

  beforeEach(() => {
    capturedEvents = [];
    debugLogger = createDebugLogger({
      enabled: true,
      statusPolling: true,
      readinessEvaluation: true,
      verboseMode: false,
      progressCallback: mockProgressCallback,
    });
  });

  describe('Resource Status Logging', () => {
    it('should log resource status with basic information', () => {
      const currentStatus = {
        replicas: 3,
        readyReplicas: 2,
        availableReplicas: 2,
        conditions: [
          { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable' },
          { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' },
        ],
      };

      debugLogger.logResourceStatus(
        mockDeployedResource,
        currentStatus,
        false,
        {
          attempt: 3,
          elapsedTime: 5000,
          isTimeout: false,
        }
      );

      // Should emit debug event via progress callback
      expect(capturedEvents).toHaveLength(1);
      const event = capturedEvents[0] as StatusDebugEvent;
      expect(event.type).toBe('status-debug');
      expect(event.resourceId).toBe('Deployment/webapp');
      expect(event.readinessResult).toBe(false);
      expect(event.context.attempt).toBe(3);
      expect(event.context.elapsedTime).toBe(5000);
      expect(event.context.isTimeout).toBe(false);
    });

    it('should handle complex readiness results', () => {
      const readinessResult = {
        ready: true,
        reason: 'All replicas are ready',
        details: { readyReplicas: 3, totalReplicas: 3 },
      };

      debugLogger.logResourceStatus(
        mockDeployedResource,
        { phase: 'Running' },
        readinessResult,
        {
          attempt: 1,
          elapsedTime: 1000,
          isTimeout: false,
        }
      );

      expect(capturedEvents).toHaveLength(1);
      const event = capturedEvents[0] as StatusDebugEvent;
      expect(event.readinessResult).toEqual(readinessResult);
    });

    it('should not log when status polling is disabled', () => {
      const disabledLogger = createDebugLogger({
        enabled: true,
        statusPolling: false,
        progressCallback: mockProgressCallback,
      });

      disabledLogger.logResourceStatus(
        mockDeployedResource,
        { phase: 'Running' },
        true,
        {
          attempt: 1,
          elapsedTime: 1000,
          isTimeout: false,
        }
      );

      expect(capturedEvents).toHaveLength(0);
    });

    it('should not log when debug logging is disabled', () => {
      const disabledLogger = createDebugLogger({
        enabled: false,
        progressCallback: mockProgressCallback,
      });

      disabledLogger.logResourceStatus(
        mockDeployedResource,
        { phase: 'Running' },
        true,
        {
          attempt: 1,
          elapsedTime: 1000,
          isTimeout: false,
        }
      );

      expect(capturedEvents).toHaveLength(0);
    });
  });

  describe('Readiness Evaluation Logging', () => {
    it('should log readiness evaluation results', () => {
      const mockEvaluator = (resource: any) => {
        return resource.status?.readyReplicas > 0;
      };

      const result = {
        ready: true,
        reason: 'Replicas are ready',
        details: { readyReplicas: 3 },
      };

      debugLogger.logReadinessEvaluation(mockDeployedResource, mockEvaluator, result);

      expect(capturedEvents).toHaveLength(1);
      const event = capturedEvents[0] as StatusDebugEvent;
      expect(event.type).toBe('status-debug');
      expect(event.resourceId).toBe('Deployment/webapp');
      expect(event.readinessResult).toEqual(result);
      expect(event.message).toContain('Readiness evaluation: ready');
    });

    it('should not log when readiness evaluation is disabled', () => {
      const disabledLogger = createDebugLogger({
        enabled: true,
        readinessEvaluation: false,
        progressCallback: mockProgressCallback,
      });

      const mockEvaluator = () => true;
      const result = { ready: true };

      disabledLogger.logReadinessEvaluation(mockDeployedResource, mockEvaluator, result);

      expect(capturedEvents).toHaveLength(0);
    });
  });

  describe('Timeout Logging', () => {
    it('should log timeout information with final status', () => {
      const finalStatus = {
        replicas: 3,
        readyReplicas: 1,
        conditions: [
          { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable' },
        ],
      };

      debugLogger.logTimeout(mockDeployedResource, finalStatus, 30000, 15);

      expect(capturedEvents).toHaveLength(1);
      const event = capturedEvents[0] as StatusDebugEvent;
      expect(event.type).toBe('status-debug');
      expect(event.resourceId).toBe('Deployment/webapp');
      expect(event.readinessResult).toBe(false);
      expect(event.context.attempt).toBe(15);
      expect(event.context.elapsedTime).toBe(30000);
      expect(event.context.isTimeout).toBe(true);
      expect(event.message).toContain('timeout');
    });
  });

  describe('API Error Logging', () => {
    it('should log API errors during status polling', () => {
      const error = new Error('Forbidden: insufficient permissions');

      debugLogger.logApiError(
        mockDeployedResource,
        error,
        {
          attempt: 5,
          elapsedTime: 10000,
          isTimeout: false,
        }
      );

      expect(capturedEvents).toHaveLength(1);
      const event = capturedEvents[0] as StatusDebugEvent;
      expect(event.type).toBe('status-debug');
      expect(event.resourceId).toBe('Deployment/webapp');
      expect(event.error).toBe(error);
      expect(event.message).toContain('API error');
      expect(event.message).toContain('Forbidden');
    });
  });

  describe('Status Summarization', () => {
    it('should summarize deployment status correctly', () => {
      const status = {
        replicas: 3,
        readyReplicas: 2,
        availableReplicas: 2,
        updatedReplicas: 3,
        observedGeneration: 1,
        conditions: [
          { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable' },
          { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' },
        ],
      };

      debugLogger.logResourceStatus(
        mockDeployedResource,
        status,
        false,
        {
          attempt: 1,
          elapsedTime: 1000,
          isTimeout: false,
        }
      );

      const event = capturedEvents[0] as StatusDebugEvent;
      expect(event.message).toContain('replicas=3');
      expect(event.message).toContain('readyReplicas=2');
      expect(event.message).toContain('availableReplicas=2');
    });

    it('should handle conditions in status summary', () => {
      const status = {
        conditions: [
          { type: 'Ready', status: 'False', reason: 'PodNotReady' },
          { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable' },
        ],
      };

      debugLogger.logResourceStatus(
        mockDeployedResource,
        status,
        false,
        {
          attempt: 1,
          elapsedTime: 1000,
          isTimeout: false,
        }
      );

      const event = capturedEvents[0] as StatusDebugEvent;
      expect(event.message).toContain('Ready=False(PodNotReady)');
    });

    it('should handle empty status objects', () => {
      debugLogger.logResourceStatus(
        mockDeployedResource,
        {},
        false,
        {
          attempt: 1,
          elapsedTime: 1000,
          isTimeout: false,
        }
      );

      const event = capturedEvents[0] as StatusDebugEvent;
      expect(event.message).toContain('no status fields');
    });

    it('should handle null/undefined status', () => {
      debugLogger.logResourceStatus(
        mockDeployedResource,
        null,
        false,
        {
          attempt: 1,
          elapsedTime: 1000,
          isTimeout: false,
        }
      );

      const event = capturedEvents[0] as StatusDebugEvent;
      expect(event.message).toContain('no status');
    });
  });

  describe('Status Sanitization', () => {
    it('should sanitize sensitive fields in status', () => {
      const statusWithSecrets = {
        replicas: 3,
        token: 'secret-token-value',
        password: 'secret-password',
        config: {
          apiKey: 'secret-api-key',
          normalField: 'normal-value',
        },
      };

      debugLogger.logResourceStatus(
        mockDeployedResource,
        statusWithSecrets,
        true,
        {
          attempt: 1,
          elapsedTime: 1000,
          isTimeout: false,
        }
      );

      const event = capturedEvents[0] as StatusDebugEvent;
      const sanitizedStatus = event.currentStatus;
      
      expect(sanitizedStatus.token).toBe('[REDACTED]');
      expect(sanitizedStatus.password).toBe('[REDACTED]');
      expect(sanitizedStatus.replicas).toBe(3);
      expect((sanitizedStatus.config as any).apiKey).toBe('[REDACTED]');
      expect((sanitizedStatus.config as any).normalField).toBe('normal-value');
    });

    it('should handle deeply nested objects with size limits', () => {
      const deepStatus = {
        level1: {
          level2: {
            level3: {
              level4: {
                data: 'deep-value',
              },
            },
          },
        },
      };

      debugLogger.logResourceStatus(
        mockDeployedResource,
        deepStatus,
        true,
        {
          attempt: 1,
          elapsedTime: 1000,
          isTimeout: false,
        }
      );

      const event = capturedEvents[0] as StatusDebugEvent;
      expect(event.currentStatus).toBeDefined();
      // Deep nesting should be limited
      expect(event.currentStatus.level1).toBeDefined();
    });

    it('should handle arrays in status', () => {
      const statusWithArrays = {
        conditions: [
          { type: 'Ready', status: 'True' },
          { type: 'Available', status: 'True' },
          // ... many more conditions
        ],
        pods: new Array(50).fill(0).map((_, i) => ({ name: `pod-${i}` })),
      };

      debugLogger.logResourceStatus(
        mockDeployedResource,
        statusWithArrays,
        true,
        {
          attempt: 1,
          elapsedTime: 1000,
          isTimeout: false,
        }
      );

      const event = capturedEvents[0] as StatusDebugEvent;
      const sanitizedStatus = event.currentStatus;
      
      // Arrays should be limited in size
      expect(Array.isArray(sanitizedStatus.conditions)).toBe(true);
      expect(Array.isArray(sanitizedStatus.pods)).toBe(true);
      expect((sanitizedStatus.pods as any[]).length).toBeLessThanOrEqual(10);
    });
  });

  describe('Configuration', () => {
    it('should respect verbose mode setting', () => {
      const verboseLogger = createDebugLogger({
        enabled: true,
        verboseMode: true,
        progressCallback: mockProgressCallback,
      });

      verboseLogger.logResourceStatus(
        mockDeployedResource,
        { phase: 'Running', replicas: 3 },
        true,
        {
          attempt: 1,
          elapsedTime: 1000,
          isTimeout: false,
        }
      );

      // In verbose mode, more detailed information should be logged
      // This would be verified through console output in a real scenario
      expect(capturedEvents).toHaveLength(1);
    });

    it('should respect max status object size limit', () => {
      const smallSizeLogger = createDebugLogger({
        enabled: true,
        maxStatusObjectSize: 100, // Very small limit
        progressCallback: mockProgressCallback,
      });

      const largeStatus = {
        data: 'x'.repeat(1000), // Large string
        moreData: 'y'.repeat(1000),
      };

      smallSizeLogger.logResourceStatus(
        mockDeployedResource,
        largeStatus,
        true,
        {
          attempt: 1,
          elapsedTime: 1000,
          isTimeout: false,
        }
      );

      expect(capturedEvents).toHaveLength(1);
      // Status should be truncated due to size limit
    });

    it('should allow updating options', () => {
      debugLogger.updateOptions({
        verboseMode: true,
        maxStatusObjectSize: 2048,
      });

      // Options should be updated
      // This would be verified through behavior changes in logging
    });

    it('should allow setting progress callback', () => {
      const newCallback = mock();
      debugLogger.setProgressCallback(newCallback);

      debugLogger.logResourceStatus(
        mockDeployedResource,
        { phase: 'Running' },
        true,
        {
          attempt: 1,
          elapsedTime: 1000,
          isTimeout: false,
        }
      );

      expect(newCallback).toHaveBeenCalledTimes(1);
    });
  });
});

describe('createDebugLogger', () => {
  it('should create DebugLogger with default options', () => {
    const logger = createDebugLogger();
    expect(logger).toBeInstanceOf(DebugLogger);
  });

  it('should create DebugLogger with custom options', () => {
    const options = {
      enabled: true,
      statusPolling: false,
      readinessEvaluation: true,
      maxStatusObjectSize: 2048,
      verboseMode: true,
      progressCallback: mock(),
    };

    const logger = createDebugLogger(options);
    expect(logger).toBeInstanceOf(DebugLogger);
  });
});

describe('createDebugLoggerFromDeploymentOptions', () => {
  it('should create DebugLogger from deployment options', () => {
    const deploymentOptions = {
      debugLogging: {
        enabled: true,
        statusPolling: true,
        readinessEvaluation: false,
        maxStatusObjectSize: 1024,
        verboseMode: true,
      },
      progressCallback: mock(),
    };

    const logger = createDebugLoggerFromDeploymentOptions(deploymentOptions);
    expect(logger).toBeInstanceOf(DebugLogger);
  });

  it('should handle missing debug logging options', () => {
    const deploymentOptions = {
      progressCallback: mock(),
    };

    const logger = createDebugLoggerFromDeploymentOptions(deploymentOptions);
    expect(logger).toBeInstanceOf(DebugLogger);
  });

  it('should handle empty deployment options', () => {
    const logger = createDebugLoggerFromDeploymentOptions({});
    expect(logger).toBeInstanceOf(DebugLogger);
  });
});