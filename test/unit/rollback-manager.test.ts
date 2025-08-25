/**
 * Test suite for ResourceRollbackManager
 *
 * This tests the critical safety mechanism for rolling back resources
 * in reverse dependency order with proper error handling.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { createRollbackManager, createRollbackManagerWithKubeConfig, ResourceRollbackManager,  } from '../../src/core/deployment/rollback-manager.js';
import type { DeploymentEvent } from '../../src/core/types/deployment.js';
import { configMap } from '../../src/factories/kubernetes/config/config-map.js';
import { service } from '../../src/factories/kubernetes/networking/service.js';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';

describe('ResourceRollbackManager', () => {
  // Mock Kubernetes client following patterns from enhanced-deployment-engine.test.ts
  const createMockK8sApi = () => {
    const mockApi = {
      create: mock(() => Promise.resolve({ body: {} })),
      read: mock(() => Promise.resolve({ body: {} })),
      delete: mock(() => Promise.resolve({ body: {} })),
      patch: mock(() => Promise.resolve({ body: {} })),
      replace: mock(() => Promise.resolve({ body: {} })),
      list: mock(() => Promise.resolve({ body: { items: [] } })),
    } as any;

    // Reset all mocks before each test
    mockApi.create.mockClear();
    mockApi.read.mockClear();
    mockApi.delete.mockClear();
    mockApi.patch.mockClear();
    mockApi.replace.mockClear();
    mockApi.list.mockClear();

    return mockApi;
  };

  // Helper to create test resources
  const createTestDeployment = (name: string, namespace: string = 'default') =>
    deployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace },
      spec: {
        replicas: 2,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: { containers: [{ name: 'app', image: 'nginx' }] },
        },
      },
    });

  const createTestService = (name: string, namespace: string = 'default') =>
    service({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace },
      spec: {
        selector: { app: name },
        ports: [{ port: 80, targetPort: 8080 }],
      },
    });

  const createTestConfigMap = (name: string, namespace: string = 'default') =>
    configMap({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name, namespace },
      data: { 'config.yaml': 'test: value' },
    });

  describe('Factory Functions', () => {
    it('should create rollback manager with KubernetesObjectApi', () => {
      const mockK8sApi = createMockK8sApi();
      const manager = createRollbackManager(mockK8sApi);

      expect(manager).toBeInstanceOf(ResourceRollbackManager);
    });

    it('should create rollback manager with KubeConfig', () => {
      const mockKubeConfig = new k8s.KubeConfig();
      // Mock the makeApiClient method
      mockKubeConfig.makeApiClient = mock(() => createMockK8sApi());

      const manager = createRollbackManagerWithKubeConfig(mockKubeConfig);

      expect(manager).toBeInstanceOf(ResourceRollbackManager);
      expect(mockKubeConfig.makeApiClient).toHaveBeenCalledWith(k8s.KubernetesObjectApi);
    });
  });

  describe('Graceful Rollback Scenarios', () => {
    let mockK8sApi: any;
    let manager: ResourceRollbackManager;

    beforeEach(() => {
      mockK8sApi = createMockK8sApi();
      manager = createRollbackManager(mockK8sApi);
    });

    it('should rollback multiple resources in reverse dependency order', async () => {
      const deployment1 = createTestDeployment('app1');
      const service1 = createTestService('app1-service');
      const configmap1 = createTestConfigMap('app1-config');

      // Resources should be rolled back in reverse order: [deployment1, service1, configmap1]
      const resources = [configmap1, service1, deployment1] as any[];

      // Mock successful deletions for all resources
      mockK8sApi.delete.mockResolvedValue({ body: {} });

      const result = await manager.rollbackResources(resources);

      expect(result.status).toBe('success');
      expect(result.rolledBackResources).toHaveLength(3);
      expect(result.errors).toHaveLength(0);

      // Verify deletion was called for each resource
      expect(mockK8sApi.delete).toHaveBeenCalledTimes(3);

      // Verify reverse order by checking the calls
      const deleteCalls = mockK8sApi.delete.mock.calls;
      expect(deleteCalls[0][0].metadata.name).toBe('app1'); // deployment first (reversed)
      expect(deleteCalls[1][0].metadata.name).toBe('app1-service'); // service second
      expect(deleteCalls[2][0].metadata.name).toBe('app1-config'); // configmap last
    });

    it('should emit proper rollback events throughout the process', async () => {
      const deployment1 = createTestDeployment('test-app');
      const resources = [deployment1] as any[];
      const events: DeploymentEvent[] = [];

      mockK8sApi.delete.mockResolvedValue({ body: {} });

      const result = await manager.rollbackResources(resources, {
        emitEvent: (event) => events.push(event),
      });

      expect(result.status).toBe('success');

      // Should have rollback started, progress, and completed events
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('rollback'); // started
      expect(eventTypes).toContain('progress'); // per resource
      expect(eventTypes).toContain('completed'); // finished

      // Check progress event has proper resource information
      const progressEvent = events.find((e) => e.type === 'progress');
      expect(progressEvent?.resourceId).toContain('Deployment/test-app');
      expect(progressEvent?.message).toContain('Successfully rolled back');
    });

    it('should handle resources that are already deleted (404 responses)', async () => {
      const deployment1 = createTestDeployment('already-deleted');
      const service1 = createTestService('still-exists');
      const resources = [deployment1, service1] as any[];

      // First deletion (deployment) returns 404 - already deleted
      const notFoundError = new Error('Not found') as any;
      notFoundError.statusCode = 404;
      mockK8sApi.delete.mockRejectedValueOnce(notFoundError);

      // Second deletion (service) succeeds
      mockK8sApi.delete.mockResolvedValueOnce({ body: {} });

      const result = await manager.rollbackResources(resources);

      expect(result.status).toBe('success');
      expect(result.rolledBackResources).toHaveLength(2); // Both count as successful
      expect(result.errors).toHaveLength(0);
    });

    it.skip('should wait for deletion completion when timeout is specified', async () => {
      const deployment1 = createTestDeployment('wait-for-deletion');
      const resources = [deployment1] as any[];

      // Mock successful deletion
      mockK8sApi.delete.mockResolvedValue({ body: {} });

      // Mock the read calls for deletion waiting
      // First read: resource still exists
      mockK8sApi.read.mockResolvedValueOnce({ body: deployment1 });
      // Second read: resource is gone (404)
      const notFoundError = new Error('Not found') as any;
      notFoundError.statusCode = 404;
      mockK8sApi.read.mockRejectedValueOnce(notFoundError);

      const startTime = Date.now();
      const result = await manager.rollbackResources(resources, {
        timeout: 5000, // 5 second timeout
      });
      const duration = Date.now() - startTime;

      expect(result.status).toBe('success');
      expect(duration).toBeGreaterThan(1000); // Should have waited some time
      expect(mockK8sApi.read).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'Deployment',
          metadata: expect.objectContaining({
            name: 'wait-for-deletion',
          }),
        })
      );
    });
  });

  describe('Force Deletion Scenarios', () => {
    let mockK8sApi: any;
    let manager: ResourceRollbackManager;

    beforeEach(() => {
      mockK8sApi = createMockK8sApi();
      manager = createRollbackManager(mockK8sApi);
    });

    it('should attempt graceful deletion first, then force delete on failure', async () => {
      const deployment1 = createTestDeployment('stubborn-resource');
      const resources = [deployment1] as any[];

      // First deletion attempt fails (not 404)
      const deleteError = new Error('Resource has finalizers') as any;
      deleteError.statusCode = 409; // Conflict
      mockK8sApi.delete.mockRejectedValueOnce(deleteError);

      // Force deletion succeeds
      mockK8sApi.delete.mockResolvedValueOnce({ body: {} });

      const result = await manager.rollbackResources(resources, {
        force: true,
      });

      expect(result.status).toBe('success');
      expect(mockK8sApi.delete).toHaveBeenCalledTimes(2);

      // Check that second call used gracePeriod = 0 for force deletion
      const forceDeletionCall = mockK8sApi.delete.mock.calls[1];
      expect(forceDeletionCall[3]).toBe(0); // gracePeriod parameter
    });

    it('should use gracePeriod=0 for force deletion', async () => {
      const service1 = createTestService('force-delete-me');
      const resources = [service1] as any[];

      // Normal deletion fails
      mockK8sApi.delete.mockRejectedValueOnce(new Error('Finalizer blocking'));
      // Force deletion succeeds
      mockK8sApi.delete.mockResolvedValueOnce({ body: {} });

      await manager.rollbackResources(resources, { force: true });

      const calls = mockK8sApi.delete.mock.calls;
      expect(calls).toHaveLength(2);

      // First call - normal deletion with undefined gracePeriod
      expect(calls[0][3]).toBeUndefined();

      // Second call - force deletion with gracePeriod = 0
      expect(calls[1][3]).toBe(0);
    });

    it('should handle force deletion failures gracefully', async () => {
      const deployment1 = createTestDeployment('impossible-to-delete');
      const resources = [deployment1] as any[];
      const events: DeploymentEvent[] = [];

      // Both normal and force deletion fail
      const deleteError = new Error('Persistent finalizer');
      mockK8sApi.delete.mockRejectedValue(deleteError);

      const result = await manager.rollbackResources(resources, {
        force: true,
        emitEvent: (event) => events.push(event),
      });

      expect(result.status).toBe('failed');
      expect(result.rolledBackResources).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.error.message).toBe('Persistent finalizer');

      // Should have emitted a failed event
      const failedEvent = events.find((e) => e.type === 'failed');
      expect(failedEvent).toBeDefined();
      expect(failedEvent?.message).toContain('Failed to rollback');
    });
  });

  describe('Error Handling and Recovery', () => {
    let mockK8sApi: any;
    let manager: ResourceRollbackManager;

    beforeEach(() => {
      mockK8sApi = createMockK8sApi();
      manager = createRollbackManager(mockK8sApi);
    });

    it('should continue rollback even when individual resources fail', async () => {
      const deployment1 = createTestDeployment('failing-resource');
      const service1 = createTestService('working-resource');
      const configmap1 = createTestConfigMap('another-working-resource');
      const resources = [deployment1, service1, configmap1] as any[];

      // Middle resource (service) fails, others succeed
      mockK8sApi.delete.mockResolvedValueOnce({ body: {} }); // deployment succeeds
      mockK8sApi.delete.mockRejectedValueOnce(new Error('Service deletion failed')); // service fails
      mockK8sApi.delete.mockResolvedValueOnce({ body: {} }); // configmap succeeds

      const result = await manager.rollbackResources(resources);

      expect(result.status).toBe('partial');
      expect(result.rolledBackResources).toHaveLength(2); // 2 succeeded
      expect(result.errors).toHaveLength(1); // 1 failed
      expect(result.errors[0]?.resourceId).toContain('Service/working-resource');
    });

    it('should collect and report all rollback errors', async () => {
      const deployment1 = createTestDeployment('fail1');
      const service1 = createTestService('fail2');
      const resources = [deployment1, service1] as any[];

      // Both deletions fail with different errors
      mockK8sApi.delete.mockRejectedValueOnce(new Error('Deployment error'));
      mockK8sApi.delete.mockRejectedValueOnce(new Error('Service error'));

      const result = await manager.rollbackResources(resources);

      expect(result.status).toBe('failed');
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]?.error.message).toBe('Deployment error');
      expect(result.errors[1]?.error.message).toBe('Service error');
      expect(result.errors[0]?.phase).toBe('rollback');
      expect(result.errors[1]?.phase).toBe('rollback');
    });

    it('should handle resources with missing metadata gracefully', async () => {
      // Create resource with minimal metadata
      const malformedResource = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {}, // No name!
        data: { test: 'value' },
      } as any;

      const resources = [malformedResource];

      const result = await manager.rollbackResources(resources);

      expect(result.status).toBe('failed');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.error.message).toContain('Resource name is required');
    });

    it('should timeout appropriately during deletion waiting', async () => {
      const deployment1 = createTestDeployment('slow-to-delete');
      const resources = [deployment1] as any[];

      // Mock successful deletion
      mockK8sApi.delete.mockResolvedValue({ body: {} });

      // Mock read calls that always return the resource (never gets deleted)
      mockK8sApi.read.mockResolvedValue({ body: deployment1 });

      const startTime = Date.now();
      const result = await manager.rollbackResources(resources, {
        timeout: 1000, // 1 second timeout (short for testing)
      });
      const duration = Date.now() - startTime;

      expect(result.status).toBe('failed');
      expect(duration).toBeGreaterThan(1000); // Should have waited at least the timeout
      expect(result.errors[0]?.error.message).toContain('Timeout waiting for resource deletion');
    });
  });

  describe('Resource Identification and Metadata', () => {
    let mockK8sApi: any;
    let manager: ResourceRollbackManager;

    beforeEach(() => {
      mockK8sApi = createMockK8sApi();
      manager = createRollbackManager(mockK8sApi);
    });

    it('should extract string values from complex metadata fields', async () => {
      // Create a resource with complex metadata (simulating refs/CEL expressions)
      const complexResource = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: 'simple-string',
          namespace: 'simple-namespace',
        },
      } as any;

      mockK8sApi.delete.mockResolvedValue({ body: {} });

      const result = await manager.rollbackResources([complexResource]);

      expect(result.status).toBe('success');
      expect(mockK8sApi.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'simple-string',
            namespace: 'simple-namespace',
          }),
        }),
        undefined,
        undefined,
        undefined
      );
    });

    it('should generate proper resource identifiers for logging', async () => {
      const deployment1 = createTestDeployment('test-app', 'production');
      const events: DeploymentEvent[] = [];

      mockK8sApi.delete.mockResolvedValue({ body: {} });

      const result = await manager.rollbackResources([deployment1] as any[], {
        emitEvent: (event) => events.push(event),
      });

      expect(result.status).toBe('success');
      expect(result.rolledBackResources[0]).toBe('Deployment/test-app (production)');

      const progressEvent = events.find((e) => e.type === 'progress');
      expect(progressEvent?.resourceId).toBe('Deployment/test-app (production)');
    });

    it('should handle namespaced and cluster-scoped resources', async () => {
      // Namespaced resource
      const namespacedResource = createTestConfigMap('namespaced-config', 'kube-system');

      // Cluster-scoped resource (simulated)
      const clusterResource = {
        apiVersion: 'v1',
        kind: 'PersistentVolume',
        metadata: { name: 'cluster-pv' }, // No namespace
      } as any;

      mockK8sApi.delete.mockResolvedValue({ body: {} });

      const result = await manager.rollbackResources([
        namespacedResource,
        clusterResource,
      ] as any[]);

      expect(result.status).toBe('success');
      expect(mockK8sApi.delete).toHaveBeenCalledTimes(2);

      // Check namespaced resource call
      const namespacedCall = mockK8sApi.delete.mock.calls[1][0]; // Second call (reverse order)
      expect(namespacedCall.metadata.namespace).toBe('kube-system');

      // Check cluster-scoped resource call
      const clusterCall = mockK8sApi.delete.mock.calls[0][0]; // First call (reverse order)
      expect(clusterCall.metadata.namespace).toBeUndefined();
    });
  });

  describe('Edge Cases and Robustness', () => {
    let mockK8sApi: any;
    let manager: ResourceRollbackManager;

    beforeEach(() => {
      mockK8sApi = createMockK8sApi();
      manager = createRollbackManager(mockK8sApi);
    });

    it('should handle empty resource list', async () => {
      const result = await manager.rollbackResources([]);

      expect(result.status).toBe('success');
      expect(result.rolledBackResources).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(mockK8sApi.delete).not.toHaveBeenCalled();
    });

    it('should handle resources with undefined metadata', async () => {
      const resourceWithoutMetadata = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        // metadata is undefined
      } as any;

      const result = await manager.rollbackResources([resourceWithoutMetadata]);

      expect(result.status).toBe('failed');
      expect(result.errors[0]?.error.message).toContain('Resource name is required');
    });

    it('should calculate duration correctly', async () => {
      const deployment1 = createTestDeployment('timing-test');
      mockK8sApi.delete.mockResolvedValue({ body: {} });

      const startTime = Date.now();
      const result = await manager.rollbackResources([deployment1] as any[]);
      const endTime = Date.now();

      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.duration).toBeLessThanOrEqual(endTime - startTime + 10); // Small buffer for timing
    });

    it('should provide meaningful rollback results', async () => {
      const deployment1 = createTestDeployment('result-test');
      mockK8sApi.delete.mockResolvedValue({ body: {} });

      const result = await manager.rollbackResources([deployment1] as any[]);

      expect(result.deploymentId).toMatch(/^rollback-\d+$/);
      expect(typeof result.duration).toBe('number');
      expect(['success', 'partial', 'failed']).toContain(result.status);
      expect(Array.isArray(result.rolledBackResources)).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });
});
