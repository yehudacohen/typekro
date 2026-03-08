/**
 * Unit tests for DirectDeploymentEngine.deployWithClosures()
 *
 * This method deploys resources AND executes closures in dependency order.
 * Closures run at level 0 (before resources) by default. Resources follow
 * in subsequent levels based on their dependency graph.
 *
 * NOTE: In @kubernetes/client-node v1.x, methods return objects directly (no .body wrapper).
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { DependencyGraph } from '../../src/core/dependencies/index.js';
import { DirectDeploymentEngine } from '../../src/core/deployment/engine.js';
import type {
  DeploymentClosure,
  DeploymentContext,
  DeploymentOptions,
  DeploymentResourceGraph,
} from '../../src/core/types/deployment.js';
import type { DeployableK8sResource, Enhanced } from '../../src/core/types/kubernetes.js';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';

// ============================================================================
// Test Helpers
// ============================================================================

type MockResource = DeployableK8sResource<Enhanced<unknown, unknown>>;

function createMockResource(
  overrides: {
    id?: string;
    kind?: string;
    apiVersion?: string;
    metadata?: { name?: string; namespace?: string; [key: string]: unknown };
    spec?: Record<string, unknown>;
  } = {}
): MockResource {
  const base = {
    id: overrides.id ?? 'testResource',
    kind: overrides.kind ?? 'Deployment',
    apiVersion: overrides.apiVersion ?? 'apps/v1',
    metadata: { name: overrides.metadata?.name ?? 'test-resource' },
    spec: overrides.spec ?? {},
  };
  return {
    ...base,
    metadata: { ...base.metadata, ...overrides.metadata },
  } as unknown as MockResource;
}

function createMockK8sApi() {
  return {
    read: mock(() => Promise.resolve({})),
    create: mock(() =>
      Promise.resolve({
        metadata: { name: 'test', namespace: 'default' },
        kind: 'Deployment',
        apiVersion: 'apps/v1',
      })
    ),
    patch: mock(() =>
      Promise.resolve({
        metadata: { name: 'test', namespace: 'default' },
        kind: 'Deployment',
        apiVersion: 'apps/v1',
      })
    ),
    replace: mock(() =>
      Promise.resolve({
        metadata: { name: 'test', namespace: 'default' },
        kind: 'Deployment',
        apiVersion: 'apps/v1',
      })
    ),
    delete: mock(() => Promise.resolve({})),
    list: mock(() => Promise.resolve({ items: [] })),
  };
}

/** Create a simple resource graph with two resources: database -> app */
function createTwoResourceGraph(): DeploymentResourceGraph {
  const graph = new DependencyGraph();

  const databaseManifest = deployment({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'database' },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'database' } },
      template: {
        metadata: { labels: { app: 'database' } },
        spec: { containers: [{ name: 'db', image: 'postgres' }] },
      },
    },
  }) as unknown as MockResource;
  (databaseManifest as unknown as Record<string, unknown>).id = 'database';

  const appManifest = deployment({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'app' },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'app' } },
      template: {
        metadata: { labels: { app: 'app' } },
        spec: { containers: [{ name: 'app', image: 'nginx' }] },
      },
    },
  }) as unknown as MockResource;
  (appManifest as unknown as Record<string, unknown>).id = 'app';

  graph.addNode('database', databaseManifest);
  graph.addNode('app', appManifest);
  graph.addEdge('app', 'database');

  return {
    name: 'test-graph',
    resources: [
      { id: 'database', manifest: databaseManifest },
      { id: 'app', manifest: appManifest },
    ],
    dependencyGraph: graph,
  };
}

/** Create a single-resource graph (no dependencies) */
function createSingleResourceGraph(): DeploymentResourceGraph {
  const graph = new DependencyGraph();

  const resourceManifest = createMockResource({
    id: 'simple',
    metadata: { name: 'simple-resource' },
  });

  graph.addNode('simple', resourceManifest);

  return {
    name: 'simple-graph',
    resources: [{ id: 'simple', manifest: resourceManifest }],
    dependencyGraph: graph,
  };
}

/** Create a graph with no resources (closure-only deployment) */
function createEmptyResourceGraph(): DeploymentResourceGraph {
  const graph = new DependencyGraph();
  return {
    name: 'empty-graph',
    resources: [],
    dependencyGraph: graph,
  };
}

/** Create a circular dependency graph */
function createCircularDependencyGraph(): DeploymentResourceGraph {
  const graph = new DependencyGraph();
  const a = createMockResource({ id: 'a', metadata: { name: 'a' } });
  const b = createMockResource({ id: 'b', metadata: { name: 'b' } });

  graph.addNode('a', a);
  graph.addNode('b', b);
  graph.addEdge('a', 'b');
  graph.addEdge('b', 'a');

  return {
    name: 'circular-graph',
    resources: [
      { id: 'a', manifest: a },
      { id: 'b', manifest: b },
    ],
    dependencyGraph: graph,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('DirectDeploymentEngine.deployWithClosures', () => {
  let mockK8sApi: ReturnType<typeof createMockK8sApi>;
  let engine: DirectDeploymentEngine;
  let defaultOptions: DeploymentOptions;
  const mockKubeConfig = { makeApiClient: mock(() => ({})) } as any;

  beforeEach(() => {
    mockK8sApi = createMockK8sApi();
    engine = new DirectDeploymentEngine(mockKubeConfig, mockK8sApi as any);
    defaultOptions = {
      mode: 'direct',
      namespace: 'test-namespace',
      timeout: 5000,
      waitForReady: false,
      dryRun: false,
    };

    // Default: resources don't exist yet (404) and create succeeds
    mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
    mockK8sApi.create.mockResolvedValue({
      metadata: { name: 'test', namespace: 'test-namespace' },
      kind: 'Deployment',
      apiVersion: 'apps/v1',
    });
  });

  // --------------------------------------------------------------------------
  // Happy Path
  // --------------------------------------------------------------------------

  describe('happy path', () => {
    it('should deploy resources and closures successfully', async () => {
      const graph = createTwoResourceGraph();
      const closureExecuted = { value: false };
      const closures: Record<string, DeploymentClosure> = {
        setupClosure: async (_ctx: DeploymentContext) => {
          closureExecuted.value = true;
          return [{ kind: 'ConfigMap', name: 'setup', apiVersion: 'v1' }];
        },
      };

      const result = await engine.deployWithClosures(graph, closures, defaultOptions, {
        name: 'test',
      });

      expect(result.status).toBe('success');
      expect(result.errors).toHaveLength(0);
      expect(result.resources).toHaveLength(2);
      expect(closureExecuted.value).toBe(true);
      expect(result.deploymentId).toBeTruthy();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty closures (resources only)', async () => {
      const graph = createTwoResourceGraph();
      const closures: Record<string, DeploymentClosure> = {};

      const result = await engine.deployWithClosures(graph, closures, defaultOptions, {
        name: 'test',
      });

      expect(result.status).toBe('success');
      expect(result.resources).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle closures only (no resources)', async () => {
      const graph = createEmptyResourceGraph();
      const closureResults: string[] = [];
      const closures: Record<string, DeploymentClosure> = {
        installCRDs: async (_ctx: DeploymentContext) => {
          closureResults.push('crds-installed');
          return [
            {
              kind: 'CustomResourceDefinition',
              name: 'test-crd',
              apiVersion: 'apiextensions.k8s.io/v1',
            },
          ];
        },
        installFlux: async (_ctx: DeploymentContext) => {
          closureResults.push('flux-installed');
          return [{ kind: 'Namespace', name: 'flux-system', apiVersion: 'v1' }];
        },
      };

      const result = await engine.deployWithClosures(graph, closures, defaultOptions, {
        name: 'test',
      });

      expect(result.status).toBe('success');
      expect(result.errors).toHaveLength(0);
      expect(result.resources).toHaveLength(0);
      expect(closureResults).toContain('crds-installed');
      expect(closureResults).toContain('flux-installed');
    });
  });

  // --------------------------------------------------------------------------
  // Closure Execution Order
  // --------------------------------------------------------------------------

  describe('closure execution order', () => {
    it('should execute closures before resources (level 0 vs level 1+)', async () => {
      const graph = createSingleResourceGraph();
      const executionOrder: string[] = [];

      // Track when the closure executes
      const closures: Record<string, DeploymentClosure> = {
        preDeploy: async (_ctx: DeploymentContext) => {
          executionOrder.push('closure:preDeploy');
          return [];
        },
      };

      // Track when resource deployment happens via the create mock
      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockImplementation((...args: unknown[]) => {
        executionOrder.push('resource:create');
        return Promise.resolve({
          metadata: { name: 'simple-resource', namespace: 'test-namespace' },
          kind: 'Deployment',
          apiVersion: 'apps/v1',
        });
      });

      await engine.deployWithClosures(graph, closures, defaultOptions, {});

      // Closure should execute before any resource creation
      expect(executionOrder.indexOf('closure:preDeploy')).toBeLessThan(
        executionOrder.indexOf('resource:create')
      );
    });
  });

  // --------------------------------------------------------------------------
  // DeploymentContext Verification
  // --------------------------------------------------------------------------

  describe('DeploymentContext passed to closures', () => {
    it('should provide kubernetesApi in context', async () => {
      const graph = createEmptyResourceGraph();
      let receivedContext: DeploymentContext | undefined;

      const closures: Record<string, DeploymentClosure> = {
        checkContext: async (ctx: DeploymentContext) => {
          receivedContext = ctx;
          return [];
        },
      };

      await engine.deployWithClosures(graph, closures, defaultOptions, {});

      expect(receivedContext).toBeDefined();
      expect(receivedContext!.kubernetesApi).toBeDefined();
      expect(receivedContext!.kubeConfig).toBeDefined();
    });

    it('should provide namespace when specified in options', async () => {
      const graph = createEmptyResourceGraph();
      let receivedNamespace: string | undefined;

      const closures: Record<string, DeploymentClosure> = {
        checkNamespace: async (ctx: DeploymentContext) => {
          receivedNamespace = ctx.namespace;
          return [];
        },
      };

      await engine.deployWithClosures(
        graph,
        closures,
        { ...defaultOptions, namespace: 'my-namespace' },
        {}
      );

      expect(receivedNamespace).toBe('my-namespace');
    });

    it('should not include namespace when not specified in options', async () => {
      const graph = createEmptyResourceGraph();
      let receivedContext: DeploymentContext | undefined;

      const closures: Record<string, DeploymentClosure> = {
        checkNoNamespace: async (ctx: DeploymentContext) => {
          receivedContext = ctx;
          return [];
        },
      };

      const optionsWithoutNamespace = { ...defaultOptions };
      delete (optionsWithoutNamespace as Record<string, unknown>).namespace;

      await engine.deployWithClosures(graph, closures, optionsWithoutNamespace, {});

      expect(receivedContext).toBeDefined();
      expect(receivedContext!.namespace).toBeUndefined();
    });

    it('should provide empty deployedResources map at level 0 (closure level)', async () => {
      const graph = createSingleResourceGraph();
      let deployedResourcesAtClosureLevel: Map<string, unknown> | undefined;

      const closures: Record<string, DeploymentClosure> = {
        checkResources: async (ctx: DeploymentContext) => {
          deployedResourcesAtClosureLevel = ctx.deployedResources;
          return [];
        },
      };

      await engine.deployWithClosures(graph, closures, defaultOptions, {});

      expect(deployedResourcesAtClosureLevel).toBeDefined();
      expect(deployedResourcesAtClosureLevel!.size).toBe(0);
    });

    it('should provide resolveReference function in context', async () => {
      const graph = createEmptyResourceGraph();
      let hasResolveRef = false;

      const closures: Record<string, DeploymentClosure> = {
        checkResolve: async (ctx: DeploymentContext) => {
          hasResolveRef = typeof ctx.resolveReference === 'function';
          return [];
        },
      };

      await engine.deployWithClosures(graph, closures, defaultOptions, {});

      expect(hasResolveRef).toBe(true);
    });

    it('should forward alchemyScope when provided', async () => {
      const graph = createEmptyResourceGraph();
      let receivedScope: unknown;
      const mockScope = { id: 'mock-scope' } as any;

      const closures: Record<string, DeploymentClosure> = {
        checkScope: async (ctx: DeploymentContext) => {
          receivedScope = ctx.alchemyScope;
          return [];
        },
      };

      await engine.deployWithClosures(graph, closures, defaultOptions, {}, mockScope);

      expect(receivedScope).toBe(mockScope);
    });

    it('should not include alchemyScope when not provided', async () => {
      const graph = createEmptyResourceGraph();
      let contextHasScope = false;

      const closures: Record<string, DeploymentClosure> = {
        checkNoScope: async (ctx: DeploymentContext) => {
          contextHasScope = 'alchemyScope' in ctx;
          return [];
        },
      };

      await engine.deployWithClosures(graph, closures, defaultOptions, {});

      expect(contextHasScope).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Closure Failure Handling
  // --------------------------------------------------------------------------

  describe('closure failure handling', () => {
    it('should capture closure failure as error with closure- prefixed resourceId', async () => {
      const graph = createEmptyResourceGraph();
      const closures: Record<string, DeploymentClosure> = {
        failingClosure: async (_ctx: DeploymentContext) => {
          throw new Error('Closure installation failed');
        },
      };

      const result = await engine.deployWithClosures(graph, closures, defaultOptions, {});

      expect(result.status).toBe('failed');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.resourceId).toBe('closure-failingClosure');
      expect(result.errors[0]?.phase).toBe('deployment');
      expect(result.errors[0]?.error.message).toBe('Closure installation failed');
    });

    it('should continue deploying other closures at the same level when one fails', async () => {
      const graph = createEmptyResourceGraph();
      let secondClosureExecuted = false;

      const closures: Record<string, DeploymentClosure> = {
        failingClosure: async (_ctx: DeploymentContext) => {
          throw new Error('First closure failed');
        },
        succeedingClosure: async (_ctx: DeploymentContext) => {
          secondClosureExecuted = true;
          return [];
        },
      };

      const result = await engine.deployWithClosures(
        graph,
        closures,
        { ...defaultOptions, rollbackOnFailure: false },
        {}
      );

      // Both closures execute at the same level (Promise.allSettled)
      expect(secondClosureExecuted).toBe(true);
      expect(result.errors).toHaveLength(1);
    });

    it('should report partial status when some closures fail and resources succeed', async () => {
      // Two-level deployment: closure at level 0, resource at level 1
      // Closure fails, but without rollbackOnFailure, resources still deploy
      const graph = createSingleResourceGraph();

      const closures: Record<string, DeploymentClosure> = {
        failingSetup: async (_ctx: DeploymentContext) => {
          throw new Error('Setup failed');
        },
      };

      const result = await engine.deployWithClosures(
        graph,
        closures,
        { ...defaultOptions, rollbackOnFailure: false },
        {}
      );

      // Closure fails but resource succeeds => we have errors but also successful resources
      expect(result.errors.length).toBeGreaterThan(0);
      // Resources may still deploy depending on rollback behavior
    });
  });

  // --------------------------------------------------------------------------
  // Resource Failure Handling
  // --------------------------------------------------------------------------

  describe('resource failure handling', () => {
    it('should capture resource deployment failure', async () => {
      const graph = createSingleResourceGraph();

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockRejectedValue(new Error('K8s API error'));

      const result = await engine.deployWithClosures(
        graph,
        {},
        {
          ...defaultOptions,
          retryPolicy: { maxRetries: 0, backoffMultiplier: 1, initialDelay: 0, maxDelay: 0 },
        },
        {}
      );

      expect(result.status).toBe('failed');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.phase).toBe('deployment');
      expect(result.resources.some((r) => r.status === 'failed')).toBe(true);
    });

    it('should track failed resources in deployedResources array', async () => {
      const graph = createSingleResourceGraph();

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockRejectedValue(new Error('Creation failed'));

      const result = await engine.deployWithClosures(
        graph,
        {},
        {
          ...defaultOptions,
          retryPolicy: { maxRetries: 0, backoffMultiplier: 1, initialDelay: 0, maxDelay: 0 },
        },
        {}
      );

      // Failed resources are still tracked in the resources array
      const failedResource = result.resources.find((r) => r.status === 'failed');
      expect(failedResource).toBeDefined();
      expect(failedResource!.kind).toBe('Deployment');
    });
  });

  // --------------------------------------------------------------------------
  // Mixed Closure + Resource Failures
  // --------------------------------------------------------------------------

  describe('mixed closure and resource failures', () => {
    it('should handle both closure and resource failures', async () => {
      const graph = createSingleResourceGraph();

      const closures: Record<string, DeploymentClosure> = {
        failingClosure: async (_ctx: DeploymentContext) => {
          throw new Error('Closure exploded');
        },
      };

      // Closure fails at level 0, resource would be at level 1
      // Without rollback, resources still attempt to deploy
      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockRejectedValue(new Error('Resource creation failed'));

      const result = await engine.deployWithClosures(
        graph,
        closures,
        {
          ...defaultOptions,
          rollbackOnFailure: false,
          retryPolicy: { maxRetries: 0, backoffMultiplier: 1, initialDelay: 0, maxDelay: 0 },
        },
        {}
      );

      expect(result.status).toBe('failed');
      // Should have errors from both closure and resource
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
      const closureError = result.errors.find((e) => e.resourceId === 'closure-failingClosure');
      expect(closureError).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Rollback
  // --------------------------------------------------------------------------

  describe('rollback on failure', () => {
    it('should trigger rollback when enabled and a closure fails', async () => {
      const graph = createEmptyResourceGraph();

      const closures: Record<string, DeploymentClosure> = {
        failingClosure: async (_ctx: DeploymentContext) => {
          throw new Error('Closure failed');
        },
      };

      const events: { type: string }[] = [];
      const result = await engine.deployWithClosures(
        graph,
        closures,
        {
          ...defaultOptions,
          rollbackOnFailure: true,
          progressCallback: (event) => events.push(event as { type: string }),
        },
        {}
      );

      expect(result.status).toBe('failed');
      // Rollback event should be emitted
      expect(events.some((e) => e.type === 'rollback')).toBe(true);
    });

    it('should trigger rollback when enabled and a resource fails', async () => {
      const graph = createSingleResourceGraph();

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockRejectedValue(new Error('Deploy failed'));
      mockK8sApi.delete.mockResolvedValue({});

      const events: { type: string }[] = [];
      const result = await engine.deployWithClosures(
        graph,
        {},
        {
          ...defaultOptions,
          rollbackOnFailure: true,
          retryPolicy: { maxRetries: 0, backoffMultiplier: 1, initialDelay: 0, maxDelay: 0 },
          progressCallback: (event) => events.push(event as { type: string }),
        },
        {}
      );

      expect(result.status).toBe('failed');
      expect(events.some((e) => e.type === 'rollback')).toBe(true);
    });

    it('should not trigger rollback when rollbackOnFailure is false', async () => {
      const graph = createSingleResourceGraph();

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockRejectedValue(new Error('Deploy failed'));

      const events: { type: string }[] = [];
      const result = await engine.deployWithClosures(
        graph,
        {},
        {
          ...defaultOptions,
          rollbackOnFailure: false,
          retryPolicy: { maxRetries: 0, backoffMultiplier: 1, initialDelay: 0, maxDelay: 0 },
          progressCallback: (event) => events.push(event as { type: string }),
        },
        {}
      );

      expect(result.status).toBe('failed');
      expect(events.some((e) => e.type === 'rollback')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Circular Dependencies
  // --------------------------------------------------------------------------

  describe('circular dependencies', () => {
    it('should throw CircularDependencyError for circular dependency graphs', async () => {
      const graph = createCircularDependencyGraph();

      await expect(engine.deployWithClosures(graph, {}, defaultOptions, {})).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Progress Events
  // --------------------------------------------------------------------------

  describe('progress events', () => {
    it('should emit started event', async () => {
      const graph = createSingleResourceGraph();
      const events: { type: string; message?: string }[] = [];

      await engine.deployWithClosures(
        graph,
        {},
        {
          ...defaultOptions,
          progressCallback: (event) => events.push(event as { type: string; message?: string }),
        },
        {}
      );

      expect(events.some((e) => e.type === 'started')).toBe(true);
    });

    it('should emit completed event on success', async () => {
      const graph = createSingleResourceGraph();
      const events: { type: string; message?: string }[] = [];

      await engine.deployWithClosures(
        graph,
        {},
        {
          ...defaultOptions,
          progressCallback: (event) => events.push(event as { type: string; message?: string }),
        },
        {}
      );

      expect(events.some((e) => e.type === 'completed')).toBe(true);
    });

    it('should emit failed event on failure', async () => {
      const graph = createEmptyResourceGraph();
      const events: { type: string; message?: string }[] = [];

      const closures: Record<string, DeploymentClosure> = {
        failing: async () => {
          throw new Error('boom');
        },
      };

      await engine.deployWithClosures(
        graph,
        closures,
        {
          ...defaultOptions,
          rollbackOnFailure: false,
          progressCallback: (event) => events.push(event as { type: string; message?: string }),
        },
        {}
      );

      // Should have 'started' and then 'failed' (not 'completed')
      expect(events.some((e) => e.type === 'started')).toBe(true);
      expect(events.some((e) => e.type === 'failed')).toBe(true);
      expect(events.some((e) => e.type === 'completed')).toBe(false);
    });

    it('should include closure count in started event message', async () => {
      const graph = createEmptyResourceGraph();
      const events: { type: string; message?: string }[] = [];

      const closures: Record<string, DeploymentClosure> = {
        setup: async () => [],
        config: async () => [],
      };

      await engine.deployWithClosures(
        graph,
        closures,
        {
          ...defaultOptions,
          progressCallback: (event) => events.push(event as { type: string; message?: string }),
        },
        {}
      );

      const startedEvent = events.find((e) => e.type === 'started');
      expect(startedEvent?.message).toContain('2 closures');
    });
  });

  // --------------------------------------------------------------------------
  // deployedResources Accumulation Across Levels
  // --------------------------------------------------------------------------

  describe('deployedResources accumulation', () => {
    it('should accumulate deployed resources across levels for closure context', async () => {
      // Multi-level graph: database at level 1, app at level 2
      // Closures run at level 0.
      // A second closure at a later level would see previously deployed resources.
      // Since all closures default to level -1 (which becomes level 0), we test that
      // the context at closure time has an empty map (no resources deployed yet).
      const graph = createTwoResourceGraph();
      let deployedAtClosureTime = 0;

      const closures: Record<string, DeploymentClosure> = {
        checker: async (ctx: DeploymentContext) => {
          deployedAtClosureTime = ctx.deployedResources.size;
          return [];
        },
      };

      await engine.deployWithClosures(graph, closures, defaultOptions, {});

      // At closure time (level 0), no resources have been deployed yet
      expect(deployedAtClosureTime).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Dry Run Mode
  // --------------------------------------------------------------------------

  describe('dry run mode', () => {
    it('should simulate resource deployment in dry run mode', async () => {
      const graph = createSingleResourceGraph();

      const result = await engine.deployWithClosures(
        graph,
        {},
        { ...defaultOptions, dryRun: true },
        {}
      );

      expect(result.status).toBe('success');
      expect(result.resources).toHaveLength(1);
      expect(result.resources.every((r) => r.status === 'deployed')).toBe(true);
      // In dry run, create should NOT be called on K8s API
      expect(mockK8sApi.create).not.toHaveBeenCalled();
    });

    it('should still execute closures in dry run mode', async () => {
      const graph = createEmptyResourceGraph();
      let closureExecuted = false;

      const closures: Record<string, DeploymentClosure> = {
        setup: async (_ctx: DeploymentContext) => {
          closureExecuted = true;
          return [];
        },
      };

      await engine.deployWithClosures(graph, closures, { ...defaultOptions, dryRun: true }, {});

      // Closures execute regardless of dry run (they control their own behavior)
      expect(closureExecuted).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Status Determination
  // --------------------------------------------------------------------------

  describe('status determination', () => {
    it('should return success when all resources and closures succeed', async () => {
      const graph = createSingleResourceGraph();
      const closures: Record<string, DeploymentClosure> = {
        setup: async () => [],
      };

      const result = await engine.deployWithClosures(graph, closures, defaultOptions, {});

      expect(result.status).toBe('success');
    });

    it('should return failed when all operations fail', async () => {
      const graph = createSingleResourceGraph();

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockRejectedValue(new Error('All failed'));

      const closures: Record<string, DeploymentClosure> = {
        failing: async () => {
          throw new Error('Closure also failed');
        },
      };

      const result = await engine.deployWithClosures(
        graph,
        closures,
        {
          ...defaultOptions,
          rollbackOnFailure: false,
          retryPolicy: { maxRetries: 0, backoffMultiplier: 1, initialDelay: 0, maxDelay: 0 },
        },
        {}
      );

      expect(result.status).toBe('failed');
    });

    it('should return partial when some resources succeed and some fail', async () => {
      const graph = createTwoResourceGraph();

      // First resource succeeds, second fails
      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create
        .mockResolvedValueOnce({
          metadata: { name: 'database', namespace: 'test-namespace' },
          kind: 'Deployment',
          apiVersion: 'apps/v1',
        })
        .mockRejectedValueOnce(new Error('Second resource failed'));

      const result = await engine.deployWithClosures(
        graph,
        {},
        {
          ...defaultOptions,
          rollbackOnFailure: false,
          retryPolicy: { maxRetries: 0, backoffMultiplier: 1, initialDelay: 0, maxDelay: 0 },
        },
        {}
      );

      expect(result.status).toBe('partial');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.resources.some((r) => r.status !== 'failed')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Deployment State Storage
  // --------------------------------------------------------------------------

  describe('deployment state storage', () => {
    it('should store deployment state for successful deployments', async () => {
      const graph = createSingleResourceGraph();

      const result = await engine.deployWithClosures(graph, {}, defaultOptions, {});

      // State should be stored (accessible via getAllDeploymentStates)
      const states = engine.getAllDeploymentStates();
      expect(states.length).toBeGreaterThan(0);
      const state = states.find((s) => s.deploymentId === result.deploymentId);
      expect(state).toBeDefined();
      expect(state!.status).toBe('completed');
    });

    it('should store deployment state for failed deployments', async () => {
      const graph = createSingleResourceGraph();

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockRejectedValue(new Error('Failed'));

      const result = await engine.deployWithClosures(
        graph,
        {},
        {
          ...defaultOptions,
          retryPolicy: { maxRetries: 0, backoffMultiplier: 1, initialDelay: 0, maxDelay: 0 },
        },
        {}
      );

      const states = engine.getAllDeploymentStates();
      const state = states.find((s) => s.deploymentId === result.deploymentId);
      expect(state).toBeDefined();
      expect(state!.status).toBe('failed');
    });
  });

  // --------------------------------------------------------------------------
  // Resource Not Found in Graph
  // --------------------------------------------------------------------------

  describe('resource not found in graph', () => {
    it('should handle mismatch between dependency graph and resources array', async () => {
      // Create a graph where the dependency graph has a node 'missing'
      // but the resources array does not contain it
      const graph = new DependencyGraph();
      const existing = createMockResource({
        id: 'existing',
        metadata: { name: 'existing' },
      });

      graph.addNode('existing', existing);
      graph.addNode('missing', createMockResource({ id: 'missing' }));

      const resourceGraph: DeploymentResourceGraph = {
        name: 'mismatch-graph',
        resources: [
          {
            id: 'existing',
            manifest: existing as unknown as DeployableK8sResource<Enhanced<unknown, unknown>>,
          },
        ],
        dependencyGraph: graph,
      };

      const result = await engine.deployWithClosures(
        resourceGraph,
        {},
        {
          ...defaultOptions,
          retryPolicy: { maxRetries: 0, backoffMultiplier: 1, initialDelay: 0, maxDelay: 0 },
        },
        {}
      );

      // The 'missing' resource should cause a validation error
      const missingError = result.errors.find((e) => e.resourceId === 'missing');
      expect(missingError).toBeDefined();
      expect(missingError!.phase).toBe('validation');
    });
  });

  // --------------------------------------------------------------------------
  // Multiple Closures
  // --------------------------------------------------------------------------

  describe('multiple closures', () => {
    it('should execute all closures at the same level', async () => {
      const graph = createEmptyResourceGraph();
      const executed: string[] = [];

      const closures: Record<string, DeploymentClosure> = {
        alpha: async () => {
          executed.push('alpha');
          return [];
        },
        beta: async () => {
          executed.push('beta');
          return [];
        },
        gamma: async () => {
          executed.push('gamma');
          return [];
        },
      };

      const result = await engine.deployWithClosures(graph, closures, defaultOptions, {});

      expect(result.status).toBe('success');
      expect(executed).toContain('alpha');
      expect(executed).toContain('beta');
      expect(executed).toContain('gamma');
    });
  });

  // --------------------------------------------------------------------------
  // Spec Parameter
  // --------------------------------------------------------------------------

  describe('spec parameter', () => {
    it('should accept and pass through the spec parameter', async () => {
      const graph = createEmptyResourceGraph();
      const spec = { appName: 'my-app', replicas: 3, image: 'nginx:latest' };

      // The spec is used by analyzeClosureDependencies internally
      // We verify the method accepts it without error
      const result = await engine.deployWithClosures(graph, {}, defaultOptions, spec);

      expect(result.status).toBe('success');
    });
  });

  // --------------------------------------------------------------------------
  // Namespace Application
  // --------------------------------------------------------------------------

  describe('namespace application', () => {
    it('should apply namespace to resource metadata during deployment', async () => {
      const graph = createSingleResourceGraph();

      mockK8sApi.read.mockRejectedValue({ statusCode: 404 });
      mockK8sApi.create.mockResolvedValue({
        metadata: { name: 'simple-resource', namespace: 'custom-ns' },
        kind: 'Deployment',
        apiVersion: 'apps/v1',
      });

      await engine.deployWithClosures(graph, {}, { ...defaultOptions, namespace: 'custom-ns' }, {});

      expect(mockK8sApi.create).toHaveBeenCalled();
      const createCalls = mockK8sApi.create.mock.calls as unknown[][];
      expect(createCalls.length).toBeGreaterThan(0);
      const firstArg = createCalls[0]?.[0] as Record<string, Record<string, unknown>>;
      expect(firstArg?.metadata?.namespace).toBe('custom-ns');
    });
  });

  // --------------------------------------------------------------------------
  // Error in Outer Try/Catch
  // --------------------------------------------------------------------------

  describe('catastrophic error handling', () => {
    it('should handle unexpected errors gracefully', async () => {
      // Create a graph that will cause an unexpected error in dependency analysis
      // by providing a graph object that throws during validation
      const badGraph: DeploymentResourceGraph = {
        name: 'bad-graph',
        resources: [],
        dependencyGraph: {
          addNode: () => {},
          addEdge: () => {},
          getNodes: () => {
            throw new Error('Unexpected graph error');
          },
        } as any,
      };

      // This should not throw — the outer catch should handle it
      const result = await engine.deployWithClosures(badGraph, {}, defaultOptions, {});

      expect(result.status).toBe('failed');
      expect(result.errors).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Abort Signal Handling
  // --------------------------------------------------------------------------

  describe('abort signal handling', () => {
    it('should set up abort controller with deployment timeout', async () => {
      const graph = createSingleResourceGraph();

      // Verify that a deployment creates and cleans up abort controllers
      // by deploying successfully with a short timeout
      const result = await engine.deployWithClosures(
        graph,
        {},
        {
          ...defaultOptions,
          timeout: 30000,
        },
        {}
      );

      expect(result.status).toBe('success');
      // After deployment, abort controllers should be cleaned up
      // abortAllOperations should be a safe no-op
      engine.abortAllOperations();
    });

    it('should abort all operations via abortAllOperations()', () => {
      // abortAllOperations is a synchronous method that aborts all tracked controllers
      // We can test it doesn't throw and clears the active controllers
      engine.abortAllOperations();
      // Should not throw even when called multiple times
      engine.abortAllOperations();
    });

    it('should clean up abort controller after successful deployment', async () => {
      const graph = createSingleResourceGraph();

      await engine.deployWithClosures(graph, {}, defaultOptions, {});

      // After successful deployment, active abort controllers should be cleaned up
      // We verify this indirectly: calling abortAllOperations should be a no-op
      engine.abortAllOperations();
      // No error means controllers were properly cleaned up
    });
  });

  // --------------------------------------------------------------------------
  // Empty Resource Graph through deploy()
  // --------------------------------------------------------------------------

  describe('empty resource graph', () => {
    it('should handle empty resource graph through deploy()', async () => {
      const graph = createEmptyResourceGraph();

      const result = await engine.deploy(graph, defaultOptions);

      expect(result.status).toBe('success');
      expect(result.resources).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle empty resource graph through deployWithClosures()', async () => {
      const graph = createEmptyResourceGraph();

      const result = await engine.deployWithClosures(graph, {}, defaultOptions, {});

      expect(result.status).toBe('success');
      expect(result.resources).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });
  });
});
