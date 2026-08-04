import { describe, expect, mock, test } from 'bun:test';
import type { KubeConfig, KubernetesObject } from '@kubernetes/client-node';
import { migrateLegacyKroArtifactBindingCrd } from '../../src/core/deployment/kro-artifact-binding-migration.js';
import {
  kroArtifactOutputField,
  kroArtifactRequirementField,
} from '../../src/core/planning/values.js';

const requirement = kroArtifactRequirementField('build');
const output = kroArtifactOutputField('image');

function desiredRgd(): KubernetesObject {
  return {
    apiVersion: 'kro.run/v1alpha1',
    kind: 'ResourceGraphDefinition',
    metadata: { name: 'application' },
    spec: {
      schema: {
        apiVersion: 'v1alpha1',
        group: 'application.example',
        kind: 'Application',
        spec: {
          typekroArtifactBindings: 'map[string]map[string]string',
        },
      },
    },
  } as unknown as KubernetesObject;
}

function defaultGroupDesiredRgd(): KubernetesObject {
  const resource = structuredClone(desiredRgd());
  const schema = Reflect.get(Reflect.get(resource, 'spec'), 'schema') as Record<
    string,
    unknown
  >;
  Reflect.deleteProperty(schema, 'group');
  return resource;
}

function legacyCrd(resourceVersion: string): KubernetesObject {
  return {
    // Match KubernetesObjectApi list deserialization: TypeMeta may be omitted
    // from each returned item even though the list endpoint determines it.
    metadata: {
      name: 'applications.application.example',
      resourceVersion,
    },
    spec: {
      group: 'application.example',
      names: { kind: 'Application' },
      versions: [
        {
          name: 'v1alpha1',
          schema: {
            openAPIV3Schema: {
              properties: {
                spec: {
                  type: 'object',
                  properties: {
                    typekroArtifactBindings: {
                      type: 'object',
                      properties: {
                        [requirement]: {
                          type: 'object',
                          properties: {
                            [output]: { type: 'string' },
                          },
                        },
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
  } as unknown as KubernetesObject;
}

describe('KRO artifact-binding migration', () => {
  test('uses KRO default group when the RGD schema declares a version only', async () => {
    const desired = defaultGroupDesiredRgd();
    const live = structuredClone(desired);
    live.metadata = {
      name: 'application',
      generation: 1,
      resourceVersion: '20',
    };
    const crd = legacyCrd('10');
    const crdSpec = Reflect.get(crd, 'spec') as Record<string, unknown>;
    crdSpec.group = 'kro.run';
    crd.metadata = {
      ...crd.metadata,
      name: 'applications.kro.run',
    };
    const list = mock(async () => ({ items: [crd] }));

    await migrateLegacyKroArtifactBindingCrd({} as KubeConfig, desired, {
      api: {
        read: mock(async () => live),
        list,
        replace: mock(async (resource: KubernetesObject) => resource),
      } as never,
    });

    expect(list).toHaveBeenCalledTimes(1);
  });

  test('retries complete RGD replacements and never serializes them as generic patches', async () => {
    let readCount = 0;
    const read = mock(async () => ({
      ...desiredRgd(),
      metadata: {
        name: 'application',
        generation: 2,
        resourceVersion: readCount++ === 0 ? '20' : '21',
        labels: { retained: 'true' },
      },
      status: {
        conditions: [{ type: 'KindReady', status: 'False', observedGeneration: 2 }],
      },
    }));
    const replace = mock(async (resource: KubernetesObject) => {
      if (
        resource.kind === 'ResourceGraphDefinition' &&
        resource.metadata?.resourceVersion === '20'
      ) {
        throw { statusCode: 409, message: 'conflict' };
      }
      return resource;
    });

    await migrateLegacyKroArtifactBindingCrd({} as KubeConfig, desiredRgd(), {
      api: {
        read,
        list: mock(async () => ({ items: [legacyCrd('10')] })),
        replace,
      } as never,
    });

    const rgdReplacements = replace.mock.calls
      .map(([resource]) => resource as KubernetesObject)
      .filter((resource) => resource.kind === 'ResourceGraphDefinition');
    expect(rgdReplacements.map((resource) => resource.metadata?.resourceVersion)).toEqual([
      '20',
      '21',
      '21',
    ]);
    expect(rgdReplacements[1]).toMatchObject({
      metadata: { labels: { retained: 'true' } },
      spec: Reflect.get(desiredRgd(), 'spec'),
    });
    expect(Reflect.has(rgdReplacements[1] ?? {}, 'status')).toBe(false);
  });

  test('resumes an interrupted stable-RGD migration and retries CRD conflicts from fresh state', async () => {
    const read = mock(async () => ({
      ...desiredRgd(),
      metadata: { name: 'application', generation: 2, resourceVersion: '20' },
      status: {
        conditions: [
          {
            type: 'KindReady',
            status: 'False',
            observedGeneration: 2,
          },
        ],
      },
    }));
    const list = mock()
      .mockResolvedValueOnce({ items: [legacyCrd('10')] })
      .mockResolvedValueOnce({ items: [legacyCrd('11')] });
    const crdVersions: string[] = [];
    const replacementKinds: string[] = [];
    const replace = mock(async (resource: KubernetesObject) => {
      replacementKinds.push(resource.kind ?? '');
      if (resource.kind === 'ResourceGraphDefinition') return resource;
      crdVersions.push(resource.metadata?.resourceVersion ?? '');
      if (crdVersions.length === 1) {
        throw { statusCode: 409, message: 'conflict' };
      }
      return resource;
    });

    await migrateLegacyKroArtifactBindingCrd({} as KubeConfig, desiredRgd(), {
      api: { read, list, replace } as never,
    });

    expect(crdVersions).toEqual(['10', '11']);
    expect(list).toHaveBeenCalledTimes(2);
    const finalCrdPatch = replace.mock.calls
      .map(([resource]) => resource as KubernetesObject)
      .reverse()
      .find((resource) => resource.kind === 'CustomResourceDefinition');
    expect(finalCrdPatch).toMatchObject({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
    });
    const versions = Reflect.get(
      Reflect.get(finalCrdPatch ?? {}, 'spec') ?? {},
      'versions'
    ) as Array<{
      schema?: { openAPIV3Schema?: { properties?: Record<string, unknown> } };
    }>;
    const spec = versions[0]?.schema?.openAPIV3Schema?.properties?.spec;
    const properties =
      spec && typeof spec === 'object' ? Reflect.get(spec, 'properties') : undefined;
    expect(Reflect.get(properties, 'typekroArtifactBindings')).toEqual({
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: { type: 'string' },
      },
    });
    expect(replacementKinds).toEqual([
      'ResourceGraphDefinition',
      'CustomResourceDefinition',
      'CustomResourceDefinition',
      'ResourceGraphDefinition',
    ]);
    const finalRgdReplacement = replace.mock.calls.at(-1)?.[0] as KubernetesObject | undefined;
    expect(
      finalRgdReplacement?.metadata?.annotations?.['typekro.io/artifact-binding-migration-retry']
    ).toBeDefined();
  });
});
