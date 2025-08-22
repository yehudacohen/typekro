/**
 * Test suite for ReplicaSet Factory Function
 *
 * This tests the ReplicaSet factory with its readiness evaluation logic
 * for pod replica management scenarios.
 */

import { describe, expect, it } from 'bun:test';
import type { V1ReplicaSet } from '@kubernetes/client-node';
import { replicaSet } from '../../../../src/factories/kubernetes/workloads/replica-set.js';

describe('ReplicaSet Factory', () => {
  const createTestReplicaSet = (
    name: string = 'testReplicaset',
    replicas: number = 3
  ): V1ReplicaSet => ({
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
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
        matchLabels: {
          app: name,
        },
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
    it('should create replicaSet with proper structure', () => {
      const replicaSetConfig = createTestReplicaSet();
      const enhanced = replicaSet(replicaSetConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('ReplicaSet');
      expect(enhanced.apiVersion).toBe('apps/v1');
      expect(enhanced.metadata.name).toBe('testReplicaset');
      expect(enhanced.spec.replicas).toBe(3);
      expect(enhanced.spec.selector.matchLabels.app).toBe('testReplicaset');
    });

    it('should handle single replica configuration', () => {
      const replicaSetConfig = createTestReplicaSet('singleReplica', 1);
      const enhanced = replicaSet(replicaSetConfig);

      expect(enhanced.spec.replicas).toBe(1);
      expect(enhanced.metadata.name).toBe('singleReplica');
    });

    it('should handle missing metadata gracefully', () => {
      const replicaSetConfig = createTestReplicaSet();
      delete (replicaSetConfig as any).metadata;
      const enhanced = replicaSet(replicaSetConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.metadata.name).toBe('unnamed-replicaset');
    });
  });

  describe('Readiness Evaluator', () => {
    it('should attach readiness evaluator', () => {
      const replicaSetConfig = createTestReplicaSet();
      const enhanced = replicaSet(replicaSetConfig);

      expect((enhanced as any).readinessEvaluator).toBeDefined();
      expect(typeof (enhanced as any).readinessEvaluator).toBe('function');
    });

    it('should evaluate as ready when all replicas are ready', () => {
      const replicaSetConfig = createTestReplicaSet();
      const enhanced = replicaSet(replicaSetConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockReplicaSet: V1ReplicaSet = {
        ...replicaSetConfig,
        status: {
          replicas: 3,
          readyReplicas: 3,
          availableReplicas: 3,
          observedGeneration: 1,
        },
      };

      const result = evaluator(mockReplicaSet);
      expect(result.ready).toBe(true);
      expect(result.reason).toBe('All 3 replicas are ready');
    });

    it('should evaluate as not ready when some replicas are not ready', () => {
      const replicaSetConfig = createTestReplicaSet();
      const enhanced = replicaSet(replicaSetConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockReplicaSet: V1ReplicaSet = {
        ...replicaSetConfig,
        status: {
          replicas: 3,
          readyReplicas: 1,
          availableReplicas: 1,
          observedGeneration: 1,
        },
      };

      const result = evaluator(mockReplicaSet);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('1/3 replicas ready');
    });

    it('should evaluate as not ready when status is missing', () => {
      const replicaSetConfig = createTestReplicaSet();
      const enhanced = replicaSet(replicaSetConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockReplicaSet: V1ReplicaSet = {
        ...replicaSetConfig,
        // No status
      };

      const result = evaluator(mockReplicaSet);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('No status available');
    });

    it('should handle missing spec replicas (defaults to 1)', () => {
      const replicaSetConfig = createTestReplicaSet();
      delete replicaSetConfig.spec!.replicas;
      const enhanced = replicaSet(replicaSetConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockReplicaSet: V1ReplicaSet = {
        ...replicaSetConfig,
        status: {
          replicas: 1,
          readyReplicas: 1,
          observedGeneration: 1,
        },
      };

      const result = evaluator(mockReplicaSet);
      expect(result.ready).toBe(true);
      expect(result.reason).toBe('All 1 replicas are ready');
    });
  });

  describe('TypeScript Compilation', () => {
    it('should compile with proper K8s types', () => {
      const replicaSetConfig = createTestReplicaSet('typedReplicaset', 5);
      const result = replicaSet(replicaSetConfig);

      // These should compile without type errors
      expect(result.kind).toBe('ReplicaSet');
      expect(result.apiVersion).toBe('apps/v1');
      expect(result.spec.replicas).toBe(5);
      expect(result.spec.template.spec!.containers).toHaveLength(1);
    });
  });
});
