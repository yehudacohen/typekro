/**
 * Tests for StatusHydrator - Updated for new interface
 *
 * NOTE: In the new @kubernetes/client-node API (v1.x), methods return objects directly
 * without a .body wrapper. The mocks must return the resource directly.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { StatusHydrator } from '../../src/core/deployment/status-hydrator.js';
import type { DeployedResource } from '../../src/core/types/deployment.js';
import type { Enhanced } from '../../src/core/types/kubernetes.js';

// Mock Kubernetes API (new API returns objects directly, no .body wrapper)
const createMockK8sApi = (mockResource?: any) =>
  ({
    read: async () =>
      mockResource || {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test-deployment', namespace: 'default' },
        status: {
          replicas: 3,
          readyReplicas: 3,
          availableReplicas: 3,
          conditions: [
            { type: 'Available', status: 'True' },
            { type: 'Progressing', status: 'True' },
          ],
        },
      },
  }) as any as k8s.KubernetesObjectApi;

describe('StatusHydrator', () => {
  let statusHydrator: StatusHydrator;
  let mockDeployedResource: DeployedResource;
  let mockEnhanced: Enhanced<any, any>;

  beforeEach(() => {
    statusHydrator = new StatusHydrator(createMockK8sApi());

    mockDeployedResource = {
      id: 'testDeployment',
      kind: 'Deployment',
      name: 'test-deployment',
      namespace: 'default',
      manifest: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test-deployment', namespace: 'default' },
      },
      status: 'ready',
      deployedAt: new Date(),
    };

    mockEnhanced = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'test-deployment', namespace: 'default' },
      spec: {} as any,
      status: {} as any,
    } as Enhanced<any, any>;
  });

  describe('hydrateStatus', () => {
    it('should successfully hydrate Deployment status fields', async () => {
      const result = await statusHydrator.hydrateStatus(mockEnhanced, mockDeployedResource);

      expect(result.success).toBe(true);
      expect(result.resourceId).toBe('test-deployment');
      expect(result.hydratedFields.length).toBeGreaterThan(0);

      // Check that status fields were populated
      expect(mockEnhanced.status.replicas).toBe(3);
      expect(mockEnhanced.status.readyReplicas).toBe(3);
      expect(mockEnhanced.status.availableReplicas).toBe(3);
      expect(mockEnhanced.status.conditions).toEqual([
        { type: 'Available', status: 'True' },
        { type: 'Progressing', status: 'True' },
      ]);
    });

    it('should handle Service status with loadBalancer', async () => {
      const serviceApi = createMockK8sApi({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'test-service', namespace: 'default' },
        status: {
          loadBalancer: {
            ingress: [{ ip: '192.168.1.100' }],
          },
        },
      });

      statusHydrator = new StatusHydrator(serviceApi);

      const serviceResource: DeployedResource = {
        ...mockDeployedResource,
        id: 'testService',
        kind: 'Service',
        name: 'test-service',
      };

      const serviceEnhanced = {
        ...mockEnhanced,
        kind: 'Service',
        metadata: { name: 'test-service', namespace: 'default' },
      } as Enhanced<any, any>;

      const result = await statusHydrator.hydrateStatus(serviceEnhanced, serviceResource);

      expect(result.success).toBe(true);
      expect(serviceEnhanced.status.loadBalancer?.ingress).toEqual([{ ip: '192.168.1.100' }]);
    });

    it('should handle Pod status with IP addresses', async () => {
      const podApi = createMockK8sApi({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'test-pod', namespace: 'default' },
        status: {
          phase: 'Running',
          podIP: '10.244.0.5',
          hostIP: '192.168.1.10',
          containerStatuses: [{ name: 'app', ready: true, restartCount: 0 }],
        },
      });

      statusHydrator = new StatusHydrator(podApi);

      const podResource: DeployedResource = {
        ...mockDeployedResource,
        id: 'testPod',
        kind: 'Pod',
        name: 'test-pod',
      };

      const podEnhanced = {
        ...mockEnhanced,
        kind: 'Pod',
        metadata: { name: 'test-pod', namespace: 'default' },
      } as Enhanced<any, any>;

      const result = await statusHydrator.hydrateStatus(podEnhanced, podResource);

      expect(result.success).toBe(true);
      expect(podEnhanced.status.phase).toBe('Running');
      expect(podEnhanced.status.podIP).toBe('10.244.0.5');
      expect(podEnhanced.status.hostIP).toBe('192.168.1.10');
      expect(podEnhanced.status.containerStatuses).toEqual([
        { name: 'app', ready: true, restartCount: 0 },
      ]);
    });

    it('should handle API errors gracefully', async () => {
      const errorApi = {
        read: async () => {
          throw new Error('Resource not found');
        },
      } as any as k8s.KubernetesObjectApi;

      statusHydrator = new StatusHydrator(errorApi);

      const result = await statusHydrator.hydrateStatus(mockEnhanced, mockDeployedResource);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Resource not found');
      expect(result.hydratedFields).toEqual([]);
    });

    it('should handle resources with no status', async () => {
      const noStatusApi = createMockK8sApi({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'test-config', namespace: 'default' },
        // No status field
      });

      statusHydrator = new StatusHydrator(noStatusApi);

      const configResource: DeployedResource = {
        ...mockDeployedResource,
        id: 'testConfig',
        kind: 'ConfigMap',
        name: 'test-config',
      };

      const result = await statusHydrator.hydrateStatus(mockEnhanced, configResource);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('No status found');
    });
  });

  describe('caching', () => {
    it('should cache status results when enabled', async () => {
      let callCount = 0;
      const cachingApi = {
        // New API returns objects directly (no .body wrapper)
        read: async () => {
          callCount++;
          return {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            status: { replicas: 3 },
          };
        },
      } as any as k8s.KubernetesObjectApi;

      statusHydrator = new StatusHydrator(cachingApi, { enableCaching: true });

      // First call should hit the API
      await statusHydrator.hydrateStatus(mockEnhanced, mockDeployedResource);
      expect(callCount).toBe(1);

      // Second call should use cache
      await statusHydrator.hydrateStatus(mockEnhanced, mockDeployedResource);
      expect(callCount).toBe(1); // Should still be 1 due to caching
    });

    it('should provide cache statistics', () => {
      const stats = statusHydrator.getCacheStats();
      expect(stats.size).toBe(0);
      expect(stats.keys).toEqual([]);
    });

    it('should clear cache when requested', async () => {
      await statusHydrator.hydrateStatus(mockEnhanced, mockDeployedResource);

      statusHydrator.clearCache();

      const stats = statusHydrator.getCacheStats();
      expect(stats.size).toBe(0);
    });
  });
});
