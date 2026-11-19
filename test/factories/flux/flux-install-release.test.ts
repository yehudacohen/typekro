/**
 * Flux install factory against the pinned upstream v2.10.0 release manifests.
 */
import { describe, expect, it } from 'bun:test';
import { loadAll } from 'js-yaml';

import { needsCRDSchemaFix } from '../../../src/core/runtime-patches/crd-schema-fix.js';
import type { KubernetesResource } from '../../../src/core/types/kubernetes.js';
import {
  fluxInstallForVersion,
  loadFluxRelease,
  makeFluxInstall,
} from '../../../src/factories/flux/index.js';
// The `typekro/flux/releases/v2.10.0` subpath.
import { fluxV2_10_0 as release } from '../../../src/factories/flux/install/releases/v2.10.0.js';
import { admissionErrors } from '../../utils/kro-admission.js';

interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string };
  spec: Record<string, unknown>;
}

const fluxInstall = await fluxInstallForVersion('v2.10.0');

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

const EXPECTED_KINDS = {
  ClusterRole: 3,
  ClusterRoleBinding: 2,
  CustomResourceDefinition: 15,
  Deployment: 7,
  Namespace: 1,
  NetworkPolicy: 3,
  ResourceQuota: 1,
  Service: 4,
  ServiceAccount: 7,
};

const CONTROLLERS = [
  'helm-controller',
  'image-automation-controller',
  'image-reflector-controller',
  'kustomize-controller',
  'notification-controller',
  'source-controller',
  'source-watcher',
];

function countByKind(items: readonly { kind: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return counts;
}

async function direct(spec: Record<string, unknown> = placement): Promise<Manifest[]> {
  const factory = await fluxInstall.factory('direct', { namespace: 'flux-system' });
  return (loadAll(factory.toYaml(spec as typeof placement)) as Manifest[]).filter(Boolean);
}

function podSpec(manifest: Manifest) {
  return (manifest.spec.template as { spec: { tolerations?: unknown[]; nodeSelector?: unknown } })
    .spec;
}

describe('pinned Flux v2.10.0 release', () => {
  it('records the sha256 of the install.yaml it was parsed from', () => {
    expect(release.version).toBe('v2.10.0');
    expect(release.sourceSha256).toBe(
      'a8c838ccd9be5d30eba9df87cd229b7c4eb80c0049fba1bc3b9840829f267f28'
    );
    expect(countByKind(release.documents)).toEqual(EXPECTED_KINDS);
  });

  it('renders every upstream object in direct mode, by kind', async () => {
    const manifests = await direct();
    expect(countByKind(manifests)).toEqual(EXPECTED_KINDS);
    expect(manifests.map((item) => `${item.kind}/${item.metadata.name}`).sort()).toEqual(
      release.documents.map((item) => `${item.kind}/${item.metadata.name}`).sort()
    );
    for (const item of manifests) {
      if (item.metadata.namespace !== undefined) {
        expect(item.metadata.namespace).toBe('flux-system');
      }
    }
  });

  it('applies the Kubernetes 1.33 CRD schema fix', async () => {
    const upstream = release.documents.find(
      (item) => item.metadata.name === 'helmreleases.helm.toolkit.fluxcd.io'
    );
    expect(needsCRDSchemaFix(upstream as unknown as KubernetesResource).needsFix).toBe(true);

    const crds = (await direct()).filter((item) => item.kind === 'CustomResourceDefinition');
    expect(crds.length).toBe(15);
    for (const crd of crds) {
      expect(needsCRDSchemaFix(crd as unknown as KubernetesResource).issues).toEqual([]);
    }
    const helmReleases = crds.find(
      (item) => item.metadata.name === 'helmreleases.helm.toolkit.fluxcd.io'
    );
    const versions = helmReleases?.spec.versions as Array<{
      name: string;
      schema: { openAPIV3Schema: { properties: { spec: { properties: { values: object } } } } };
    }>;
    const v2 = versions.find((version) => version.name === 'v2');
    expect(v2?.schema.openAPIV3Schema.properties.spec.properties.values).toMatchObject({
      type: 'object',
      'x-kubernetes-preserve-unknown-fields': true,
    });
  });

  it('applies the placement inputs to every controller', async () => {
    const controllers = (await direct()).filter((item) => item.kind === 'Deployment');
    expect(controllers.map((item) => item.metadata.name).sort()).toEqual(CONTROLLERS);
    for (const controller of controllers) {
      expect(podSpec(controller).tolerations).toEqual(placement.tolerations);
      expect(podSpec(controller).nodeSelector).toEqual(placement.nodeSelector);
    }
  });

  it('serializes to a KRO graph with readiness on every controller', () => {
    const docs = loadAll(fluxInstall.toYaml()) as Array<{
      kind: string;
      spec: {
        resources: Array<{ id: string; readyWhen?: string[]; template: { kind: string } }>;
        schema: { status: Record<string, string> };
      };
    }>;
    const graph = docs[docs.length - 1];
    expect(graph?.kind).toBe('ResourceGraphDefinition');
    // KRO hoists the Namespace out of the graph.
    const { Namespace: _hoisted, ...graphKinds } = EXPECTED_KINDS;
    expect(
      countByKind(graph?.spec.resources.map((resource) => resource.template) ?? [])
    ).toStrictEqual(graphKinds);
    const controllers =
      graph?.spec.resources.filter((resource) => resource.template.kind === 'Deployment') ?? [];
    expect(controllers.length).toBe(7);
    for (const controller of controllers) {
      expect(controller.readyWhen?.[0]).toContain(`${controller.id}.status.readyReplicas`);
      expect(graph?.spec.schema.status.ready).toContain(`${controller.id}.status.readyReplicas`);
    }
  });

  it('lowers to one Alchemy declaration per upstream object', async () => {
    const factory = await fluxInstall.factory('direct', { namespace: 'flux-system' });
    expect((await factory.toAlchemyResources(placement)).length).toBe(release.documents.length);
  });

  it('loads the same release on demand as the subpath export', async () => {
    expect(await loadFluxRelease('v2.10.0')).toBe(release);
  });

  it('refuses a different version', async () => {
    await expect(direct({ version: 'v2.7.4' })).rejects.toThrow('these manifests are v2.10.0');
    await expect(direct({ version: 'v2.8.0' })).rejects.toThrow('these manifests are v2.10.0');
    await expect(fluxInstallForVersion('v2.7.4')).rejects.toThrow(
      'No pinned Flux manifests for v2.7.4'
    );
    expect(admissionErrors(fluxInstall.toYaml(), 'FluxInstall', { version: 'v2.6.0' })).toEqual([
      'spec.version: "v2.6.0" is not one of ["v2.10.0"]',
    ]);
    expect(() => makeFluxInstall({ release: { ...release, version: '2.10.0' } })).toThrow(
      'Flux version must be pinned'
    );
  });
});
