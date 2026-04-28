/**
 * Test suite for DirectTypeKroDeployer
 *
 * This tests the alchemy deployment integration with readiness evaluator lookup from registry.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  DirectTypeKroDeployer,
  KroTypeKroDeployer,
  ResourceGraphDefinitionDeletionDeferredError,
} from '../../src/alchemy/deployers.js';
import {
  deleteKroDefinition,
  deleteKroInstanceFinalizerSafeForTest,
  listKroInstancesForTest,
} from '../../src/alchemy/kro-delete.js';
import {
  handleResourceDeletionForTest,
  inferKroDeletionOptionsForTest,
} from '../../src/alchemy/resource-registration.js';
import { ReadinessEvaluatorRegistry } from '../../src/core/readiness/registry.js';
import { getMetadataField } from '../../src/core/metadata/index.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';
import { service } from '../../src/factories/kubernetes/networking/service.js';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';
import { getReadinessEvaluator, requireReadinessEvaluator } from '../utils/mock-factories.js';

describe('DirectTypeKroDeployer', () => {
  // Mock DirectDeploymentEngine following established patterns
  const createMockEngine = () => {
    const mockEngine = {
      deploy: mock(() =>
        Promise.resolve({
          status: 'success',
          deployedResources: [],
          duration: 100,
          errors: [],
        })
      ),
      deleteResource: mock(() => Promise.resolve()),
      dispose: mock(() => Promise.resolve()),
      k8sApi: {
        create: mock(() => Promise.resolve({ body: {} })),
        read: mock(() => Promise.resolve({ body: {} })),
        delete: mock(() => Promise.resolve({ body: {} })),
        patch: mock(() => Promise.resolve({ body: {} })),
      },
    } as unknown as import('../../src/core/deployment/engine.js').DirectDeploymentEngine;

    return mockEngine;
  };

  // Helper to create test resources
  const createTestDeployment = (name: string, replicas: number = 2) =>
    deployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: 'default' },
      spec: {
        replicas,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: { containers: [{ name: 'app', image: 'nginx:alpine' }] },
        },
      },
    });

  const createTestService = (name: string) =>
    service({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: 'default' },
      spec: {
        selector: { app: name },
        ports: [{ port: 80, targetPort: 8080 }],
      },
    });

  describe('Readiness Evaluator Registry Lookup', () => {
    let mockEngine: any;

    beforeEach(() => {
      mockEngine = createMockEngine();
      // Create deployer to ensure it's properly initialized
      new DirectTypeKroDeployer(mockEngine);
    });

    it('preserves TypeKro deployment metadata options', async () => {
      const testDeployment = createTestDeployment('metadata-options', 1);
      const deployer = new DirectTypeKroDeployer(mockEngine);

      await deployer.deploy(testDeployment, {
        mode: 'alchemy',
        namespace: 'test-ns',
        factoryName: 'alchemy-factory',
        instanceName: 'alchemy-instance',
        singletonSpecFingerprint: 'sha256:test',
      });

      const options = mockEngine.deploy.mock.calls[0]?.[1];
      expect(options.factoryName).toBe('alchemy-factory');
      expect(options.instanceName).toBe('alchemy-instance');
      expect(options.singletonSpecFingerprint).toBe('sha256:test');
      expect(options.namespace).toBe('test-ns');
      expect(options.mode).toBe('direct');
    });

    it('disposes the underlying deployment engine', async () => {
      const deployer = new DirectTypeKroDeployer(mockEngine);

      await deployer.dispose();

      expect(mockEngine.dispose).toHaveBeenCalledTimes(1);
    });

    it('should use readiness evaluator from factory-created resources', () => {
      const testDeployment = createTestDeployment('test-app', 3);

      // Factory-created resources should already have readiness evaluators attached
      expect(typeof getReadinessEvaluator(testDeployment)).toBe('function');

      // The evaluator should work correctly
      const evaluator = requireReadinessEvaluator(testDeployment);
      const readyResult = evaluator({
        status: {
          readyReplicas: 3,
          availableReplicas: 3,
          updatedReplicas: 3,
          replicas: 3,
        },
      });

      expect(readyResult.ready).toBe(true);
    });

    it('should have evaluators registered in the global registry by kind', () => {
      // Create a deployment to trigger registration
      createTestDeployment('registry-test', 2);

      // Check that the registry has an evaluator for Deployment kind
      const registry = ReadinessEvaluatorRegistry.getInstance();
      expect(registry.hasEvaluatorForKind('Deployment')).toBe(true);

      const evaluator = registry.getEvaluatorForKind('Deployment');
      expect(evaluator).not.toBeNull();
      expect(typeof evaluator).toBe('function');
    });

    it('should have Service evaluators registered in the registry', () => {
      // Create a service to trigger registration
      createTestService('registry-service-test');

      const registry = ReadinessEvaluatorRegistry.getInstance();
      expect(registry.hasEvaluatorForKind('Service')).toBe(true);

      const evaluator = registry.getEvaluatorForKind('Service');
      expect(evaluator).not.toBeNull();
    });

    it('should evaluate Deployment readiness correctly via registry evaluator', () => {
      createTestDeployment('eval-test', 3);

      const registry = ReadinessEvaluatorRegistry.getInstance();
      const evaluator = registry.getEvaluatorForKind('Deployment');

      // Test ready condition
      const readyResult = evaluator!({
        status: {
          readyReplicas: 3,
          availableReplicas: 3,
          updatedReplicas: 3,
          replicas: 3,
        },
      });
      expect(readyResult.ready).toBe(true);

      // Test not ready condition
      const notReadyResult = evaluator!({
        status: {
          readyReplicas: 1,
          availableReplicas: 2,
          updatedReplicas: 3,
          replicas: 3,
        },
      });
      expect(notReadyResult.ready).toBe(false);
    });

    it('should handle missing status gracefully', () => {
      createTestDeployment('missing-status-test', 2);

      const registry = ReadinessEvaluatorRegistry.getInstance();
      const evaluator = registry.getEvaluatorForKind('Deployment');

      // Test with null status
      const nullStatusResult = evaluator!({ status: null });
      expect(nullStatusResult.ready).toBe(false);

      // Test with undefined status
      const undefinedStatusResult = evaluator!({ status: undefined });
      expect(undefinedStatusResult.ready).toBe(false);

      // Test with missing status entirely
      const noStatusResult = evaluator!({});
      expect(noStatusResult.ready).toBe(false);
    });
  });

  describe('Deployment Integration', () => {
    let mockEngine: any;
    let deployer: DirectTypeKroDeployer;

    beforeEach(() => {
      mockEngine = createMockEngine();
      deployer = new DirectTypeKroDeployer(mockEngine);
    });

    it('should integrate with DirectDeploymentEngine properly', () => {
      expect(deployer).toBeDefined();
      expect(deployer).toBeInstanceOf(DirectTypeKroDeployer);
    });

    it('should preserve resource identity during deployment', async () => {
      const originalDeployment = createTestDeployment('identity-test', 4);
      const originalMetadata = originalDeployment.metadata;
      const originalSpec = originalDeployment.spec;

      // Deploy the resource
      const result = await deployer.deploy(originalDeployment, {
        mode: 'direct',
        namespace: 'default',
        waitForReady: false,
      });

      // Verify core resource properties are maintained
      expect(result.apiVersion).toBe(originalDeployment.apiVersion);
      expect(result.kind).toBe(originalDeployment.kind);
      expect(result.metadata).toEqual(originalMetadata);
      expect(result.spec).toEqual(originalSpec);

      // Verify the readiness evaluator is properly attached
      expect(getReadinessEvaluator(result)).toBeDefined();
      expect(typeof getReadinessEvaluator(result)).toBe('function');
    });

    it('should call engine.deploy with correct resource graph', async () => {
      const testDeployment = createTestDeployment('engine-test', 2);

      await deployer.deploy(testDeployment, {
        mode: 'direct',
        namespace: 'test-ns',
        waitForReady: false,
      });

      // Verify engine.deploy was called
      expect(mockEngine.deploy).toHaveBeenCalled();

      // Get the call arguments
      const callArgs = mockEngine.deploy.mock.calls[0];
      const resourceGraph = callArgs[0];
      const options = callArgs[1];

      // Verify resource graph structure
      expect(resourceGraph.resources).toHaveLength(1);
      expect(resourceGraph.resources[0].manifest.kind).toBe('Deployment');
      expect(resourceGraph.resources[0].manifest.metadata.name).toBe('engine-test');

      // Verify options
      expect(options.namespace).toBe('test-ns');
    });
  });

  describe('Error Handling', () => {
    let mockEngine: any;
    let deployer: DirectTypeKroDeployer;

    beforeEach(() => {
      mockEngine = createMockEngine();
      deployer = new DirectTypeKroDeployer(mockEngine);
    });

    it('should throw ResourceDeploymentError on deployment failure', async () => {
      // Configure mock to return failure
      mockEngine.deploy.mockImplementation(() =>
        Promise.resolve({
          status: 'failed',
          errors: [{ error: new Error('Deployment failed') }],
          deployedResources: [],
          duration: 100,
        })
      );

      const testDeployment = createTestDeployment('error-test', 2);

      await expect(
        deployer.deploy(testDeployment, {
          mode: 'direct',
          namespace: 'default',
          waitForReady: false,
        })
      ).rejects.toThrow('Deployment failed');
    });

    it('should handle multiple errors in deployment failure', async () => {
      mockEngine.deploy.mockImplementation(() =>
        Promise.resolve({
          status: 'failed',
          errors: [
            { error: new Error('First error') },
            { error: new Error('Second error') },
            { error: new Error('Third error') },
          ],
          deployedResources: [],
          duration: 100,
        })
      );

      const testDeployment = createTestDeployment('multi-error-test', 2);

      try {
        await deployer.deploy(testDeployment, {
          mode: 'direct',
          namespace: 'default',
          waitForReady: false,
        });
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain('First error');
        expect(error.message).toContain('2 other errors');
      }
    });
  });

  describe('Delete Operations', () => {
    let mockEngine: any;
    let deployer: DirectTypeKroDeployer;

    beforeEach(() => {
      mockEngine = createMockEngine();
      deployer = new DirectTypeKroDeployer(mockEngine);
    });

    it('uses the resource namespace when delete options have a different factory namespace', async () => {
      const testDeployment = createTestDeployment('delete-test', 2);

      await deployer.delete(testDeployment, { mode: 'direct', namespace: 'test-ns' });

      expect(mockEngine.deleteResource).toHaveBeenCalled();

      const callArgs = mockEngine.deleteResource.mock.calls[0];
      const deployedResource = callArgs[0];

      expect(deployedResource.kind).toBe('Deployment');
      expect(deployedResource.name).toBe('delete-test');
      expect(deployedResource.namespace).toBe('default');
    });

    it('should use resource namespace if options namespace not provided', async () => {
      const testDeployment = createTestDeployment('ns-test', 2);

      await deployer.delete(testDeployment, { mode: 'direct' });

      const callArgs = mockEngine.deleteResource.mock.calls[0];
      const deployedResource = callArgs[0];

      // Should fall back to resource metadata namespace
      expect(deployedResource.namespace).toBe('default');
    });

    it('restores cluster-scope metadata for JSON-restored cluster resources', async () => {
      const ns = namespace({ metadata: { name: 'alchemy-direct-ns' } });
      const restored = JSON.parse(JSON.stringify(ns));

      await deployer.delete(restored, { mode: 'direct', namespace: 'default' });

      const callArgs = mockEngine.deleteResource.mock.calls[0];
      const deployedResource = callArgs[0];
      expect(deployedResource.kind).toBe('Namespace');
      expect(deployedResource.namespace).toBe('');
      expect(getMetadataField(deployedResource.manifest, 'scope')).toBe('cluster');
    });
  });

  describe('TypeKroDeployer Interface Compliance', () => {
    let mockEngine: any;
    let deployer: DirectTypeKroDeployer;

    beforeEach(() => {
      mockEngine = createMockEngine();
      deployer = new DirectTypeKroDeployer(mockEngine);
    });

    it('should implement the TypeKroDeployer interface', () => {
      expect(deployer).toBeDefined();
      expect(deployer.constructor.name).toBe('DirectTypeKroDeployer');
      expect(typeof deployer.deploy).toBe('function');
      expect(typeof deployer.delete).toBe('function');
    });

    it('should work with different resource types', async () => {
      const serviceResource = createTestService('test-service');

      // Should handle Service resources
      const result = await deployer.deploy(serviceResource, {
        mode: 'direct',
        namespace: 'default',
        waitForReady: false,
      });

      expect(result.kind).toBe('Service');
      expect(getReadinessEvaluator(result)).toBeDefined();
    });
  });
});

describe('KroTypeKroDeployer', () => {
  const createMockEngine = () => ({
    deploy: mock(() =>
      Promise.resolve({
        status: 'success',
        deployedResources: [],
        duration: 100,
        errors: [],
      })
    ),
    deleteResource: mock(() => Promise.resolve()),
    dispose: mock(() => Promise.resolve()),
  }) as unknown as import('../../src/core/deployment/engine.js').DirectDeploymentEngine;

  it('throws when the deployment engine reports failure', async () => {
    const mockEngine = createMockEngine() as any;
    mockEngine.deploy.mockImplementation(() =>
      Promise.resolve({
        status: 'failed',
        errors: [{ error: new Error('KRO instance apply failed') }],
        deployedResources: [],
        duration: 100,
      })
    );
    const deployer = new KroTypeKroDeployer(mockEngine);
    const testDeployment = deployment({
      metadata: { name: 'kro-error-test', namespace: 'default' },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'kro-error-test' } },
        template: {
          metadata: { labels: { app: 'kro-error-test' } },
          spec: { containers: [{ name: 'app', image: 'nginx:alpine' }] },
        },
      },
    });

    await expect(
      deployer.deploy(testDeployment, {
        mode: 'kro',
        namespace: 'default',
      })
    ).rejects.toThrow('KRO instance apply failed');
  });

  it('adds the resource to the dependency graph passed to the engine', async () => {
    const mockEngine = createMockEngine() as any;
    const deployer = new KroTypeKroDeployer(mockEngine);
    const testDeployment = deployment({
      metadata: { name: 'kro-graph-test', namespace: 'default' },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'kro-graph-test' } },
        template: {
          metadata: { labels: { app: 'kro-graph-test' } },
          spec: { containers: [{ name: 'app', image: 'nginx:alpine' }] },
        },
      },
    });

    await deployer.deploy(testDeployment, {
      mode: 'kro',
      namespace: 'default',
    });

    const graph = mockEngine.deploy.mock.calls[0]?.[0];
    expect(graph.resources).toHaveLength(1);
    expect(graph.dependencyGraph.getNodes().size).toBe(1);
    expect(graph.dependencyGraph.hasNode(graph.resources[0].id)).toBe(true);
  });

  it('uses the factory deleteInstance hook for KRO custom resource deletion', async () => {
    const mockEngine = createMockEngine() as any;
    const deleteInstance = mock(() => Promise.resolve());
    const deployer = new KroTypeKroDeployer(mockEngine, { deleteInstance });
    const kroInstance = {
      apiVersion: 'test.kro.run/v1alpha1',
      kind: 'TestApp',
      metadata: { name: 'test-app', namespace: 'test-ns' },
      spec: {},
    } as any;

    await deployer.delete(kroInstance, { mode: 'kro', namespace: 'test-ns' });

    expect(deleteInstance).toHaveBeenCalledWith('test-app');
    expect(mockEngine.deleteResource).not.toHaveBeenCalled();
  });

  it('lists Alchemy KRO instances cluster-wide for shared RGD checks', async () => {
    const listCalls: Record<string, unknown>[] = [];
    const instances = await listKroInstancesForTest({} as any, {
      apiVersion: 'example.com/v1alpha1',
      group: 'example.com',
      kind: 'TestApp',
      namespace: 'apps-a',
      rgdName: 'test-app',
      plural: 'testapps',
    }, {
      listClusterCustomObject: async (request: Record<string, unknown>) => {
        listCalls.push(request);
        return { items: [{ metadata: { name: 'same-name', namespace: 'apps-b' } }] };
      },
    });

    expect(listCalls).toEqual([{ group: 'example.com', version: 'v1alpha1', plural: 'testapps' }]);
    expect(instances[0]?.metadata?.namespace).toBe('apps-b');
  });

  it('deletes KRO instance then removes RGD and CRD when no instances remain', async () => {
    const deletes: Record<string, any>[] = [];
    let readCount = 0;
    const k8sApi = {
      list: mock(() => Promise.resolve({ items: [] })),
      read: mock(() => {
        readCount += 1;
        if (readCount === 1) return Promise.resolve({ metadata: { name: 'test-app' } });
        return Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
      }),
      delete: mock((resource: Record<string, any>) => {
        deletes.push(resource);
        return Promise.resolve({});
      }),
    };
    const customApi = {
      listClusterCustomObject: mock(() => Promise.resolve({ items: [] })),
    };

    await deleteKroInstanceFinalizerSafeForTest({} as any, 'test-app', {
      apiVersion: 'example.com/v1alpha1',
      group: 'example.com',
      kind: 'TestApp',
      namespace: 'apps-a',
      rgdName: 'test-app',
      plural: 'testapps',
    }, {
      k8sApi,
      customApi,
      sleep: mock(() => Promise.resolve()),
    });

    expect(k8sApi.read).toHaveBeenCalledTimes(2);
    expect(customApi.listClusterCustomObject).toHaveBeenCalledWith({
      group: 'example.com',
      version: 'v1alpha1',
      plural: 'testapps',
    });
    expect(deletes).toEqual([
      {
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        metadata: { name: 'test-app', namespace: 'apps-a' },
      },
      {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'ResourceGraphDefinition',
        metadata: { name: 'test-app' },
      },
      {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'testapps.example.com' },
      },
    ]);
  });

  it('preserves KRO RGD and CRD while other instances still exist', async () => {
    const deletes: Record<string, any>[] = [];
    const k8sApi = {
      list: mock(() => Promise.resolve({ items: [] })),
      read: mock(() => Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }))),
      delete: mock((resource: Record<string, any>) => {
        deletes.push(resource);
        return Promise.resolve({});
      }),
    };
    const customApi = {
      listClusterCustomObject: mock(() =>
        Promise.resolve({ items: [{ metadata: { name: 'other-app', namespace: 'apps-a' } }] })
      ),
    };

    await deleteKroInstanceFinalizerSafeForTest({} as any, 'test-app', {
      apiVersion: 'example.com/v1alpha1',
      group: 'example.com',
      kind: 'TestApp',
      namespace: 'apps-a',
      rgdName: 'test-app',
      plural: 'testapps',
    }, {
      k8sApi,
      customApi,
      sleep: mock(() => Promise.resolve()),
    });

    expect(deletes).toEqual([
      {
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        metadata: { name: 'test-app', namespace: 'apps-a' },
      },
    ]);
  });

  it('treats missing KRO instances as deleted before finalizer-safe cleanup', async () => {
    const deletes: Record<string, any>[] = [];
    const k8sApi = {
      list: mock(() => Promise.resolve({ items: [] })),
      read: mock(() => Promise.resolve({})),
      delete: mock((resource: Record<string, any>) => {
        deletes.push(resource);
        if (resource.kind === 'TestApp') {
          return Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
        }
        return Promise.resolve({});
      }),
    };
    const customApi = {
      listClusterCustomObject: mock(() => Promise.resolve({ items: [] })),
    };

    await deleteKroInstanceFinalizerSafeForTest({} as any, 'missing-app', {
      apiVersion: 'example.com/v1alpha1',
      group: 'example.com',
      kind: 'TestApp',
      namespace: 'apps-a',
      rgdName: 'test-app',
      plural: 'testapps',
    }, {
      k8sApi,
      customApi,
      sleep: mock(() => Promise.resolve()),
    });

    expect(k8sApi.read).not.toHaveBeenCalled();
    expect(deletes.map((resource) => resource.kind)).toEqual([
      'TestApp',
      'ResourceGraphDefinition',
      'CustomResourceDefinition',
    ]);
  });

  it('fails without RGD cleanup when KRO instance deletion times out', async () => {
    const k8sApi = {
      list: mock(() => Promise.resolve({ items: [] })),
      read: mock(() => Promise.resolve({ metadata: { name: 'test-app' } })),
      delete: mock(() => Promise.resolve({})),
    };
    const customApi = {
      listClusterCustomObject: mock(() => Promise.resolve({ items: [] })),
    };

    await expect(deleteKroInstanceFinalizerSafeForTest({} as any, 'test-app', {
      apiVersion: 'example.com/v1alpha1',
      group: 'example.com',
      kind: 'TestApp',
      namespace: 'apps-a',
      rgdName: 'test-app',
      plural: 'testapps',
      timeout: 0,
    }, {
      k8sApi,
      customApi,
      sleep: mock(() => Promise.resolve()),
    })).rejects.toThrow('deletion did not complete');

    expect(k8sApi.delete).toHaveBeenCalledTimes(1);
    expect(customApi.listClusterCustomObject).not.toHaveBeenCalled();
  });

  it('propagates finalizer-safe RGD cleanup failures', async () => {
    const deletes: Record<string, any>[] = [];
    const k8sApi = {
      list: mock(() => Promise.resolve({ items: [] })),
      read: mock(() => Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }))),
      delete: mock((resource: Record<string, any>) => {
        deletes.push(resource);
        if (resource.kind === 'ResourceGraphDefinition') {
          return Promise.reject(Object.assign(new Error('RBAC denied'), { statusCode: 403 }));
        }
        return Promise.resolve({});
      }),
    };
    const customApi = {
      listClusterCustomObject: mock(() => Promise.resolve({ items: [] })),
    };

    await expect(deleteKroInstanceFinalizerSafeForTest({} as any, 'test-app', {
      apiVersion: 'example.com/v1alpha1',
      group: 'example.com',
      kind: 'TestApp',
      namespace: 'apps-a',
      rgdName: 'test-app',
      plural: 'testapps',
    }, {
      k8sApi,
      customApi,
      sleep: mock(() => Promise.resolve()),
    })).rejects.toThrow('RBAC denied');

    expect(deletes.map((resource) => resource.kind)).toEqual(['TestApp', 'ResourceGraphDefinition']);
  });

  it('treats missing generated CRD as idempotent Alchemy KRO definition cleanup', async () => {
    const deletes: Record<string, unknown>[] = [];
    const k8sApi = {
      list: mock(() => Promise.resolve({ items: [] })),
      delete: mock((resource: Record<string, unknown>) => {
        deletes.push(resource);
        return Promise.resolve({});
      }),
    };

    await deleteKroDefinition({} as any, {
      apiVersion: 'example.com/v1alpha1',
      group: 'example.com',
      kind: 'TestApp',
      namespace: 'apps-a',
      rgdName: 'test-app',
    }, k8sApi);

    expect(k8sApi.list).toHaveBeenCalledWith('apiextensions.k8s.io/v1', 'CustomResourceDefinition');
    expect(deletes).toEqual([
      {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'ResourceGraphDefinition',
        metadata: { name: 'test-app' },
      },
    ]);
  });

  it('defers ResourceGraphDefinition state deletion while KRO instances still exist', async () => {
    const mockEngine = createMockEngine() as any;
    const deleteInstance = mock(() => Promise.resolve());
    const shouldSkipRgdDelete = mock(() => Promise.resolve(true));
    const deployer = new KroTypeKroDeployer(mockEngine, { deleteInstance, shouldSkipRgdDelete });
    const rgd = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: 'test-app' },
      spec: {},
    } as any;

    await expect(deployer.delete(rgd, { mode: 'kro', namespace: 'test-ns' })).rejects.toThrow(
      'ResourceGraphDefinition deletion deferred'
    );
    await expect(deployer.delete(rgd, { mode: 'kro', namespace: 'test-ns' })).rejects.toBeInstanceOf(
      ResourceGraphDefinitionDeletionDeferredError
    );

    expect(deleteInstance).not.toHaveBeenCalled();
    expect(shouldSkipRgdDelete).toHaveBeenCalledWith('test-app');
    expect(mockEngine.deleteResource).not.toHaveBeenCalled();
  });

  it('deletes ResourceGraphDefinitions when no KRO instances were registered', async () => {
    const mockEngine = createMockEngine() as any;
    const deleteInstance = mock(() => Promise.resolve());
    const shouldSkipRgdDelete = mock(() => Promise.resolve(false));
    const deleteResourceGraphDefinition = mock(() => Promise.resolve());
    const deployer = new KroTypeKroDeployer(mockEngine, {
      deleteInstance,
      shouldSkipRgdDelete,
      deleteResourceGraphDefinition,
    });
    const rgd = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: 'test-app' },
      spec: {},
    } as any;

    await deployer.delete(rgd, { mode: 'kro', namespace: 'test-ns' });

    expect(deleteInstance).not.toHaveBeenCalled();
    expect(shouldSkipRgdDelete).toHaveBeenCalledWith('test-app');
    expect(deleteResourceGraphDefinition).toHaveBeenCalledWith('test-app');
    expect(mockEngine.deleteResource).not.toHaveBeenCalled();
  });

  it('refuses generic ResourceGraphDefinition deletion without finalizer-safe metadata', async () => {
    const mockEngine = createMockEngine() as any;
    const deployer = new KroTypeKroDeployer(mockEngine);
    const rgd = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: 'legacy-app' },
      spec: {},
    } as any;

    await expect(deployer.delete(rgd, { mode: 'kro', namespace: 'test-ns' })).rejects.toThrow(
      'ResourceGraphDefinition deletion requires finalizer-safe KRO metadata'
    );
    expect(mockEngine.deleteResource).not.toHaveBeenCalled();
  });

  it('infers finalizer-safe KRO deletion metadata from legacy RGD state', () => {
    const deletion = inferKroDeletionOptionsForTest({
      resource: {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'ResourceGraphDefinition',
        metadata: { name: 'legacy-app', namespace: 'apps' },
        spec: { schema: { apiVersion: 'v1alpha1', group: 'example.com', kind: 'LegacyApp' } },
      },
      namespace: 'fallback-ns',
      deploymentStrategy: 'kro',
    } as any);

    expect(deletion).toMatchObject({
      apiVersion: 'example.com/v1alpha1',
      group: 'example.com',
      kind: 'LegacyApp',
      namespace: 'apps',
      rgdName: 'legacy-app',
    });
  });

  it('infers finalizer-safe KRO deletion metadata from legacy instance state', () => {
    const deletion = inferKroDeletionOptionsForTest({
      resource: {
        apiVersion: 'example.com/v1alpha1',
        kind: 'LegacyApp',
        metadata: {
          name: 'legacy-instance',
          namespace: 'apps',
          labels: { 'typekro.io/rgd': 'legacy-app' },
        },
        spec: {},
      },
      namespace: 'fallback-ns',
      deploymentStrategy: 'kro',
    } as any);

    expect(deletion).toMatchObject({
      apiVersion: 'example.com/v1alpha1',
      group: 'example.com',
      kind: 'LegacyApp',
      namespace: 'apps',
      rgdName: 'legacy-app',
    });
  });

  it('does not infer finalizer-safe KRO deletion metadata from unlabeled legacy instances', () => {
    const deletion = inferKroDeletionOptionsForTest({
      resource: {
        apiVersion: 'example.com/v1alpha1',
        kind: 'LegacyApp',
        metadata: {
          name: 'legacy-instance',
          namespace: 'apps',
        },
        spec: {},
      },
      namespace: 'fallback-ns',
      deploymentStrategy: 'kro',
    } as any);

    expect(deletion).toBeUndefined();
  });

  it('propagates ResourceGraphDefinition delete failures so Alchemy keeps retry state', async () => {
    const mockEngine = createMockEngine() as any;
    const deleteResourceGraphDefinition = mock(() => Promise.reject(new Error('RBAC denied')));
    const deployer = new KroTypeKroDeployer(mockEngine, {
      deleteInstance: mock(() => Promise.resolve()),
      shouldSkipRgdDelete: mock(() => Promise.resolve(false)),
      deleteResourceGraphDefinition,
    });
    const rgd = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: 'test-app' },
      spec: {},
    } as any;

    await expect(deployer.delete(rgd, { mode: 'kro', namespace: 'test-ns' })).rejects.toThrow('RBAC denied');
    expect(deleteResourceGraphDefinition).toHaveBeenCalledWith('test-app');
  });

  it('keeps Alchemy state without failing when RGD deletion is deferred', async () => {
    const rgd = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: 'test-app' },
      spec: {},
    } as any;
    const destroy = mock(() => ({ destroyed: true }));
    const deployer = {
      delete: mock(() => Promise.reject(new ResourceGraphDefinitionDeletionDeferredError('test-app'))),
    };
    const logger = {
      debug: mock(() => undefined),
      error: mock(() => undefined),
    } as any;

    const result = await handleResourceDeletionForTest(
      { destroy, id: 'rgd-state' } as any,
      {
        resource: rgd,
        namespace: 'test-ns',
        deploymentStrategy: 'kro',
        deployer,
      } as any,
      logger
    );

    expect(destroy).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(result.resource).toBe(rgd);
    expect(result.deployedResource).toBe(rgd);
    expect(result.ready).toBe(false);
  });

  it('refuses generic KRO custom resource deletion without finalizer-safe metadata', async () => {
    const mockEngine = createMockEngine() as any;
    const deployer = new KroTypeKroDeployer(mockEngine);
    const kroInstance = {
      apiVersion: 'test.kro.run/v1alpha1',
      kind: 'TestApp',
      metadata: { name: 'stuck-app', namespace: 'test-ns' },
      spec: {},
    } as any;

    await expect(
      deployer.delete(kroInstance, { mode: 'kro', namespace: 'test-ns', timeout: 0 })
    ).rejects.toThrow('KRO resource deletion requires finalizer-safe metadata for TestApp/stuck-app');
    expect(mockEngine.deleteResource).not.toHaveBeenCalled();
  });

  it('refuses Alchemy generic KRO custom resource deletion without finalizer-safe metadata', async () => {
    const mockEngine = createMockEngine() as any;
    const deployer = new KroTypeKroDeployer(mockEngine);
    const kroInstance = {
      apiVersion: 'example.com/v1alpha1',
      kind: 'TestApp',
      metadata: { name: 'stuck-app', namespace: 'test-ns' },
      spec: {},
    } as any;

    await expect(
      deployer.delete(kroInstance, { mode: 'alchemy', namespace: 'test-ns', timeout: 0 } as any)
    ).rejects.toThrow('KRO resource deletion requires finalizer-safe metadata for TestApp/stuck-app');
    expect(mockEngine.deleteResource).not.toHaveBeenCalled();
  });

  it('does not destroy Alchemy state when resource deletion fails', async () => {
    const testDeployment = deployment({
      metadata: { name: 'delete-failure-test', namespace: 'default' },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'delete-failure-test' } },
        template: {
          metadata: { labels: { app: 'delete-failure-test' } },
          spec: { containers: [{ name: 'app', image: 'nginx:alpine' }] },
        },
      },
    });
    const destroy = mock(() => ({ destroyed: true }));
    const deployer = {
      delete: mock(() => Promise.reject(new Error('delete failed'))),
    };
    const logger = {
      error: mock(() => undefined),
    } as any;

    await expect(
      handleResourceDeletionForTest(
        { destroy } as any,
        {
          resource: testDeployment,
          namespace: 'test-ns',
          deploymentStrategy: 'direct',
          deployer,
        } as any,
        logger
      )
    ).rejects.toThrow('delete failed');

    expect(destroy).not.toHaveBeenCalled();
  });
});
