import { describe, expect, mock, test } from 'bun:test';
import { deployKroResourceForTest } from '../../../src/alchemy/resource-registration.js';
import type { TypeKroDeployer, TypeKroResourceProps } from '../../../src/alchemy/types.js';
import {
  migrateLegacyKroArtifactBindingCrd,
  repairRetainedKroGeneratedCrdOwnership,
} from '../../../src/core/deployment/kro-artifact-binding-migration.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';
import { createMockKubeConfig } from '../../utils/mock-factories.js';

const RGD_NAME = 'demo-owner';
const CRD_NAME = 'demoapps.demo.example';
const STALE_RGD_UID = 'uid-deleted-out-of-band';
const NEW_RGD_UID = 'uid-recreated';

type Manifest = Record<string, any>;

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
      group: 'demo.example',
      names: { kind: 'DemoApp' },
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
        group: 'demo.example',
        kind: 'DemoApp',
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
      const stored = {
        ...object,
        metadata: { ...object.metadata, resourceVersion: '42' },
      };
      if (object.kind === 'CustomResourceDefinition') {
        cluster.crd = stored;
      } else {
        cluster.rgd = stored;
      }
      return stored;
    },
  } as unknown as Parameters<typeof migrateLegacyKroArtifactBindingCrd>[2] extends
    | { api?: infer A }
    | undefined
    ? A
    : never;
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

function props(
  deployer: TypeKroDeployer,
  options: Record<string, unknown> = {}
): TypeKroResourceProps<Enhanced<Record<string, unknown>, Record<string, unknown>>> {
  return {
    resource: desiredRgd(),
    namespace: 'typekro-singletons',
    deploymentStrategy: 'kro',
    deployer,
    options: { timeout: 10_000, ...options },
  } as unknown as TypeKroResourceProps<Enhanced<Record<string, unknown>, Record<string, unknown>>>;
}

describe('Alchemy KRO update whose live ResourceGraphDefinition is gone', () => {
  test('converges to a clean create and relabels the retained generated CRD', async () => {
    const cluster: FakeCluster = {
      // Deleted out-of-band by another stack's teardown; its generated CRD was retained.
      rgd: undefined,
      crd: retainedCrd(STALE_RGD_UID),
      calls: [],
    };
    const api = fakeApi(cluster);
    const deployer = applyingDeployer(cluster);

    const result = await deployKroResourceForTest(props(deployer), undefined, {
      migrateLegacyArtifactBindings: (kubeConfig, resource, dependencies) =>
        migrateLegacyKroArtifactBindingCrd(kubeConfig, resource, { ...dependencies, api }),
      repairRetainedCrdOwnership: (kubeConfig, resource, dependencies) =>
        repairRetainedKroGeneratedCrdOwnership(kubeConfig, resource, { ...dependencies, api }),
      kubeConfigForMigration: createMockKubeConfig,
    });

    expect(result.ready).toBe(true);
    // The migration is a no-op against a missing RGD; the normal apply creates it.
    expect(cluster.calls).toContain('engine.deploy');
    expect(cluster.rgd?.metadata?.uid).toBe(NEW_RGD_UID);
    // The retained CRD is adopted by the recreated RGD rather than left pointing at the dead one.
    expect(cluster.crd.metadata.labels['kro.run/resource-graph-definition-id']).toBe(NEW_RGD_UID);
  });

  test('rejects with a timeout naming the ResourceGraphDefinition instead of hanging', async () => {
    const deployer = applyingDeployer({
      rgd: undefined,
      crd: retainedCrd(STALE_RGD_UID),
      calls: [],
    });
    // A wedged request: the promise never settles, exactly like a hung exec credential.
    const wedged = {
      read: () => new Promise(() => undefined),
      list: () => new Promise(() => undefined),
      replace: () => new Promise(() => undefined),
    } as unknown as Parameters<typeof migrateLegacyKroArtifactBindingCrd>[2] extends
      | { api?: infer A }
      | undefined
      ? A
      : never;

    const promise = deployKroResourceForTest(
      props(deployer, { httpTimeouts: { default: 50 } }),
      undefined,
      {
        migrateLegacyArtifactBindings: (kubeConfig, resource, dependencies) =>
          migrateLegacyKroArtifactBindingCrd(kubeConfig, resource, {
            ...dependencies,
            api: wedged,
          }),
        kubeConfigForMigration: createMockKubeConfig,
      }
    );

    await expect(promise).rejects.toThrow(
      new RegExp(`ResourceGraphDefinition ${RGD_NAME}.*read.*request timeout`, 's')
    );
    expect(deployer.deploy).not.toHaveBeenCalled();
  });

  test('leaves the healthy update path unchanged', async () => {
    const liveRgd: Manifest = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: RGD_NAME, uid: NEW_RGD_UID, resourceVersion: '40' },
      spec: {
        schema: {
          apiVersion: 'v1alpha1',
          group: 'demo.example',
          kind: 'DemoApp',
          // The released v0.32 topology-shaped schema the migration broadens.
          spec: { typekroArtifactBindings: { requirement: { output: 'string' } } },
        },
      },
    };
    const cluster: FakeCluster = { rgd: liveRgd, crd: retainedCrd(NEW_RGD_UID), calls: [] };
    const api = fakeApi(cluster);
    const deployer = applyingDeployer(cluster);

    const result = await deployKroResourceForTest(props(deployer), undefined, {
      migrateLegacyArtifactBindings: (kubeConfig, resource, dependencies) =>
        migrateLegacyKroArtifactBindingCrd(kubeConfig, resource, { ...dependencies, api }),
      repairRetainedCrdOwnership: (kubeConfig, resource, dependencies) =>
        repairRetainedKroGeneratedCrdOwnership(kubeConfig, resource, { ...dependencies, api }),
      kubeConfigForMigration: createMockKubeConfig,
    });

    expect(result.ready).toBe(true);
    expect(cluster.calls).toContain('engine.deploy');
    // The live RGD is replaced with the desired one before the apply, as before.
    expect(cluster.calls).toContain(`replace ResourceGraphDefinition/${RGD_NAME}`);
    expect(cluster.crd.metadata.labels['kro.run/resource-graph-definition-id']).toBe(NEW_RGD_UID);
  });
});
