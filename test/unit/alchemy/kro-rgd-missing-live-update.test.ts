import { describe, expect, mock, test } from 'bun:test';
import {
  deployKroResourceForTest,
  detectKroResourceIdentityDriftForTest,
  existingInstanceNamespacesAlchemyForTest,
  waitForPersistedIdentityDeletionForTest,
} from '../../../src/alchemy/resource-registration.js';
import type {
  TypeKroDeployer,
  TypeKroResource,
  TypeKroResourceProps,
} from '../../../src/alchemy/types.js';
import {
  migrateLegacyKroArtifactBindingCrd,
  repairRetainedKroGeneratedCrdOwnership,
} from '../../../src/core/deployment/kro-artifact-binding-migration.js';
import { getComponentLogger } from '../../../src/core/logging/index.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';
import { createMockKubeConfig } from '../../utils/mock-factories.js';

const RGD_NAME = 'demo-owner';
const CRD_NAME = 'demoapps.demo.example';
const CRD_GROUP = 'demo.example';
const CRD_KIND = 'DemoApp';
const STALE_RGD_UID = 'uid-deleted-out-of-band';
const NEW_RGD_UID = 'uid-recreated';
const RECONCILE_ANNOTATION = 'typekro.io/retained-crd-adoption-retry';

type Manifest = Record<string, any>;

/**
 * Hard watchdog for every wedge test below.
 *
 * Without it, a REGRESSION that drops a bound turns these tests into a hang rather than a failure —
 * the exact symptom the fix exists to eliminate, reproduced in CI. Racing the assertion against a
 * short deadline makes a lost bound RED and fast.
 */
async function settlesWithin<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`call did not settle within ${ms}ms — it is UNBOUNDED`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** An API method that neither resolves nor rejects — a hung exec credential, a half-open socket. */
const wedgedCall = () => new Promise(() => undefined);

function notFound(): Error {
  return Object.assign(new Error('the server could not find the requested resource'), {
    statusCode: 404,
    code: 404,
  });
}

/** The generated CRD KRO retained after the RGD was deleted out-of-band: stale RGD-id label. */
function retainedCrd(rgdId: string): Manifest {
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: {
      name: CRD_NAME,
      resourceVersion: '41',
      labels: {
        'kro.run/owned': 'true',
        'kro.run/resource-graph-definition-name': RGD_NAME,
        'kro.run/resource-graph-definition-id': rgdId,
      },
    },
    spec: {
      group: CRD_GROUP,
      names: { kind: CRD_KIND, plural: 'demoapps' },
      versions: [
        {
          name: 'v1alpha1',
          schema: {
            openAPIV3Schema: {
              properties: {
                spec: {
                  properties: {
                    typekroArtifactBindings: {
                      type: 'object',
                      additionalProperties: {
                        type: 'object',
                        additionalProperties: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    },
  };
}

/** A singleton-owner ResourceGraphDefinition as Alchemy state rehydrates it. */
function desiredRgd(): Enhanced<Record<string, unknown>, Record<string, unknown>> {
  return {
    apiVersion: 'kro.run/v1alpha1',
    kind: 'ResourceGraphDefinition',
    metadata: { name: RGD_NAME },
    spec: {
      schema: {
        apiVersion: 'v1alpha1',
        group: CRD_GROUP,
        kind: CRD_KIND,
        spec: { typekroArtifactBindings: 'map[string]map[string]string' },
      },
    },
  } as unknown as Enhanced<Record<string, unknown>, Record<string, unknown>>;
}

interface FakeCluster {
  rgd: Manifest | undefined;
  crd: Manifest;
  calls: string[];
}

function fakeApi(cluster: FakeCluster) {
  return {
    read: async (spec: Manifest) => {
      cluster.calls.push(`read ${spec.kind}/${spec.metadata?.name}`);
      if (spec.kind === 'ResourceGraphDefinition') {
        if (!cluster.rgd) throw notFound();
        return cluster.rgd;
      }
      if (spec.kind === 'CustomResourceDefinition') return cluster.crd;
      throw notFound();
    },
    list: async (_apiVersion: string, kind: string) => {
      cluster.calls.push(`list ${kind}`);
      return kind === 'CustomResourceDefinition' ? { items: [cluster.crd] } : { items: [] };
    },
    replace: async (object: Manifest) => {
      cluster.calls.push(`replace ${object.kind}/${object.metadata?.name}`);
      const stored = { ...object, metadata: { ...object.metadata, resourceVersion: '42' } };
      if (object.kind === 'CustomResourceDefinition') {
        cluster.crd = stored;
      } else {
        cluster.rgd = { ...(cluster.rgd ?? {}), ...stored };
      }
      return stored;
    },
  } as any;
}

/** Applies the RGD the way the deployment engine would, minting a fresh UID. */
function applyingDeployer(cluster: FakeCluster): TypeKroDeployer {
  return {
    deploy: mock(async (resource: Manifest) => {
      cluster.calls.push('engine.deploy');
      cluster.rgd = {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'ResourceGraphDefinition',
        metadata: { name: RGD_NAME, uid: NEW_RGD_UID, resourceVersion: '43' },
        spec: resource.spec,
      };
      return resource;
    }) as TypeKroDeployer['deploy'],
    delete: mock(async () => undefined),
    dispose: mock(async () => undefined),
  };
}

type Props = TypeKroResourceProps<Enhanced<Record<string, unknown>, Record<string, unknown>>>;

function props(deployer?: TypeKroDeployer, options: Record<string, unknown> = {}): Props {
  return {
    resource: desiredRgd(),
    namespace: 'typekro-singletons',
    deploymentStrategy: 'kro',
    ...(deployer ? { deployer } : {}),
    options: { timeout: 10_000, ...options },
  } as unknown as Props;
}

/**
 * Alchemy's persisted state: the RGD as it was when it last deployed, carrying the UID of the
 * object that has since been deleted out-of-band.
 */
function staleOutput(): TypeKroResource<
  Enhanced<Record<string, unknown>, Record<string, unknown>>
> {
  return {
    ...props(),
    deployedResource: {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: RGD_NAME, uid: STALE_RGD_UID, resourceVersion: '12' },
    },
    ready: true,
    deployedAt: 1,
  } as unknown as TypeKroResource<Enhanced<Record<string, unknown>, Record<string, unknown>>>;
}

function migrationDeps(api: unknown) {
  return {
    migrateLegacyArtifactBindings: (kubeConfig: any, resource: any, dependencies: any) =>
      migrateLegacyKroArtifactBindingCrd(kubeConfig, resource, { ...dependencies, api } as any),
    repairRetainedCrdOwnership: (kubeConfig: any, resource: any, dependencies: any) =>
      repairRetainedKroGeneratedCrdOwnership(kubeConfig, resource, { ...dependencies, api } as any),
    kubeConfigForMigration: createMockKubeConfig,
  };
}

describe('Alchemy KRO update whose live ResourceGraphDefinition is gone', () => {
  test('drifts to update, converges to a clean create, and adopts the retained CRD', async () => {
    const cluster: FakeCluster = {
      // Deleted out-of-band by another stack's teardown; its generated CRD was retained.
      rgd: undefined,
      crd: retainedCrd(STALE_RGD_UID),
      calls: [],
    };
    const output = staleOutput();
    const liveReader = {
      read: async () => {
        if (!cluster.rgd) throw notFound();
        return cluster.rgd as any;
      },
    };

    // 1. Alchemy's diff: persisted state exists, the live object 404s → reconcile as an update.
    await expect(
      detectKroResourceIdentityDriftForTest(props(), output, liveReader)
    ).resolves.toEqual({ action: 'update' });

    // 2. Nothing is terminating, so the reconcile proceeds straight to the deploy.
    await expect(
      waitForPersistedIdentityDeletionForTest(props(), output, undefined, { reader: liveReader })
    ).resolves.toBeUndefined();

    // 3. The deploy itself.
    const deployer = applyingDeployer(cluster);
    const result = await deployKroResourceForTest(
      props(deployer),
      undefined,
      migrationDeps(fakeApi(cluster))
    );

    expect(result.ready).toBe(true);
    // The artifact-binding migration is a no-op against a missing RGD; the normal apply creates it.
    expect(cluster.calls).toContain('engine.deploy');
    expect(cluster.rgd?.metadata?.uid).toBe(NEW_RGD_UID);
    // The retained CRD is adopted by the recreated RGD rather than left pointing at the dead one.
    expect(cluster.crd.metadata.labels['kro.run/resource-graph-definition-id']).toBe(NEW_RGD_UID);
    // ...and KRO is asked to reconcile the RGD against the newly-adopted CRD.
    expect(cluster.rgd?.metadata?.annotations?.[RECONCILE_ANNOTATION]).toBeString();
    expect(cluster.calls.indexOf(`replace ${'CustomResourceDefinition'}/${CRD_NAME}`)).toBeLessThan(
      cluster.calls.lastIndexOf(`replace ResourceGraphDefinition/${RGD_NAME}`)
    );
  });

  test('treats an RGD with zero live instances as nothing to protect', async () => {
    // The other half of the observed state: the retained CRD exists but has no instances, so the
    // pre-hoist scan resolves an empty protected set instead of failing closed.
    const scanned = await existingInstanceNamespacesAlchemyForTest(
      {
        ...props(),
        namespaceOwnerRgd: RGD_NAME,
        namespacePreHoistQuery: { group: CRD_GROUP, version: 'v1alpha1', kind: CRD_KIND },
      } as unknown as Props,
      createMockKubeConfig(),
      getComponentLogger('test'),
      {
        objectApi: { list: async () => ({ items: [retainedCrd(STALE_RGD_UID)] }) },
        customApi: { listClusterCustomObject: async () => ({ items: [] }) },
      } as any
    );
    expect([...scanned]).toEqual([]);
  });

  test('leaves the healthy update path unchanged', async () => {
    const liveRgd: Manifest = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: RGD_NAME, uid: NEW_RGD_UID, resourceVersion: '40' },
      spec: {
        schema: {
          apiVersion: 'v1alpha1',
          group: CRD_GROUP,
          kind: CRD_KIND,
          // The released v0.32 topology-shaped schema the migration broadens.
          spec: { typekroArtifactBindings: { requirement: { output: 'string' } } },
        },
      },
    };
    const cluster: FakeCluster = { rgd: liveRgd, crd: retainedCrd(NEW_RGD_UID), calls: [] };
    const deployer = applyingDeployer(cluster);

    const result = await deployKroResourceForTest(
      props(deployer),
      undefined,
      migrationDeps(fakeApi(cluster))
    );

    expect(result.ready).toBe(true);
    expect(cluster.calls).toContain('engine.deploy');
    // The live RGD is replaced with the desired one before the apply, as before.
    expect(cluster.calls).toContain(`replace ResourceGraphDefinition/${RGD_NAME}`);
    expect(cluster.crd.metadata.labels['kro.run/resource-graph-definition-id']).toBe(NEW_RGD_UID);
  });
});

/**
 * Every pre-deploy cluster call must reject when it wedges. Each test injects a client whose method
 * never settles through the seam the production path actually uses, so REMOVING the bound at that
 * seam turns the test red rather than hanging CI.
 */
describe('Alchemy KRO handler bounds every cluster call it makes', () => {
  const fast = { httpTimeouts: { default: 40, create: 40, delete: 40 } };

  test('the artifact-binding migration rejects, naming the ResourceGraphDefinition', async () => {
    const deployer = applyingDeployer({
      rgd: undefined,
      crd: retainedCrd(STALE_RGD_UID),
      calls: [],
    });
    const promise = deployKroResourceForTest(
      props(deployer, fast),
      undefined,
      migrationDeps({ read: wedgedCall, list: wedgedCall, replace: wedgedCall })
    );
    await expect(settlesWithin(promise)).rejects.toThrow(
      new RegExp(`ResourceGraphDefinition ${RGD_NAME}.*read exceeded its 40ms request timeout`, 's')
    );
    expect(deployer.deploy).not.toHaveBeenCalled();
  });

  test('the drift check rejects instead of stalling the diff', async () => {
    await expect(
      settlesWithin(
        detectKroResourceIdentityDriftForTest(props(undefined, fast), staleOutput(), {
          read: wedgedCall as any,
        })
      )
    ).rejects.toThrow(/exceeded its 40ms request timeout/);
  });

  test('the terminating-identity wait rejects instead of stalling the reconcile', async () => {
    await expect(
      settlesWithin(
        waitForPersistedIdentityDeletionForTest(props(undefined, fast), staleOutput(), undefined, {
          reader: { read: wedgedCall as any },
        })
      )
    ).rejects.toThrow(/exceeded its 40ms request timeout/);
  });

  test('the pre-hoist CRD discovery rejects', async () => {
    await expect(
      settlesWithin(
        existingInstanceNamespacesAlchemyForTest(
          {
            ...props(undefined, fast),
            namespacePreHoistQuery: { group: CRD_GROUP, version: 'v1alpha1', kind: CRD_KIND },
          } as unknown as Props,
          createMockKubeConfig(),
          getComponentLogger('test'),
          { objectApi: { list: wedgedCall } } as any
        )
      )
    ).rejects.toThrow(/exceeded its 40ms request timeout/);
  });

  test('the pre-hoist instance listing rejects', async () => {
    await expect(
      settlesWithin(
        existingInstanceNamespacesAlchemyForTest(
          {
            ...props(undefined, fast),
            namespacePreHoistQuery: { group: CRD_GROUP, version: 'v1alpha1', kind: CRD_KIND },
          } as unknown as Props,
          createMockKubeConfig(),
          getComponentLogger('test'),
          {
            objectApi: { list: async () => ({ items: [retainedCrd(STALE_RGD_UID)] }) },
            customApi: { listClusterCustomObject: wedgedCall },
          } as any
        )
      )
    ).rejects.toThrow(/Pre-hoist safety check could not list existing instances/);
  });

  test('the owned-namespace pagination rejects at the helper itself', async () => {
    // `listNamespacesOwnedByRgd` builds its OWN client and paginates in a loop that re-checks its
    // abort signal only BETWEEN pages, so the bound has to live INSIDE the helper — the caller
    // wrapping an injected client would leave the teardown caller, which injects nothing, exposed.
    const { listNamespacesOwnedByRgd } = await import(
      '../../../src/core/deployment/kro-namespace-teardown.js'
    );
    await expect(
      settlesWithin(
        listNamespacesOwnedByRgd(createMockKubeConfig(), RGD_NAME, {
          k8sApi: { list: wedgedCall } as never,
          requestBudget: { read: 40, write: 40, delete: 40 },
        })
      )
    ).rejects.toThrow(
      new RegExp(
        `Namespaces owned by ResourceGraphDefinition ${RGD_NAME} list exceeded its 40ms request timeout`
      )
    );
  });

  test('the owned-namespace pagination rejects through the pre-hoist gate', async () => {
    // The last unbounded call in the fail-closed pre-hoist gate: it builds its own client and
    // paginates in a loop that only re-checks its abort signal BETWEEN pages.
    await expect(
      settlesWithin(
        existingInstanceNamespacesAlchemyForTest(
          {
            ...props(undefined, fast),
            namespaceOwnerRgd: RGD_NAME,
            namespacePreHoistQuery: { group: CRD_GROUP, version: 'v1alpha1', kind: CRD_KIND },
          } as unknown as Props,
          createMockKubeConfig(),
          getComponentLogger('test'),
          {
            objectApi: { list: async () => ({ items: [retainedCrd(STALE_RGD_UID)] }) },
            customApi: {
              listClusterCustomObject: async () => ({
                items: [
                  {
                    metadata: {
                      namespace: 'demo',
                      annotations: { 'typekro.io/hoisted-namespaces': '["demo"]' },
                    },
                  },
                ],
              }),
            },
            ownedNamespaceListApi: { list: wedgedCall },
          } as any
        )
      )
    ).rejects.toThrow(/could not list namespaces owned by RGD/i);
  });
});
