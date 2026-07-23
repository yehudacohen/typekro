import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { Effect } from 'effect';
import * as Alchemy from 'alchemy';
import * as StateMod from 'alchemy/State';
import * as Test from 'alchemy/Test/Core';
import {
  KroResource,
  kroProvider,
  materializeAlchemyResources,
} from '../../../src/alchemy/index.js';
import type { AlchemyResourceDeclaration } from '../../../src/alchemy/types.js';
import { simple, toResourceGraph } from '../../../src/index.js';
import {
  createKubernetesObjectApiClient,
  deleteNamespaceAndWait,
  ensureNamespaceExists,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;
const runToken = Math.random().toString(36).slice(2, 8);
const namespace = `typekro-alchemy-kro-${runToken}`;
const group = `alchemy-${runToken}.typekro.dev`;
const kind = `AlchemyKroUpgrade${runToken}`;
const rgdName = `alchemy-kro-upgrade-${runToken}`;
const instanceName = `upgrade-${runToken}`;

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

function withoutCanonicalBundle(
  declarations: readonly AlchemyResourceDeclaration[]
): AlchemyResourceDeclaration[] {
  return declarations.map((declaration) => {
    const { kroArtifactBundle: _bundle, kroArtifactOperationId: _operation, ...legacyProps } =
      declaration.props;
    return { ...declaration, props: legacyProps };
  });
}

describeOrSkip('Alchemy KRO persisted-state upgrade (e2e)', () => {
  beforeAll(async () => {
    if (!clusterAvailable) return;
    await ensureNamespaceExists(namespace);
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    const kubeConfig = getIntegrationTestKubeConfig();
    const objectApi = createKubernetesObjectApiClient(kubeConfig);
    await objectApi
      .delete({
        apiVersion: 'kro.run/v1alpha1',
        kind: 'ResourceGraphDefinition',
        metadata: { name: rgdName },
      })
      .catch(() => undefined);
    const crds = await objectApi
      .list('apiextensions.k8s.io/v1', 'CustomResourceDefinition')
      .catch(() => ({ items: [] }));
    for (const crd of crds.items) {
      if ((crd as { spec?: { group?: string } }).spec?.group !== group) continue;
      await objectApi.delete(crd).catch(() => undefined);
    }
    await deleteNamespaceAndWait(namespace, kubeConfig).catch(() => undefined);
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

    await runDeploy(legacyStack);
    expect(JSON.stringify(persistedState)).not.toContain('kroArtifactBundle');

    try {
      await runDeploy(modernStack);
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
      await runDestroy(modernStack);
    }
  }, 300_000);
});
