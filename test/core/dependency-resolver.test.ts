/**
 * Unit tests for dependency resolution engine
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';
import { DependencyGraph, DependencyResolver } from '../../src/core/dependencies/index.js';
import { CircularDependencyError } from '../../src/core/errors.js';
import { setResourceId } from '../../src/core/metadata/index.js';
import type { DeployableK8sResource, Enhanced } from '../../src/index.js';

// Helper function to create properly typed test resources
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
  return {
    ...base,
    ...overrides,
    metadata: { ...base.metadata, ...overrides.metadata },
  } as unknown as DeployableK8sResource<Enhanced<object, object>>;
}

describe('DependencyResolver', () => {
  let resolver: DependencyResolver;

  beforeEach(() => {
    resolver = new DependencyResolver();
  });

  describe('buildDependencyGraph', () => {
    it('should create a graph with all resources as nodes', () => {
      const resources = [
        createMockResource({
          id: 'app',
          metadata: { name: 'app' },
        }),
        createMockResource({
          id: 'db',
          metadata: { name: 'db' },
        }),
      ];

      const graph = resolver.buildDependencyGraph(resources);

      expect(graph.getNode('app')).toBeDefined();
      expect(graph.getNode('db')).toBeDefined();
    });

    it('should detect dependencies from KubernetesRef objects', () => {
      const resources = [
        createMockResource({
          id: 'app',
          metadata: { name: 'app' },
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    env: [
                      {
                        name: 'DB_HOST',
                        value: {
                          [KUBERNETES_REF_BRAND]: true,
                          resourceId: 'db',
                          fieldPath: 'status.podIP',
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        }),
        createMockResource({
          id: 'db',
          metadata: { name: 'db' },
        }),
      ];

      const graph = resolver.buildDependencyGraph(resources);

      expect(graph.getDependencies('app')).toContain('db');
      expect(graph.getDependents('db')).toContain('app');
    });

    it('should detect dependencies from CEL expressions', () => {
      const resources = [
        createMockResource({
          id: 'app',
          metadata: { name: 'app' },
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    env: [
                      {
                        name: 'DATABASE_URL',
                        value: {
                          [CEL_EXPRESSION_BRAND]: true,
                          expression: 'concat("postgresql://", db.status.endpoint, ":5432/mydb")',
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        }),
        createMockResource({
          id: 'db',
          metadata: { name: 'db' },
        }),
      ];

      const graph = resolver.buildDependencyGraph(resources);

      expect(graph.getDependencies('app')).toContain('db');
    });

    it('should handle nested references in complex objects', () => {
      const resources = [
        createMockResource({
          id: 'ingress',
          kind: 'Ingress',
          apiVersion: 'networking.k8s.io/v1',
          metadata: { name: 'ingress' },
          spec: {
            rules: [
              {
                http: {
                  paths: [
                    {
                      backend: {
                        service: {
                          name: {
                            [KUBERNETES_REF_BRAND]: true,
                            resourceId: 'service',
                            fieldPath: 'metadata.name',
                          },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
        createMockResource({
          id: 'service',
          kind: 'Service',
          apiVersion: 'v1',
          metadata: { name: 'service' },
        }),
      ];

      const graph = resolver.buildDependencyGraph(resources);

      expect(graph.getDependencies('ingress')).toContain('service');
    });

    it('should ignore schema references', () => {
      const resources = [
        createMockResource({
          id: 'app',
          metadata: { name: 'app' },
          spec: {
            replicas: {
              [KUBERNETES_REF_BRAND]: true,
              resourceId: '__schema__',
              fieldPath: 'spec.replicas',
            },
          },
        }),
      ];

      const graph = resolver.buildDependencyGraph(resources);

      expect(graph.getDependencies('app')).toHaveLength(0);
    });
  });

  describe('getTopologicalOrder', () => {
    it('should return correct deployment order for simple dependency', () => {
      const graph = new DependencyGraph();
      graph.addNode('db', createMockResource({ id: 'db' }));
      graph.addNode('app', createMockResource({ id: 'app' }));
      graph.addEdge('app', 'db'); // app depends on db

      const order = resolver.getTopologicalOrder(graph);

      expect(order.indexOf('db')).toBeLessThan(order.indexOf('app'));
    });

    it('should return correct order for complex dependency chain', () => {
      const graph = new DependencyGraph();
      graph.addNode('db', createMockResource({ id: 'db' }));
      graph.addNode('api', createMockResource({ id: 'api' }));
      graph.addNode('web', createMockResource({ id: 'web' }));
      graph.addNode('ingress', createMockResource({ id: 'ingress' }));

      graph.addEdge('api', 'db'); // api depends on db
      graph.addEdge('web', 'api'); // web depends on api
      graph.addEdge('ingress', 'web'); // ingress depends on web

      const order = resolver.getTopologicalOrder(graph);

      expect(order.indexOf('db')).toBeLessThan(order.indexOf('api'));
      expect(order.indexOf('api')).toBeLessThan(order.indexOf('web'));
      expect(order.indexOf('web')).toBeLessThan(order.indexOf('ingress'));
    });

    it('should handle resources with no dependencies', () => {
      const graph = new DependencyGraph();
      graph.addNode('independent1', createMockResource({ id: 'independent1' }));
      graph.addNode('independent2', createMockResource({ id: 'independent2' }));

      const order = resolver.getTopologicalOrder(graph);

      expect(order).toHaveLength(2);
      expect(order).toContain('independent1');
      expect(order).toContain('independent2');
    });
  });

  describe('validateNoCycles', () => {
    it('should not throw for acyclic graph', () => {
      const graph = new DependencyGraph();
      graph.addNode('a', createMockResource({ id: 'a' }));
      graph.addNode('b', createMockResource({ id: 'b' }));
      graph.addEdge('b', 'a');

      expect(() => resolver.validateNoCycles(graph)).not.toThrow();
    });

    it('should throw CircularDependencyError for cyclic graph', () => {
      const graph = new DependencyGraph();
      graph.addNode('a', createMockResource({ id: 'a' }));
      graph.addNode('b', createMockResource({ id: 'b' }));
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'a');

      expect(() => resolver.validateNoCycles(graph)).toThrow(CircularDependencyError);
    });

    it('should detect complex cycles', () => {
      const graph = new DependencyGraph();
      graph.addNode('a', createMockResource({ id: 'a' }));
      graph.addNode('b', createMockResource({ id: 'b' }));
      graph.addNode('c', createMockResource({ id: 'c' }));
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'c');
      graph.addEdge('c', 'a'); // Creates cycle: a -> b -> c -> a

      expect(() => resolver.validateNoCycles(graph)).toThrow(CircularDependencyError);
    });
  });

  describe('analyzeDeploymentOrder', () => {
    it('should group resources by dependency levels', () => {
      const graph = new DependencyGraph();
      graph.addNode('db', createMockResource({ id: 'db' }));
      graph.addNode('cache', createMockResource({ id: 'cache' }));
      graph.addNode('api', createMockResource({ id: 'api' }));
      graph.addNode('web', createMockResource({ id: 'web' }));

      graph.addEdge('api', 'db');
      graph.addEdge('api', 'cache');
      graph.addEdge('web', 'api');

      const plan = resolver.analyzeDeploymentOrder(graph);

      expect(plan.levels).toHaveLength(3);
      expect(plan.levels[0]).toEqual(expect.arrayContaining(['db', 'cache']));
      expect(plan.levels[1]).toContain('api');
      expect(plan.levels[2]).toContain('web');
      expect(plan.maxParallelism).toBe(2);
    });

    it('should handle independent resources', () => {
      const graph = new DependencyGraph();
      graph.addNode('a', createMockResource({ id: 'a' }));
      graph.addNode('b', createMockResource({ id: 'b' }));
      graph.addNode('c', createMockResource({ id: 'c' }));

      const plan = resolver.analyzeDeploymentOrder(graph);

      expect(plan.levels).toHaveLength(1);
      expect(plan.levels[0]).toEqual(expect.arrayContaining(['a', 'b', 'c']));
      expect(plan.maxParallelism).toBe(3);
    });
  });

  describe('getRollbackOrder', () => {
    it('should return reverse of deployment order', () => {
      const graph = new DependencyGraph();
      graph.addNode('db', createMockResource({ id: 'db' }));
      graph.addNode('app', createMockResource({ id: 'app' }));
      graph.addEdge('app', 'db');

      const rollbackOrder = resolver.getRollbackOrder(graph);

      expect(rollbackOrder.indexOf('app')).toBeLessThan(rollbackOrder.indexOf('db'));
    });
  });

  describe('findIndependentResources', () => {
    it('should find resources with no dependencies', () => {
      const graph = new DependencyGraph();
      graph.addNode('db', createMockResource({ id: 'db' }));
      graph.addNode('cache', createMockResource({ id: 'cache' }));
      graph.addNode('app', createMockResource({ id: 'app' }));
      graph.addEdge('app', 'db');

      const independent = resolver.findIndependentResources(graph);

      expect(independent).toEqual(expect.arrayContaining(['db', 'cache']));
      expect(independent).not.toContain('app');
    });
  });

  describe('findTerminalResources', () => {
    it('should find resources that nothing depends on', () => {
      const graph = new DependencyGraph();
      graph.addNode('db', createMockResource({ id: 'db' }));
      graph.addNode('app', createMockResource({ id: 'app' }));
      graph.addNode('ingress', createMockResource({ id: 'ingress' }));
      graph.addEdge('app', 'db');
      graph.addEdge('ingress', 'app');

      const terminal = resolver.findTerminalResources(graph);

      expect(terminal).toContain('ingress');
      expect(terminal).not.toContain('db');
      expect(terminal).not.toContain('app');
    });
  });
});

describe('DependencyGraph', () => {
  let graph: DependencyGraph;

  beforeEach(() => {
    graph = new DependencyGraph();
  });

  describe('addNode', () => {
    it('should add a node successfully', () => {
      graph.addNode('test', createMockResource({ id: 'test' }));

      expect(graph.getNode('test')).toBeDefined();
      expect(graph.getNode('test')?.id).toBe('test');
    });

    it('should throw error for duplicate node', () => {
      graph.addNode('test', createMockResource({ id: 'test' }));

      expect(() => graph.addNode('test', createMockResource({ id: 'test' }))).toThrow();
    });
  });

  describe('addEdge', () => {
    beforeEach(() => {
      graph.addNode('a', createMockResource({ id: 'a' }));
      graph.addNode('b', createMockResource({ id: 'b' }));
    });

    it('should add edge successfully', () => {
      graph.addEdge('a', 'b');

      expect(graph.getDependencies('a')).toContain('b');
      expect(graph.getDependents('b')).toContain('a');
    });

    it('should throw error for non-existent nodes', () => {
      expect(() => graph.addEdge('a', 'nonexistent')).toThrow();
      expect(() => graph.addEdge('nonexistent', 'b')).toThrow();
    });
  });

  describe('hasCycles', () => {
    it('should return false for acyclic graph', () => {
      graph.addNode('a', createMockResource({ id: 'a' }));
      graph.addNode('b', createMockResource({ id: 'b' }));
      graph.addEdge('a', 'b');

      expect(graph.hasCycles()).toBe(false);
    });

    it('should return true for cyclic graph', () => {
      graph.addNode('a', createMockResource({ id: 'a' }));
      graph.addNode('b', createMockResource({ id: 'b' }));
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'a');

      expect(graph.hasCycles()).toBe(true);
    });
  });

  describe('clone', () => {
    it('should create identical copy', () => {
      graph.addNode('a', createMockResource({ id: 'a' }));
      graph.addNode('b', createMockResource({ id: 'b' }));
      graph.addEdge('a', 'b');

      const cloned = graph.clone();

      expect(cloned.getNode('a')).toBeDefined();
      expect(cloned.getNode('b')).toBeDefined();
      expect(cloned.getDependencies('a')).toContain('b');
    });

    it('should be independent of original', () => {
      graph.addNode('a', createMockResource({ id: 'a' }));
      const cloned = graph.clone();

      graph.addNode('b', createMockResource({ id: 'b' }));

      expect(cloned.getNode('b')).toBeUndefined();
    });
  });

  describe('getSubgraph', () => {
    beforeEach(() => {
      graph.addNode('a', createMockResource({ id: 'a' }));
      graph.addNode('b', createMockResource({ id: 'b' }));
      graph.addNode('c', createMockResource({ id: 'c' }));
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'c');
    });

    it('should create subgraph with specified nodes', () => {
      const subgraph = graph.getSubgraph(['a', 'b']);

      expect(subgraph.getNode('a')).toBeDefined();
      expect(subgraph.getNode('b')).toBeDefined();
      expect(subgraph.getNode('c')).toBeUndefined();
    });

    it('should preserve edges between included nodes', () => {
      const subgraph = graph.getSubgraph(['a', 'b']);

      expect(subgraph.getDependencies('a')).toContain('b');
    });

    it('should not include edges to excluded nodes', () => {
      const subgraph = graph.getSubgraph(['b', 'c']);

      expect(subgraph.getDependencies('b')).toContain('c');
      expect(subgraph.getDependents('b')).toHaveLength(0); // 'a' is excluded
    });
  });

  describe('Implicit Namespace Dependencies', () => {
    let resolver: DependencyResolver;

    beforeEach(() => {
      resolver = new DependencyResolver();
    });

    it('should detect that namespaced resources depend on their Namespace resource', () => {
      const ns = createMockResource({
        id: 'appNamespace',
        kind: 'Namespace',
        apiVersion: 'v1',
        metadata: { name: 'my-app' },
      });
      const deployment = createMockResource({
        id: 'appDeployment',
        kind: 'Deployment',
        apiVersion: 'apps/v1',
        metadata: { name: 'web', namespace: 'my-app' },
      });
      const service = createMockResource({
        id: 'appService',
        kind: 'Service',
        apiVersion: 'v1',
        metadata: { name: 'web-svc', namespace: 'my-app' },
      });

      const graph = resolver.buildDependencyGraph([ns, deployment, service]);
      const plan = resolver.analyzeDeploymentOrder(graph);

      // Namespace should be at level 0, resources in that namespace at level 1+
      expect(plan.levels.length).toBeGreaterThanOrEqual(2);
      expect(plan.levels[0]).toContain('appNamespace');
      // Deployment and Service should NOT be at level 0
      expect(plan.levels[0]).not.toContain('appDeployment');
      expect(plan.levels[0]).not.toContain('appService');
    });

    it('should not add dependency for resources in a different namespace', () => {
      const ns = createMockResource({
        id: 'appNamespace',
        kind: 'Namespace',
        apiVersion: 'v1',
        metadata: { name: 'my-app' },
      });
      const deployment = createMockResource({
        id: 'otherDeployment',
        kind: 'Deployment',
        apiVersion: 'apps/v1',
        metadata: { name: 'other', namespace: 'default' },
      });

      const graph = resolver.buildDependencyGraph([ns, deployment]);

      // No dependency — deployment is in 'default', not 'my-app'
      expect(graph.getDependencies('otherDeployment')).not.toContain('appNamespace');
    });

    it('should handle resources without metadata.namespace (cluster-scoped)', () => {
      const ns = createMockResource({
        id: 'appNamespace',
        kind: 'Namespace',
        apiVersion: 'v1',
        metadata: { name: 'my-app' },
      });
      const clusterRole = createMockResource({
        id: 'myClusterRole',
        kind: 'ClusterRole',
        apiVersion: 'rbac.authorization.k8s.io/v1',
        metadata: { name: 'admin-role' },
      });

      const graph = resolver.buildDependencyGraph([ns, clusterRole]);

      // No dependency — ClusterRole has no namespace
      expect(graph.getDependencies('myClusterRole')).not.toContain('appNamespace');
    });

    it('should not add self-dependency for Namespace resources', () => {
      const ns = createMockResource({
        id: 'appNamespace',
        kind: 'Namespace',
        apiVersion: 'v1',
        metadata: { name: 'my-app' },
      });

      const graph = resolver.buildDependencyGraph([ns]);

      expect(graph.getDependencies('appNamespace')).toHaveLength(0);
    });
  });

  describe('Embedded Marker String Dependencies', () => {
    let resolver: DependencyResolver;

    beforeEach(() => {
      resolver = new DependencyResolver();
    });

    it('should detect dependencies from __KUBERNETES_REF__ marker strings in values', () => {
      const database = createMockResource({
        id: 'database',
        kind: 'Cluster',
        apiVersion: 'postgresql.cnpg.io/v1',
        metadata: { name: 'testapp-db' },
      });
      const helmRelease = createMockResource({
        id: 'inngestRelease',
        kind: 'HelmRelease',
        apiVersion: 'helm.toolkit.fluxcd.io/v2',
        metadata: { name: 'testapp-inngest' },
        spec: {
          values: {
            inngest: {
              postgres: {
                uri: 'postgresql://app@__KUBERNETES_REF_database_status.writeService__:5432/testdb',
              },
            },
          },
        },
      });

      const graph = resolver.buildDependencyGraph([database, helmRelease]);

      // The marker string should create a dependency: inngestRelease -> database
      expect(graph.getDependencies('inngestRelease')).toContain('database');
    });

    it('should detect multiple marker refs in the same string', () => {
      const database = createMockResource({
        id: 'database',
        kind: 'Cluster',
        metadata: { name: 'db' },
      });
      const cache = createMockResource({
        id: 'cache',
        kind: 'Valkey',
        metadata: { name: 'cache' },
      });
      const app = createMockResource({
        id: 'app',
        kind: 'Deployment',
        metadata: { name: 'app' },
        spec: {
          env: {
            DB_URL: 'postgresql://__KUBERNETES_REF_database_status.writeService__:5432/db',
            REDIS_URL: 'redis://__KUBERNETES_REF_cache_status.hostname__:6379',
          },
        },
      });

      const graph = resolver.buildDependencyGraph([database, cache, app]);

      expect(graph.getDependencies('app')).toContain('database');
      expect(graph.getDependencies('app')).toContain('cache');
    });

    it('should NOT detect __schema__ refs as resource dependencies', () => {
      const app = createMockResource({
        id: 'app',
        kind: 'Deployment',
        metadata: { name: 'app' },
        spec: {
          image: '__KUBERNETES_REF___schema___spec.image__',
        },
      });

      const graph = resolver.buildDependencyGraph([app]);

      // Schema refs are internal — no dependency edges
      expect(graph.getDependencies('app')).toHaveLength(0);
    });

    it('should detect marker refs in deeply nested objects', () => {
      const database = createMockResource({
        id: 'database',
        kind: 'Cluster',
        metadata: { name: 'db' },
      });
      const helmRelease = createMockResource({
        id: 'helmRelease',
        kind: 'HelmRelease',
        metadata: { name: 'inngest' },
        spec: {
          values: {
            level1: {
              level2: {
                level3: {
                  uri: '__KUBERNETES_REF_database_status.writeService__',
                },
              },
            },
          },
        },
      });

      const graph = resolver.buildDependencyGraph([database, helmRelease]);

      expect(graph.getDependencies('helmRelease')).toContain('database');
    });

    it('should detect marker refs in arrays', () => {
      const database = createMockResource({
        id: 'database',
        kind: 'Cluster',
        metadata: { name: 'db' },
      });
      const helmRelease = createMockResource({
        id: 'helmRelease',
        kind: 'HelmRelease',
        metadata: { name: 'inngest' },
        spec: {
          values: {
            extraEnv: [
              { name: 'DB_HOST', value: '__KUBERNETES_REF_database_status.writeService__' },
              { name: 'OTHER', value: 'static-value' },
            ],
          },
        },
      });

      const graph = resolver.buildDependencyGraph([database, helmRelease]);

      expect(graph.getDependencies('helmRelease')).toContain('database');
    });

    it('should resolve marker refs using original composition IDs mapped to graph IDs', () => {
      // Simulates the real deployment: graph IDs are prefixed (testappResource0Database)
      // but marker strings reference the original composition ID (database)
      const database = createMockResource({
        id: 'testappResource0Database',
        kind: 'Cluster',
        apiVersion: 'postgresql.cnpg.io/v1',
        metadata: { name: 'testapp-db' },
      });
      // Set the original composition ID on the resource metadata
      setResourceId(database, 'database');

      const helmRelease = createMockResource({
        id: 'testappResource5Inngesthelmrelease',
        kind: 'HelmRelease',
        apiVersion: 'helm.toolkit.fluxcd.io/v2',
        metadata: { name: 'testapp-inngest' },
        spec: {
          values: {
            inngest: {
              postgres: {
                uri: 'postgresql://app@__KUBERNETES_REF_database_status.writeService__:5432/testdb',
              },
            },
          },
        },
      });

      const graph = resolver.buildDependencyGraph([database, helmRelease]);

      // The marker ref 'database' should be resolved to 'testappResource0Database'
      expect(graph.getDependencies('testappResource5Inngesthelmrelease'))
        .toContain('testappResource0Database');
    });

    it('should produce correct deployment levels with marker + namespace deps', () => {
      const ns = createMockResource({
        id: 'appNamespace',
        kind: 'Namespace',
        apiVersion: 'v1',
        metadata: { name: 'my-app' },
      });
      const database = createMockResource({
        id: 'database',
        kind: 'Cluster',
        metadata: { name: 'db', namespace: 'my-app' },
      });
      const cache = createMockResource({
        id: 'cache',
        kind: 'Valkey',
        metadata: { name: 'cache', namespace: 'my-app' },
      });
      const helmRelease = createMockResource({
        id: 'inngest',
        kind: 'HelmRelease',
        metadata: { name: 'inngest', namespace: 'my-app' },
        spec: {
          values: {
            postgres: { uri: 'pg://__KUBERNETES_REF_database_status.writeService__:5432' },
            redis: { uri: 'redis://__KUBERNETES_REF_cache_status.hostname__:6379' },
          },
        },
      });

      const graph = resolver.buildDependencyGraph([ns, database, cache, helmRelease]);
      const plan = resolver.analyzeDeploymentOrder(graph);

      // Level 0: Namespace (no deps)
      expect(plan.levels[0]).toContain('appNamespace');
      expect(plan.levels[0]).not.toContain('database');
      expect(plan.levels[0]).not.toContain('cache');
      expect(plan.levels[0]).not.toContain('inngest');

      // Level 1: database + cache (depend on namespace only)
      expect(plan.levels[1]).toContain('database');
      expect(plan.levels[1]).toContain('cache');
      expect(plan.levels[1]).not.toContain('inngest');

      // Level 2: inngest (depends on database + cache via markers, and namespace)
      expect(plan.levels[2]).toContain('inngest');
    });
  });
});
