/**
 * Test suite for DaemonSet Factory Function
 *
 * This tests the DaemonSet factory with its readiness evaluation logic
 * for node-based pod scheduling scenarios.
 */

import { describe, expect, it } from 'bun:test';
import type { V1DaemonSet } from '@kubernetes/client-node';
import { daemonSet } from '../../../../src/factories/kubernetes/workloads/daemon-set.js';

describe('DaemonSet Factory', () => {
  const createTestDaemonSet = (
    name: string = 'testDaemonset',
    namespace: string = 'default'
  ): V1DaemonSet => ({
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: {
      name,
      namespace,
      labels: {
        app: name,
      },
    },
    spec: {
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
              name: 'main',
              image: 'nginx:1.21',
              ports: [
                {
                  containerPort: 80,
                  protocol: 'TCP',
                },
              ],
            },
          ],
          tolerations: [
            {
              operator: 'Exists',
            },
          ],
        },
      },
    },
  });

  describe('Factory Creation', () => {
    it('should create daemonSet with proper structure', () => {
      const daemonSetConfig = createTestDaemonSet();
      const enhanced = daemonSet(daemonSetConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('DaemonSet');
      expect(enhanced.apiVersion).toBe('apps/v1');
      expect(enhanced.metadata.name).toBe('testDaemonset');
      expect(enhanced.metadata.namespace).toBe('default');
      expect(enhanced.spec.selector.matchLabels.app).toBe('testDaemonset');
    });

    it('should preserve original spec configuration', () => {
      const daemonSetConfig = createTestDaemonSet('customDaemonset', 'kube-system');
      daemonSetConfig.spec!.template.spec!.containers[0].image = 'custom:latest';
      const enhanced = daemonSet(daemonSetConfig);

      expect(enhanced.spec.template.spec!.containers[0].image).toBe('custom:latest');
      expect(enhanced.metadata.namespace).toBe('kube-system');
      expect(enhanced.metadata.name).toBe('customDaemonset');
    });

    it('should handle daemonSet with complex tolerations and nodeSelector', () => {
      const daemonSetConfig = createTestDaemonSet('systemDaemonset');
      daemonSetConfig.spec!.template.spec!.tolerations = [
        {
          key: 'node-role.kubernetes.io/control-plane',
          operator: 'Exists',
          effect: 'NoSchedule',
        },
        {
          key: 'node.kubernetes.io/unschedulable',
          operator: 'Exists',
          effect: 'NoSchedule',
        },
      ];
      daemonSetConfig.spec!.template.spec!.nodeSelector = {
        'kubernetes.io/os': 'linux',
      };

      const enhanced = daemonSet(daemonSetConfig);

      expect(enhanced.spec.template.spec!.tolerations).toHaveLength(2);
      expect(enhanced.spec.template.spec!.nodeSelector).toEqual({
        'kubernetes.io/os': 'linux',
      });
    });

    it('should handle missing metadata gracefully', () => {
      const daemonSetConfig = createTestDaemonSet();
      delete (daemonSetConfig as any).metadata;
      const enhanced = daemonSet(daemonSetConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.metadata.name).toBe('unnamed-daemonset');
    });
  });

  describe('Readiness Evaluator', () => {
    it('should attach readiness evaluator', () => {
      const daemonSetConfig = createTestDaemonSet();
      const enhanced = daemonSet(daemonSetConfig);

      expect((enhanced as any).readinessEvaluator).toBeDefined();
      expect(typeof (enhanced as any).readinessEvaluator).toBe('function');
    });

    it('should evaluate as ready when all pods are ready', () => {
      const daemonSetConfig = createTestDaemonSet();
      const enhanced = daemonSet(daemonSetConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockDaemonSet: V1DaemonSet = {
        ...daemonSetConfig,
        status: {
          desiredNumberScheduled: 3,
          numberReady: 3,
          numberAvailable: 3,
          numberUnavailable: 0,
          updatedNumberScheduled: 3,
          currentNumberScheduled: 3,
        },
      };

      const result = evaluator(mockDaemonSet);
      expect(result.ready).toBe(true);
      expect(result.reason).toBe('All 3 pods are ready');
    });

    it('should evaluate as not ready when some pods are not ready', () => {
      const daemonSetConfig = createTestDaemonSet();
      const enhanced = daemonSet(daemonSetConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockDaemonSet: V1DaemonSet = {
        ...daemonSetConfig,
        status: {
          desiredNumberScheduled: 5,
          numberReady: 2,
          numberAvailable: 2,
          numberUnavailable: 3,
          updatedNumberScheduled: 5,
          currentNumberScheduled: 5,
        },
      };

      const result = evaluator(mockDaemonSet);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('2/5 pods ready');
    });

    it('should evaluate as not ready when no pods are scheduled', () => {
      const daemonSetConfig = createTestDaemonSet();
      const enhanced = daemonSet(daemonSetConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockDaemonSet: V1DaemonSet = {
        ...daemonSetConfig,
        status: {
          desiredNumberScheduled: 0,
          numberReady: 0,
          numberAvailable: 0,
          numberUnavailable: 0,
          updatedNumberScheduled: 0,
          currentNumberScheduled: 0,
        },
      };

      const result = evaluator(mockDaemonSet);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('0/0 pods ready');
    });

    it('should evaluate as not ready when status is missing', () => {
      const daemonSetConfig = createTestDaemonSet();
      const enhanced = daemonSet(daemonSetConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockDaemonSet: V1DaemonSet = {
        ...daemonSetConfig,
        // No status
      };

      const result = evaluator(mockDaemonSet);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('No status available');
    });

    it('should handle missing status fields gracefully', () => {
      const daemonSetConfig = createTestDaemonSet();
      const enhanced = daemonSet(daemonSetConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockDaemonSet: V1DaemonSet = {
        ...daemonSetConfig,
        status: {
          // Missing desiredNumberScheduled and numberReady
        },
      };

      const result = evaluator(mockDaemonSet);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('0/0 pods ready');
    });

    it('should handle evaluation errors gracefully', () => {
      const daemonSetConfig = createTestDaemonSet();
      const enhanced = daemonSet(daemonSetConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      // Mock a DaemonSet that might cause an error during evaluation
      const mockDaemonSet = {
        get status() {
          throw new Error('Status access failed');
        },
      };

      const result = evaluator(mockDaemonSet);
      expect(result.ready).toBe(false);
      expect(result.reason).toContain('Error checking DaemonSet status');
    });

    it('should handle single node ready scenario', () => {
      const daemonSetConfig = createTestDaemonSet();
      const enhanced = daemonSet(daemonSetConfig);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockDaemonSet: V1DaemonSet = {
        ...daemonSetConfig,
        status: {
          desiredNumberScheduled: 1,
          numberReady: 1,
          numberAvailable: 1,
          numberUnavailable: 0,
          updatedNumberScheduled: 1,
          currentNumberScheduled: 1,
        },
      };

      const result = evaluator(mockDaemonSet);
      expect(result.ready).toBe(true);
      expect(result.reason).toBe('All 1 pods are ready');
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed daemonSet gracefully', () => {
      const malformedDaemonSet = {
        spec: {
          // Missing selector and template
        },
      } as any;

      const enhanced = daemonSet(malformedDaemonSet);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('DaemonSet');
      expect(enhanced.apiVersion).toBe('apps/v1');
    });

    it('should handle missing spec gracefully', () => {
      const daemonSetConfig = {
        metadata: { name: 'testDaemonset' },
      } as any;

      const enhanced = daemonSet(daemonSetConfig);

      expect(enhanced).toBeDefined();
      expect(enhanced.metadata.name).toBe('testDaemonset');
    });
  });

  describe('TypeScript Compilation', () => {
    it('should compile with proper K8s types', () => {
      const daemonSetConfig = createTestDaemonSet('typedDaemonset');
      const result = daemonSet(daemonSetConfig);

      // These should compile without type errors
      expect(result.kind).toBe('DaemonSet');
      expect(result.apiVersion).toBe('apps/v1');
      expect(result.spec.selector.matchLabels.app).toBe('typedDaemonset');
      expect(result.spec.template.spec!.containers).toHaveLength(1);
    });
  });
});
