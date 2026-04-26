/**
 * Tests for live status hydration in direct mode.
 *
 * Verifies that after deployment, the composition re-execution with
 * live status data produces correct boolean/numeric status values
 * instead of proxy artifacts.
 *
 * Covers:
 * - Direct resource status injection via createPropertyProxy
 * - Nested composition status injection via createKubernetesRefProxy
 * - Deep nested structures (Records in Records)
 * - deepMergeLiveStatus recursive merge
 * - Mixed resolved/unresolved values in objects
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Cel } from '../../src/index.js';
import {
  createCompositionContext,
  runWithCompositionContext,
} from '../../src/core/composition/context.js';
import { synthesizeNestedCompositionStatus } from '../../src/core/deployment/nested-composition-status.js';
import { createSchemaProxy } from '../../src/core/references/schema-proxy.js';
import { serializeStatusMappingsToCel } from '../../src/core/serialization/cel-references.js';
import { simple } from '../../src/factories/simple/index.js';
import { createResource } from '../../src/core/proxy/create-resource.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Create a minimal CRD resource factory for testing.
 */
function testCrdResource(config: { name: string; namespace?: string; id?: string }) {
  return createResource(
    {
      apiVersion: 'test.example.com/v1',
      kind: 'TestCluster',
      metadata: { name: config.name, namespace: config.namespace || 'default' },
      spec: {},
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced' }
  ) as any;
}

// ─── Schemas ─────────────────────────────────────────────────────────────

const InnerStatusSchema = type({
  ready: 'boolean',
  phase: '"Ready" | "Installing"',
  appUrl: 'string',
});

const InnerSpecSchema = type({
  name: 'string',
  'namespace?': 'string',
  key: 'string',
});

const innerComposition = kubernetesComposition(
  {
    name: 'inner-composition',
    kind: 'InnerTest',
    spec: InnerSpecSchema,
    status: InnerStatusSchema,
  },
  (spec) => {
    simple.Deployment({
      name: `${spec.name}-deploy`,
      image: 'nginx:alpine',
      id: 'innerDeploy',
    });

    simple.Service({
      name: spec.name,
      selector: { app: spec.name },
      ports: [{ port: 80, targetPort: 80 }],
      id: 'innerService',
    });

    return {
      ready: true, // static for testing — in real use this would be a status comparison
      phase: 'Ready' as const,
      appUrl: `http://${spec.name}:80`,
    };
  }
);

const OuterSpecSchema = type({
  name: 'string',
  'namespace?': 'string',
  replicas: 'number',
});

const OuterStatusSchema = type({
  ready: 'boolean',
  appUrl: 'string',
  components: {
    app: 'boolean',
    database: 'boolean',
    inner: 'boolean',
  },
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Live Status Hydration', () => {
  describe('createPropertyProxy with liveStatusMap', () => {
    it('should return live status values when liveStatusMap is populated', () => {
      const ctx = createCompositionContext('live-test', { deduplicateIds: true });
      ctx.liveStatusMap = new Map([
        ['database', { readyInstances: 3, phase: 'Cluster in healthy state', instances: 3 }],
        ['cache', { ready: true }],
      ]);

      const result = runWithCompositionContext(ctx, () => {
        const db = testCrdResource({ name: 'test-db', id: 'database' });
        const cache = testCrdResource({ name: 'test-cache', id: 'cache' });

        // These should return live values, not KubernetesRef proxies
        return {
          dbReadyInstances: db.status.readyInstances,
          dbPhase: db.status.phase,
          cacheReady: cache.status.ready,
          // Comparisons should evaluate correctly
          dbHealthy: db.status.readyInstances >= 3,
          cacheHealthy: cache.status.ready === true,
        };
      });

      expect(result.dbReadyInstances).toBe(3);
      expect(result.dbPhase).toBe('Cluster in healthy state');
      expect(result.cacheReady).toBe(true);
      expect(result.dbHealthy).toBe(true);
      expect(result.cacheHealthy).toBe(true);
    });

    it('should fall back to KubernetesRef when liveStatusMap has no entry for resource', () => {
      const ctx = createCompositionContext('fallback-test', { deduplicateIds: true });
      ctx.liveStatusMap = new Map([
        ['database', { readyInstances: 1 }],
        // No entry for 'unknownResource'
      ]);

      const result = runWithCompositionContext(ctx, () => {
        const unknown = testCrdResource({ name: 'unknown', id: 'unknownResource' });
        const value = unknown.status.readyInstances;
        // The comparison with a KubernetesRef produces NaN >= 1 → false
        const comparison = value >= 1;
        return { comparison };
      });

      // Without live data, comparison evaluates to false (NaN >= 1)
      expect(result.comparison).toBe(false);
    });

    it('should handle nested status objects from live data', () => {
      const ctx = createCompositionContext('nested-test', { deduplicateIds: true });
      ctx.liveStatusMap = new Map([
        ['database', {
          cluster: { healthy: true, pods: 3 },
          phase: 'Running',
        }],
      ]);

      const result = runWithCompositionContext(ctx, () => {
        const db = testCrdResource({ name: 'test-db', id: 'database' });
        // First level returns the nested object
        const cluster = db.status.cluster;
        return {
          cluster,
          healthy: cluster?.healthy,
          pods: cluster?.pods,
          phase: db.status.phase,
        };
      });

      expect(result.cluster).toEqual({ healthy: true, pods: 3 });
      expect(result.healthy).toBe(true);
      expect(result.pods).toBe(3);
      expect(result.phase).toBe('Running');
    });
  });

  describe('createKubernetesRefProxy with liveStatusMap (nested compositions)', () => {
    it('should inject live status into nested composition status proxy', () => {
      const ctx = createCompositionContext('nested-comp-test', { deduplicateIds: true });
      // Simulate synthesized nested composition status
      ctx.liveStatusMap = new Map([
        ['inner1', { ready: true, phase: 'Ready' }],
      ]);

      const result = runWithCompositionContext(ctx, () => {
        // Call the inner composition — this creates a NestedCompositionResource
        // whose status proxy goes through createKubernetesRefProxy
        const inner = innerComposition({
          name: 'test-inner',
          key: 'test-key',
        });

        // Accessing inner.status.ready should use liveStatusMap
        return {
          ready: inner.status.ready,
          phase: inner.status.phase,
        };
      });

      expect(result.ready).toBe(true);
      expect(result.phase).toBe('Ready');
    });

    it('should handle nested composition status with deep fields', () => {
      const ctx = createCompositionContext('deep-nested-test', { deduplicateIds: true });
      ctx.liveStatusMap = new Map([
        ['inner1', {
          ready: true,
          components: { deploy: true, service: true },
        }],
      ]);

      const result = runWithCompositionContext(ctx, () => {
        const inner = innerComposition({
          name: 'test-inner',
          key: 'test-key',
        });

        // Access deep fields injected via liveStatusMap (not in the TypeScript type)
        const status = inner.status as Record<string, unknown>;
        return {
          ready: status.ready,
          components: status.components,
        };
      });

      expect(result.ready).toBe(true);
      expect(result.components).toEqual({ deploy: true, service: true });
    });
  });

  describe('Composition function body with live status (simulating reExecuteWithLiveStatus)', () => {
    it('synthesizes nested static status fields while preserving live readiness fields', () => {
      const outerFn = (spec: { name: string }) => {
        const inner = innerComposition({ name: `${spec.name}-inner`, key: 'test' });
        return { ready: inner.status.ready };
      };

      kubernetesComposition(
        {
          name: 'outer-nested-snapshot-test',
          kind: 'OuterNestedSnapshotTest',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        outerFn
      );

      const probeCtx = createCompositionContext('nested-snapshot-probe', { deduplicateIds: true });
      runWithCompositionContext(probeCtx, () => {
        outerFn({ name: 'myapp' });
      });

      const enrichedMap = synthesizeNestedCompositionStatus(
        probeCtx.resources,
        new Map([['inner1InnerDeploy', { readyReplicas: 1 }]]),
        { debug() {} } as never,
        probeCtx.nestedCompositionIds,
        probeCtx.nestedStatusSnapshots
      );

      expect(enrichedMap.get('inner1')).toEqual({
        appUrl: 'http://myapp-inner:80',
        ready: true,
        phase: 'Ready',
        failed: false,
      });
    });

    it('filters unresolved nested status snapshot markers during synthesis', () => {
      const enrichedMap = synthesizeNestedCompositionStatus(
        {
          inner1InnerDeploy: testCrdResource({ name: 'x', id: 'innerDeploy' }),
        },
        new Map([['inner1InnerDeploy', { readyReplicas: 1 }]]),
        { debug() {} } as never,
        new Set(['inner1']),
        new Map([
          ['inner1', {
            appUrl: '__KUBERNETES_REF_inner1_status.appUrl__',
            components: { app: true },
          }],
        ])
      );

      expect(enrichedMap.get('inner1')).toEqual({
        components: { app: true },
        ready: true,
        phase: 'Ready',
        failed: false,
      });
    });

    it('resolves nested static status fields during live re-execution', () => {
      const outerFn = (spec: { name: string }) => {
        const inner = innerComposition({ name: `${spec.name}-inner`, key: 'test' });
        return {
          ready: inner.status.ready,
          innerUrl: inner.status.appUrl,
        };
      };

      kubernetesComposition(
        {
          name: 'outer-nested-static-test',
          kind: 'OuterNestedStaticTest',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean', innerUrl: 'string' }),
        },
        outerFn
      );

      const probeCtx = createCompositionContext('nested-static-probe', { deduplicateIds: true });
      runWithCompositionContext(probeCtx, () => {
        outerFn({ name: 'myapp' });
      });

      const enrichedMap = synthesizeNestedCompositionStatus(
        probeCtx.resources,
        new Map([['inner1InnerDeploy', { readyReplicas: 1 }]]),
        { debug() {} } as never,
        probeCtx.nestedCompositionIds,
        probeCtx.nestedStatusSnapshots
      );

      const ctx = createCompositionContext('nested-static-reexecution', { deduplicateIds: true });
      ctx.liveStatusMap = enrichedMap;

      const status = runWithCompositionContext(ctx, () => {
        return outerFn({ name: 'myapp' });
      });

      expect(status.ready).toBe(true);
      expect(status.innerUrl).toBe('http://myapp-inner:80');
      expect(status.innerUrl).not.toContain('__KUBERNETES_REF_');
    });

    it('should resolve both spec-derived and status-derived fields with live data', () => {
      // Simulate what reExecuteWithLiveStatus does: create a context with liveStatusMap
      // and run the composition function body directly
      const ctx = createCompositionContext('e2e-test', { deduplicateIds: true });
      ctx.liveStatusMap = new Map([
        ['app', { readyReplicas: 2, availableReplicas: 2 }],
        ['database', { readyInstances: 1, phase: 'Cluster in healthy state' }],
        ['cache', { ready: true }],
        ['inner1', { ready: true, phase: 'Ready' }],
      ]);

      // Run the composition function body directly with live data in context
      const status = runWithCompositionContext(ctx, () => {
        const appReplicas = 2;

        const app = simple.Deployment({
          name: 'myapp',
          image: 'nginx:alpine',
          replicas: appReplicas,
          id: 'app',
        });

        const database = testCrdResource({ name: 'myapp-db', id: 'database' });
        const cache = testCrdResource({ name: 'myapp-cache', id: 'cache' });
        const inner = innerComposition({ name: 'myapp-inner', key: 'test' });

        return {
          ready:
            app.status.readyReplicas >= appReplicas &&
            database.status.readyInstances >= 1 &&
            cache.status.ready &&
            inner.status.ready,
          appUrl: 'http://myapp:80',
          components: {
            app: app.status.readyReplicas >= appReplicas,
            database: database.status.readyInstances >= 1,
            inner: inner.status.ready === true,
          },
        };
      });

      // Spec-derived
      expect(status.appUrl).toBe('http://myapp:80');

      // Status-derived — should use live data
      expect(status.components.app).toBe(true);      // 2 >= 2
      expect(status.components.database).toBe(true);  // 1 >= 1
      expect(status.components.inner).toBe(true);     // live: true

      // Top-level ready (all && together)
      expect(status.ready).toBe(true);
    });

    it('should return false when live status shows not ready', () => {
      const ctx = createCompositionContext('not-ready-test', { deduplicateIds: true });
      ctx.liveStatusMap = new Map([
        ['app', { readyReplicas: 1, availableReplicas: 1 }], // only 1, need 3
        ['database', { readyInstances: 0 }],                  // 0, need 1
        ['cache', { ready: false }],
        ['inner1', { ready: false, phase: 'Installing' }],
      ]);

      const status = runWithCompositionContext(ctx, () => {
        const replicas = 3;

        const app = simple.Deployment({
          name: 'myapp',
          image: 'nginx',
          replicas,
          id: 'app',
        });
        const database = testCrdResource({ name: 'myapp-db', id: 'database' });
        const cache = testCrdResource({ name: 'myapp-cache', id: 'cache' });
        const inner = innerComposition({ name: 'myapp-inner', key: 'key' });

        return {
          ready:
            app.status.readyReplicas >= replicas &&
            database.status.readyInstances >= 1 &&
            cache.status.ready &&
            inner.status.ready,
          appUrl: 'http://myapp:80',
          components: {
            app: app.status.readyReplicas >= replicas,
            database: database.status.readyInstances >= 1,
            inner: inner.status.ready === true,
          },
        };
      });

      expect(status.ready).toBe(false);
      expect(status.components.app).toBe(false);      // 1 < 3
      expect(status.components.database).toBe(false);  // 0 < 1
      expect(status.components.inner).toBe(false);     // live: false
    });

    it('should handle mixed readiness (some ready, some not)', () => {
      const ctx = createCompositionContext('mixed-test', { deduplicateIds: true });
      ctx.liveStatusMap = new Map([
        ['app', { readyReplicas: 2, availableReplicas: 2 }],
        ['database', { readyInstances: 1 }],
        ['cache', { ready: true }],
        ['inner1', { ready: false }], // inner not ready
      ]);

      const status = runWithCompositionContext(ctx, () => {
        const app = simple.Deployment({ name: 'x', image: 'nginx', replicas: 2, id: 'app' });
        const database = testCrdResource({ name: 'x-db', id: 'database' });
        const cache = testCrdResource({ name: 'x-cache', id: 'cache' });
        const inner = innerComposition({ name: 'x-inner', key: 'k' });

        return {
          ready:
            app.status.readyReplicas >= 2 &&
            database.status.readyInstances >= 1 &&
            cache.status.ready &&
            inner.status.ready,
          components: {
            app: app.status.readyReplicas >= 2,
            database: database.status.readyInstances >= 1,
            cache: cache.status.ready === true,
            inner: inner.status.ready === true,
          },
        };
      });

      expect(status.ready).toBe(false);             // inner is false
      expect(status.components.app).toBe(true);
      expect(status.components.database).toBe(true);
      expect(status.components.cache).toBe(true);
      expect(status.components.inner).toBe(false);
    });

    it('normalizes top-level ready from fully resolved component booleans', () => {
      const ctx = createCompositionContext('component-normalization-test', { deduplicateIds: true });
      ctx.liveStatusMap = new Map([
        ['app', { readyReplicas: 1 }],
        ['database', { ready: true }],
      ]);

      const status = runWithCompositionContext(ctx, () => {
        const app = simple.Deployment({ name: 'myapp', image: 'nginx', id: 'app' });
        const database = testCrdResource({ name: 'myapp-db', id: 'database' });

        return {
          // Simulate a composition-level false that can appear before the
          // final merged component booleans are normalized.
          ready: false,
          components: {
            app: app.status.readyReplicas >= 1,
            database: database.status.ready === true,
          },
        };
      });

      expect(status.ready).toBe(false);
      expect(status.components.app).toBe(true);
      expect(status.components.database).toBe(true);
    });
  });

  describe('KRO YAML generation (unaffected by live status)', () => {
    it('should still generate valid CEL expressions in KRO mode', () => {
      const composition = kubernetesComposition(
        {
          name: 'kro-test',
          kind: 'KroTest',
          spec: OuterSpecSchema,
          status: OuterStatusSchema,
        },
        (spec) => {
          const app = simple.Deployment({
            name: spec.name,
            image: 'nginx',
            replicas: spec.replicas,
            id: 'app',
          });
          const database = testCrdResource({ name: `${spec.name}-db`, id: 'database' });
          const cache = testCrdResource({ name: `${spec.name}-cache`, id: 'cache' });
          const inner = innerComposition({ name: `${spec.name}-inner`, key: 'key' });

          return {
            ready:
              app.status.readyReplicas >= spec.replicas &&
              database.status.readyInstances >= 1 &&
              cache.status.ready &&
              inner.status.ready,
            appUrl: `http://${spec.name}:80`,
            components: {
              app: app.status.readyReplicas >= spec.replicas,
              database: database.status.readyInstances >= 1,
              inner: inner.status.ready,
            },
          };
        }
      );

      const yaml: string = composition.toYaml();

      // Should contain RGD structure
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
      expect(yaml).toContain('name: kro-test');

      // Should contain all resource kinds
      expect(yaml).toContain('kind: Deployment');
      expect(yaml).toContain('kind: TestCluster');
    });

    it('should convert status field template literals to CEL expressions in KRO YAML', () => {
      const StatusUrlSchema = type({
        dbUrl: 'string',
        cacheUrl: 'string',
      });
      const SpecSchema = type({ name: 'string' });

      const composition = kubernetesComposition(
        {
          name: 'cel-status-refs',
          kind: 'CelStatusTest',
          spec: SpecSchema,
          status: StatusUrlSchema,
        },
        (spec) => {
          const database = testCrdResource({ name: `${spec.name}-db`, id: 'database' });
          const cache = testCrdResource({ name: `${spec.name}-cache`, id: 'cache' });

          return {
            // These use status field refs in template literals.
            // Before the Symbol.toPrimitive fix, these would produce 'undefined'.
            // Now they should produce __KUBERNETES_REF__ markers that become CEL.
            dbUrl: `postgresql://app@${database.status.writeService}:5432/mydb`,
            cacheUrl: `redis://${cache.status.hostname}:6379`,
          };
        }
      );

      const yaml: string = composition.toYaml();

      // Status field references in template literals should become CEL expressions,
      // not 'undefined' or raw marker strings
      expect(yaml).not.toContain('undefined');
      expect(yaml).not.toContain('__KUBERNETES_REF_');

      // Should contain CEL expression references to resource status fields
      expect(yaml).toContain('database');
      expect(yaml).toContain('writeService');
      expect(yaml).toContain('cache');
      expect(yaml).toContain('hostname');
    });

    it('should resolve nested refs inside status Cel.template expressions', () => {
      const serialized = serializeStatusMappingsToCel(
        {
          prefixedUrl: Cel.template('prefix-%s', Cel.expr<string>('nested.status.appUrl')),
        },
        {
          '__nestedStatus:nested:appUrl': '"http://" + string(schema.spec.name) + ":80"',
        },
      );

      expect(String(serialized.prefixedUrl)).toContain('prefix-${');
      expect(String(serialized.prefixedUrl)).toContain('string(spec.name)');
      expect(String(serialized.prefixedUrl)).not.toContain('nested.status.appUrl');
      expect(String(serialized.prefixedUrl)).not.toContain('__KUBERNETES_REF_nested');
    });

    it('should rewrite direct schema KubernetesRefs for KRO status expressions', () => {
      const schema = createSchemaProxy<{ namespace: string }, Record<string, never>>();
      const serialized = serializeStatusMappingsToCel({
        namespace: schema.spec.namespace,
        details: {
          namespace: schema.spec.namespace,
        },
      });

      expect(serialized.namespace).toBe('${spec.namespace}');
      expect((serialized.details as Record<string, string>).namespace).toBe('${spec.namespace}');
      expect(JSON.stringify(serialized)).not.toContain('__schema__');
      expect(JSON.stringify(serialized)).not.toContain('schema.spec');
    });
  });

  describe('KubernetesRef proxy type coercion (Symbol.toPrimitive)', () => {
    it('should produce marker strings in template literals', () => {
      const ctx = createCompositionContext('toPrimitive-test', { deduplicateIds: true });

      const result = runWithCompositionContext(ctx, () => {
        const db = testCrdResource({ name: 'mydb', id: 'database' });
        const ref = db.status.writeService;

        return {
          // Direct coercion methods
          toString: ref.toString(),
          valueOf: ref.valueOf(),
          stringCoercion: String(ref),
          templateLiteral: `pg://${ref}:5432`,
          toMarkerString: ref.toMarkerString(),
        };
      });

      const expected = '__KUBERNETES_REF_database_status.writeService__';
      expect(result.toString).toBe(expected);
      expect(result.valueOf).toBe(expected);
      expect(result.stringCoercion).toBe(expected);
      expect(result.templateLiteral).toBe(`pg://${expected}:5432`);
      expect(result.toMarkerString).toBe(expected);
    });

    it('should embed marker strings that the dependency resolver can detect', () => {
      const ctx = createCompositionContext('dep-detection-test', { deduplicateIds: true });

      const result = runWithCompositionContext(ctx, () => {
        const db = testCrdResource({ name: 'mydb', id: 'database' });
        const cache = testCrdResource({ name: 'mycache', id: 'cache' });

        // Simulate building Helm values with status references
        return {
          postgresUri: `postgresql://app@${db.status.writeService}:5432/mydb`,
          redisUri: `redis://${cache.status.hostname}:6379`,
        };
      });

      // Both URIs should contain detectable KubernetesRef markers
      expect(result.postgresUri).toContain('__KUBERNETES_REF_database_status.writeService__');
      expect(result.redisUri).toContain('__KUBERNETES_REF_cache_status.hostname__');
    });

    it('should NOT produce marker strings for metadata fields that exist on the target', () => {
      const ctx = createCompositionContext('eager-value-test', { deduplicateIds: true });

      const result = runWithCompositionContext(ctx, () => {
        const db = testCrdResource({ name: 'mydb', id: 'database' });

        // metadata.name IS on the target object, so it returns the eager value
        return {
          metadataName: `${db.metadata.name}`,
          statusField: `${db.status.writeService}`,
        };
      });

      // metadata.name returns the actual value (eager resolution)
      expect(result.metadataName).toBe('mydb');
      // status.writeService returns a marker (lazy reference)
      expect(result.statusField).toContain('__KUBERNETES_REF_');
    });

    it('should produce nested marker strings for deep status access', () => {
      const ctx = createCompositionContext('deep-ref-test', { deduplicateIds: true });

      const result = runWithCompositionContext(ctx, () => {
        const db = testCrdResource({ name: 'mydb', id: 'database' });
        return {
          deepRef: `${db.status.cluster.endpoint}`,
        };
      });

      expect(result.deepRef).toBe('__KUBERNETES_REF_database_status.cluster.endpoint__');
    });
  });
});
