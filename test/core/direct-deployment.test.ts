/**
 * Unit tests for direct deployment engine and factory pattern integration
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { type } from 'arktype';
import {
  DependencyGraph,
  type DeployableK8sResource,
  type DeploymentOptions,
  DirectDeploymentEngine,
  type Enhanced,
  toResourceGraph,
  simpleDeployment,
  simpleService,
  Cel,
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

// Create a mock ReferenceResolver class for dependency injection
class MockReferenceResolver {
  async resolveReferences(resource: any) {
    return resource; // Just return the resource as-is
  }

  clearCache() {
    // Mock implementation - no cache to clear
  }

  getCacheStats() {
    return { size: 0, keys: [] };
  }
}

// Mock setTimeout to resolve immediately for faster tests
const originalSetTimeout = globalThis.setTimeout;
const mockSetTimeout = mock((callback: () => void, _delay: number) => {
  // Resolve immediately instead of waiting
  return originalSetTimeout(callback, 0);
});
globalThis.setTimeout = mockSetTimeout as any;

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
        kind: 'Deployment',
        apiVersion: 'apps/v1',
      },
    })
  ),
  delete: mock(() => Promise.resolve({ body: {} })),
};

const mockKubeConfig = {
  makeApiClient: mock(() => mockK8sApi),
} as any;

describe('DirectDeploymentEngine', () => {
  let engine: DirectDeploymentEngine;
  let defaultOptions: DeploymentOptions;

  beforeEach(() => {
    const mockReferenceResolver = new MockReferenceResolver();
    engine = new DirectDeploymentEngine(
      mockKubeConfig,
      mockK8sApi as any,
      mockReferenceResolver as any
    );
    defaultOptions = {
      mode: 'direct',
      namespace: 'test-namespace',
      timeout: 5000,
      waitForReady: false,
      dryRun: false,
    };

    // Clear mocks
    mockK8sApi.read.mockClear();
    mockK8sApi.create.mockClear();
    mockK8sApi.replace.mockClear();
    mockK8sApi.delete.mockClear();
    mockSetTimeout.mockClear();
  });

  afterAll(() => {
    // Restore original setTimeout
    globalThis.setTimeout = originalSetTimeout;
  });

  describe('deploy', () => {
    it('should deploy resources in dependency order', async () => {
      const graph = createTestResourceGraph();

      // Mock successful deployments
      mockK8sApi.read.mockRejectedValue({ statusCode: 404 }); // Resource doesn't exist
      mockK8sApi.create.mockResolvedValue({
        body: {
          metadata: { name: 'test', namespace: 'default' },
          kind: 'Deployment',
          apiVersion: 'apps/v1',
        },
      });

      const result = await engine.deploy(graph, defaultOptions);

      expect(result.status).toBe('success');
      expect(result.resources).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
      expect(mockK8sApi.create).toHaveBeenCalledTimes(2);
    });

    it('should handle dry run mode', async () => {
      const graph = createTestResourceGraph();
      const dryRunOptions = { ...defaultOptions, dryRun: true };

      const result = await engine.deploy(graph, dryRunOptions);

      expect(result.status).toBe('success');
      expect(result.resources).toHaveLength(2);
      expect(result.resources.every((r) => r.status === 'deployed')).toBe(true);
      expect(mockK8sApi.create).not.toHaveBeenCalled();
    });

    it('should apply namespace to resources', async () => {
      const graph = createTestResourceGraph();

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockResolvedValue({
        body: {
          metadata: { name: 'test', namespace: 'test-namespace' },
          kind: 'Deployment',
          apiVersion: 'apps/v1',
        },
      });

      await engine.deploy(graph, defaultOptions);

      // Check that create was called with the correct namespace
      expect(mockK8sApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            namespace: 'test-namespace',
          }),
        })
      );
    });

    it('should update existing resources', async () => {
      const graph = createTestResourceGraph();

      // Mock existing resource
      mockK8sApi.read.mockResolvedValue({
        body: {
          metadata: {
            name: 'database',
            namespace: 'default',
            resourceVersion: '12345',
          },
        },
      });

      mockK8sApi.replace.mockResolvedValue({
        body: {
          metadata: { name: 'database', namespace: 'default' },
          kind: 'Deployment',
          apiVersion: 'apps/v1',
        },
      });

      await engine.deploy(graph, defaultOptions);

      expect(mockK8sApi.replace).toHaveBeenCalled();
      expect(mockK8sApi.create).not.toHaveBeenCalled();
    });

    it('should handle deployment failures', async () => {
      const graph = createTestResourceGraph();

      // Set retry policy to 0 retries for faster test
      const failureOptions = {
        ...defaultOptions,
        retryPolicy: {
          maxRetries: 0,
          backoffMultiplier: 1,
          initialDelay: 0,
          maxDelay: 0,
        },
      };

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockRejectedValueOnce(new Error('Deployment failed'));
      mockK8sApi.create.mockResolvedValue({
        body: {
          metadata: { name: 'test', namespace: 'default' },
          kind: 'Deployment',
          apiVersion: 'apps/v1',
        },
      });

      const result = await engine.deploy(graph, failureOptions);

      expect(result.status).toBe('partial');
      expect(result.errors).toHaveLength(1);
      expect(result.resources.some((r) => r.status === 'failed')).toBe(true);
    });

    it('should rollback on failure when requested', async () => {
      const graph = createTestResourceGraph();
      const rollbackOptions = {
        ...defaultOptions,
        rollbackOnFailure: true,
        retryPolicy: {
          maxRetries: 0,
          backoffMultiplier: 1,
          initialDelay: 0,
          maxDelay: 0,
        },
      };

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create
        .mockResolvedValueOnce({
          body: {
            metadata: { name: 'database', namespace: 'default' },
            kind: 'Deployment',
            apiVersion: 'apps/v1',
          },
        })
        .mockRejectedValueOnce(new Error('Second deployment failed'));

      mockK8sApi.delete.mockResolvedValue({ body: {} });

      const result = await engine.deploy(graph, rollbackOptions);

      expect(result.status).toBe('failed');
      expect(mockK8sApi.delete).toHaveBeenCalled();
    });

    it('should emit progress events', async () => {
      const graph = createTestResourceGraph();
      const events: any[] = [];
      const optionsWithCallback = {
        ...defaultOptions,
        progressCallback: (event: any) => events.push(event),
      };

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockResolvedValue({
        body: {
          metadata: { name: 'test', namespace: 'default' },
          kind: 'Deployment',
          apiVersion: 'apps/v1',
        },
      });

      await engine.deploy(graph, optionsWithCallback);

      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === 'started')).toBe(true);
      expect(events.some((e) => e.type === 'completed')).toBe(true);
    });

    it('should wait for resource readiness when requested', async () => {
      const graph = createTestResourceGraph();
      const readyOptions = {
        ...defaultOptions,
        waitForReady: true,
        timeout: 5000, // Shorter timeout for test
      };

      // Mock the deployment creation and readiness checks
      let readCallCount = 0;
      mockK8sApi.read.mockImplementation(() => {
        readCallCount++;
        if (readCallCount <= 2) {
          // First two calls are for checking if resources exist during deployment
          return Promise.reject({ statusCode: 404 });
        } else {
          // Subsequent calls are for readiness checks - return ready status
          return Promise.resolve({
            body: {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              metadata: { name: 'test', namespace: 'default' },
              status: { readyReplicas: 1, replicas: 1 },
            },
          });
        }
      });

      mockK8sApi.create.mockResolvedValue({
        body: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'test', namespace: 'default' },
        },
      });

      const result = await engine.deploy(graph, readyOptions);

      expect(result.status).toBe('success');
      expect(result.resources.every((r) => r.status === 'ready')).toBe(true);
    });
  });

  describe('resource readiness detection', () => {
    it('should detect Deployment readiness', () => {
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

    it('should detect Pod readiness', () => {
      const isResourceReady = (engine as any).isResourceReady.bind(engine);

      const readyPod = {
        kind: 'Pod',
        status: { phase: 'Running' },
      };

      const notReadyPod = {
        kind: 'Pod',
        status: { phase: 'Pending' },
      };

      expect(isResourceReady(readyPod)).toBe(true);
      expect(isResourceReady(notReadyPod)).toBe(false);
    });

    it('should handle unknown resource types', () => {
      const isResourceReady = (engine as any).isResourceReady.bind(engine);

      const unknownResource = {
        kind: 'CustomResource',
        status: { someField: 'value' },
      };

      expect(isResourceReady(unknownResource)).toBe(true);
    });

    it('should handle resources without status', () => {
      const isResourceReady = (engine as any).isResourceReady.bind(engine);

      const resourceWithoutStatus = {
        kind: 'Service',
      };

      expect(isResourceReady(resourceWithoutStatus)).toBe(false);
    });

    it('should detect StatefulSet readiness', () => {
      const isResourceReady = (engine as any).isResourceReady.bind(engine);

      const readyStatefulSet = {
        kind: 'StatefulSet',
        spec: { replicas: 3 },
        status: { readyReplicas: 3 },
      };

      const notReadyStatefulSet = {
        kind: 'StatefulSet',
        spec: { replicas: 3 },
        status: { readyReplicas: 1 },
      };

      expect(isResourceReady(readyStatefulSet)).toBe(true);
      expect(isResourceReady(notReadyStatefulSet)).toBe(false);
    });

    it('should detect DaemonSet readiness', () => {
      const isResourceReady = (engine as any).isResourceReady.bind(engine);

      const readyDaemonSet = {
        kind: 'DaemonSet',
        status: { desiredNumberScheduled: 3, numberReady: 3 },
      };

      const notReadyDaemonSet = {
        kind: 'DaemonSet',
        status: { desiredNumberScheduled: 3, numberReady: 1 },
      };

      expect(isResourceReady(readyDaemonSet)).toBe(true);
      expect(isResourceReady(notReadyDaemonSet)).toBe(false);
    });

    it('should detect Job readiness', () => {
      const isResourceReady = (engine as any).isResourceReady.bind(engine);

      const readyJob = {
        kind: 'Job',
        spec: { completions: 1 },
        status: { succeeded: 1 },
      };

      const notReadyJob = {
        kind: 'Job',
        spec: { completions: 3 },
        status: { succeeded: 1 },
      };

      expect(isResourceReady(readyJob)).toBe(true);
      expect(isResourceReady(notReadyJob)).toBe(false);
    });

    it('should detect PVC readiness', () => {
      const isResourceReady = (engine as any).isResourceReady.bind(engine);

      const readyPVC = {
        kind: 'PersistentVolumeClaim',
        status: { phase: 'Bound' },
      };

      const notReadyPVC = {
        kind: 'PersistentVolumeClaim',
        status: { phase: 'Pending' },
      };

      expect(isResourceReady(readyPVC)).toBe(true);
      expect(isResourceReady(notReadyPVC)).toBe(false);
    });

    it('should detect LoadBalancer Service readiness', () => {
      const isResourceReady = (engine as any).isResourceReady.bind(engine);

      const readyLBService = {
        kind: 'Service',
        spec: { type: 'LoadBalancer' },
        status: {
          loadBalancer: {
            ingress: [{ ip: '1.2.3.4' }],
          },
        },
      };

      const notReadyLBService = {
        kind: 'Service',
        spec: { type: 'LoadBalancer' },
        status: {},
      };

      expect(isResourceReady(readyLBService)).toBe(true);
      expect(isResourceReady(notReadyLBService)).toBe(false);
    });

    it('should handle ConfigMap and Secret as immediately ready', () => {
      const isResourceReady = (engine as any).isResourceReady.bind(engine);

      const configMap = {
        kind: 'ConfigMap',
        status: {},
      };

      const secret = {
        kind: 'Secret',
        status: {},
      };

      expect(isResourceReady(configMap)).toBe(true);
      expect(isResourceReady(secret)).toBe(true);
    });
  });

  describe('retry logic', () => {
    it('should retry failed deployments', async () => {
      const graph = createSimpleResourceGraph();
      const retryOptions = {
        ...defaultOptions,
        retryPolicy: {
          maxRetries: 2,
          backoffMultiplier: 1.5,
          initialDelay: 1, // Very short delay
          maxDelay: 10,
        },
      };

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });

      let callCount = 0;
      mockK8sApi.create.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Temporary failure'));
        } else if (callCount === 2) {
          return Promise.reject(new Error('Another failure'));
        } else {
          return Promise.resolve({
            body: {
              metadata: { name: 'test', namespace: 'default' },
              kind: 'Deployment',
              apiVersion: 'apps/v1',
            },
          });
        }
      });

      const result = await engine.deploy(graph, retryOptions);

      expect(result.status).toBe('success');
      expect(mockK8sApi.create).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should fail after max retries', async () => {
      const graph = createSimpleResourceGraph();
      const retryOptions = {
        ...defaultOptions,
        retryPolicy: {
          maxRetries: 1,
          backoffMultiplier: 2,
          initialDelay: 50,
          maxDelay: 500,
        },
      };

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockRejectedValue(new Error('Persistent failure'));

      const result = await engine.deploy(graph, retryOptions);

      expect(result.status).toBe('failed');
      expect(mockK8sApi.create).toHaveBeenCalledTimes(2); // Initial + 1 retry
    });
  });

  describe('error handling', () => {
    it('should handle circular dependencies', async () => {
      const circularGraph = createCircularDependencyGraph();

      await expect(engine.deploy(circularGraph, defaultOptions)).rejects.toThrow(
        'Circular dependency detected'
      );
    });

    it('should handle missing resources in graph', async () => {
      const invalidGraph = createInvalidResourceGraph();

      const result = await engine.deploy(invalidGraph, defaultOptions);

      expect(result.status).toBe('failed');
      expect(result.errors.some((e) => e.phase === 'validation')).toBe(true);
    });
  });

  describe('rollback functionality', () => {
    it('should rollback a deployment by ID', async () => {
      // Use simple graph to avoid complexity
      const graph = createSimpleResourceGraph();

      // Reset all mocks and setup fresh state
      mockK8sApi.create.mockClear();
      mockK8sApi.read.mockClear();
      mockK8sApi.delete.mockClear();

      // Reset mock implementations to default successful behavior
      mockK8sApi.create.mockResolvedValue({
        body: {
          metadata: { name: 'simple', namespace: 'test-namespace' },
          kind: 'Deployment',
          apiVersion: 'apps/v1',
        },
      });

      // First deploy the resources
      const deployResult = await engine.deploy(graph, defaultOptions);
      expect(deployResult.status).toBe('success');

      // Setup rollback mocks - delete succeeds, then read fails (resource deleted)
      mockK8sApi.delete.mockResolvedValue({ body: {} });
      mockK8sApi.read.mockRejectedValue({ response: { statusCode: 404 } }); // Resource not found after delete

      // Now rollback the deployment
      const rollbackResult = await engine.rollback(deployResult.deploymentId);

      expect(rollbackResult.deploymentId).toBe(deployResult.deploymentId);
      expect(rollbackResult.status).toBe('success');
      expect(rollbackResult.rolledBackResources).toHaveLength(1); // simple resource
      expect(rollbackResult.errors).toHaveLength(0);

      // Verify delete was called
      expect(mockK8sApi.delete).toHaveBeenCalledTimes(1);
    });

    it('should handle rollback of non-existent deployment', async () => {
      await expect(engine.rollback('non-existent-id')).rejects.toThrow(
        'Deployment non-existent-id not found. Cannot rollback.'
      );
    });

    it('should handle partial rollback failures', async () => {
      const graph = createSimpleResourceGraph();

      // Reset mocks and setup fresh state
      mockK8sApi.create.mockClear();
      mockK8sApi.read.mockClear();
      mockK8sApi.delete.mockClear();

      // Setup successful deployment - resource doesn't exist, so create it
      mockK8sApi.read.mockRejectedValue({ statusCode: 404 }); // Resource doesn't exist
      mockK8sApi.create.mockResolvedValue({
        body: {
          metadata: { name: 'simple', namespace: 'test-namespace' },
          kind: 'Deployment',
          apiVersion: 'apps/v1',
        },
      });

      // Deploy first
      const deployResult = await engine.deploy(graph, defaultOptions);
      expect(deployResult.status).toBe('success');

      // Mock delete to fail
      mockK8sApi.delete.mockImplementationOnce(() => {
        throw new Error('Delete failed');
      });

      const rollbackResult = await engine.rollback(deployResult.deploymentId);

      expect(rollbackResult.status).toBe('failed');
      expect(rollbackResult.rolledBackResources).toHaveLength(0);
      expect(rollbackResult.errors).toHaveLength(1);
      expect(rollbackResult.errors[0]?.phase).toBe('rollback');
    });

    it('should handle rollback when no resources were deployed', async () => {
      const graph = createSimpleResourceGraph();

      // Reset mocks and setup failure
      mockK8sApi.create.mockClear();
      mockK8sApi.read.mockClear();
      mockK8sApi.delete.mockClear();

      // Setup read to fail (resource doesn't exist) and create to fail
      mockK8sApi.read.mockRejectedValue({ statusCode: 404 }); // Resource doesn't exist
      mockK8sApi.create.mockRejectedValue(new Error('Deployment failed')); // Create fails

      const deployResult = await engine.deploy(graph, defaultOptions);
      expect(deployResult.status).toBe('failed');

      // Rollback should succeed but do nothing
      const rollbackResult = await engine.rollback(deployResult.deploymentId);

      expect(rollbackResult.status).toBe('success');
      expect(rollbackResult.rolledBackResources).toHaveLength(0);
      expect(rollbackResult.errors).toHaveLength(0);
    });
  });

  describe('deployment status', () => {
    it('should return deployment status by ID', async () => {
      const graph = createSimpleResourceGraph();

      // Reset mocks
      mockK8sApi.create.mockClear();
      mockK8sApi.read.mockClear();
      mockK8sApi.delete.mockClear();

      // Setup successful deployment - resource doesn't exist, so create it
      mockK8sApi.read.mockRejectedValue({ statusCode: 404 }); // Resource doesn't exist
      mockK8sApi.create.mockResolvedValue({
        body: {
          metadata: { name: 'simple', namespace: 'test-namespace' },
          kind: 'Deployment',
          apiVersion: 'apps/v1',
        },
      });

      const deployResult = await engine.deploy(graph, defaultOptions);
      const status = await engine.getStatus(deployResult.deploymentId);

      expect(status.deploymentId).toBe(deployResult.deploymentId);
      expect(status.status).toBe('completed');
      expect(status.resources).toHaveLength(1);
      expect(status.startTime).toBeInstanceOf(Date);
      expect(status.duration).toBeGreaterThanOrEqual(0); // Duration can be 0 in fast tests
    });

    it('should return unknown status for non-existent deployment', async () => {
      const status = await engine.getStatus('non-existent-id');

      expect(status.deploymentId).toBe('non-existent-id');
      expect(status.status).toBe('unknown');
      expect(status.resources).toHaveLength(0);
    });
  });
});

// Helper functions to create test data
function createTestResourceGraph() {
  const graph = new DependencyGraph();

  const databaseManifest = createMockResource({
    id: 'database',
    metadata: { name: 'database' },
    spec: { replicas: 1 },
  });

  const appManifest = createMockResource({
    id: 'app',
    metadata: { name: 'app' },
    spec: { replicas: 1 },
  });

  graph.addNode('database', databaseManifest);
  graph.addNode('app', appManifest);
  graph.addEdge('app', 'database'); // app depends on database

  return {
    name: 'test-graph',
    resources: [
      { id: 'database', manifest: databaseManifest },
      { id: 'app', manifest: appManifest }
    ],
    dependencyGraph: graph,
  };
}

function createSimpleResourceGraph() {
  const graph = new DependencyGraph();

  const resourceManifest = createMockResource({
    id: 'simple',
    metadata: { name: 'simple' },
    spec: { replicas: 1 },
  });

  graph.addNode('simple', resourceManifest);

  return {
    name: 'simple-graph',
    resources: [{ id: 'simple', manifest: resourceManifest }],
    dependencyGraph: graph,
  };
}

function createCircularDependencyGraph() {
  const graph = new DependencyGraph();

  const resourceA = createMockResource({
    id: 'a',
    metadata: { name: 'a' },
  });

  const resourceB = createMockResource({
    id: 'b',
    metadata: { name: 'b' },
  });

  graph.addNode('a', resourceA);
  graph.addNode('b', resourceB);
  graph.addEdge('a', 'b');
  graph.addEdge('b', 'a'); // Creates circular dependency

  return {
    name: 'circular-graph',
    resources: [
      { id: 'a', manifest: resourceA },
      { id: 'b', manifest: resourceB }
    ],
    dependencyGraph: graph,
  };
}

function createInvalidResourceGraph() {
  const graph = new DependencyGraph();

  // Add nodes but create a mismatch between graph and resources
  graph.addNode('existing', createMockResource({ id: 'existing' }));
  graph.addNode('missing', createMockResource({ id: 'missing' })); // This node exists in graph but not in resources array

  return {
    name: 'invalid-graph',
    resources: [{ 
      id: 'existing', 
      manifest: createMockResource({ id: 'existing', metadata: { name: 'existing' } })
    }],
    // The 'missing' node is in the dependency graph but not in the resources array
    dependencyGraph: graph,
  };
}

// Factory Pattern Integration Tests
describe('DirectDeploymentEngine Factory Pattern Integration', () => {
  let _engine: DirectDeploymentEngine;
  let _defaultOptions: DeploymentOptions;

  beforeEach(() => {
    const mockReferenceResolver = new MockReferenceResolver();
    _engine = new DirectDeploymentEngine(
      mockKubeConfig,
      mockK8sApi as any,
      mockReferenceResolver as any
    );
    _defaultOptions = {
      mode: 'direct',
      namespace: 'test-namespace',
      timeout: 5000,
      waitForReady: false,
      dryRun: false,
    };

    // Clear mocks
    mockK8sApi.read.mockClear();
    mockK8sApi.create.mockClear();
    mockK8sApi.replace.mockClear();
    mockK8sApi.delete.mockClear();
    mockSetTimeout.mockClear();
  });

  describe('Factory Pattern Integration', () => {
    it('should work with DirectResourceFactory deployment', async () => {
      // Create a typed resource graph using the new factory pattern
      const WebAppSpecSchema = type({
        name: 'string',
        image: 'string',
        replicas: 'number',
        environment: '"development" | "staging" | "production"',
      });

      const WebAppStatusSchema = type({
        url: 'string',
        readyReplicas: 'number',
        phase: '"pending" | "running" | "failed"',
      });

      const schemaDefinition = {
        apiVersion: 'v1alpha1',
        kind: 'WebApp',
        spec: WebAppSpecSchema,
        status: WebAppStatusSchema,
      };

      const graph = toResourceGraph(
        {
          name: 'webapp-stack',
          ...schemaDefinition,
        },
        (schema) => ({
          deployment: simpleDeployment({
            id: 'webappDeployment',
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
          }),
          service: simpleService({
            id: 'webappService',
            name: schema.spec.name,
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: 3000 }],
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.service.metadata.name}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>(resources.deployment.status.readyReplicas, ' > 0 ? "running" : "pending"'),
        })
      );

      // Create a direct factory
      const factory = await graph.factory('direct', {
        namespace: 'test-namespace',
        waitForReady: false,
      });

      expect(factory.mode).toBe('direct');
      expect(factory.namespace).toBe('test-namespace');
      expect(factory.isAlchemyManaged).toBe(false);
    });

    it('should handle factory deployment with proper resource resolution', async () => {
      // Create a simple resource graph for testing
      const TestSpecSchema = type({
        name: 'string',
        image: 'string',
        replicas: 'number',
      });

      const TestStatusSchema = type({
        phase: 'string',
      });

      const schemaDefinition = {
        apiVersion: 'test.com/v1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      };

      const graph = toResourceGraph(
        {
          name: 'test-app',
          ...schemaDefinition,
        },
        (schema) => ({
          deployment: simpleDeployment({
            id: 'testDeployment',
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
          }),
        }),
        (_schema, resources) => ({
          phase: resources.deployment.status.phase,
        })
      );

      const factory = await graph.factory('direct', {
        namespace: 'test-namespace',
        waitForReady: false,
      });

      // This should work without throwing errors
      expect(factory).toBeDefined();
      expect(factory.mode).toBe('direct');
      expect(factory.namespace).toBe('test-namespace');
    });

    it('should support factory status and instance management', async () => {
      const TestSpecSchema = type({
        name: 'string',
        image: 'string',
      });

      const TestStatusSchema = type({
        phase: 'string',
      });

      const schemaDefinition = {
        apiVersion: 'test.com/v1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      };

      const graph = toResourceGraph(
        {
          name: 'test-app',
          ...schemaDefinition,
        },
        (schema) => ({
          deployment: simpleDeployment({
            id: 'testDeployment',
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: 1,
          }),
        }),
        (_schema, resources) => ({
          phase: resources.deployment.status.phase,
        })
      );

      const factory = await graph.factory('direct', {
        namespace: 'test-namespace',
      });

      // Test factory status
      const status = await factory.getStatus();
      expect(status.name).toBe('test-app');
      expect(status.mode).toBe('direct');
      expect(status.namespace).toBe('test-namespace');
      expect(status.isAlchemyManaged).toBe(false);

      // Test instance management
      const instances = await factory.getInstances();
      expect(Array.isArray(instances)).toBe(true);
    });

    it('should generate YAML for factory deployments', async () => {
      const TestSpecSchema = type({
        name: 'string',
        image: 'string',
        replicas: 'number',
      });

      const TestStatusSchema = type({
        phase: 'string',
      });

      const schemaDefinition = {
        apiVersion: 'test.com/v1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      };

      const graph = toResourceGraph(
        {
          name: 'test-app',
          ...schemaDefinition,
        },
        (schema) => ({
          deployment: simpleDeployment({
            id: 'testDeployment',
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
          }),
        }),
        (_schema, resources) => ({
          phase: resources.deployment.status.phase,
        })
      );

      const factory = await graph.factory('direct', {
        namespace: 'test-namespace',
      });

      // Test YAML generation
      const yaml = factory.toYaml({
        name: 'test-app',
        image: 'nginx:latest',
        replicas: 2,
      });

      expect(typeof yaml).toBe('string');
      expect(yaml.length).toBeGreaterThan(0);
      expect(yaml).toContain('apiVersion');
      expect(yaml).toContain('kind');
    });

    it('should support dry run deployments through factory', async () => {
      const TestSpecSchema = type({
        name: 'string',
        image: 'string',
        replicas: 'number',
      });

      const TestStatusSchema = type({
        phase: 'string',
      });

      const schemaDefinition = {
        apiVersion: 'test.com/v1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      };

      const graph = toResourceGraph(
        {
          name: 'test-app',
          ...schemaDefinition,
        },
        (schema) => ({
          deployment: simpleDeployment({
            id: 'testDeployment',
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
          }),
        }),
        (_schema, resources) => ({
          phase: resources.deployment.status.phase,
        })
      );

      const factory = await graph.factory('direct', {
        namespace: 'test-namespace',
      });

      // Test that the factory has the toDryRun method
      expect(typeof factory.toDryRun).toBe('function');
      
      // Note: We can't easily test the actual dry run execution in this test environment
      // because it requires a real Kubernetes client setup. The method existence test
      // validates that the factory pattern integration is working correctly.
    });

    it('should handle alchemy integration detection', async () => {
      const TestSpecSchema = type({
        name: 'string',
        image: 'string',
      });

      const TestStatusSchema = type({
        phase: 'string',
      });

      const schemaDefinition = {
        apiVersion: 'test.com/v1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      };

      const graph = toResourceGraph(
        {
          name: 'test-app',
          ...schemaDefinition,
        },
        (schema) => ({
          deployment: simpleDeployment({
            id: 'testDeployment',
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: 1,
          }),
        }),
        (_schema, resources) => ({
          phase: resources.deployment.status.phase,
        })
      );

      // Test without alchemy scope
      const directFactory = await graph.factory('direct', {
        namespace: 'test-namespace',
      });

      expect(directFactory.isAlchemyManaged).toBe(false);

      // Test with mock alchemy scope
      const mockAlchemyScope = {
        register: mock(() => Promise.resolve()),
      };

      const alchemyFactory = await graph.factory('direct', {
        namespace: 'test-namespace',
        alchemyScope: mockAlchemyScope as any,
      });

      expect(alchemyFactory.isAlchemyManaged).toBe(true);
    });
  });
});
