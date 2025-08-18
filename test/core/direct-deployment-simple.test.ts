/**
 * Simplified tests for direct deployment engine
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  DependencyGraph,
  type DeployableK8sResource,
  type DeployedResource,
  type DeploymentOptions,
  DirectDeploymentEngine,
  type Enhanced,
} from '../../src/core.js';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';
import { service } from '../../src/factories/kubernetes/networking/service.js';

// Helper function to create properly typed test resources with mock readiness evaluators
function createMockResource(
  overrides: Partial<DeployableK8sResource<Enhanced<any, any>>> = {}
): DeployableK8sResource<Enhanced<any, any>> {
  const resource = {
    id: 'testResource',
    kind: 'Deployment',
    apiVersion: 'apps/v1',
    metadata: { name: 'test-resource' },
    spec: {},
    status: {},
    ...overrides,
  } as DeployableK8sResource<Enhanced<any, any>>;

  // Add a mock readiness evaluator for testing
  Object.defineProperty(resource, 'readinessEvaluator', {
    value: () => ({ ready: true, message: 'Mock resource ready' }),
    enumerable: false,
    configurable: true,
    writable: false
  });

  return resource;
}

// Mock the Kubernetes client
const mockK8sApi = {
  read: mock((resource?: any) => {
    // Default to resource not found (404) unless specifically mocked otherwise
    return Promise.reject({ statusCode: 404 });
  }),
  create: mock((resource?: any) =>
    Promise.resolve({
      body: {
        metadata: { name: resource?.metadata?.name || 'test', namespace: resource?.metadata?.namespace || 'default' },
        kind: resource?.kind || 'Deployment',
        apiVersion: resource?.apiVersion || 'apps/v1',
      },
    })
  ),
  patch: mock((resource?: any) =>
    Promise.resolve({
      body: {
        metadata: { name: resource?.metadata?.name || 'test', namespace: resource?.metadata?.namespace || 'default' },
        kind: resource?.kind || 'ConfigMap',
        apiVersion: resource?.apiVersion || 'v1',
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
    engine = new DirectDeploymentEngine(mockKubeConfig, mockK8sApi as any, mockReferenceResolver as any);
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
    mockK8sApi.patch.mockClear();
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

      // Mock resource doesn't exist initially, then exists after creation
      let readCallCount = 0;
      mockK8sApi.read.mockImplementation(() => {
        readCallCount++;
        if (readCallCount === 1) {
          // First call during deployment - resource doesn't exist yet
          return Promise.reject({ statusCode: 404 });
        } else {
          // Subsequent calls during readiness check - resource exists
          return Promise.resolve({
            body: {
              metadata: { name: 'test-deployment', namespace: 'test-namespace' },
              kind: 'Deployment',
              apiVersion: 'apps/v1',
              status: { readyReplicas: 1, availableReplicas: 1 }
            },
          });
        }
      });

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

      // Mock existing resource - first call finds it, subsequent calls return updated version
      mockK8sApi.read.mockResolvedValue({
        body: {
          metadata: {
            name: 'existing-config',
            namespace: 'test-namespace',
            resourceVersion: '12345',
          },
          kind: 'ConfigMap',
          apiVersion: 'v1',
        },
      });

      // Since the resource exists, the engine should use patch, not create
      mockK8sApi.patch.mockResolvedValue({
        body: {
          metadata: { name: 'existing-config', namespace: 'test-namespace' },
          kind: 'ConfigMap',
          apiVersion: 'v1',
        },
      });

      const result = await engine.deployResource(resource, defaultOptions);

      expect(result.status).toBe('deployed');
      expect(mockK8sApi.patch).toHaveBeenCalledTimes(1);
      expect(mockK8sApi.create).not.toHaveBeenCalled();
    });

    it('should apply namespace to resources', async () => {
      const resource = createMockResource({
        id: 'testResource',
        kind: 'Pod',
        apiVersion: 'v1',
        metadata: { name: 'test-pod' },
      });

      // Mock resource doesn't exist initially, then exists after creation
      let readCallCount = 0;
      mockK8sApi.read.mockImplementation(() => {
        readCallCount++;
        if (readCallCount === 1) {
          return Promise.reject({ statusCode: 404 });
        } else {
          return Promise.resolve({
            body: {
              metadata: { name: 'test-pod', namespace: 'test-namespace' },
              kind: 'Pod',
              apiVersion: 'v1',
              status: { phase: 'Running' }
            },
          });
        }
      });

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

      // Mock resource doesn't exist initially, then exists after creation
      let readCallCount = 0;
      mockK8sApi.read.mockImplementation(() => {
        readCallCount++;
        if (readCallCount === 1) {
          return Promise.reject({ statusCode: 404 });
        } else {
          return Promise.resolve({
            body: {
              metadata: { name: 'simple', namespace: 'test-namespace' },
              kind: 'Deployment',
              apiVersion: 'apps/v1',
              status: { readyReplicas: 1, availableReplicas: 1 }
            },
          });
        }
      });

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
      // Test deployment failure by making the create call fail
      const resource = createMockResource({
        id: 'failingResource',
        metadata: { name: 'failing-deployment' },
        spec: { replicas: 1 },
      });

      // Clear previous mocks and set up fresh ones for this test
      mockK8sApi.read.mockClear();
      mockK8sApi.create.mockClear();
      
      // Mock resource doesn't exist, and create fails
      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockRejectedValue(new Error('Deployment failed'));

      // Use faster retry policy for testing, but still test the retry logic
      const testRetryOptions = {
        ...defaultOptions,
        timeout: 10000, // 10 second timeout to allow for retries
        retryPolicy: {
          maxRetries: 2, // Fewer retries for faster testing
          initialDelay: 100, // Faster delays for testing
          maxDelay: 500,
          backoffMultiplier: 2,
        }
      };

      // This should fail after retrying, demonstrating graceful error handling
      await expect(engine.deployResource(resource, testRetryOptions)).rejects.toThrow('Deployment failed');
    }, 15000); // 15 second test timeout to allow for retries
  });

  describe('resource readiness detection', () => {
    it('should detect Deployment readiness using factory evaluator', async () => {
      // Create deployed resources using factory functions with readiness evaluators
      // Create a deployment using the factory function (which includes readiness evaluator)
      const readyDeploymentManifest = deployment({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'ready-deployment', namespace: 'default' },
        spec: { 
          replicas: 3,
          selector: { matchLabels: { app: 'ready-deployment' } },
          template: {
            metadata: { labels: { app: 'ready-deployment' } },
            spec: { containers: [{ name: 'app', image: 'nginx' }] }
          }
        }
      });

      const readyDeployedResource: DeployedResource = {
        id: 'ready-deployment',
        kind: 'Deployment',
        name: 'ready-deployment',
        namespace: 'default',
        manifest: readyDeploymentManifest as any, // Cast to KubernetesResource for DeployedResource
        status: 'deployed',
        deployedAt: new Date()
      };

      // Create a deployment using the factory function (which includes readiness evaluator)
      const notReadyDeploymentManifest = deployment({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'not-ready-deployment', namespace: 'default' },
        spec: { 
          replicas: 3,
          selector: { matchLabels: { app: 'not-ready-deployment' } },
          template: {
            metadata: { labels: { app: 'not-ready-deployment' } },
            spec: { containers: [{ name: 'app', image: 'nginx' }] }
          }
        }
      });

      const notReadyDeployedResource: DeployedResource = {
        id: 'not-ready-deployment',
        kind: 'Deployment',
        name: 'not-ready-deployment',
        namespace: 'default',
        manifest: notReadyDeploymentManifest as any, // Cast to KubernetesResource for DeployedResource
        status: 'deployed',
        deployedAt: new Date()
      };

      // Mock the k8s API to return different statuses
      mockK8sApi.read.mockImplementation((resource: any) => {
        const name = resource.metadata?.name;
        if (name === 'ready-deployment') {
          return Promise.resolve({
            body: {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              metadata: { name: 'ready-deployment', namespace: 'default' },
              spec: { replicas: 3 },
              status: { readyReplicas: 3, availableReplicas: 3, replicas: 3 }
            }
          });
        } else if (name === 'not-ready-deployment') {
          return Promise.resolve({
            body: {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              metadata: { name: 'not-ready-deployment', namespace: 'default' },
              spec: { replicas: 3 },
              status: { readyReplicas: 1, availableReplicas: 1, replicas: 3 }
            }
          });
        } else {
          return Promise.reject({ statusCode: 404 });
        }
      });

      const readyResult = await engine.isDeployedResourceReady(readyDeployedResource);
      const notReadyResult = await engine.isDeployedResourceReady(notReadyDeployedResource);

      expect(readyResult).toBe(true);
      expect(notReadyResult).toBe(false);
    });

    it('should handle Service readiness using full evaluation pipeline', async () => {
      // Create a deployed resource with a proper readiness evaluator (like from service factory)
      // Create a service using the factory function (which includes readiness evaluator)
      const serviceManifest = service({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'test-service', namespace: 'default' },
        spec: { ports: [{ port: 80 }], type: 'ClusterIP' }
      });

      const deployedResource: DeployedResource = {
        id: 'test-service',
        kind: 'Service',
        name: 'test-service',
        namespace: 'default',
        manifest: serviceManifest as any, // Cast to KubernetesResource for DeployedResource
        status: 'deployed',
        deployedAt: new Date()
      };

      // Mock the k8s API to return the service with status
      mockK8sApi.read.mockResolvedValue({
        body: {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: { name: 'test-service', namespace: 'default' },
          spec: { ports: [{ port: 80 }], type: 'ClusterIP' },
          status: {}
        }
      });

      const isReady = await engine.isDeployedResourceReady(deployedResource);
      expect(isReady).toBe(true);
    });

    it('should handle resources without status using full evaluation pipeline', async () => {
      // Create a deployed resource that would use the full evaluation pipeline
      const deployedResource: DeployedResource = {
        id: 'test-configmap',
        kind: 'ConfigMap',
        name: 'test-configmap',
        namespace: 'default',
        manifest: {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'test-configmap', namespace: 'default' }
          // No status field
        },
        status: 'deployed',
        deployedAt: new Date()
      };

      // Mock the k8s API to return the configmap without status
      mockK8sApi.read.mockResolvedValue({
        body: {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'test-configmap', namespace: 'default' }
          // No status field
        }
      });

      const isReady = await engine.isDeployedResourceReady(deployedResource);
      expect(isReady).toBe(false);
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
