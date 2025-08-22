/**
 * Test suite for ReplicationController Factory Function
 *
 * This tests the ReplicationController factory with its readiness evaluation logic
 * for legacy pod replica management scenarios.
 */

import { describe, expect, it } from 'bun:test';
import type { V1ReplicationController } from '@kubernetes/client-node';
import { replicationController } from '../../../../src/factories/kubernetes/workloads/replication-controller.js';

describe('ReplicationController Factory', () => {
  const createTestReplicationController = (
    name: string = 'testRc',
    replicas: number = 2
  ): V1ReplicationController => ({
    apiVersion: 'v1',
    kind: 'ReplicationController',
    metadata: {
      name,
      namespace: 'default',
      labels: {
        app: name,
      },
    },
    spec: {
      replicas,
      selector: {
        app: name,
      },
      template: {
        metadata: {
          labels: {
            app: name,
          },
        },
        spec: {
          containers: [
            {
              name: 'app',
              image: 'nginx:1.21',
              ports: [
                {
                  containerPort: 80,
                },
              ],
            },
          ],
        },
      },
    },
  });

  describe('Factory Creation', () => {
    it('should create replicationController with proper structure', () => {
      const rcConfig = createTestReplicationController();
      const enhanced = replicationController(rcConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('ReplicationController');
      expect(enhanced.apiVersion).toBe('v1');
      expect(enhanced.metadata.name).toBe('testRc');
      expect(enhanced.spec.replicas).toBe(2);
      expect(enhanced.spec.selector.app).toBe('testRc');
    });

    it('should handle legacy RC configuration', () => {
      const rcConfig = createTestReplicationController('legacyRc', 1);
      rcConfig.spec!.template!.spec!.containers[0].image = 'httpd:2.4';
      const enhanced = replicationController(rcConfig);

      expect(enhanced.spec.template!.spec!.containers[0].image).toBe('httpd:2.4');
      expect(enhanced.spec.replicas).toBe(1);
    });

    it('should handle missing metadata gracefully', () => {
      const rcConfig = createTestReplicationController();
      delete (rcConfig as any).metadata;
      const enhanced = replicationController(rcConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.metadata.name).toBe('unnamed-replicationcontroller');
    });
  });

  describe('Readiness Evaluator', () => {
    it('should attach readiness evaluator', () => {
      const rcConfig = createTestReplicationController();
      const enhanced = replicationController(rcConfig);

      expect((enhanced as any).readinessEvaluator).toBeDefined();
      expect(typeof (enhanced as any).readinessEvaluator).toBe('function');
    });

    it('should evaluate as ready when all replicas are ready and available', () => {
      const rcConfig = createTestReplicationController();
      const enhanced = replicationController(rcConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockRC: V1ReplicationController = {
        ...rcConfig,
        status: {
          replicas: 2,
          readyReplicas: 2,
          availableReplicas: 2,
          observedGeneration: 1,
        },
      };

      const result = evaluator(mockRC);
      expect(result.ready).toBe(true);
      expect(result.message).toContain(
        'ReplicationController has 2/2 ready replicas and 2/2 available replicas'
      );
    });

    it('should evaluate as not ready when some replicas are not ready', () => {
      const rcConfig = createTestReplicationController();
      const enhanced = replicationController(rcConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockRC: V1ReplicationController = {
        ...rcConfig,
        status: {
          replicas: 2,
          readyReplicas: 1,
          availableReplicas: 1,
          observedGeneration: 1,
        },
      };

      const result = evaluator(mockRC);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('ReplicasNotReady');
      expect(result.message).toContain('Waiting for replicas: 1/2 ready, 1/2 available');
    });

    it('should evaluate as not ready when status is missing', () => {
      const rcConfig = createTestReplicationController();
      const enhanced = replicationController(rcConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockRC: V1ReplicationController = {
        ...rcConfig,
        // No status
      };

      const result = evaluator(mockRC);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('StatusMissing');
      expect(result.message).toBe('ReplicationController status not available yet');
    });

    it('should handle missing readyReplicas and availableReplicas', () => {
      const rcConfig = createTestReplicationController();
      const enhanced = replicationController(rcConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockRC: V1ReplicationController = {
        ...rcConfig,
        status: {
          replicas: 2,
          observedGeneration: 1,
          // Missing readyReplicas and availableReplicas
        },
      };

      const result = evaluator(mockRC);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('ReplicasNotReady');
      expect(result.message).toContain('Waiting for replicas: 0/2 ready, 0/2 available');
    });

    it('should handle single replica scenario', () => {
      const rcConfig = createTestReplicationController('singleRc', 1);
      const enhanced = replicationController(rcConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockRC: V1ReplicationController = {
        ...rcConfig,
        status: {
          replicas: 1,
          readyReplicas: 1,
          availableReplicas: 1,
          observedGeneration: 1,
        },
      };

      const result = evaluator(mockRC);
      expect(result.ready).toBe(true);
      expect(result.message).toContain(
        'ReplicationController has 1/1 ready replicas and 1/1 available replicas'
      );
    });
  });

  describe('TypeScript Compilation', () => {
    it('should compile with proper K8s types', () => {
      const rcConfig = createTestReplicationController('typedRc', 3);
      const result = replicationController(rcConfig);

      // These should compile without type errors
      expect(result.kind).toBe('ReplicationController');
      expect(result.apiVersion).toBe('v1');
      expect(result.spec.replicas).toBe(3);
      expect(result.spec.template!.spec!.containers).toHaveLength(1);
    });
  });
});
