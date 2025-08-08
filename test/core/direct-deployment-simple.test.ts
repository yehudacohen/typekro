/**
 * Simplified tests for direct deployment engine
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  DependencyGraph,
  type DeployableK8sResource,
  type DeploymentOptions,
  DirectDeploymentEngine,
  type Enhanced,
} from '../../src/core.js';

// Helper function to create properly typed test resources
function createMockResource(
  overrides: Partial<DeployableK8sResource<Enhanced<any, any>>> = {}
): DeployableK8sResource<Enhanced<any, any>> {
  return {
    id: 'testResource',
    kind: 'Deployment',
    apiVersion: 'apps/v1',
    metadata: { name: 'test-resource' },
    spec: {},
    status: {},
    ...overrides,
  } as DeployableK8sResource<Enhanced<any, any>>;
}

// Mock the Kubernetes client
const mockK8sApi = {
  read: mock(() => Promise.resolve({ body: {} })),
  create: mock(() =>
    Promise.resolve({
      body: {
        metadata: { name: 'test', namespace: 'default' },
        kind: 'Deployment',
        apiVersion: 'apps/v1',
      },
    })
  ),
  replace: mock(() =>
    Promise.resolve({
      body: {
        metadata: { name: 'test', namespace: 'default' },
        kind: 'ConfigMap',
        apiVersion: 'v1',
      },
    })
  ),
  delete: mock(() => Promise.resolve({ body: {} })),
};

const mockKubeConfig = {
  makeApiClient: mock(() => mockK8sApi),
} as any;

// Mock the ReferenceResolver to avoid infinite loops
const mockReferenceResolver = {
  resolveReferences: mock(async (resource: any) => resource), // Just return the resource as-is
  clearCache: mock(() => {
    // Mock implementation - no cache to clear
  }),
  getCacheStats: mock(() => ({ size: 0, keys: [] })),
};

mock.module('../../src/core/reference-resolver.js', () => ({
  ReferenceResolver: mock(() => mockReferenceResolver),
}));

describe('DirectDeploymentEngine Simple', () => {
  let engine: DirectDeploymentEngine;
  let defaultOptions: DeploymentOptions;

  beforeEach(() => {
    engine = new DirectDeploymentEngine(mockKubeConfig, mockK8sApi as any);
    defaultOptions = {
      mode: 'direct',
      namespace: 'test-namespace',
      timeout: 1000, // Short timeout for tests
      waitForReady: false,
      dryRun: false,
    };

    // Clear mocks
    mockK8sApi.read.mockClear();
    mockK8sApi.create.mockClear();
    mockK8sApi.replace.mockClear();
    mockK8sApi.delete.mockClear();
    mockReferenceResolver.resolveReferences.mockClear();
  });

  describe('deployResource', () => {
    it('should deploy a single resource successfully', async () => {
      const resource = createMockResource({
        id: 'testResource',
        metadata: { name: 'test-deployment' },
        spec: { replicas: 1 },
      });

      // Mock resource doesn't exist
      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockResolvedValue({
        body: {
          metadata: { name: 'test-deployment', namespace: 'test-namespace' },
          kind: 'Deployment',
          apiVersion: 'apps/v1',
        },
      });

      const result = await engine.deployResource(resource, defaultOptions);

      expect(result.id).toBe('testResource');
      expect(result.kind).toBe('Deployment');
      expect(result.status).toBe('deployed');
      expect(mockK8sApi.create).toHaveBeenCalledTimes(1);
    });

    it('should handle dry run mode', async () => {
      const resource = createMockResource({
        id: 'testResource',
        kind: 'Service',
        apiVersion: 'v1',
        metadata: { name: 'test-service' },
      });

      const dryRunOptions = { ...defaultOptions, dryRun: true };
      const result = await engine.deployResource(resource, dryRunOptions);

      expect(result.status).toBe('deployed');
      expect(mockK8sApi.create).not.toHaveBeenCalled();
      expect(mockK8sApi.read).not.toHaveBeenCalled();
    });

    it('should update existing resources', async () => {
      const resource = createMockResource({
        id: 'existingResource',
        kind: 'ConfigMap',
        apiVersion: 'v1',
        metadata: { name: 'existing-config' },
      });

      // Mock existing resource
      mockK8sApi.read.mockResolvedValue({
        body: {
          metadata: {
            name: 'existing-config',
            namespace: 'test-namespace',
            resourceVersion: '12345',
          },
        },
      });

      mockK8sApi.replace.mockResolvedValue({
        body: {
          metadata: { name: 'existing-config', namespace: 'test-namespace' },
          kind: 'ConfigMap',
          apiVersion: 'v1',
        },
      });

      const result = await engine.deployResource(resource, defaultOptions);

      expect(result.status).toBe('deployed');
      expect(mockK8sApi.replace).toHaveBeenCalledTimes(1);
      expect(mockK8sApi.create).not.toHaveBeenCalled();
    });

    it('should apply namespace to resources', async () => {
      const resource = createMockResource({
        id: 'testResource',
        kind: 'Pod',
        apiVersion: 'v1',
        metadata: { name: 'test-pod' },
      });

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockResolvedValue({
        body: {
          metadata: { name: 'test-pod', namespace: 'test-namespace' },
          kind: 'Pod',
          apiVersion: 'v1',
        },
      });

      await engine.deployResource(resource, defaultOptions);

      expect(mockK8sApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            namespace: 'test-namespace',
          }),
        })
      );
    });
  });

  describe('deploy with simple graph', () => {
    it('should deploy a simple resource graph', async () => {
      const graph = createSimpleGraph();

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockResolvedValue({
        body: {
          metadata: { name: 'simple', namespace: 'test-namespace' },
          kind: 'Deployment',
          apiVersion: 'apps/v1',
        },
      });

      const result = await engine.deploy(graph, defaultOptions);

      expect(result.status).toBe('success');
      expect(result.resources).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle deployment failures gracefully', async () => {
      // Test deployment failure by mocking the deployToCluster method directly
      const resource = createMockResource({
        id: 'failingResource',
        metadata: { name: 'failing-deployment' },
        spec: { replicas: 1 },
      });

      // Mock the deployToCluster method to throw an error
      const originalDeployToCluster = (engine as any).deployToCluster;
      (engine as any).deployToCluster = mock(() => {
        throw new Error('Deployment failed');
      });

      try {
        await engine.deployResource(resource, defaultOptions);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeDefined();
        expect((error as Error).message).toBe('Deployment failed');
      } finally {
        // Restore the original method
        (engine as any).deployToCluster = originalDeployToCluster;
      }
    });
  });

  describe('resource readiness detection', () => {
    it('should detect Deployment readiness correctly', () => {
      const isResourceReady = (engine as any).isResourceReady.bind(engine);

      const readyDeployment = {
        kind: 'Deployment',
        status: { readyReplicas: 3, replicas: 3 },
      };

      const notReadyDeployment = {
        kind: 'Deployment',
        status: { readyReplicas: 1, replicas: 3 },
      };

      expect(isResourceReady(readyDeployment)).toBe(true);
      expect(isResourceReady(notReadyDeployment)).toBe(false);
    });

    it('should handle Service readiness', () => {
      const isResourceReady = (engine as any).isResourceReady.bind(engine);

      const service = {
        kind: 'Service',
        status: {},
      };

      expect(isResourceReady(service)).toBe(true);
    });

    it('should handle resources without status', () => {
      const isResourceReady = (engine as any).isResourceReady.bind(engine);

      const resourceWithoutStatus = {
        kind: 'ConfigMap',
      };

      expect(isResourceReady(resourceWithoutStatus)).toBe(false);
    });
  });
});

// Helper functions
function createSimpleGraph() {
  const graph = new DependencyGraph();

  const manifest = createMockResource({
    id: 'simple',
    metadata: { name: 'simple' },
    spec: { replicas: 1 },
  });

  const resource = {
    id: 'simple',
    manifest: manifest,
  };

  graph.addNode('simple', manifest);

  return {
    name: 'simple-graph',
    resources: [resource],
    dependencyGraph: graph,
  };
}
