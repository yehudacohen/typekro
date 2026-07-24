import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import * as Alchemy from 'alchemy';
import * as Provider from 'alchemy/Provider';
import type { Resource as AlchemyResource } from 'alchemy/Resource';
import { Resource } from 'alchemy/Resource';
import * as State from 'alchemy/State';
import * as Test from 'alchemy/Test/Core';
import { type } from 'arktype';
import { Effect, Layer } from 'effect';
import {
  KroResource,
  kroProvider,
  materializeAlchemyResources,
} from '../../../src/alchemy/index.js';
import { artifactOutput } from '../../../src/experimental-planning.js';
import { createResource, toResourceGraph } from '../../../src/index.js';
import {
  createKubernetesObjectApiClient,
  createTestNamespace,
  deleteGeneratedCrdAndWait,
  deleteTestNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  type ResourceIdentity,
  type TestNamespaceLease,
  waitForResourceAbsent,
} from '../shared-kubeconfig.js';

const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;
const runToken = Math.random().toString(36).slice(2, 8);

setDefaultTimeout(1_200_000);

interface ImageArtifactProps {
  digest: string;
  consumerName: string;
  consumerNamespace: string;
}

type ImageArtifactResource = AlchemyResource<
  'TypeKro.Test.ImageArtifact',
  ImageArtifactProps,
  {
    image: string;
    consumerName: string;
    consumerNamespace: string;
  }
>;

interface ProviderEvent {
  action: 'reconcile' | 'delete';
  digest?: string;
  consumerPresent?: boolean;
}

const ImageArtifact = Resource<ImageArtifactResource>('TypeKro.Test.ImageArtifact');

const imageArtifactProvider = (events: ProviderEvent[]) =>
  Provider.succeed(ImageArtifact, {
    read: ({ output }) => Effect.succeed(output),
    reconcile: ({ news }) =>
      Effect.sync(() => {
        events.push({ action: 'reconcile', digest: news.digest });
        return {
          image: `registry.example/typekro@sha256:${news.digest}`,
          consumerName: news.consumerName,
          consumerNamespace: news.consumerNamespace,
        };
      }),
    delete: ({ output }) =>
      Effect.tryPromise(async () => {
        const objectApi = createKubernetesObjectApiClient();
        const consumerPresent = await objectApi
          .read({
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: {
              name: output.consumerName,
              namespace: output.consumerNamespace,
            },
          })
          .then(
            () => true,
            () => false
          );
        events.push({ action: 'delete', consumerPresent });
      }),
  });

const runDeploy = (options: unknown, stack: unknown) =>
  Effect.runPromise(
    Test.toEffect(Test.deploy(options as never, stack as never) as never, options as never)
  );

const runDestroy = (options: unknown, stack: unknown) =>
  Effect.runPromise(
    Test.toEffect(Test.destroy(options as never, stack as never) as never, options as never)
  );

interface AlchemyRuntime {
  options: unknown;
  stack: unknown;
}

function graph(mode: 'direct' | 'kro') {
  const suffix = `${mode}-${runToken}`;
  return toResourceGraph(
    {
      name: `artifact-${suffix}`,
      apiVersion: `artifact-${suffix}.typekro.dev/v1alpha1`,
      kind: mode === 'direct' ? `DirectArtifact${runToken}` : `KroArtifact${runToken}`,
      revision: '1',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    (schema) => ({
      config: createResource({
        id: 'consumer',
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: schema.spec.name },
        data: { image: artifactOutput('build', 'image') },
      }),
    }),
    () => ({ ready: true })
  );
}

async function readImage(namespace: string, name: string): Promise<string | undefined> {
  const config = (await createKubernetesObjectApiClient().read({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name, namespace },
  })) as { data?: { image?: string } };
  return config.data?.image;
}

describeOrSkip('Alchemy cross-provider TypeKro artifacts (e2e)', () => {
  type Mode = 'direct' | 'kro';

  const namespaces = {
    direct: `typekro-artifact-direct-${runToken}`,
    kro: `typekro-artifact-kro-${runToken}`,
  };
  const activeDeployments = new Map<Mode, AlchemyRuntime>();
  const namespaceLeases = new Map<Mode, TestNamespaceLease>();

  const destroyDeployment = async (mode: Mode): Promise<void> => {
    const runtime = activeDeployments.get(mode);
    if (!runtime) return;
    await runDestroy(runtime.options, runtime.stack);
    activeDeployments.delete(mode);
  };

  const destroyActiveDeployments = async (): Promise<void> => {
    const results = await Promise.allSettled(
      [...activeDeployments.keys()].map((mode) => destroyDeployment(mode))
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to destroy Alchemy test deployments');
    }
  };

  beforeAll(async () => {
    if (!clusterAvailable) return;
    namespaceLeases.set('direct', await createTestNamespace(namespaces.direct));
    namespaceLeases.set('kro', await createTestNamespace(namespaces.kro));
  });

  afterEach(async () => {
    if (!clusterAvailable) return;
    await destroyActiveDeployments();
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    await destroyActiveDeployments();

    const kubeConfig = getIntegrationTestKubeConfig();
    const objectApi = createKubernetesObjectApiClient(kubeConfig);
    const kroGroup = `artifact-kro-${runToken}.typekro.dev`;
    const kroInstance: ResourceIdentity = {
      apiVersion: `${kroGroup}/v1alpha1`,
      kind: `KroArtifact${runToken}`,
      metadata: {
        name: 'artifact-consumer-kro',
        namespace: namespaces.kro,
      },
    };
    const rgd: ResourceIdentity = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: `artifact-kro-${runToken}` },
    };
    const consumers: ResourceIdentity[] = [
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: 'artifact-consumer-direct',
          namespace: namespaces.direct,
        },
      },
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: 'artifact-consumer-kro',
          namespace: namespaces.kro,
        },
      },
    ];

    await Promise.all(consumers.map((consumer) => waitForResourceAbsent(consumer, kubeConfig)));
    await waitForResourceAbsent(kroInstance, kubeConfig);
    await waitForResourceAbsent(rgd, kubeConfig);

    const namespaceResults = await Promise.allSettled(
      [...namespaceLeases.values()].map((lease) => deleteTestNamespaceAndWait(lease, kubeConfig))
    );
    const namespaceFailures = namespaceResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (namespaceFailures.length > 0) {
      throw new AggregateError(namespaceFailures, 'Failed to delete Alchemy test namespaces');
    }

    const crds = await objectApi.list('apiextensions.k8s.io/v1', 'CustomResourceDefinition');
    for (const crd of crds.items) {
      const group = (crd as { spec?: { group?: string } }).spec?.group;
      if (group !== kroGroup) continue;
      const crdName = crd.metadata?.name;
      if (!crdName) {
        throw new Error(`Generated CRD for ${kroGroup} has no metadata.name`);
      }
      const crdIdentity: ResourceIdentity = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: crdName },
      };
      await deleteGeneratedCrdAndWait(
        crdIdentity,
        kroInstance.apiVersion,
        kroInstance.kind,
        kubeConfig
      );
    }

    const remainingCrds = await objectApi.list(
      'apiextensions.k8s.io/v1',
      'CustomResourceDefinition'
    );
    const remainingForGroup = remainingCrds.items.filter(
      (crd) => (crd as { spec?: { group?: string } }).spec?.group === kroGroup
    );
    if (remainingForGroup.length > 0) {
      throw new Error(
        `Generated CRD cleanup for ${kroGroup} left ${remainingForGroup.length} resource(s)`
      );
    }
  });

  for (const mode of ['direct', 'kro'] as const) {
    it(`executes, rehydrates, updates, and safely deletes ${mode} artifact bindings`, async () => {
      const namespace = namespaces[mode];
      const consumerName = `artifact-consumer-${mode}`;
      const stackName = `typekro-artifact-${mode}-${runToken}`;
      const events: ProviderEvent[] = [];
      const declarations = await graph(mode)
        .factory(mode, {
          namespace,
          timeout: 180_000,
          waitForReady: true,
          plan: {
            inputs: {
              image: {
                kind: 'artifact',
                requirement: {
                  id: 'build',
                  kind: 'container-image',
                  descriptor: { kind: 'literal', value: consumerName },
                  outputs: ['image'],
                },
              },
            },
          },
        })
        .toAlchemyResources({ name: consumerName });

      const makeRuntime = (
        digest: string,
        persistedState: Record<string, Record<string, Record<string, unknown>>>
      ) => {
        const providers = Layer.mergeAll(kroProvider, imageArtifactProvider(events));
        const options = {
          providers,
          state: State.inMemoryState(persistedState as never),
        };
        const stack = Alchemy.Stack(
          stackName,
          options as never,
          Effect.gen(function* () {
            const build = yield* ImageArtifact('build', {
              digest,
              consumerName,
              consumerNamespace: namespace,
            });
            return yield* materializeAlchemyResources(KroResource, declarations, {
              artifacts: {
                build: {
                  resource: build,
                  outputs: { image: build.image },
                },
              },
            });
          }) as never
        );
        return { options, stack };
      };

      try {
        const initialState: Record<string, Record<string, Record<string, unknown>>> = {};
        const initial = makeRuntime('111', initialState);
        activeDeployments.set(mode, initial);
        await runDeploy(initial.options, initial.stack);
        expect(events).toContainEqual({ action: 'reconcile', digest: '111' });
        expect(await readImage(namespace, consumerName)).toBe(
          'registry.example/typekro@sha256:111'
        );

        const restoredState = JSON.parse(JSON.stringify(initialState)) as typeof initialState;
        const updated = makeRuntime('222', restoredState);
        activeDeployments.set(mode, updated);
        await runDeploy(updated.options, updated.stack);
        expect(events).toContainEqual({ action: 'reconcile', digest: '222' });
        expect(await readImage(namespace, consumerName)).toBe(
          'registry.example/typekro@sha256:222'
        );
      } finally {
        await destroyDeployment(mode);
      }

      expect(events.at(-1)).toEqual({ action: 'delete', consumerPresent: false });
      await expect(readImage(namespace, consumerName)).rejects.toThrow();
    }, 360_000);
  }
});
