/**
 * Simplified tests for direct deployment engine
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { DependencyGraph } from '../../src/core/dependencies/index.js';
import { DeploymentTimeoutError } from '../../src/core/errors.js';
import { setMetadataField } from '../../src/core/metadata/index.js';
import { resourceGraphDefinition } from '../../src/factories/kro/resource-graph-definition.js';
import { service } from '../../src/factories/kubernetes/networking/service.js';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';
import {
  type DeployableK8sResource,
  type DeployedResource,
  type DeploymentOptions,
  type DeploymentResourceGraph,
  DirectDeploymentEngine,
  type Enhanced,
  type KubernetesResource,
} from '../../src/index.js';

// Helper function to create properly typed test resources with mock readiness evaluators
function createMockResource(
  overrides: {
    id?: string;
    kind?: string;
    apiVersion?: string;
    metadata?: { name?: string; namespace?: string; [key: string]: unknown };
    spec?: Record<string, unknown>;
    status?: Record<string, unknown>;
  } = {}
): DeployableK8sResource<Enhanced<object, object>> {
  const base = {
    id: 'testResource',
    kind: 'Deployment',
    apiVersion: 'apps/v1',
    metadata: { name: 'test-resource' },
    spec: {},
    status: {},
  };
  const resource = {
    ...base,
    ...overrides,
    metadata: { ...base.metadata, ...overrides.metadata },
  } as unknown as DeployableK8sResource<Enhanced<object, object>>;

  // Add a mock readiness evaluator for testing
  Object.defineProperty(resource, 'readinessEvaluator', {
    value: () => ({ ready: true, message: 'Mock resource ready' }),
    enumerable: false,
    configurable: true,
    writable: false,
  });

  return resource;
}

// Mock the Kubernetes client
// NOTE: In the new @kubernetes/client-node API (v1.x), methods return objects directly
// without a .body wrapper. The mocks must return the resource directly.
const mockK8sApi = {
  read: mock(
    (_resource?: Record<string, unknown>): Promise<Record<string, unknown>> =>
      Promise.reject({ statusCode: 404 })
  ),
  create: mock((resource?: Record<string, unknown>) =>
    Promise.resolve({
      metadata: {
        name: (resource?.metadata as Record<string, unknown>)?.name || 'test',
        namespace: (resource?.metadata as Record<string, unknown>)?.namespace || 'default',
      },
      kind: resource?.kind || 'Deployment',
      apiVersion: resource?.apiVersion || 'apps/v1',
    })
  ),
  patch: mock((resource?: Record<string, unknown>) =>
    // Returns object directly (no .body wrapper)
    Promise.resolve({
      metadata: {
        name: (resource?.metadata as Record<string, unknown>)?.name || 'test',
        namespace: (resource?.metadata as Record<string, unknown>)?.namespace || 'default',
      },
      kind: resource?.kind || 'ConfigMap',
      apiVersion: resource?.apiVersion || 'v1',
    })
  ),
  delete: mock(() => Promise.resolve({})),
};

const mockKubeConfig = {
  makeApiClient: mock(() => mockK8sApi),
} as unknown as import('@kubernetes/client-node').KubeConfig;

// Mock the ReferenceResolver to avoid infinite loops
const mockReferenceResolver = {
  resolveReferences: mock(
    async (resource: any, _context?: { resourceKeyMapping?: Map<string, unknown> }) => resource
  ), // Just return the resource as-is
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
    engine = new DirectDeploymentEngine(
      mockKubeConfig,
      mockK8sApi as unknown as import('@kubernetes/client-node').KubernetesObjectApi,
      mockReferenceResolver as unknown as import('../../src/core/references/resolver.js').ReferenceResolver
    );
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
    mockK8sApi.read.mockImplementation((_resource?: Record<string, unknown>) =>
      Promise.reject({ statusCode: 404 })
    );
    mockK8sApi.create.mockImplementation((resource?: Record<string, unknown>) =>
      Promise.resolve({
        metadata: {
          name: (resource?.metadata as Record<string, unknown>)?.name || 'test',
          namespace: (resource?.metadata as Record<string, unknown>)?.namespace || 'default',
        },
        kind: resource?.kind || 'Deployment',
        apiVersion: resource?.apiVersion || 'apps/v1',
      })
    );
    mockK8sApi.patch.mockImplementation((resource?: Record<string, unknown>) =>
      Promise.resolve({
        metadata: {
          name: (resource?.metadata as Record<string, unknown>)?.name || 'test',
          namespace: (resource?.metadata as Record<string, unknown>)?.namespace || 'default',
        },
        kind: resource?.kind || 'ConfigMap',
        apiVersion: resource?.apiVersion || 'v1',
      })
    );
    mockK8sApi.delete.mockImplementation(() => Promise.resolve({}));
    mockReferenceResolver.resolveReferences.mockClear();
    mockReferenceResolver.resolveReferences.mockImplementation(async (resource: any) => resource);
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
      // New API returns objects directly (no .body wrapper)
      mockK8sApi.read.mockImplementation(() => {
        readCallCount++;
        if (readCallCount === 1) {
          // First call during deployment - resource doesn't exist yet
          return Promise.reject({ statusCode: 404 });
        } else {
          // Subsequent calls during readiness check - resource exists
          return Promise.resolve({
            metadata: { name: 'test-deployment', namespace: 'test-namespace' },
            kind: 'Deployment',
            apiVersion: 'apps/v1',
            status: { readyReplicas: 1, availableReplicas: 1 },
          });
        }
      });

      mockK8sApi.create.mockResolvedValue({
        metadata: { name: 'test-deployment', namespace: 'test-namespace' },
        kind: 'Deployment',
        apiVersion: 'apps/v1',
      });

      const result = await engine.deployResource(resource, defaultOptions);

      expect(result.id).toBe('testResource');
      expect(result.kind).toBe('Deployment');
      expect(result.status).toBe('deployed');
      expect(mockK8sApi.create).toHaveBeenCalledTimes(1);
    });

    it('reattaches registered readiness before applying a single resource', async () => {
      const enhanced = resourceGraphDefinition({
        metadata: { name: 'registered-readiness' },
        spec: { schema: {}, resources: [] },
      });
      const resource = {
        ...enhanced,
        id: 'registered-readiness',
      } as DeployableK8sResource<Enhanced<object, object>>;
      let readCount = 0;
      mockK8sApi.read.mockImplementation(() => {
        readCount += 1;
        if (readCount === 1) return Promise.reject({ statusCode: 404 });
        return Promise.resolve({
          apiVersion: 'kro.run/v1alpha1',
          kind: 'ResourceGraphDefinition',
          metadata: { name: 'registered-readiness', generation: 1 },
          status: {
            state: 'Active',
            conditions: [{ type: 'Ready', status: 'True', observedGeneration: 1 }],
          },
        });
      });

      const result = await engine.deployResource(resource, {
        ...defaultOptions,
        waitForReady: true,
      });

      expect(result.status).toBe('ready');
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
      // New API returns objects directly (no .body wrapper)
      mockK8sApi.read.mockResolvedValue({
        metadata: {
          name: 'existing-config',
          namespace: 'test-namespace',
          resourceVersion: '12345',
        },
        kind: 'ConfigMap',
        apiVersion: 'v1',
      });

      // Since the resource exists, the engine should use patch, not create
      mockK8sApi.patch.mockResolvedValue({
        metadata: { name: 'existing-config', namespace: 'test-namespace' },
        kind: 'ConfigMap',
        apiVersion: 'v1',
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
      // New API returns objects directly (no .body wrapper)
      let readCallCount = 0;
      mockK8sApi.read.mockImplementation(() => {
        readCallCount++;
        if (readCallCount === 1) {
          return Promise.reject({ statusCode: 404 });
        } else {
          return Promise.resolve({
            metadata: { name: 'test-pod', namespace: 'test-namespace' },
            kind: 'Pod',
            apiVersion: 'v1',
            status: { phase: 'Running' },
          });
        }
      });

      mockK8sApi.create.mockResolvedValue({
        metadata: { name: 'test-pod', namespace: 'test-namespace' },
        kind: 'Pod',
        apiVersion: 'v1',
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

  describe('deployment timeout watchdog', () => {
    it('aborts with contextual deployment timeout evidence', async () => {
      let timeoutHandler: (() => void) | undefined;
      const fakeTimer = { unref: mock() } as unknown as ReturnType<typeof setTimeout>;
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((handler: TimerHandler) => {
        timeoutHandler = handler as () => void;
        return fakeTimer;
      }) as unknown as typeof setTimeout;

      try {
        const setupDeploymentTimeout = (
          engine as unknown as {
            setupDeploymentTimeout: (
              deploymentId: string,
              options: DeploymentOptions,
              deploymentLogger: { debug: (...args: unknown[]) => void }
            ) => { abortController: AbortController };
          }
        ).setupDeploymentTimeout.bind(engine);

        const { abortController } = setupDeploymentTimeout(
          'deployment-contextual-timeout',
          {
            ...defaultOptions,
            timeout: 1234,
            factoryName: 'web-stack',
            instanceName: 'production',
          },
          { debug: mock() }
        );
        timeoutHandler?.();

        expect(abortController.signal.aborted).toBe(true);
        expect(abortController.signal.reason).toBeInstanceOf(DeploymentTimeoutError);
        const reason = abortController.signal.reason as DeploymentTimeoutError;
        expect(reason.operation).toBe('deployment');
        expect(reason.resourceName).toBe('production');
        expect(reason.timeoutMs).toBe(1234);
        expect(reason.message).toContain('web-stack/production');
        expect(reason.message).toContain('Pending resource, readiness, and closure operations');
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }
    });

    it('unrefs the deployment watchdog timer so it cannot keep the process alive', () => {
      const fakeTimer = {
        unref: mock(),
      } as unknown as ReturnType<typeof setTimeout>;

      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
        void handler;
        void args;
        return fakeTimer;
      }) as unknown as typeof setTimeout;

      try {
        const setupDeploymentTimeout = (
          engine as unknown as {
            setupDeploymentTimeout: (
              deploymentId: string,
              options: DeploymentOptions,
              deploymentLogger: { debug: (...args: unknown[]) => void }
            ) => { timeoutId: ReturnType<typeof setTimeout> };
          }
        ).setupDeploymentTimeout.bind(engine);

        const { timeoutId } = setupDeploymentTimeout('deployment-test', defaultOptions, {
          debug: mock(),
        });

        expect(timeoutId).toBe(fakeTimer);
        expect(
          (fakeTimer as unknown as { unref: ReturnType<typeof mock> }).unref
        ).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }
    });

    it('forwards a caller abort signal into the deployment controller', async () => {
      const external = new AbortController();
      const setupDeploymentTimeout = (
        engine as unknown as {
          setupDeploymentTimeout: (
            deploymentId: string,
            options: DeploymentOptions,
            deploymentLogger: { debug: (...args: unknown[]) => void }
          ) => {
            abortController: AbortController;
            timeoutId: ReturnType<typeof setTimeout>;
            detachExternalAbort: () => void;
          };
          cleanupDeployment: (
            abortController: AbortController,
            timeoutId: ReturnType<typeof setTimeout>,
            deploymentLogger: { debug: (...args: unknown[]) => void },
            detachExternalAbort: () => void
          ) => Promise<void>;
        }
      ).setupDeploymentTimeout.bind(engine);
      const cleanupDeployment = (
        engine as unknown as {
          cleanupDeployment: (
            abortController: AbortController,
            timeoutId: ReturnType<typeof setTimeout>,
            deploymentLogger: { debug: (...args: unknown[]) => void },
            detachExternalAbort: () => void
          ) => Promise<void>;
        }
      ).cleanupDeployment.bind(engine);
      const logger = { debug: mock() };

      const setup = setupDeploymentTimeout(
        'deployment-external-abort',
        { ...defaultOptions, abortSignal: external.signal },
        logger
      );
      const reason = new Error('caller cancelled');
      external.abort(reason);

      expect(setup.abortController.signal.aborted).toBe(true);
      expect(setup.abortController.signal.reason).toBe(reason);

      await cleanupDeployment(
        setup.abortController,
        setup.timeoutId,
        logger,
        setup.detachExternalAbort
      );
    });
  });

  describe('deploy with simple graph', () => {
    it('should deploy a simple resource graph', async () => {
      const graph = createSimpleGraph();

      // Mock resource doesn't exist initially, then exists after creation
      // New API returns objects directly (no .body wrapper)
      let readCallCount = 0;
      mockK8sApi.read.mockImplementation(() => {
        readCallCount++;
        if (readCallCount === 1) {
          return Promise.reject({ statusCode: 404 });
        } else {
          return Promise.resolve({
            metadata: { name: 'simple', namespace: 'test-namespace' },
            kind: 'Deployment',
            apiVersion: 'apps/v1',
            status: { readyReplicas: 1, availableReplicas: 1 },
          });
        }
      });

      mockK8sApi.create.mockResolvedValue({
        metadata: { name: 'simple', namespace: 'test-namespace' },
        kind: 'Deployment',
        apiVersion: 'apps/v1',
      });

      const result = await engine.deploy(graph, defaultOptions);

      expect(result.status).toBe('success');
      expect(result.resources).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('pre-reads external references into resolution context without applying them', async () => {
      const graph = createSimpleGraph();
      const external = createMockResource({
        id: 'platformConfig',
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'platform-config', namespace: 'platform-system' },
      });
      graph.externalReferences = [{ id: 'platformConfig', manifest: external }];
      const liveExternal = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'platform-config', namespace: 'platform-system' },
        data: { region: 'us-east-1' },
      };
      mockK8sApi.read.mockImplementation((target?: Record<string, unknown>) => {
        if (target?.kind === 'ConfigMap') return Promise.resolve(liveExternal);
        return Promise.reject({ statusCode: 404 });
      });
      mockReferenceResolver.resolveReferences.mockImplementation(
        async (
          resource: KubernetesResource,
          context?: { resourceKeyMapping?: Map<string, unknown> }
        ) => {
          expect(context?.resourceKeyMapping?.get('platformConfig')).toBe(liveExternal);
          return resource;
        }
      );

      const result = await engine.deploy(graph, defaultOptions);

      expect(result.status).toBe('success');
      expect(mockK8sApi.read).toHaveBeenCalledWith({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'platform-config', namespace: 'platform-system' },
      });
      expect(mockK8sApi.create).toHaveBeenCalledTimes(1);
    });

    it('resolves external references from seeds before attempting a cluster read', async () => {
      const graph = createSimpleGraph();
      const external = createMockResource({
        id: 'singletonOwner',
        apiVersion: 'kro.run/v1alpha1',
        kind: 'SharedPlatform',
        metadata: { name: 'shared-platform', namespace: 'typekro-singletons' },
      });
      graph.externalReferences = [{ id: 'singletonOwner', manifest: external }];
      const seededManifest = {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'SharedPlatform',
        metadata: { name: 'shared-platform', namespace: 'typekro-singletons' },
        status: { ready: true, endpoint: 'http://shared-platform:80' },
      };
      const seed: DeployedResource = {
        id: 'singletonOwner',
        kind: 'SharedPlatform',
        name: 'shared-platform',
        namespace: 'typekro-singletons',
        manifest: seededManifest,
        liveManifest: seededManifest,
        status: 'ready',
        applied: false,
        deployedAt: new Date(),
      };
      mockReferenceResolver.resolveReferences.mockImplementation(
        async (
          resource: KubernetesResource,
          context?: { resourceKeyMapping?: Map<string, unknown> }
        ) => {
          expect(context?.resourceKeyMapping?.get('singletonOwner')).toBe(seededManifest);
          return resource;
        }
      );

      const result = await engine.deploy(graph, defaultOptions, [seed]);

      expect(result.status).toBe('success');
      expect(mockK8sApi.read).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'SharedPlatform' })
      );
      expect(result.resources.some((resource) => resource.id === seed.id)).toBe(false);
    });

    it('fails before applying managed resources when a required external reference is missing', async () => {
      const graph = createSimpleGraph();
      const external = createMockResource({
        id: 'platformConfig',
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'missing-config', namespace: 'platform-system' },
      });
      graph.externalReferences = [{ id: 'platformConfig', manifest: external }];
      mockK8sApi.read.mockRejectedValue({ statusCode: 404, message: 'Not Found' });

      const result = await engine.deploy(graph, defaultOptions);

      expect(result.status).toBe('failed');
      expect(result.errors[0]?.error.message).toContain(
        'Required external resource ConfigMap/missing-config could not be read'
      );
      expect(mockK8sApi.create).not.toHaveBeenCalled();
      expect(mockK8sApi.patch).not.toHaveBeenCalled();
    });

    it('reads cluster-scoped external references without adding a namespace', async () => {
      const graph = createSimpleGraph();
      const external = createMockResource({
        id: 'clusterPolicy',
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRole',
        metadata: { name: 'platform-reader' },
      });
      setMetadataField(external, 'scope', 'cluster');
      graph.externalReferences = [{ id: 'clusterPolicy', manifest: external }];
      mockK8sApi.read.mockImplementation((target?: Record<string, unknown>) => {
        if (target?.kind === 'ClusterRole') {
          return Promise.resolve({
            apiVersion: 'rbac.authorization.k8s.io/v1',
            kind: 'ClusterRole',
            metadata: { name: 'platform-reader' },
          });
        }
        return Promise.reject({ statusCode: 404 });
      });

      const result = await engine.deploy(graph, defaultOptions);

      expect(result.status).toBe('success');
      expect(mockK8sApi.read).toHaveBeenCalledWith({
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRole',
        metadata: { name: 'platform-reader' },
      });
      expect(mockK8sApi.create).toHaveBeenCalledTimes(1);
    });

    it('reads an external reference with in-graph dependencies only after they are applied', async () => {
      // The observed Service is created by `owner`, so reading it before `owner` is applied is
      // exactly the 404 that issue #187 reports.
      const graph = createSimpleGraph();
      const consumer = createMockResource({
        id: 'consumer',
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'consumer' },
      });
      graph.resources.push({ id: 'consumer', manifest: consumer });
      graph.dependencyGraph.addNode('consumer', consumer);
      graph.dependencyGraph.addEdge('consumer', 'simple');

      const observed = createMockResource({
        id: 'chartService',
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'chart-service', namespace: 'test-namespace' },
      });
      graph.externalReferences = [
        { id: 'chartService', manifest: observed, dependsOn: ['simple'] },
      ];

      const liveObserved = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'chart-service', namespace: 'test-namespace' },
        spec: { clusterIP: '10.0.0.7' },
      };
      let ownerApplied = false;
      const ownerAppliedAtServiceRead: boolean[] = [];
      mockK8sApi.create.mockImplementation((resource?: Record<string, unknown>) => {
        if (resource?.kind === 'Deployment') ownerApplied = true;
        return Promise.resolve({
          apiVersion: resource?.apiVersion ?? 'apps/v1',
          kind: resource?.kind ?? 'Deployment',
          metadata: (resource?.metadata ?? {}) as { name: string; namespace: string },
        });
      });
      mockK8sApi.read.mockImplementation((target?: Record<string, unknown>) => {
        if (target?.kind === 'Service') {
          ownerAppliedAtServiceRead.push(ownerApplied);
          return ownerApplied ? Promise.resolve(liveObserved) : Promise.reject({ statusCode: 404 });
        }
        return Promise.reject({ statusCode: 404 });
      });

      let observedSeenByConsumer: unknown;
      mockReferenceResolver.resolveReferences.mockImplementation(
        async (
          resource: KubernetesResource,
          context?: { resourceKeyMapping?: Map<string, unknown> }
        ) => {
          if (resource.kind === 'ConfigMap') {
            observedSeenByConsumer = context?.resourceKeyMapping?.get('chartService');
          }
          return resource;
        }
      );

      const result = await engine.deploy(graph, defaultOptions);

      expect(result.status).toBe('success');
      // Every attempt to read the observed Service happened after its owner was applied.
      expect(ownerAppliedAtServiceRead.length).toBeGreaterThan(0);
      expect(ownerAppliedAtServiceRead.every(Boolean)).toBe(true);
      // …and a resource scheduled after the observed Service sees the live read in its context.
      expect(observedSeenByConsumer).toBe(liveObserved);
    });

    it('resolves an external reference without in-graph dependencies before applying anything', async () => {
      const graph = createSimpleGraph();
      const external = createMockResource({
        id: 'platformConfig',
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'platform-config', namespace: 'platform-system' },
      });
      graph.externalReferences = [{ id: 'platformConfig', manifest: external }];
      const liveExternal = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'platform-config', namespace: 'platform-system' },
      };
      let createsBeforeExternalRead: number | undefined;
      mockK8sApi.read.mockImplementation((target?: Record<string, unknown>) => {
        if (target?.kind === 'ConfigMap') {
          createsBeforeExternalRead ??= mockK8sApi.create.mock.calls.length;
          return Promise.resolve(liveExternal);
        }
        return Promise.reject({ statusCode: 404 });
      });

      const result = await engine.deploy(graph, defaultOptions);

      expect(result.status).toBe('success');
      expect(createsBeforeExternalRead).toBe(0);
    });

    it('fails naming an external reference that never appears after its dependencies', async () => {
      const graph = createSimpleGraph();
      const observed = createMockResource({
        id: 'chartService',
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'chart-service', namespace: 'test-namespace' },
      });
      graph.externalReferences = [
        { id: 'chartService', manifest: observed, dependsOn: ['simple'] },
      ];
      mockK8sApi.read.mockImplementation(() => Promise.reject({ statusCode: 404 }));

      // A short deployment timeout leaves no read budget, so the wait ends on the first attempt.
      const result = await engine.deploy(graph, { ...defaultOptions, timeout: 200 });

      expect(result.status).toBe('failed');
      const message = result.errors[0]?.error.message ?? '';
      expect(message).toContain('Service/chart-service');
      expect(message).toContain("reference 'chartService'");
      expect(message).toContain('dependsOn targets [simple]');
      expect(message).toMatch(/after waiting \d+ms/);
    });

    describe('deferred external reference read errors', () => {
      const liveObserved = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'chart-service', namespace: 'test-namespace' },
        spec: { clusterIP: '10.0.0.7' },
      };

      // A graph whose observed Service is produced by `simple`, so its read is deferred behind it.
      function graphWithDeferredService(): DeploymentResourceGraph {
        const graph = createSimpleGraph();
        const observed = createMockResource({
          id: 'chartService',
          apiVersion: 'v1',
          kind: 'Service',
          metadata: { name: 'chart-service', namespace: 'test-namespace' },
        });
        graph.externalReferences = [
          { id: 'chartService', manifest: observed, dependsOn: ['simple'] },
        ];
        return graph;
      }

      /**
       * Fail the observed Service read with `failures` in order, then serve it live. Reads for
       * anything else stay 404 so the owning Deployment still takes the create path.
       */
      function failServiceReadsThenServe(failures: unknown[]): void {
        let attempt = 0;
        mockK8sApi.read.mockImplementation((target?: Record<string, unknown>) => {
          if (target?.kind !== 'Service') return Promise.reject({ statusCode: 404 });
          const failure = failures[attempt++];
          return failure === undefined
            ? Promise.resolve(liveObserved)
            : Promise.reject(failure as Record<string, unknown>);
        });
      }

      /** Always fail the observed Service read with the same error. */
      function failServiceReads(failure: unknown): void {
        mockK8sApi.read.mockImplementation((target?: Record<string, unknown>) =>
          Promise.reject(
            (target?.kind === 'Service' ? failure : { statusCode: 404 }) as Record<string, unknown>
          )
        );
      }

      // A budget wide enough that spending it would take ~10s — long enough for the fail-fast
      // assertions below to be unambiguous, and long enough to allow one poll interval of retry.
      const retryOptions = { timeout: 12_000 };

      it('keeps polling a 404 until the observed resource appears', async () => {
        failServiceReadsThenServe([{ statusCode: 404 }]);

        const result = await engine.deploy(graphWithDeferredService(), {
          ...defaultOptions,
          ...retryOptions,
        });

        expect(result.status).toBe('success');
        const serviceReads = mockK8sApi.read.mock.calls.filter(
          ([target]) => (target as Record<string, unknown> | undefined)?.kind === 'Service'
        );
        expect(serviceReads.length).toBeGreaterThanOrEqual(2);
      });

      it('keeps polling a 500 until the read succeeds', async () => {
        failServiceReadsThenServe([{ statusCode: 500, body: { code: 500, message: 'etcd busy' } }]);

        const result = await engine.deploy(graphWithDeferredService(), {
          ...defaultOptions,
          ...retryOptions,
        });

        expect(result.status).toBe('success');
      });

      it('keeps polling a transport failure until the read succeeds', async () => {
        failServiceReadsThenServe([new Error('connect ECONNREFUSED 127.0.0.1:6443')]);

        const result = await engine.deploy(graphWithDeferredService(), {
          ...defaultOptions,
          ...retryOptions,
        });

        expect(result.status).toBe('success');
      });

      it('fails immediately on a 403 instead of spending the read budget', async () => {
        failServiceReads({
          statusCode: 403,
          body: {
            code: 403,
            reason: 'Forbidden',
            message: 'services "chart-service" is forbidden: User cannot get resource "services"',
          },
        });

        const startedAt = Date.now();
        const result = await engine.deploy(graphWithDeferredService(), {
          ...defaultOptions,
          ...retryOptions,
        });
        const elapsed = Date.now() - startedAt;

        expect(result.status).toBe('failed');
        // The budget is ~10s; a fail-fast must land nowhere near it.
        expect(elapsed).toBeLessThan(2_000);
        const message = result.errors[0]?.error.message ?? '';
        expect(message).toContain('Service/chart-service');
        expect(message).toContain("reference 'chartService'");
        expect(message).toContain('permission denied (HTTP 403)');
        expect(message).toContain('dependsOn targets [simple]');
        expect(message).toContain('is forbidden');
        expect(message).not.toMatch(/after waiting \d+ms/);
        // Exactly one attempt — no polling at all.
        const serviceReads = mockK8sApi.read.mock.calls.filter(
          ([target]) => (target as Record<string, unknown> | undefined)?.kind === 'Service'
        );
        expect(serviceReads).toHaveLength(1);
      });

      it('fails immediately on a 422', async () => {
        failServiceReads({
          statusCode: 422,
          body: { code: 422, reason: 'Invalid', message: 'Service "chart-service" is invalid' },
        });

        const startedAt = Date.now();
        const result = await engine.deploy(graphWithDeferredService(), {
          ...defaultOptions,
          ...retryOptions,
        });

        expect(result.status).toBe('failed');
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        const message = result.errors[0]?.error.message ?? '';
        expect(message).toContain("reference 'chartService'");
        expect(message).toContain('invalid request (HTTP 422)');
      });

      it('fails immediately when the resource type itself is not served', async () => {
        failServiceReads({
          statusCode: 404,
          body: {
            code: 404,
            reason: 'NotFound',
            message: 'the server could not find the requested resource',
            details: {},
          },
        });

        const startedAt = Date.now();
        const result = await engine.deploy(graphWithDeferredService(), {
          ...defaultOptions,
          ...retryOptions,
        });

        expect(result.status).toBe('failed');
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        const message = result.errors[0]?.error.message ?? '';
        expect(message).toContain('unknown resource type (HTTP 404)');
      });

      it('fails immediately on a programming error with no Kubernetes shape', async () => {
        failServiceReads(new TypeError('resourceRef.metadata is undefined'));

        const startedAt = Date.now();
        const result = await engine.deploy(graphWithDeferredService(), {
          ...defaultOptions,
          ...retryOptions,
        });

        expect(result.status).toBe('failed');
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        const message = result.errors[0]?.error.message ?? '';
        expect(message).toContain('not a Kubernetes API error');
        expect(message).toContain('resourceRef.metadata is undefined');
      });
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
        },
      };

      // This should fail after retrying, demonstrating graceful error handling
      await expect(engine.deployResource(resource, testRetryOptions)).rejects.toThrow(
        'Deployment failed'
      );
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
            spec: { containers: [{ name: 'app', image: 'nginx' }] },
          },
        },
      });

      const readyDeployedResource: DeployedResource = {
        id: 'ready-deployment',
        kind: 'Deployment',
        name: 'ready-deployment',
        namespace: 'default',
        manifest: readyDeploymentManifest as unknown as KubernetesResource,
        status: 'deployed',
        deployedAt: new Date(),
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
            spec: { containers: [{ name: 'app', image: 'nginx' }] },
          },
        },
      });

      const notReadyDeployedResource: DeployedResource = {
        id: 'not-ready-deployment',
        kind: 'Deployment',
        name: 'not-ready-deployment',
        namespace: 'default',
        manifest: notReadyDeploymentManifest as unknown as KubernetesResource,
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Mock the k8s API to return different statuses
      // New API returns objects directly (no .body wrapper)
      mockK8sApi.read.mockImplementation((resource?: Record<string, unknown>) => {
        const name = (resource?.metadata as Record<string, unknown>)?.name;
        if (name === 'ready-deployment') {
          return Promise.resolve({
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'ready-deployment', namespace: 'default' },
            spec: { replicas: 3 },
            status: { readyReplicas: 3, availableReplicas: 3, replicas: 3 },
          });
        } else if (name === 'not-ready-deployment') {
          return Promise.resolve({
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name: 'not-ready-deployment', namespace: 'default' },
            spec: { replicas: 3 },
            status: { readyReplicas: 1, availableReplicas: 1, replicas: 3 },
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
        spec: { ports: [{ port: 80 }], type: 'ClusterIP' },
      });

      const deployedResource: DeployedResource = {
        id: 'test-service',
        kind: 'Service',
        name: 'test-service',
        namespace: 'default',
        manifest: serviceManifest as unknown as KubernetesResource,
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Mock the k8s API to return the service with status
      // New API returns objects directly (no .body wrapper)
      mockK8sApi.read.mockResolvedValue({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'test-service', namespace: 'default' },
        spec: { ports: [{ port: 80 }], type: 'ClusterIP' },
        status: {},
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
          metadata: { name: 'test-configmap', namespace: 'default' },
          // No status field
        },
        status: 'deployed',
        deployedAt: new Date(),
      };

      // Mock the k8s API to return the configmap without status
      // New API returns objects directly (no .body wrapper)
      mockK8sApi.read.mockResolvedValue({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'test-configmap', namespace: 'default' },
        // No status field
      });

      const isReady = await engine.isDeployedResourceReady(deployedResource);
      expect(isReady).toBe(false);
    });
  });
});

// Helper functions
function createSimpleGraph(): DeploymentResourceGraph {
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
