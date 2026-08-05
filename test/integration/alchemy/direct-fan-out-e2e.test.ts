/**
 * E2E (live cluster): the alchemy **v2** direct-mode fan-out.
 *
 * `factory.toAlchemyResources(spec)` emits one declaration per resource; `materializeAlchemyResources`
 * instantiates them as `KroResource`s wiring `dependsOn` → alchemy `Output` dependencies. This proves
 * the whole chain against a real cluster:
 *   - per-resource state granularity (one alchemy resource per Kubernetes resource),
 *   - dependency ORDERING (the ConfigMap deploys only after the Deployment),
 *   - cross-resource REFERENCE RESOLUTION — the ConfigMap reads the Deployment's LIVE
 *     `status.readyReplicas`, which only resolves if the dependency deployed first, its live status
 *     was captured, and the (alchemy-serialized) CEL ref was re-evaluated in the reconcile,
 *   - reverse-topological TEARDOWN.
 *
 * Direct mode needs no KRO operator (it applies plain manifests), so this runs on any cluster
 * (e.g. OrbStack). Skipped automatically when no cluster is reachable.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(900_000);
import { Effect } from 'effect';
import * as Alchemy from 'alchemy';
import * as Test from 'alchemy/Test/Core';
import * as StateMod from 'alchemy/State';
import { type } from 'arktype';
import { Cel, simple, toResourceGraph } from '../../../src/index.js';
import {
  KroResource,
  kroProvider,
  materializeAlchemyResources,
} from '../../../src/alchemy/index.js';
import {
  createAppsV1ApiClient,
  createCoreV1ApiClient,
  createTestNamespace,
  deleteTestNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  type TestNamespaceLease,
  waitForResourceAbsent,
} from '../shared-kubeconfig';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

const NS = `tk-alchemy-fanout-${crypto.randomUUID().slice(0, 8)}`;

const SpecSchema = type({ name: 'string', image: 'string', replicas: 'number%1' });
const StatusSchema = type({ phase: '"pending" | "running" | "failed"', readyReplicas: 'number%1' });
type AppSpec = typeof SpecSchema.infer;

const makeGraph = () =>
  toResourceGraph(
    {
      name: 'fanoutapp',
      apiVersion: 'v1alpha1',
      kind: 'FanoutApp',
      spec: SpecSchema,
      status: StatusSchema,
    },
    (schema) => {
      const deployment = simple.Deployment({
        name: schema.spec.name,
        image: schema.spec.image,
        replicas: schema.spec.replicas,
        id: 'appDeployment',
      });
      return {
        deployment,
        // Reads the Deployment's LIVE status → a genuine cross-resource dependency + reference.
        config: simple.ConfigMap({
          name: Cel.template('%s-cfg', schema.spec.name),
          data: { readyReplicas: Cel.template('%s', deployment.status.readyReplicas) },
          id: 'appConfig',
        }),
      };
    },
    (_schema, resources) => ({
      phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
      readyReplicas: resources.deployment?.status.readyReplicas,
    })
  );

const RetentionSpecSchema = type({ prefix: 'string' });
const makeRetentionGraph = () =>
  toResourceGraph(
    {
      name: 'retentionapp',
      apiVersion: 'v1alpha1',
      kind: 'RetentionApp',
      spec: RetentionSpecSchema,
      status: type({}),
    },
    (schema) => ({
      retained: simple.ConfigMap({
        name: Cel.template('%s-retained', schema.spec.prefix),
        data: { lifecycle: 'retained' },
        id: 'retainedConfig',
      }),
      destroyed: simple.ConfigMap({
        name: Cel.template('%s-destroyed', schema.spec.prefix),
        data: { lifecycle: 'destroyed' },
        id: 'destroyedConfig',
      }),
    }),
    () => ({})
  );

const makeOptions = { providers: kroProvider, state: StateMod.inMemoryState() };
const runDeploy = (s: unknown) =>
  Effect.runPromise(
    Test.toEffect(Test.deploy(makeOptions, s as never) as never, makeOptions as never)
  );
const runDestroy = (s: unknown) =>
  Effect.runPromise(
    Test.toEffect(Test.destroy(makeOptions, s as never) as never, makeOptions as never)
  );

describeOrSkip('Alchemy v2 direct-mode fan-out (e2e)', () => {
  let kubeConfig: ReturnType<typeof getIntegrationTestKubeConfig>;
  let namespaceLease: TestNamespaceLease | undefined;

  beforeAll(async () => {
    if (!clusterAvailable) return;
    kubeConfig = getIntegrationTestKubeConfig();
    namespaceLease = await createTestNamespace(NS, kubeConfig);
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    if (namespaceLease) {
      await deleteTestNamespaceAndWait(namespaceLease, kubeConfig);
    }
  });

  it('deploys per-resource, in dependency order, resolving a cross-resource ref against live state, then tears down', async () => {
    const appsApi = createAppsV1ApiClient(kubeConfig);
    const coreApi = createCoreV1ApiClient(kubeConfig);
    const factory = await makeGraph().factory('direct', {
      namespace: NS,
      waitForReady: true,
      timeout: 120_000,
    });
    const spec: AppSpec = { name: 'fanapp', image: 'nginx:1.27-alpine', replicas: 1 };

    // Fan-out: one declaration per resource, topologically ordered, ConfigMap dependsOn Deployment.
    const decls = await factory.toAlchemyResources(spec);
    expect(decls.length).toBe(2);
    const deploymentDecl = decls.find((d) => d.props.resourceId === 'appDeployment');
    const configDecl = decls.find((d) => d.props.resourceId === 'appConfig');
    expect(deploymentDecl).toBeDefined();
    expect(configDecl).toBeDefined();
    expect(configDecl?.dependsOn).toContain(deploymentDecl?.id);
    expect(decls.indexOf(deploymentDecl!)).toBeLessThan(decls.indexOf(configDecl!));

    const stack = Alchemy.Stack(
      'tk-alchemy-fanout-e2e',
      makeOptions as never,
      materializeAlchemyResources(KroResource, decls) as never
    );

    try {
      await runDeploy(stack);

      // Both resources landed.
      const deployment = await appsApi.readNamespacedDeployment({
        namespace: NS,
        name: 'fanapp',
      });
      expect(deployment.metadata?.name).toBe('fanapp');
      // The ConfigMap carries the Deployment's resolved LIVE readyReplicas (not the literal CEL string).
      const config = await coreApi.readNamespacedConfigMap({
        namespace: NS,
        name: 'fanapp-cfg',
      });
      const deployReady = deployment.status?.readyReplicas;
      const cfgValue = config.data?.readyReplicas;
      expect(deployReady).toBe(1);
      expect(cfgValue).toBe('1');
      expect(cfgValue).not.toContain('${');
    } finally {
      await runDestroy(stack);
    }

    // Reverse-topo teardown removed our resources.
    await Promise.all([
      waitForResourceAbsent(
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { namespace: NS, name: 'fanapp' },
        },
        kubeConfig
      ),
      waitForResourceAbsent(
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { namespace: NS, name: 'fanapp-cfg' },
        },
        kubeConfig
      ),
    ]);
  }, 180_000);

  it('honors declaration retention through Alchemy destroy', async () => {
    const coreApi = createCoreV1ApiClient(kubeConfig);
    const prefix = `retain-${crypto.randomUUID().slice(0, 8)}`;
    const retainedName = `${prefix}-retained`;
    const destroyedName = `${prefix}-destroyed`;
    const factory = await makeRetentionGraph().factory('direct', {
      namespace: NS,
      waitForReady: true,
      timeout: 120_000,
    });
    const declarations = await factory.toAlchemyResources({ prefix });
    const retained = declarations.find(
      (declaration) => declaration.props.resourceId === 'retainedConfig'
    );
    expect(retained).toBeDefined();
    retained!.props.retain = true;

    const stack = Alchemy.Stack(
      `tk-alchemy-retention-${prefix}`,
      makeOptions as never,
      materializeAlchemyResources(KroResource, declarations) as never
    );

    try {
      await runDeploy(stack);
      await runDestroy(stack);

      await waitForResourceAbsent(
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { namespace: NS, name: destroyedName },
        },
        kubeConfig
      );
      const liveRetained = await coreApi.readNamespacedConfigMap({
        namespace: NS,
        name: retainedName,
      });
      expect(liveRetained.data?.lifecycle).toBe('retained');
    } finally {
      await coreApi
        .deleteNamespacedConfigMap({ namespace: NS, name: retainedName })
        .catch(() => undefined);
      await waitForResourceAbsent(
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { namespace: NS, name: retainedName },
        },
        kubeConfig
      );
    }
  }, 180_000);
});
