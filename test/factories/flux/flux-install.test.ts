/**
 * Flux install factory, against a small neutral stand-in release shaped like Flux's install
 * manifests. flux-install-release.test.ts covers the pinned upstream release.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadAll } from 'js-yaml';

import {
  FLUX_RELEASE_VERSIONS,
  fluxInstallForVersion,
  isPinnedFluxVersion,
  loadFluxRelease,
  makeFluxInstall,
  validateFluxRelease,
} from '../../../src/factories/flux/index.js';
import { admissionErrors } from '../../utils/kro-admission.js';
import { fluxStandInRelease } from '../../fixtures/flux/stand-in-release.js';

interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; annotations?: Record<string, string> };
  spec: Record<string, unknown>;
}

const fluxInstall = makeFluxInstall({ release: fluxStandInRelease });
const placement = {
  version: 'v2.10.0',
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
    for (const version of ['v2.10.0', 'v2.8.0-rc.1', 'v10.0.0']) {
      expect(isPinnedFluxVersion(version)).toBe(true);
    }
    for (const version of ['latest', '2.10.0', 'v2.7', 'v2', 'v2.10.0.1', '']) {
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
    const controllers = (await direct({ version: 'v2.10.0' })).filter(
      (item) => item.kind === 'Deployment'
    );
    for (const controller of controllers) {
      expect(podSpec(controller).tolerations).toEqual([]);
      expect(podSpec(controller).nodeSelector).toEqual({ 'kubernetes.io/os': 'linux' });
    }
  });

  it('refuses a version other than the release, and an unpinned one', async () => {
    await expect(direct({ version: 'v2.7.4' })).rejects.toThrow('these manifests are v2.10.0');
    await expect(direct({ version: 'latest' })).rejects.toThrow(
      'Flux latest is requested, but these manifests are v2.10.0.'
    );
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

  it('accepts only the release version on the instance schema', () => {
    const yaml = fluxInstall.toYaml();
    expect(yaml).toContain('version: string | enum="v2.10.0"');
    expect(admissionErrors(yaml, 'FluxInstall', placement)).toEqual([]);
  });

  it('refuses another version at admission, where the composition body never runs', () => {
    const yaml = fluxInstall.toYaml();
    for (const version of ['v2.6.0', 'v2.7.4', 'latest']) {
      expect(admissionErrors(yaml, 'FluxInstall', { ...placement, version })).toEqual([
        `spec.version: ${JSON.stringify(version)} is not one of ["v2.10.0"]`,
      ]);
    }
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

describe('pinned releases', () => {
  it('load on demand, and point at the README for other versions', async () => {
    expect(FLUX_RELEASE_VERSIONS).toEqual(['v2.10.0']);
    expect((await loadFluxRelease('v2.10.0')).version).toBe('v2.10.0');
    expect(await fluxInstallForVersion('v2.10.0')).toBeDefined();
    await expect(fluxInstallForVersion('v2.6.0')).rejects.toThrow(
      'src/factories/flux/install/README.md'
    );
    await expect(loadFluxRelease('latest')).rejects.toThrow('Flux version must be pinned');
  });

  it('are not reachable from the root entry or typekro/flux through static imports', () => {
    const release = resolve(
      import.meta.dir,
      '../../../src/factories/flux/install/releases/v2.10.0.ts'
    );
    for (const entry of ['../../../src/index.ts', '../../../src/factories/flux/index.ts']) {
      const reachable = staticImportClosure(resolve(import.meta.dir, entry));
      expect(reachable.size).toBeGreaterThan(10);
      expect(reachable.has(release)).toBe(false);
    }
  });
});

/**
 * Source files reachable from `entry` through static `import`/`export ... from` statements with
 * relative specifiers. Dynamic `import()` is not followed: it loads only when called.
 */
function staticImportClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  const specifiers =
    /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"](\.[^'"]+)['"]/gmu;
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(specifiers)) {
      const target = resolve(dirname(file), match[1] ?? '');
      const candidates = [
        target.replace(/\.js$/u, '.ts'),
        `${target}.ts`,
        join(target, 'index.ts'),
      ];
      const found = candidates.find(
        (candidate) => existsSync(candidate) && candidate.endsWith('.ts')
      );
      if (found) pending.push(found);
    }
  }
  return seen;
}
