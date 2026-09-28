/**
 * Direct-mode `toAlchemyResources()` over compositions that iterate a spec array.
 *
 * Direct mode expands each collection body into one concrete resource per item. Every expanded
 * resource must become its own Alchemy declaration whose durable execution record is concretized
 * from that item's bindings — the same resources, names and specs that direct `toYaml()` renders.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import yaml from 'js-yaml';

import { resourceFromDirectArtifactRecordForTest } from '../../../src/alchemy/resource-registration.js';
import type {
  AlchemyResourceDeclaration,
  TypeKroResourceProps,
} from '../../../src/alchemy/types.js';
import { decodeDirectArtifactExecutionRecord } from '../../../src/core/planning/index.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';
import { ConfigMap, Deployment, Service } from '../../../src/factories/simple/index.js';
import { kubernetesComposition } from '../../../src/index.js';

const RegionSpec = type({
  name: 'string',
  image: 'string',
  regions: type({ name: 'string', replicas: 'number', zone: 'string' }).array(),
});
type RegionSpecType = typeof RegionSpec.infer;

function regionalComposition() {
  return kubernetesComposition(
    {
      name: 'regional-app',
      apiVersion: 'v1alpha1',
      kind: 'RegionalApp',
      spec: RegionSpec,
      status: type({ total: 'number' }),
    },
    (spec) => {
      for (const region of spec.regions) {
        Deployment({
          id: 'regionDeployment',
          name: `${spec.name}-${region.name}`,
          image: spec.image,
          replicas: region.replicas,
          env: { ZONE: region.zone, REGION: region.name },
        });
        Service({
          id: 'regionService',
          name: `${spec.name}-${region.name}-svc`,
          selector: { app: `${spec.name}-${region.name}` },
          ports: [{ port: 80 }],
        });
      }
      return { total: spec.regions.length };
    }
  );
}

function spec(count: number): RegionSpecType {
  const regions = [
    { name: 'us-east', replicas: 1, zone: 'zone-a' },
    { name: 'eu-west', replicas: 2, zone: 'zone-b' },
    { name: 'ap-south', replicas: 3, zone: 'zone-c' },
  ];
  return { name: 'shop', image: 'nginx:1.27', regions: regions.slice(0, count) };
}

/** Plain JSON view of a manifest: drops the graph `id` and any non-enumerable metadata. */
function plain(resource: unknown): Record<string, unknown> {
  const { id: _id, ...manifest } = JSON.parse(JSON.stringify(resource)) as Record<string, unknown>;
  return manifest;
}

function manifestKey(manifest: Record<string, unknown>): string {
  const metadata = manifest.metadata as { name?: string } | undefined;
  return `${String(manifest.kind)}/${metadata?.name ?? ''}`;
}

function restoredProps(declaration: AlchemyResourceDeclaration) {
  return JSON.parse(JSON.stringify(declaration.props)) as TypeKroResourceProps<
    Enhanced<unknown, unknown>
  >;
}

describe('direct toAlchemyResources with forEach', () => {
  it.each([0, 1, 3])('emits one declaration per resource for %i item(s)', async (count) => {
    const factory = regionalComposition().factory('direct', { namespace: 'apps' });
    const declarations = await factory.toAlchemyResources(spec(count));

    expect(declarations).toHaveLength(count * 2);
    expect(new Set(declarations.map((declaration) => declaration.id)).size).toBe(count * 2);
    const names = declarations.map(
      (declaration) =>
        `${declaration.props.resource.kind}/${declaration.props.resource.metadata.name}`
    );
    for (const region of spec(count).regions) {
      expect(names).toContain(`Deployment/shop-${region.name}`);
      expect(names).toContain(`Service/shop-${region.name}-svc`);
    }
    for (const declaration of declarations) {
      expect(declaration.props.deploymentStrategy).toBe('direct');
      expect(JSON.stringify(declaration.props)).not.toContain('$item');
    }
  });

  it('resolves nested item fields per expanded resource', async () => {
    const factory = regionalComposition().factory('direct', { namespace: 'apps' });
    const declarations = await factory.toAlchemyResources(spec(3));

    for (const region of spec(3).regions) {
      const deployment = declarations.find(
        (declaration) => declaration.props.resource.metadata.name === `shop-${region.name}`
      );
      const manifest = plain(deployment?.props.resource) as {
        spec: {
          replicas: number;
          template: {
            spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> };
          };
        };
      };
      expect(manifest.spec.replicas).toBe(region.replicas);
      expect(manifest.spec.template.spec.containers[0]?.env).toEqual(
        expect.arrayContaining([
          { name: 'ZONE', value: region.zone },
          { name: 'REGION', value: region.name },
        ])
      );
    }
  });

  it.each([0, 1, 3])('matches direct toYaml() names and specs for %i item(s)', async (count) => {
    const factory = regionalComposition().factory('direct', { namespace: 'apps' });
    const rendered = yaml
      .loadAll(factory.toYaml(spec(count)))
      .filter((document): document is Record<string, unknown> => !!document)
      .map(plain);
    // Alchemy carries the target namespace in `props.namespace` rather than on the manifest.
    const declared = (await factory.toAlchemyResources(spec(count))).map((declaration) => {
      const manifest = plain(declaration.props.resource);
      return {
        ...manifest,
        metadata: {
          ...(manifest.metadata as Record<string, unknown>),
          namespace: declaration.props.namespace,
        },
      };
    });

    const byKey = (manifests: Record<string, unknown>[]) =>
      Object.fromEntries(manifests.map((manifest) => [manifestKey(manifest), manifest]));
    expect(byKey(declared)).toEqual(byKey(rendered));
  });

  it('writes a concrete execution record per expanded resource that rehydrates to it', async () => {
    const factory = regionalComposition().factory('direct', { namespace: 'apps' });
    const declarations = await factory.toAlchemyResources(spec(3));

    const resourceIds = declarations.map((declaration) => declaration.props.resourceId);
    expect(resourceIds).toEqual(
      expect.arrayContaining([
        'regionDeployment',
        'regionDeployment-1',
        'regionDeployment-2',
        'regionService',
        'regionService-1',
        'regionService-2',
      ])
    );
    for (const declaration of declarations) {
      const record = decodeDirectArtifactExecutionRecord(
        declaration.props.artifactExecutionRecord ?? ''
      );
      expect(record.artifact.sourceNodeId).toBe(declaration.props.resourceId as string);
      expect(record.artifact.iteration).toBeUndefined();

      const rehydrated = resourceFromDirectArtifactRecordForTest(restoredProps(declaration));
      expect(plain(rehydrated)).toEqual(plain(declaration.props.resource));
    }
  });

  it('wires each item that consumes a shared resource to that one producer', async () => {
    const composition = kubernetesComposition(
      {
        name: 'regional-config',
        apiVersion: 'v1alpha1',
        kind: 'RegionalConfig',
        spec: RegionSpec,
        status: type({ total: 'number' }),
      },
      (spec) => {
        const database = Deployment({ id: 'database', name: `${spec.name}-db`, image: 'db:1' });
        for (const region of spec.regions) {
          ConfigMap({
            id: 'regionConfig',
            name: `${spec.name}-${region.name}-cfg`,
            data: { zone: region.zone, dbReady: `${database.status.readyReplicas}` },
          });
        }
        return { total: spec.regions.length };
      }
    );
    const factory = composition.factory('direct', { namespace: 'apps' });
    const declarations = await factory.toAlchemyResources(spec(3));
    const database = declarations.find(
      (declaration) => declaration.props.resourceId === 'database'
    ) as AlchemyResourceDeclaration;
    const configs = declarations.filter((declaration) =>
      declaration.props.resourceId?.startsWith('regionConfig')
    );

    expect(database).toBeDefined();
    expect(configs).toHaveLength(3);
    for (const [index, config] of configs.entries()) {
      expect(config.dependsOn).toEqual([database.id]);
      const record = decodeDirectArtifactExecutionRecord(
        config.props.artifactExecutionRecord ?? ''
      );
      expect(record.dependencies).toEqual(['database']);
      expect((config.props.resource as { data?: { zone?: string } }).data?.zone).toBe(
        spec(3).regions[index]?.zone as string
      );

      const restored = restoredProps(config);
      restored.dependencies = [
        {
          resource: database.props.resource,
          resourceId: 'database',
          namespace: 'apps',
          deploymentStrategy: 'direct',
          deployedResource: {
            ...database.props.resource,
            status: { readyReplicas: 1 },
          } as Enhanced<unknown, unknown>,
          ready: true,
          deployedAt: 0,
        },
      ];
      expect(resourceFromDirectArtifactRecordForTest(restored)?.kind).toBe('ConfigMap');
    }
  });

  it('leaves KRO-mode forEach output symbolic', () => {
    const rendered = regionalComposition().factory('kro', { namespace: 'apps' }).toYaml();

    expect(rendered).toContain('forEach:');
    expect(rendered).toContain('${');
  });
});
