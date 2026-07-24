import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import * as Alchemy from 'alchemy';
import * as StateMod from 'alchemy/State';
import * as Test from 'alchemy/Test/Core';
import { type } from 'arktype';
import { Effect } from 'effect';
import {
  KroResource,
  kroProvider,
  materializeAlchemyResources,
} from '../../../src/alchemy/index.js';
import type { AlchemyResourceDeclaration } from '../../../src/alchemy/types.js';
import { simple, toResourceGraph } from '../../../src/index.js';
import {
  createKubernetesObjectApiClient,
  createTestNamespace,
  deleteGeneratedCrdAndWait,
  deleteTestNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  isNotFoundError,
  type TestNamespaceLease,
  waitForResourceAbsent,
} from '../shared-kubeconfig.js';

const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;
const runToken = Math.random().toString(36).slice(2, 8);
const namespace = `typekro-alchemy-kro-${runToken}`;
const group = `alchemy-${runToken}.typekro.dev`;
const kind = `AlchemyKroUpgrade${runToken}`;
const rgdName = `alchemy-kro-upgrade-${runToken}`;
const instanceName = `upgrade-${runToken}`;
const schemaGroup = `alchemy-schema-${runToken}.typekro.dev`;
const schemaKind = `AlchemySchemaUpgrade${runToken}`;
const schemaRgdName = `alchemy-schema-upgrade-${runToken}`;
const schemaInstanceName = `schema-upgrade-${runToken}`;

const persistedState: Record<string, Record<string, Record<string, unknown>>> = {};
const makeOptions = {
  providers: kroProvider,
  state: StateMod.inMemoryState(persistedState as never),
};

const runDeploy = (stack: unknown) =>
  Effect.runPromise(
    Test.toEffect(Test.deploy(makeOptions, stack as never) as never, makeOptions as never)
  );
const runDestroy = (stack: unknown) =>
  Effect.runPromise(
    Test.toEffect(Test.destroy(makeOptions, stack as never) as never, makeOptions as never)
  );

setDefaultTimeout(600_000);

function graph() {
  return toResourceGraph(
    {
      name: rgdName,
      apiVersion: `${group}/v1alpha1`,
      kind,
      revision: '1',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    (schema) => ({
      config: simple.ConfigMap({
        id: 'config',
        name: schema.spec.name,
        namespace,
        data: { generation: 'canonical-bundle' },
      }),
    }),
    () => ({ ready: true })
  );
}

function originalSchemaGraph() {
  return toResourceGraph(
    {
      name: schemaRgdName,
      apiVersion: `${schemaGroup}/v1alpha1`,
      kind: schemaKind,
      revision: '1',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    (schema) => ({
      config: simple.ConfigMap({
        id: 'config',
        name: schema.spec.name,
        namespace,
        data: { nested: 'not-yet-declared' },
      }),
    }),
    () => ({ ready: true })
  );
}

function upgradedSchemaGraph() {
  return toResourceGraph(
    {
      name: schemaRgdName,
      apiVersion: `${schemaGroup}/v1alpha1`,
      kind: schemaKind,
      revision: '2',
      spec: type({
        name: 'string',
        settings: {
          nested: 'string',
        },
      }),
      status: type({ ready: 'boolean' }),
    },
    (schema) => ({
      config: simple.ConfigMap({
        id: 'config',
        name: schema.spec.name,
        namespace,
        data: { nested: schema.spec.settings.nested },
      }),
    }),
    () => ({ ready: true })
  );
}

function withoutCanonicalBundle(
  declarations: readonly AlchemyResourceDeclaration[]
): AlchemyResourceDeclaration[] {
  return declarations.map((declaration) => {
    const {
      kroArtifactBundle: _bundle,
      kroArtifactOperationId: _operation,
      ...legacyProps
    } = declaration.props;
    return { ...declaration, props: legacyProps };
  });
}

describeOrSkip('Alchemy KRO persisted-state upgrade (e2e)', () => {
  const activeStacks = new Set<unknown>();
  let namespaceLease: TestNamespaceLease | undefined;

  const destroyActiveStacks = async () => {
    const results = await Promise.allSettled(
      [...activeStacks].map(async (stack) => {
        await runDestroy(stack);
        activeStacks.delete(stack);
      })
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to destroy Alchemy KRO upgrade stacks');
    }
  };

  beforeAll(async () => {
    if (!clusterAvailable) return;
    namespaceLease = await createTestNamespace(namespace);
  });

  afterEach(async () => {
    if (!clusterAvailable) return;
    await destroyActiveStacks();
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    await destroyActiveStacks();

    const kubeConfig = getIntegrationTestKubeConfig();
    const objectApi = createKubernetesObjectApiClient(kubeConfig);
    const definitions = [
      {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'ResourceGraphDefinition',
        metadata: { name: rgdName },
      },
      {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'ResourceGraphDefinition',
        metadata: { name: schemaRgdName },
      },
    ];
    const cleanupErrors: unknown[] = [];
    for (const definition of definitions) {
      await objectApi.delete(definition).catch((error: unknown) => {
        if (!isNotFoundError(error)) cleanupErrors.push(error);
      });
      await waitForResourceAbsent(definition, kubeConfig, 60_000).catch((error) =>
        cleanupErrors.push(error)
      );
    }

    const crds = await objectApi
      .list('apiextensions.k8s.io/v1', 'CustomResourceDefinition')
      .catch((error) => {
        cleanupErrors.push(error);
        return { items: [] };
      });
    for (const crd of crds.items) {
      const crdGroup = (crd as { spec?: { group?: string } }).spec?.group;
      if (crdGroup !== group && crdGroup !== schemaGroup) continue;
      const crdName = crd.metadata?.name;
      if (!crdName) {
        cleanupErrors.push(new Error(`Generated CRD for ${crdGroup} has no metadata.name`));
        continue;
      }
      const instanceApiVersion =
        crdGroup === group ? `${group}/v1alpha1` : `${schemaGroup}/v1alpha1`;
      const instanceKind = crdGroup === group ? kind : schemaKind;
      await deleteGeneratedCrdAndWait(
        {
          apiVersion: 'apiextensions.k8s.io/v1',
          kind: 'CustomResourceDefinition',
          metadata: { name: crdName },
        },
        instanceApiVersion,
        instanceKind,
        kubeConfig
      ).catch((error) => cleanupErrors.push(error));
    }
    if (namespaceLease) {
      await deleteTestNamespaceAndWait(namespaceLease, kubeConfig).catch((error) =>
        cleanupErrors.push(error)
      );
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to clean up Alchemy KRO upgrade resources');
    }
  });

  it('upgrades legacy JSON-only KRO state to canonical bundle state through the provider host', async () => {
    const factory = graph().factory('kro', {
      namespace,
      timeout: 180_000,
      waitForReady: true,
    });
    const declarations = await factory.toAlchemyResources({ name: instanceName });
    const legacyDeclarations = withoutCanonicalBundle(declarations);
    const legacyStack = Alchemy.Stack(
      'typekro-alchemy-kro-upgrade',
      makeOptions as never,
      materializeAlchemyResources(KroResource, legacyDeclarations) as never
    );
    const modernStack = Alchemy.Stack(
      'typekro-alchemy-kro-upgrade',
      makeOptions as never,
      materializeAlchemyResources(KroResource, declarations) as never
    );

    try {
      await runDeploy(legacyStack);
      activeStacks.add(legacyStack);
      expect(JSON.stringify(persistedState)).not.toContain('kroArtifactBundle');

      await runDeploy(modernStack);
      activeStacks.delete(legacyStack);
      activeStacks.add(modernStack);
      const encodedState = JSON.stringify(persistedState);
      expect(encodedState).toContain('kroArtifactBundle');
      expect(encodedState).toContain('kroArtifactOperationId');

      const objectApi = createKubernetesObjectApiClient();
      const config = (await objectApi.read({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: instanceName, namespace },
      })) as { data?: Record<string, string> };
      expect(config.data?.generation).toBe('canonical-bundle');
    } finally {
      await destroyActiveStacks();
    }
  }, 300_000);

  it('waits for an upgraded RGD schema before materializing a newly nested instance field', async () => {
    const originalDeclarations = await originalSchemaGraph()
      .factory('kro', {
        namespace,
        timeout: 180_000,
        waitForReady: true,
      })
      .toAlchemyResources({ name: schemaInstanceName });
    const upgradedDeclarations = await upgradedSchemaGraph()
      .factory('kro', {
        namespace,
        timeout: 180_000,
        waitForReady: true,
      })
      .toAlchemyResources({
        name: schemaInstanceName,
        settings: { nested: 'preserved-after-upgrade' },
      });
    const originalStack = Alchemy.Stack(
      `typekro-alchemy-schema-upgrade-${runToken}`,
      makeOptions as never,
      materializeAlchemyResources(KroResource, originalDeclarations) as never
    );
    const upgradedStack = Alchemy.Stack(
      `typekro-alchemy-schema-upgrade-${runToken}`,
      makeOptions as never,
      materializeAlchemyResources(KroResource, upgradedDeclarations) as never
    );

    try {
      await runDeploy(originalStack);
      activeStacks.add(originalStack);

      await runDeploy(upgradedStack);
      activeStacks.delete(originalStack);
      activeStacks.add(upgradedStack);

      const objectApi = createKubernetesObjectApiClient();
      const admitted = (await objectApi.read({
        apiVersion: `${schemaGroup}/v1alpha1`,
        kind: schemaKind,
        metadata: { name: schemaInstanceName, namespace },
      })) as { spec?: { settings?: { nested?: string } } };
      expect(admitted.spec?.settings?.nested).toBe('preserved-after-upgrade');

      const config = (await objectApi.read({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: schemaInstanceName, namespace },
      })) as { data?: Record<string, string> };
      expect(config.data?.nested).toBe('preserved-after-upgrade');
    } finally {
      await destroyActiveStacks();
    }
  }, 300_000);
});
