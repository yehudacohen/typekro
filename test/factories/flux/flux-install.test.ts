/**
 * Flux install factory, against a neutral stand-in release shaped like Flux's
 * install manifests (no upstream manifests are vendored).
 */
import { describe, expect, it } from 'bun:test';
import { loadAll } from 'js-yaml';

import {
  FLUX_RELEASES,
  fluxInstallForVersion,
  isPinnedFluxVersion,
  makeFluxInstall,
  validateFluxRelease,
} from '../../../src/factories/flux/index.js';
import { fluxStandInRelease } from '../../fixtures/flux/stand-in-release.js';

interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; annotations?: Record<string, string> };
  spec: Record<string, unknown>;
}

const fluxInstall = makeFluxInstall({ release: fluxStandInRelease });
const placement = {
  version: 'v2.7.5',
  tolerations: [
    {
      key: 'example.com/capacity-class',
      operator: 'Exists' as const,
      effect: 'NoSchedule' as const,
    },
  ],
  nodeSelector: { 'kubernetes.io/os': 'linux', 'example.com/capacity-class': 'stable' },
};

async function direct(spec: Record<string, unknown> = placement): Promise<Manifest[]> {
  const factory = await fluxInstall.factory('direct', { namespace: 'flux-system' });
  return (loadAll(factory.toYaml(spec as typeof placement)) as Manifest[]).filter(Boolean);
}

function podSpec(manifest: Manifest) {
  return (manifest.spec.template as { spec: { tolerations?: unknown[]; nodeSelector?: unknown } })
    .spec;
}

describe('pinned Flux versions', () => {
  it('accepts exact versions and refuses latest, unprefixed and partial versions', () => {
    for (const version of ['v2.7.5', 'v2.8.0-rc.1', 'v10.0.0']) {
      expect(isPinnedFluxVersion(version)).toBe(true);
    }
    for (const version of ['latest', '2.7.5', 'v2.7', 'v2', 'v2.7.5.1', '']) {
      expect(isPinnedFluxVersion(version)).toBe(false);
    }
  });

  it('refuses a release with an unpinned version', () => {
    expect(() =>
      makeFluxInstall({ release: { ...fluxStandInRelease, version: 'latest' } })
    ).toThrow('Flux version must be pinned');
  });
});

describe('release validation', () => {
  it('refuses a kind with no factory', () => {
    const release = {
      ...fluxStandInRelease,
      documents: [
        ...fluxStandInRelease.documents,
        { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'x', namespace: 'flux-system' } },
      ],
    };
    expect(() => validateFluxRelease(release)).toThrow('has a kind with no factory');
  });

  it('refuses manifests that span namespaces', () => {
    const release = {
      ...fluxStandInRelease,
      documents: [
        ...fluxStandInRelease.documents,
        { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'x', namespace: 'other' } },
      ],
    };
    expect(() => validateFluxRelease(release)).toThrow('span namespaces');
  });

  it('refuses manifests with no controller', () => {
    const release = {
      ...fluxStandInRelease,
      documents: fluxStandInRelease.documents.filter((document) => document.kind !== 'Deployment'),
    };
    expect(() => validateFluxRelease(release)).toThrow('no controller Deployment');
  });
});

describe('makeFluxInstall (direct mode)', () => {
  it('renders every manifest as a declaration', async () => {
    const manifests = await direct();
    expect(manifests.map((item) => `${item.kind}/${item.metadata.name}`).sort()).toEqual(
      fluxStandInRelease.documents.map((item) => `${item.kind}/${item.metadata.name}`).sort()
    );
  });

  it('applies the Kubernetes 1.33 CRD schema fix', async () => {
    const helmReleases = (await direct()).find(
      (item) => item.metadata.name === 'helmreleases.helm.toolkit.fluxcd.io'
    );
    const versions = helmReleases?.spec.versions as Array<{
      schema: { openAPIV3Schema: { properties: { spec: { properties: { values: object } } } } };
    }>;
    expect(versions[0]?.schema.openAPIV3Schema.properties.spec.properties.values).toEqual({
      type: 'object',
      'x-kubernetes-preserve-unknown-fields': true,
    });
  });

  it('applies the placement inputs to every controller', async () => {
    const controllers = (await direct()).filter((item) => item.kind === 'Deployment');
    expect(controllers.length).toBe(2);
    for (const controller of controllers) {
      expect(podSpec(controller).tolerations).toEqual(placement.tolerations);
      expect(podSpec(controller).nodeSelector).toEqual(placement.nodeSelector);
    }
  });

  it("keeps the manifests' own placement when none is given", async () => {
    const controllers = (await direct({ version: 'v2.7.5' })).filter(
      (item) => item.kind === 'Deployment'
    );
    for (const controller of controllers) {
      expect(podSpec(controller).tolerations).toEqual([]);
      expect(podSpec(controller).nodeSelector).toEqual({ 'kubernetes.io/os': 'linux' });
    }
  });

  it('refuses a version other than the release, and an unpinned one', async () => {
    await expect(direct({ version: 'v2.7.4' })).rejects.toThrow('these manifests are v2.7.5');
    await expect(direct({ version: 'latest' })).rejects.toThrow('Flux version must be pinned');
  });
});

describe('makeFluxInstall (KRO mode)', () => {
  type Rgd = {
    kind: string;
    spec: {
      resources: Array<{
        id: string;
        readyWhen?: string[];
        template: { kind: string; metadata: { annotations?: Record<string, string> } };
      }>;
      schema: { status: Record<string, string> };
    };
  };
  const rgd = (): Rgd => {
    const docs = loadAll(fluxInstall.toYaml()) as Rgd[];
    const last = docs[docs.length - 1];
    if (!last) throw new Error('no RGD');
    return last;
  };

  it('serializes with readiness on each controller', () => {
    const graph = rgd();
    expect(graph.kind).toBe('ResourceGraphDefinition');
    const controllers = graph.spec.resources.filter(
      (resource) => resource.template.kind === 'Deployment'
    );
    expect(controllers.map((resource) => resource.id).sort()).toEqual([
      'deploymentHelmController',
      'deploymentSourceController',
    ]);
    for (const controller of controllers) {
      expect(controller.readyWhen?.[0]).toContain(`${controller.id}.status.readyReplicas`);
    }
    expect(graph.spec.schema.status.ready).toContain(
      'deploymentHelmController.status.readyReplicas'
    );
    expect(graph.spec.schema.status.ready).toContain(
      'deploymentSourceController.status.readyReplicas'
    );
  });

  it('orders CRDs before RBAC and services, and those before the controllers', () => {
    const annotations = (id: string) =>
      Object.keys(
        rgd().spec.resources.find((resource) => resource.id === id)?.template.metadata
          .annotations ?? {}
      ).filter((key) => key.startsWith('typekro.dev/depends-on-'));
    expect(annotations('serviceSourceController')).toContain(
      'typekro.dev/depends-on-customResourceDefinitionHelmreleasesHelmToolkitFluxcdIo'
    );
    expect(annotations('deploymentHelmController')).toContain(
      'typekro.dev/depends-on-serviceSourceController'
    );
  });
});

describe('makeFluxInstall (Alchemy declarations)', () => {
  it('lowers to Alchemy resource declarations, with no deploy-time closure', async () => {
    const factory = await fluxInstall.factory('direct', { namespace: 'flux-system' });
    const declarations = await factory.toAlchemyResources(placement);
    expect(declarations.length).toBe(fluxStandInRelease.documents.length);
  });
});

describe('fluxInstallForVersion', () => {
  it('has no vendored release yet and points at the README', () => {
    expect(Object.keys(FLUX_RELEASES)).toEqual([]);
    expect(() => fluxInstallForVersion('v2.7.5')).toThrow('src/factories/flux/install/README.md');
    expect(() => fluxInstallForVersion('latest')).toThrow('Flux version must be pinned');
  });
});
