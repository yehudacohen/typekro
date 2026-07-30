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

function legacyCrd(resourceVersion: string): KubernetesObject {
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
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
  test('resumes an interrupted stable-RGD migration and retries CRD conflicts from fresh state', async () => {
    const read = mock(async () => ({
      ...desiredRgd(),
      metadata: { name: 'application', generation: 2 },
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
    const patch = mock(async (resource: KubernetesObject) => {
      if (resource.kind === 'CustomResourceDefinition') {
        crdVersions.push(resource.metadata?.resourceVersion ?? '');
        if (crdVersions.length === 1) {
          throw { statusCode: 409, message: 'conflict' };
        }
      }
      return resource;
    });

    await migrateLegacyKroArtifactBindingCrd({} as KubeConfig, desiredRgd(), {
      api: { read, list, patch } as never,
    });

    expect(crdVersions).toEqual(['10', '11']);
    expect(list).toHaveBeenCalledTimes(2);
    const crdPatches = patch.mock.calls
      .map(([resource]) => resource as KubernetesObject)
      .filter((resource: KubernetesObject) => resource.kind === 'CustomResourceDefinition');
    const finalCrdPatch = crdPatches[crdPatches.length - 1];
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
    expect(
      patch.mock.calls.some(
        ([resource]) =>
          (resource as KubernetesObject).metadata?.annotations?.[
            'typekro.io/artifact-binding-migration-retry'
          ] !== undefined
      )
    ).toBe(true);
  });
});
