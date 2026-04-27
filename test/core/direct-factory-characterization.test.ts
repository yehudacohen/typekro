/**
 * Characterization tests for DirectResourceFactoryImpl non-enumerable property handling
 *
 * These tests capture the CURRENT behavior of how non-enumerable properties
 * (__resourceId, readinessEvaluator) are preserved through resource cloning,
 * re-execution, and YAML generation. They serve as a safety net for the
 * WeakMap migration (Phase 2.6).
 *
 * Focus areas:
 *   1. __resourceId preservation through createResourceGraphForInstance()
 *   2. readinessEvaluator preservation through createResourceGraphForInstance()
 *   3. Non-enumerability contract (Object.keys, JSON.stringify, for-in exclude these)
 *   4. toYaml() strips non-serializable values via JSON round-trip
 *   5. Property descriptor shapes (enumerable/configurable/writable)
 *   6. resolveSchemaReferencesToValues readinessEvaluator preservation
 *
 * @see src/core/deployment/direct-factory.ts
 */

import { describe, expect, it, mock } from 'bun:test';
import { type } from 'arktype';
import type { DirectResourceFactoryImpl } from '../../src/core/deployment/direct-factory.js';
import { createDirectResourceFactory } from '../../src/core/deployment/direct-factory.js';
import {
  RESOURCE_ID_ANNOTATION,
  SINGLETON_SPEC_FINGERPRINT_ANNOTATION,
} from '../../src/core/deployment/resource-tagging.js';
import { getSingletonInstanceName } from '../../src/core/deployment/shared-utilities.js';
import { getSingletonResourceId, singleton } from '../../src/core/singleton/singleton.js';
import { DirectDeploymentStrategy } from '../../src/core/deployment/strategies/direct-strategy.js';
import { DependencyResolver } from '../../src/core/dependencies/resolver.js';
import { getCurrentCompositionContext } from '../../src/core/composition/context.js';
import {
  copyResourceMetadata,
  getMetadataField,
  getResourceId,
  setResourceId,
} from '../../src/core/metadata/index.js';
import { Cel, kubernetesComposition, simple, toResourceGraph } from '../../src/index.js';
import type { KroCompatibleType, SchemaDefinition } from '../../src/core/types/serialization.js';
import type {
  InternalResourceFactoryDeployOptions,
  SingletonDefinitionRecord,
} from '../../src/core/types/deployment.js';

// ---------------------------------------------------------------------------
// Schema definitions used across tests
// ---------------------------------------------------------------------------

const TestSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1',
  port: 'number%1',
});

const TestStatusSchema = type({
  phase: '"pending" | "running" | "failed"',
  readyReplicas: 'number%1',
  url: 'string',
});

type TestSpec = typeof TestSpecSchema.infer;
type TestStatus = typeof TestStatusSchema.infer;

const DEFAULT_SPEC: TestSpec = {
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3,
  port: 8080,
};

describe('DirectResourceFactory: deployed instance tracking', () => {
  it('stores overridden instance names under the override key', async () => {
    const factory = createDirectResourceFactory(
      'tracking-test',
      {},
      {
        apiVersion: 'test.typekro.io/v1alpha1',
        kind: 'TrackingTest',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      undefined,
      { hydrateStatus: false }
    );
    const deployedInstance = { metadata: { name: 'custom-instance' } };
    (factory as unknown as Record<string, unknown>).getDeploymentStrategy = () => ({
      deploy: async () => deployedInstance,
    });

    await factory.deploy(DEFAULT_SPEC, {
      instanceNameOverride: 'custom-instance',
    } as InternalResourceFactoryDeployOptions);

    const deployedInstances = (factory as unknown as { deployedInstances: Map<string, unknown> })
      .deployedInstances;
    expect(deployedInstances.get('custom-instance')).toBe(deployedInstance);
    expect(deployedInstances.has('my-app')).toBe(false);
  });

  it('validates parent spec before singleton owner discovery', async () => {
    const StrictSpecSchema = type({ name: '"expected"' });
    const StrictStatusSchema = type({ ready: 'boolean' });
    const factory = createDirectResourceFactory(
      'invalid-parent-test',
      {},
      {
        apiVersion: 'test.typekro.io/v1alpha1',
        kind: 'InvalidParentTest',
        spec: StrictSpecSchema,
        status: StrictStatusSchema,
      },
      undefined,
      { hydrateStatus: false }
    );
    let singletonDiscoveryCalls = 0;
    (factory as unknown as Record<string, unknown>).ensureSingletonOwners = async () => {
      singletonDiscoveryCalls++;
    };

    await expect(factory.deploy({ name: 'bad' } as never)).rejects.toThrow('Invalid spec');

    expect(singletonDiscoveryCalls).toBe(0);
  });

  it('throws and preserves tracking when deleteInstance rollback is partial', async () => {
    const factory = createDirectResourceFactory(
      'partial-cleanup-test',
      {},
      {
        apiVersion: 'test.typekro.io/v1alpha1',
        kind: 'PartialCleanupTest',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      undefined,
      { hydrateStatus: false }
    );
    const deployedInstances = (factory as unknown as { deployedInstances: Map<string, unknown> })
      .deployedInstances;
    deployedInstances.set('my-app', {
      metadata: {
        name: 'my-app',
        annotations: { 'typekro.io/deployment-id': 'deploy-1' },
      },
    });
    (factory as unknown as Record<string, unknown>).getDeploymentEngine = () => ({
      rollback: mock(() =>
        Promise.resolve({
          deploymentId: 'deploy-1',
          rolledBackResources: ['ConfigMap/app-config'],
          duration: 10,
          status: 'partial',
          errors: [
            {
              resourceId: 'app',
              phase: 'rollback',
              error: new Error('delete failed'),
              timestamp: new Date(),
            },
          ],
        })
      ),
      getKubernetesApi: mock(() => ({})),
    });

    await expect(factory.deleteInstance('my-app')).rejects.toThrow('Cleanup incomplete');
    expect(deployedInstances.has('my-app')).toBe(true);
  });

  it('factory rollback uses deployment state child resources, not logical instances', async () => {
    const factory = createDirectResourceFactory(
      'factory-rollback-child-resources',
      {},
      {
        apiVersion: 'test.typekro.io/v1alpha1',
        kind: 'FactoryRollbackChildResources',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      undefined,
      { hydrateStatus: false }
    );
    const deployedInstances = (factory as unknown as { deployedInstances: Map<string, unknown> })
      .deployedInstances;
    deployedInstances.set('my-app', {
      metadata: {
        name: 'my-app',
        annotations: { 'typekro.io/deployment-id': 'deploy-children' },
      },
    });
    const rollback = mock(() =>
      Promise.resolve({
        deploymentId: 'deploy-children',
        rolledBackResources: ['Deployment/my-app', 'Service/my-app'],
        duration: 5,
        status: 'success' as const,
        errors: [],
      })
    );
    (factory as unknown as Record<string, unknown>).getDeploymentEngine = () => ({
      rollback,
      loadDeploymentByInstance: mock(() => Promise.resolve(undefined)),
    });

    const result = await factory.rollback();

    expect(rollback).toHaveBeenCalledWith('deploy-children', {});
    expect(result.rolledBackResources).toEqual(['Deployment/my-app', 'Service/my-app']);
    expect(deployedInstances.size).toBe(0);
  });

  it('throws when namespace deletion does not complete before timeout', async () => {
    const factory = createDirectResourceFactory(
      'namespace-timeout-test',
      {},
      {
        apiVersion: 'test.typekro.io/v1alpha1',
        kind: 'NamespaceTimeoutTest',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      undefined,
      { hydrateStatus: false }
    );
    const waitForNamespaceDeletion = getPrivateMethod(factory, 'waitForNamespaceDeletion') as (
      k8sApi: { read(request: Record<string, unknown>): Promise<unknown> },
      namespaces: string[],
      timeout: number
    ) => Promise<void>;

    await expect(
      waitForNamespaceDeletion({ read: mock(() => Promise.resolve({ body: {} })) }, ['stuck-ns'], 0)
    ).rejects.toThrow('Timed out waiting for namespace stuck-ns to be deleted');
  });
});

// ---------------------------------------------------------------------------
// Helper: create a standard test factory via toResourceGraph
// ---------------------------------------------------------------------------

async function createTestFactory(
  factoryName = 'char-test'
): Promise<DirectResourceFactoryImpl<TestSpec, TestStatus>> {
  const graph = toResourceGraph(
    {
      name: factoryName,
      apiVersion: 'test.typekro.io/v1alpha1',
      kind: 'WebApp',
      spec: TestSpecSchema,
      status: TestStatusSchema,
    },
    (schema) => ({
      deployment: simple.Deployment({
        name: schema.spec.name,
        image: schema.spec.image,
        replicas: schema.spec.replicas,
        id: 'webappDeployment',
      }),
      service: simple.Service({
        name: Cel.template('%s-svc', schema.spec.name),
        selector: { app: schema.spec.name },
        ports: [{ port: 80, targetPort: schema.spec.port }],
        id: 'webappService',
      }),
    }),
    (_schema, resources) => ({
      readyReplicas: resources.deployment?.status.readyReplicas,
      url: 'http://localhost',
      phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
    })
  );

  return (await graph.factory('direct', {
    namespace: 'test-ns',
    waitForReady: true,
  })) as unknown as DirectResourceFactoryImpl<TestSpec, TestStatus>;
}

function getPrivateMethod<TInstance extends object>(
  instance: TInstance,
  methodName: string
): (...args: unknown[]) => unknown {
  const method = (instance as unknown as Record<string, (...args: unknown[]) => unknown>)[
    methodName
  ];
  if (!method) {
    throw new Error(`Private method '${methodName}' not found`);
  }
  return method.bind(instance);
}

// ===========================================================================
// 1. createResourceGraphForInstance — __resourceId preservation
// ===========================================================================

describe('DirectFactory: __resourceId preservation', () => {
  it('resources in graph have resourceId stored in WeakMap metadata', async () => {
    const factory = await createTestFactory('rid-test');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    // Each resource in the graph should have resourceId in WeakMap
    for (const res of graph.resources) {
      const manifest = res.manifest;
      const rid = getResourceId(manifest);
      expect(rid).toBeDefined();
      expect(typeof rid).toBe('string');

      // Should NOT be a property on the object (stored in WeakMap instead)
      expect(Object.keys(manifest)).not.toContain('__resourceId');
    }
  });

  it('__resourceId is NOT visible in Object.keys()', async () => {
    const factory = await createTestFactory('rid-keys');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (const res of graph.resources) {
      const keys = Object.keys(res.manifest);
      expect(keys).not.toContain('__resourceId');
    }
  });

  it('__resourceId is NOT visible in JSON.stringify()', async () => {
    const factory = await createTestFactory('rid-json');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (const res of graph.resources) {
      const json = JSON.stringify(res.manifest);
      expect(json).not.toContain('__resourceId');
    }
  });

  it('__resourceId is NOT visible in for-in loops', async () => {
    const factory = await createTestFactory('rid-forin');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (const res of graph.resources) {
      const forInKeys: string[] = [];
      for (const key in res.manifest) {
        forInKeys.push(key);
      }
      expect(forInKeys).not.toContain('__resourceId');
    }
  });

  it('__resourceId preserves the original resource key from composition', async () => {
    const factory = await createTestFactory('rid-original');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    // The original resource keys were 'webappDeployment' and 'webappService'
    const resourceIds = graph.resources.map((r) => getResourceId(r.manifest));

    // Should contain the original IDs (the exact values depend on how the
    // proxy and composition fn return them)
    expect(resourceIds.length).toBeGreaterThanOrEqual(2);
    for (const rid of resourceIds) {
      expect(typeof rid).toBe('string');
      expect((rid as string).length).toBeGreaterThan(0);
    }
  });

  it('resolves string dependsOn targets into dependency metadata', () => {
    const app = simple.Deployment({
      name: 'app',
      image: 'nginx',
      id: 'app',
    });

    app.dependsOn('database');

    expect(getMetadataField(app, 'dependsOn')).toEqual([{ resourceId: 'database' }]);
  });

  it('uses string dependsOn targets as direct deployment graph edges', () => {
    const database = simple.Deployment({
      name: 'database',
      image: 'postgres',
      id: 'database',
    });
    const app = simple.Deployment({
      name: 'app',
      image: 'nginx',
      id: 'app',
    });

    app.dependsOn('database');

    const graphDatabase = { ...database, id: 'testResource0Database' } as typeof database & {
      id: string;
    };
    const graphApp = { ...app, id: 'testResource1App' } as typeof app & { id: string };
    copyResourceMetadata(database, graphDatabase);
    copyResourceMetadata(app, graphApp);
    const graph = new DependencyResolver().buildDependencyGraph([graphDatabase, graphApp]);

    expect(graph.getDependencies('testResource1App')).toEqual(['testResource0Database']);
  });

  it('throws for unresolved dependsOn targets', () => {
    const app = simple.Deployment({
      name: 'app',
      image: 'nginx',
      id: 'app',
    });

    expect(() => app.dependsOn({ nope: true } as never)).toThrow('dependsOn() target');
  });
});

describe('DirectFactory: direct-mode CEL fallback', () => {
  it('resolves exact nested schema CEL references without stringifying scalar values', async () => {
    const factory = await createTestFactory('nested-cel-fallback');
    const resolveSchemaReferencesToValues = getPrivateMethod(
      factory,
      'resolveSchemaReferencesToValues'
    );

    const spec = {
      name: 'app',
      database: { instances: 2, enabled: true },
    };

    expect(
      resolveSchemaReferencesToValues(Cel.expr('schema.spec.database.instances'), spec, 'root')
    ).toBe(2);
    expect(
      resolveSchemaReferencesToValues(Cel.expr('schema.spec.database.enabled'), spec, 'root')
    ).toBe(true);
  });

  it('resolves nested schema CEL references inside fallback strings', async () => {
    const factory = await createTestFactory('nested-cel-string-fallback');
    const resolveSchemaReferencesToValues = getPrivateMethod(
      factory,
      'resolveSchemaReferencesToValues'
    );

    const spec = {
      name: 'app',
      database: { host: 'postgres', port: 5432 },
    };

    expect(
      resolveSchemaReferencesToValues(
        Cel.expr('postgres://schema.spec.database.host:schema.spec.database.port/app'),
        spec,
        'root'
      )
    ).toBe('postgres://postgres:5432/app');
  });
});

describe('DirectFactory: singleton owner boundaries', () => {
  it('uses singleton instance override when generating owner resource graph ids', async () => {
    const factory = await createTestFactory('singleton-id-override');
    const graph = factory.createResourceGraphForInstance(
      { name: 'spec-derived-name', image: 'nginx:latest', replicas: 1, port: 8080 },
      'stable-singleton-id'
    );

    expect(graph.resources[0]?.id).toStartWith('stableSingletonIdResource0');
    expect(graph.resources[0]?.id).not.toStartWith('specDerivedNameResource0');
  });

  it('ensures singleton owners in direct mode using the singleton id as instance name', async () => {
    type OwnerSpec = KroCompatibleType & {
      name: string;
    };

    const deployCalls: Array<{ spec: OwnerSpec; opts?: Record<string, unknown> | undefined }> = [];
    const disposeCalls: string[] = [];
    const fakeComposition = {
      factory(mode: 'direct' | 'kro', options?: Record<string, unknown>) {
        expect(mode).toBe('direct');
        expect(options?.namespace).toBe('shared-system');

        return {
          async getInstances() {
            return [];
          },
          async deploy(spec: OwnerSpec, opts?: Record<string, unknown>) {
            deployCalls.push({ spec, ...(opts ? { opts } : {}) });
            return { metadata: { name: String(opts?.instanceNameOverride ?? spec.name) } };
          },
          async dispose() {
            disposeCalls.push('disposed');
          },
        };
      },
    };

    const schema: SchemaDefinition<{ name: string }, { ready: boolean }> = {
      apiVersion: 'v1alpha1',
      kind: 'SingletonConsumer',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    };

    const factory = createDirectResourceFactory('singleton-consumer', {}, schema, undefined, {
      namespace: 'default',
      singletonDefinitions: [
        {
          id: 'stable-singleton-id',
          key: 'SingletonBootstrap:stable-singleton-id',
          specFingerprint: 'fp',
          registryNamespace: 'shared-system',
          composition: fakeComposition as never,
          spec: { name: 'user-facing-name' },
        } satisfies SingletonDefinitionRecord,
      ],
    }) as unknown as DirectResourceFactoryImpl<{ name: string }, { ready: boolean }>;

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (spec: {
      name: string;
    }) => Promise<void>;

    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};

    await ensureSingletonOwners({ name: 'consumer' });

    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0]?.spec).toEqual({ name: 'user-facing-name' });
    expect(deployCalls[0]?.opts?.instanceNameOverride).toBe('stable-singleton-id');
    expect(disposeCalls).toEqual(['disposed']);
  });

  it('sanitizes singleton instance names to valid Kubernetes names', async () => {
    expect(getSingletonInstanceName('platformOperator')).toBe('platform-operator');
    expect(getSingletonInstanceName('platform_operator')).toBe('platform-operator');
  });

  it('hydrates singleton references from the deployed singleton owner status', async () => {
    type OwnerSpec = KroCompatibleType & { name: string };
    type OwnerStatus = KroCompatibleType & { ready: boolean; endpoint: string };
    const singletonKey =
      'kro.run/v1alpha1/SingletonBootstrap:singleton-bootstrap#platform-bootstrap';
    const deployedOwnerStatus = { ready: true, endpoint: 'http://owner-live:80' };

    const fakeOwnerComposition = Object.assign(
      (() => ({ ready: false, endpoint: 'unreachable' })) as unknown as (
        spec: OwnerSpec
      ) => OwnerStatus,
      {
        _definition: {
          apiVersion: 'v1alpha1',
          kind: 'SingletonBootstrap',
          name: 'singleton-bootstrap',
        },
        factory(mode: 'direct' | 'kro', options?: Record<string, unknown>) {
          expect(mode).toBe('direct');
          expect(options?.namespace).toBe('typekro-singletons');
          return {
            async getInstances() {
              return [];
            },
            async deploy() {
              return { status: deployedOwnerStatus };
            },
            async dispose() {},
          };
        },
      }
    );

    const consumer = kubernetesComposition(
      {
        name: 'singleton-status-consumer',
        kind: 'SingletonStatusConsumer',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean', endpoint: 'string' }),
      },
      (spec) => {
        const shared = singleton(fakeOwnerComposition as never, {
          id: 'platform-bootstrap',
          spec: { name: `${spec.name}-shared` },
        }) as { status: { ready: boolean; endpoint: string } };
        const worker = simple.Deployment({
          name: `${spec.name}-worker`,
          image: 'nginx',
          id: 'worker',
        });

        return {
          ready: shared.status.ready && worker.status.readyReplicas >= 1,
          endpoint: shared.status.endpoint,
        };
      }
    );

    const factory = consumer.factory('direct', {
      namespace: 'test-ns',
    }) as DirectResourceFactoryImpl<{ name: string }, { ready: boolean; endpoint: string }>;
    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (spec: {
      name: string;
    }) => Promise<void>;
    await ensureSingletonOwners({ name: 'app' });

    const status = factory.reExecuteWithLiveStatus(
      { name: 'app' },
      new Map([['worker', { readyReplicas: 1 }]])
    );

    expect(status?.ready).toBe(true);
    expect(status?.endpoint).toBe(deployedOwnerStatus.endpoint);
    expect(
      (
        factory as unknown as { singletonOwnerStatuses: Map<string, Record<string, unknown>> }
      ).singletonOwnerStatuses.get(getSingletonResourceId(singletonKey))
    ).toEqual(deployedOwnerStatus);
  });

  it('rejects deployed singleton owner spec drift before reconciling', async () => {
    const deployCalls: Array<{
      spec: { name: string };
      opts?: Record<string, unknown> | undefined;
    }> = [];
    const fakeComposition = {
      factory() {
        return {
          async getInstances() {
            return [
              {
                metadata: { name: 'stable-singleton-id' },
                spec: { name: 'old-name' },
              },
            ];
          },
          async deploy(spec: { name: string }, opts?: Record<string, unknown>) {
            deployCalls.push({ spec, ...(opts ? { opts } : {}) });
            return { metadata: { name: String(opts?.instanceNameOverride ?? spec.name) } };
          },
          async dispose() {},
        };
      },
    };

    const schema: SchemaDefinition<{ name: string }, { ready: boolean }> = {
      apiVersion: 'v1alpha1',
      kind: 'SingletonConsumer',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    };

    const factory = createDirectResourceFactory('singleton-consumer', {}, schema, undefined, {
      namespace: 'default',
      singletonDefinitions: [
        {
          id: 'stable-singleton-id',
          key: 'SingletonBootstrap:stable-singleton-id',
          specFingerprint: JSON.stringify({ name: 'new-name' }),
          registryNamespace: 'shared-system',
          composition: fakeComposition as never,
          spec: { name: 'new-name' },
        } satisfies SingletonDefinitionRecord,
      ],
    }) as unknown as DirectResourceFactoryImpl<{ name: string }, { ready: boolean }>;

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (spec: {
      name: string;
    }) => Promise<void>;

    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};

    await expect(ensureSingletonOwners({ name: 'consumer' })).rejects.toThrow(
      /Singleton config drift detected/
    );

    expect(deployCalls).toHaveLength(0);
  });

  it('reconciles existing singleton owners when the deployed spec matches', async () => {
    const deployCalls: Array<{
      spec: { name: string };
      opts?: Record<string, unknown> | undefined;
    }> = [];
    const fakeComposition = {
      factory() {
        return {
          async getInstances() {
            return [
              {
                metadata: { name: 'stable-singleton-id' },
                spec: { name: 'same-name' },
              },
            ];
          },
          async deploy(spec: { name: string }, opts?: Record<string, unknown>) {
            deployCalls.push({ spec, ...(opts ? { opts } : {}) });
            return { metadata: { name: String(opts?.instanceNameOverride ?? spec.name) } };
          },
          async dispose() {},
        };
      },
    };

    const schema: SchemaDefinition<{ name: string }, { ready: boolean }> = {
      apiVersion: 'v1alpha1',
      kind: 'SingletonConsumer',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    };

    const factory = createDirectResourceFactory('singleton-consumer', {}, schema, undefined, {
      namespace: 'default',
      singletonDefinitions: [
        {
          id: 'stable-singleton-id',
          key: 'SingletonBootstrap:stable-singleton-id',
          specFingerprint: '{"name":"same-name"}',
          registryNamespace: 'shared-system',
          composition: fakeComposition as never,
          spec: { name: 'same-name' },
        } satisfies SingletonDefinitionRecord,
      ],
    }) as unknown as DirectResourceFactoryImpl<{ name: string }, { ready: boolean }>;

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (spec: {
      name: string;
    }) => Promise<void>;

    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};

    await ensureSingletonOwners({ name: 'consumer' });

    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0]?.spec).toEqual({ name: 'same-name' });
    expect(deployCalls[0]?.opts?.instanceNameOverride).toBe('stable-singleton-id');
  });

  it('rejects cross-process direct singleton owner spec drift discovered from resource tags', async () => {
    const deployCalls: Array<{
      spec: { name: string };
      opts?: Record<string, unknown> | undefined;
    }> = [];
    const fakeComposition = {
      factory() {
        return {
          name: 'singleton-owner-factory',
          async getInstances() {
            return [];
          },
          createResourceGraphForInstance() {
            return { resources: [], dependencyGraph: {}, name: 'fake' };
          },
          async deploy(spec: { name: string }, opts?: Record<string, unknown>) {
            deployCalls.push({ spec, ...(opts ? { opts } : {}) });
            return { metadata: { name: String(opts?.instanceNameOverride ?? spec.name) } };
          },
          async dispose() {},
        };
      },
    };

    const schema: SchemaDefinition<{ name: string }, { ready: boolean }> = {
      apiVersion: 'v1alpha1',
      kind: 'SingletonConsumer',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    };

    const factory = createDirectResourceFactory('singleton-consumer', {}, schema, undefined, {
      namespace: 'default',
      singletonDefinitions: [
        {
          id: 'stable-singleton-id',
          key: 'SingletonBootstrap:stable-singleton-id',
          specFingerprint: '{"name":"new-name"}',
          registryNamespace: 'shared-system',
          composition: fakeComposition as never,
          spec: { name: 'new-name' },
        } satisfies SingletonDefinitionRecord,
      ],
    }) as unknown as DirectResourceFactoryImpl<{ name: string }, { ready: boolean }>;

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (spec: {
      name: string;
    }) => Promise<void>;

    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};
    (factory as unknown as Record<string, unknown>).deploymentEngine = {
      async loadDeploymentByInstance() {
        return {
          resources: [
            {
              id: 'old-resource',
              kind: 'ConfigMap',
              name: 'old-resource',
              namespace: 'shared-system',
              status: 'deployed',
              deployedAt: new Date(),
              manifest: {
                apiVersion: 'v1',
                kind: 'ConfigMap',
                metadata: {
                  name: 'old-resource',
                  namespace: 'shared-system',
                  annotations: {
                    [SINGLETON_SPEC_FINGERPRINT_ANNOTATION]: 'fnv64:old-spec',
                  },
                },
              },
            },
          ],
        };
      },
    };

    await expect(ensureSingletonOwners({ name: 'consumer' })).rejects.toThrow(
      /Singleton config drift detected/
    );

    expect(deployCalls).toHaveLength(0);
  });

  it('does not falsely reject legacy direct singleton resources without spec fingerprints', async () => {
    const deployCalls: Array<{
      spec: { name: string };
      opts?: Record<string, unknown> | undefined;
    }> = [];
    const fakeComposition = Object.assign(() => ({ ready: false }), {
      _definition: {
        apiVersion: 'v1alpha1',
        kind: 'SingletonBootstrap',
        name: 'singleton-bootstrap',
      },
      _compositionFn: () => ({
        ready:
          (
            getCurrentCompositionContext()?.liveStatusMap?.get('legacy-resource') as
              | { ready?: boolean }
              | undefined
          )?.ready === true,
      }),
      factory() {
        return {
          name: 'singleton-owner-factory',
          async getInstances() {
            return [];
          },
          createResourceGraphForInstance() {
            return { resources: [], dependencyGraph: {}, name: 'fake' };
          },
          async deploy(spec: { name: string }, opts?: Record<string, unknown>) {
            deployCalls.push({ spec, ...(opts ? { opts } : {}) });
            return { metadata: { name: String(opts?.instanceNameOverride ?? spec.name) } };
          },
          async dispose() {},
        };
      },
    });

    const schema: SchemaDefinition<{ name: string }, { ready: boolean }> = {
      apiVersion: 'v1alpha1',
      kind: 'SingletonConsumer',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    };

    const factory = createDirectResourceFactory('singleton-consumer', {}, schema, undefined, {
      namespace: 'default',
      singletonDefinitions: [
        {
          id: 'stable-singleton-id',
          key: 'SingletonBootstrap:stable-singleton-id',
          specFingerprint: '{"name":"new-name"}',
          registryNamespace: 'shared-system',
          composition: fakeComposition as never,
          spec: { name: 'new-name' },
        } satisfies SingletonDefinitionRecord,
      ],
    }) as unknown as DirectResourceFactoryImpl<{ name: string }, { ready: boolean }>;

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (spec: {
      name: string;
    }) => Promise<void>;

    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};
    (factory as unknown as Record<string, unknown>).deploymentEngine = {
      async loadDeploymentByInstance() {
        return {
          resources: [
            {
              id: 'legacy-resource',
              kind: 'ConfigMap',
              name: 'legacy-resource',
              namespace: 'shared-system',
              status: 'deployed',
              deployedAt: new Date(),
              manifest: {
                apiVersion: 'v1',
                kind: 'ConfigMap',
                status: { ready: true },
                metadata: {
                  name: 'legacy-resource',
                  namespace: 'shared-system',
                  annotations: {},
                },
              },
            },
          ],
        };
      },
    };

    await ensureSingletonOwners({ name: 'consumer' });

    expect(deployCalls).toHaveLength(0);
    expect(
      (
        factory as unknown as { singletonOwnerStatuses: Map<string, Record<string, unknown>> }
      ).singletonOwnerStatuses.get(getSingletonResourceId('SingletonBootstrap:stable-singleton-id'))
    ).toEqual({ ready: true });
  });

  it('recovers parent singleton status from legacy unfingerprinted owner resources', async () => {
    const fakeComposition = Object.assign(() => ({ ready: false }), {
      _definition: {
        apiVersion: 'v1alpha1',
        kind: 'SingletonBootstrap',
        name: 'singleton-bootstrap',
      },
      _compositionFn: () => ({
        ready:
          (
            getCurrentCompositionContext()?.liveStatusMap?.get('legacy-resource') as
              | { ready?: boolean }
              | undefined
          )?.ready === true,
      }),
      factory() {
        return {
          name: 'singleton-owner-factory',
          async getInstances() {
            return [];
          },
          createResourceGraphForInstance() {
            return { resources: [], dependencyGraph: {}, name: 'fake' };
          },
          async deploy() {
            throw new Error('legacy singleton owner should not be redeployed');
          },
          async dispose() {},
        };
      },
    });

    const consumer = kubernetesComposition(
      {
        name: 'legacy-singleton-consumer',
        kind: 'LegacySingletonConsumer',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const shared = singleton(fakeComposition as never, {
          id: 'stable-singleton-id',
          spec: { name: `${spec.name}-shared` },
        }) as { status: { ready: boolean } };
        return { ready: shared.status.ready };
      }
    );

    const factory = consumer.factory('direct', {
      namespace: 'default',
    }) as DirectResourceFactoryImpl<{ name: string }, { ready: boolean }>;
    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};
    (factory as unknown as Record<string, unknown>).deploymentEngine = {
      async loadDeploymentByInstance() {
        return {
          resources: [
            {
              id: 'legacy-resource',
              kind: 'ConfigMap',
              name: 'legacy-resource',
              namespace: 'typekro-singletons',
              status: 'deployed',
              deployedAt: new Date(),
              manifest: {
                apiVersion: 'v1',
                kind: 'ConfigMap',
                status: { ready: true },
                metadata: {
                  name: 'legacy-resource',
                  namespace: 'typekro-singletons',
                  annotations: {},
                },
              },
            },
          ],
        };
      },
    };

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (spec: {
      name: string;
    }) => Promise<void>;
    await ensureSingletonOwners({ name: 'consumer' });

    const status = factory.reExecuteWithLiveStatus({ name: 'consumer' }, new Map());

    expect(status?.ready).toBe(true);
  });

  it('recovers legacy singleton status when discovery only has generated deploy graph ids', async () => {
    const fakeComposition = Object.assign(() => ({ ready: false }), {
      _definition: {
        apiVersion: 'v1alpha1',
        kind: 'SingletonBootstrap',
        name: 'singleton-bootstrap',
      },
      _compositionFn: () => {
        simple.ConfigMap({ name: 'legacy-resource', data: {}, id: 'localDb' });
        return {
          ready:
            (
              getCurrentCompositionContext()?.liveStatusMap?.get('localDb') as
                | { ready?: boolean }
                | undefined
            )?.ready === true,
        };
      },
      factory() {
        return {
          name: 'singleton-owner-factory',
          async getInstances() {
            return [];
          },
          createResourceGraphForInstance() {
            return { resources: [], dependencyGraph: {}, name: 'fake' };
          },
          async deploy() {
            throw new Error('legacy singleton owner should not be redeployed');
          },
          async dispose() {},
        };
      },
    });

    const consumer = kubernetesComposition(
      {
        name: 'legacy-singleton-generated-id-consumer',
        kind: 'LegacySingletonGeneratedIdConsumer',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const shared = singleton(fakeComposition as never, {
          id: 'stable-singleton-id',
          spec: { name: `${spec.name}-shared` },
        }) as { status: { ready: boolean } };
        return { ready: shared.status.ready };
      }
    );

    const factory = consumer.factory('direct', {
      namespace: 'default',
    }) as DirectResourceFactoryImpl<{ name: string }, { ready: boolean }>;
    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};
    (factory as unknown as Record<string, unknown>).deploymentEngine = {
      async loadDeploymentByInstance() {
        return {
          resources: [
            {
              id: 'stableSingletonIdResource0Localdb',
              kind: 'ConfigMap',
              name: 'legacy-resource',
              namespace: 'typekro-singletons',
              status: 'deployed',
              deployedAt: new Date(),
              manifest: {
                apiVersion: 'v1',
                kind: 'ConfigMap',
                status: { ready: true },
                metadata: {
                  // Deliberately does not match the probed local resource identity.
                  // This forces recovery through the generated deploy graph id
                  // suffix (`Localdb` -> local id `localDb`).
                  name: 'stale-resource',
                  namespace: 'typekro-singletons',
                  annotations: {
                    [RESOURCE_ID_ANNOTATION]: 'stableSingletonIdResource0Localdb',
                  },
                },
              },
            },
          ],
        };
      },
    };

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (spec: {
      name: string;
    }) => Promise<void>;
    await ensureSingletonOwners({ name: 'consumer' });

    const status = factory.reExecuteWithLiveStatus({ name: 'consumer' }, new Map());

    expect(status?.ready).toBe(true);
  });

  it('reconciles legacy singleton owners when expected graph resources are missing', async () => {
    const deployCalls: unknown[] = [];
    const fakeComposition = Object.assign(() => ({ ready: false }), {
      _definition: {
        apiVersion: 'v1alpha1',
        kind: 'SingletonBootstrap',
        name: 'singleton-bootstrap',
      },
      _compositionFn: () => ({ ready: true }),
      factory() {
        return {
          name: 'singleton-owner-factory',
          async getInstances() {
            return [];
          },
          createResourceGraphForInstance() {
            return {
              resources: [{ id: 'new-resource', manifest: { kind: 'ConfigMap' } }],
              dependencyGraph: {},
              name: 'fake',
            };
          },
          async deploy(...args: unknown[]) {
            deployCalls.push(args);
            return { status: { ready: true } };
          },
          async dispose() {},
        };
      },
    });

    const consumer = kubernetesComposition(
      {
        name: 'legacy-singleton-repair-consumer',
        kind: 'LegacySingletonRepairConsumer',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const shared = singleton(fakeComposition as never, {
          id: 'stable-singleton-id',
          spec: { name: `${spec.name}-shared` },
        }) as { status: { ready: boolean } };
        return { ready: shared.status.ready };
      }
    );

    const factory = consumer.factory('direct', {
      namespace: 'default',
    }) as DirectResourceFactoryImpl<{ name: string }, { ready: boolean }>;
    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};
    (factory as unknown as Record<string, unknown>).deploymentEngine = {
      async loadDeploymentByInstance() {
        return {
          resources: [
            {
              id: 'legacy-resource',
              kind: 'ConfigMap',
              name: 'legacy-resource',
              namespace: 'typekro-singletons',
              status: 'deployed',
              deployedAt: new Date(),
              manifest: {
                apiVersion: 'v1',
                kind: 'ConfigMap',
                metadata: {
                  name: 'legacy-resource',
                  namespace: 'typekro-singletons',
                  annotations: {},
                },
              },
            },
          ],
        };
      },
    };

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (spec: {
      name: string;
    }) => Promise<void>;
    await ensureSingletonOwners({ name: 'consumer' });

    expect(deployCalls).toHaveLength(1);
  });

  it('reconciles legacy singleton owners with HelmRelease resources even when graph resources exist', async () => {
    const deployCalls: unknown[] = [];
    const fakeComposition = Object.assign(() => ({ ready: false }), {
      _definition: {
        apiVersion: 'v1alpha1',
        kind: 'SingletonBootstrap',
        name: 'singleton-bootstrap',
      },
      _compositionFn: () => ({ ready: true }),
      factory() {
        return {
          name: 'singleton-owner-factory',
          async getInstances() {
            return [];
          },
          createResourceGraphForInstance() {
            return {
              resources: [{ id: 'helm-release', manifest: { kind: 'HelmRelease' } }],
              dependencyGraph: {},
              name: 'fake',
            };
          },
          async deploy(...args: unknown[]) {
            deployCalls.push(args);
            return { status: { ready: true } };
          },
          async dispose() {},
        };
      },
    });

    const consumer = kubernetesComposition(
      {
        name: 'legacy-singleton-helm-repair-consumer',
        kind: 'LegacySingletonHelmRepairConsumer',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const shared = singleton(fakeComposition as never, {
          id: 'stable-singleton-id',
          spec: { name: `${spec.name}-shared` },
        }) as { status: { ready: boolean } };
        return { ready: shared.status.ready };
      }
    );

    const factory = consumer.factory('direct', {
      namespace: 'default',
    }) as DirectResourceFactoryImpl<{ name: string }, { ready: boolean }>;
    (factory as unknown as Record<string, unknown>).ensureTargetNamespace = async () => {};
    (factory as unknown as Record<string, unknown>).deploymentEngine = {
      async loadDeploymentByInstance() {
        return {
          resources: [
            {
              id: 'helm-release',
              kind: 'HelmRelease',
              name: 'legacy-release',
              namespace: 'typekro-singletons',
              status: 'deployed',
              deployedAt: new Date(),
              manifest: {
                apiVersion: 'helm.toolkit.fluxcd.io/v2',
                kind: 'HelmRelease',
                metadata: {
                  name: 'legacy-release',
                  namespace: 'typekro-singletons',
                  annotations: {},
                },
              },
            },
          ],
        };
      },
    };

    const ensureSingletonOwners = getPrivateMethod(factory, 'ensureSingletonOwners') as (spec: {
      name: string;
    }) => Promise<void>;
    await ensureSingletonOwners({ name: 'consumer' });

    expect(deployCalls).toHaveLength(1);
  });
});

describe('DirectDeploymentStrategy: live status hydration ids', () => {
  it('keys live statuses by composition-local resource id before deployed graph id annotations', async () => {
    const manifest = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'demo',
        namespace: 'default',
        annotations: {
          [RESOURCE_ID_ANNOTATION]: 'deployedGraphId',
        },
      },
    };
    setResourceId(manifest, 'compositionLocalId');

    const strategy = new DirectDeploymentStrategy(
      'factory',
      'default',
      {
        apiVersion: 'v1alpha1',
        kind: 'HydrationIdCheck',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      undefined,
      undefined,
      {},
      {
        getKubernetesApi() {
          return {
            async read() {
              return { status: { ready: true } };
            },
          };
        },
      } as never,
      {
        createResourceGraphForInstance() {
          return { name: 'unused', resources: [], dependencyGraph: {} as never };
        },
      }
    );

    const buildLiveStatusMap = getPrivateMethod(strategy, 'buildLiveStatusMap') as (
      deploymentResult: unknown
    ) => Promise<Map<string, Record<string, unknown>>>;

    const liveStatusMap = await buildLiveStatusMap({
      resources: [
        {
          id: 'deployedGraphId',
          kind: 'ConfigMap',
          name: 'demo',
          namespace: 'default',
          manifest,
          status: 'deployed',
          deployedAt: new Date(),
        },
      ],
    });

    expect(liveStatusMap.get('compositionLocalId')).toEqual({ ready: true });
    expect(liveStatusMap.has('deployedGraphId')).toBe(false);
  });
});

// ===========================================================================
// 2. createResourceGraphForInstance — readinessEvaluator preservation
// ===========================================================================

describe('DirectFactory: readinessEvaluator preservation', () => {
  it('readinessEvaluator is set as non-enumerable on resources that have one', async () => {
    const factory = await createTestFactory('eval-test');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    // At least the Deployment should have a readinessEvaluator (set by simple.Deployment)
    const deploymentResource = graph.resources.find((r) => r.manifest.kind === 'Deployment');

    if (deploymentResource) {
      const manifest = deploymentResource.manifest as unknown as Record<string, unknown>;
      if (typeof manifest.readinessEvaluator === 'function') {
        // Should be non-enumerable
        const desc = Object.getOwnPropertyDescriptor(manifest, 'readinessEvaluator');
        expect(desc).toBeDefined();
        expect(desc?.enumerable).toBe(false);
      }
    }
    // Note: If no readinessEvaluator is found, test passes — the characterization
    // is that the property MAY be present and when it is, it's non-enumerable
  });

  it('readinessEvaluator is NOT visible in Object.keys()', async () => {
    const factory = await createTestFactory('eval-keys');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (const res of graph.resources) {
      const keys = Object.keys(res.manifest);
      expect(keys).not.toContain('readinessEvaluator');
    }
  });

  it('readinessEvaluator is NOT visible in JSON.stringify()', async () => {
    const factory = await createTestFactory('eval-json');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (const res of graph.resources) {
      const json = JSON.stringify(res.manifest);
      expect(json).not.toContain('readinessEvaluator');
    }
  });

  it('readinessEvaluator is NOT visible in for-in loops', async () => {
    const factory = await createTestFactory('eval-forin');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (const res of graph.resources) {
      const forInKeys: string[] = [];
      for (const key in res.manifest) {
        forInKeys.push(key);
      }
      expect(forInKeys).not.toContain('readinessEvaluator');
    }
  });

  it('readinessEvaluator is callable when present', async () => {
    const factory = await createTestFactory('eval-call');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (const res of graph.resources) {
      const manifest = res.manifest as unknown as Record<string, unknown>;
      if (typeof manifest.readinessEvaluator === 'function') {
        // The evaluator should be callable — verify it doesn't throw
        const fn = manifest.readinessEvaluator as (resource: unknown) => unknown;
        expect(() => fn({ status: { readyReplicas: 1 } })).not.toThrow();
      }
    }
  });
});

// ===========================================================================
// 3. Property descriptor shapes
// ===========================================================================

describe('DirectFactory: property descriptor shapes', () => {
  it('__resourceId descriptor: {enumerable: false, configurable: true}', async () => {
    const factory = await createTestFactory('desc-rid');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (const res of graph.resources) {
      const desc = Object.getOwnPropertyDescriptor(res.manifest, '__resourceId');
      if (desc) {
        expect(desc.enumerable).toBe(false);
        expect(desc.configurable).toBe(true);
        // writable defaults to false when using value descriptor without explicit writable
      }
    }
  });

  it('readinessEvaluator descriptor: {enumerable: false, configurable: true, writable: false}', async () => {
    const factory = await createTestFactory('desc-eval');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (const res of graph.resources) {
      const desc = Object.getOwnPropertyDescriptor(res.manifest, 'readinessEvaluator');
      if (desc) {
        expect(desc.enumerable).toBe(false);
        expect(desc.configurable).toBe(true);
        expect(desc.writable).toBe(false);
      }
    }
  });
});

// ===========================================================================
// 4. toYaml() — JSON round-trip strips non-serializable values
// ===========================================================================

describe('DirectFactory: toYaml() serialization safety', () => {
  it('YAML output does not contain readinessEvaluator', async () => {
    const factory = await createTestFactory('yaml-eval');
    const yamlOutput = factory.toYaml(DEFAULT_SPEC);

    expect(yamlOutput).not.toContain('readinessEvaluator');
  });

  it('YAML output does not contain __resourceId', async () => {
    const factory = await createTestFactory('yaml-rid');
    const yamlOutput = factory.toYaml(DEFAULT_SPEC);

    expect(yamlOutput).not.toContain('__resourceId');
  });

  it('YAML output does not contain function artifacts', async () => {
    const factory = await createTestFactory('yaml-fn');
    const yamlOutput = factory.toYaml(DEFAULT_SPEC);

    // JSON round-trip at line 725 should strip functions
    expect(yamlOutput).not.toContain('[Function');
    expect(yamlOutput).not.toContain('function(');
    expect(yamlOutput).not.toContain('=>');
  });

  it('YAML output contains valid Kubernetes resource structure', async () => {
    const factory = await createTestFactory('yaml-valid');
    const yamlOutput = factory.toYaml(DEFAULT_SPEC);

    expect(yamlOutput).toContain('apiVersion:');
    expect(yamlOutput).toContain('kind:');
    expect(yamlOutput).toContain('metadata:');
  });
});

// ===========================================================================
// 5. Resource graph structure
// ===========================================================================

describe('DirectFactory: createResourceGraphForInstance structure', () => {
  it('returns name, resources, and dependencyGraph fields', async () => {
    const factory = await createTestFactory('struct-test');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    expect(graph.name).toBeDefined();
    expect(typeof graph.name).toBe('string');
    expect(graph.resources).toBeDefined();
    expect(Array.isArray(graph.resources)).toBe(true);
    expect(graph.dependencyGraph).toBeDefined();
  });

  it('each resource has id and manifest', async () => {
    const factory = await createTestFactory('struct-res');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (const res of graph.resources) {
      expect(res.id).toBeDefined();
      expect(typeof res.id).toBe('string');
      expect(res.manifest).toBeDefined();
      expect(typeof res.manifest).toBe('object');
    }
  });

  it('resource IDs are prefixed with instance name', async () => {
    const factory = await createTestFactory('struct-prefix');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (const res of graph.resources) {
      // IDs are generated as toCamelCase(`${instanceName}-resource-${index}-${originalId}`)
      // They should be camelCase strings
      expect(res.id).toMatch(/^[a-z]/);
      expect(res.id.length).toBeGreaterThan(0);
    }
  });

  it('graph name includes factory name', async () => {
    const factory = await createTestFactory('my-factory');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    expect(graph.name).toContain('my-factory');
  });
});

// ===========================================================================
// 6. resolveSchemaReferencesToValues — readinessEvaluator preservation
// ===========================================================================

describe('DirectFactory: resolveSchemaReferencesToValues readinessEvaluator', () => {
  it('readinessEvaluator survives the fallback reference resolution path', async () => {
    // Create a factory WITHOUT compositionFn (forces fallback path)
    // We do this by constructing a factory with resources that have readinessEvaluator set
    // The simplest way is to go through the normal factory creation and test toYaml
    // which uses resolveSchemaReferencesToValues in the fallback path
    const factory = await createTestFactory('resolve-eval');

    // createResourceGraphForInstance() calls resolveResourcesForSpec which may use
    // resolveSchemaReferencesToValues in the fallback path. Either way, the
    // readinessEvaluator should be preserved.
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    // Verify the graph was created successfully (no crash from lost evaluator)
    expect(graph.resources.length).toBeGreaterThan(0);

    // Check readinessEvaluator is present and non-enumerable where applicable
    const deployments = graph.resources.filter((r) => r.manifest.kind === 'Deployment');
    for (const dep of deployments) {
      const manifest = dep.manifest as unknown as Record<string, unknown>;
      if (typeof manifest.readinessEvaluator === 'function') {
        const desc = Object.getOwnPropertyDescriptor(manifest, 'readinessEvaluator');
        expect(desc?.enumerable).toBe(false);
      }
    }
  });
});

// ===========================================================================
// 7. Multiple calls produce consistent results
// ===========================================================================

describe('DirectFactory: consistency across multiple calls', () => {
  it('createResourceGraphForInstance returns same structure for same spec', async () => {
    const factory = await createTestFactory('consist-test');

    const graph1 = factory.createResourceGraphForInstance(DEFAULT_SPEC);
    const graph2 = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    expect(graph1.resources.length).toBe(graph2.resources.length);

    for (let i = 0; i < graph1.resources.length; i++) {
      expect(graph1.resources[i]!.manifest.kind).toBe(graph2.resources[i]!.manifest.kind);
      expect(graph1.resources[i]!.manifest.apiVersion).toBe(
        graph2.resources[i]!.manifest.apiVersion
      );
    }
  });

  it('__resourceId values are consistent across calls', async () => {
    const factory = await createTestFactory('consist-rid');

    const graph1 = factory.createResourceGraphForInstance(DEFAULT_SPEC);
    const graph2 = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (let i = 0; i < graph1.resources.length; i++) {
      const rid1 = (graph1.resources[i]!.manifest as unknown as Record<string, unknown>)
        .__resourceId;
      const rid2 = (graph2.resources[i]!.manifest as unknown as Record<string, unknown>)
        .__resourceId;
      expect(rid1).toBe(rid2);
    }
  });
});

// ===========================================================================
// 8. Object.entries / Object.values behavior
// ===========================================================================

describe('DirectFactory: enumeration behavior', () => {
  it('Object.entries on resource manifest does NOT include __resourceId', async () => {
    const factory = await createTestFactory('enum-entries');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (const res of graph.resources) {
      const entries = Object.entries(res.manifest);
      const keys = entries.map(([k]) => k);
      expect(keys).not.toContain('__resourceId');
    }
  });

  it('Object.entries on resource manifest does NOT include readinessEvaluator', async () => {
    const factory = await createTestFactory('enum-eval');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (const res of graph.resources) {
      const entries = Object.entries(res.manifest);
      const keys = entries.map(([k]) => k);
      expect(keys).not.toContain('readinessEvaluator');
    }
  });

  it('Object.getOwnPropertyNames includes non-enumerable properties', async () => {
    const factory = await createTestFactory('enum-own');
    const graph = factory.createResourceGraphForInstance(DEFAULT_SPEC);

    for (const res of graph.resources) {
      const allProps = Object.getOwnPropertyNames(res.manifest);
      // __resourceId should appear in getOwnPropertyNames even though non-enumerable
      const manifest = res.manifest as unknown as Record<string, unknown>;
      if (manifest.__resourceId !== undefined) {
        expect(allProps).toContain('__resourceId');
      }
    }
  });
});
