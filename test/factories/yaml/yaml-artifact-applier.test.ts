import { describe, expect, it, mock } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { ServerSideApplyConflictError } from '../../../src/core/deployment/errors.js';
import type { DeploymentContext } from '../../../src/core/types/deployment.js';
import type { KubernetesResource } from '../../../src/core/types/kubernetes.js';
import {
  applyYamlArtifact,
  yamlDeploymentApplyPolicy,
} from '../../../src/factories/kubernetes/yaml/yaml-artifact-applier.js';

const manifest: KubernetesResource = {
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: { name: 'settings', namespace: 'apps' },
  data: { mode: 'strict' },
};

function contextWithApi(api: Record<string, unknown>): DeploymentContext {
  return {
    kubernetesApi: api as unknown as k8s.KubernetesObjectApi,
    deployedResources: new Map(),
    resolveReference: async () => undefined,
  };
}

describe('YAML artifact application', () => {
  it('maps every compatibility strategy to an explicit artifact policy', () => {
    expect(yamlDeploymentApplyPolicy('replace')).toEqual({
      strategy: 'create-or-patch',
      existingResource: 'patch',
      immutableFieldPolicy: 'fail',
    });
    expect(yamlDeploymentApplyPolicy('skipIfExists')).toEqual({
      strategy: 'create-or-patch',
      existingResource: 'warn',
      immutableFieldPolicy: 'fail',
    });
    expect(yamlDeploymentApplyPolicy('fail')).toEqual({ strategy: 'create-only' });
    expect(
      yamlDeploymentApplyPolicy('serverSideApply', {
        fieldManager: 'fixture-owner',
        forceConflicts: true,
      })
    ).toEqual({
      strategy: 'server-side-apply',
      fieldManager: 'fixture-owner',
      fieldConflictPolicy: 'force-owned-fields',
      immutableFieldPolicy: 'fail',
    });
  });

  it('uses the canonical SSA operation and field-ownership settings', async () => {
    const patch = mock(
      async (
        _resource: k8s.KubernetesObject,
        _pretty?: string,
        _dryRun?: string,
        _fieldManager?: string,
        _force?: boolean,
        _contentType?: string
      ) => manifest
    );
    const api = {
      patch,
      read: mock(async () => manifest),
      create: mock(async () => manifest),
      delete: mock(async () => undefined),
    };

    await applyYamlArtifact(manifest, 'serverSideApply', contextWithApi(api), 'fixture', {
      fieldManager: 'fixture-owner',
      forceConflicts: true,
    });

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[3]).toBe('fixture-owner');
    expect(patch.mock.calls[0]?.[4]).toBe(true);
    expect(patch.mock.calls[0]?.[5]).toBe('application/apply-patch+yaml');
  });

  it('does not degrade SSA ownership conflicts into legacy conflict handling', async () => {
    const api = {
      patch: mock(async () => {
        throw Object.assign(new Error('field is owned by another manager'), { statusCode: 409 });
      }),
      read: mock(async () => manifest),
      create: mock(async () => manifest),
      delete: mock(async () => undefined),
    };

    await expect(
      applyYamlArtifact(manifest, 'serverSideApply', contextWithApi(api), 'fixture')
    ).rejects.toBeInstanceOf(ServerSideApplyConflictError);
  });

  it('fails closed when an SSA CRD is rejected by admission', async () => {
    const crd: KubernetesResource = {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'widgets.example.com' },
      spec: {},
    };
    const api = {
      patch: mock(async () => {
        throw Object.assign(new Error('invalid CRD schema'), { statusCode: 422 });
      }),
      read: mock(async () => crd),
      create: mock(async () => crd),
      delete: mock(async () => undefined),
    };

    await expect(
      applyYamlArtifact(crd, 'serverSideApply', contextWithApi(api), 'fixture')
    ).rejects.toThrow('invalid CRD schema');
  });

  it('uses the canonical create path when a YAML artifact is absent', async () => {
    const create = mock(async () => manifest);
    const api = {
      read: mock(async () => {
        throw Object.assign(new Error('not found'), { statusCode: 404 });
      }),
      create,
      patch: mock(async () => manifest),
      delete: mock(async () => undefined),
    };

    const result = await applyYamlArtifact(manifest, 'replace', contextWithApi(api), 'fixture');

    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      name: 'settings',
      namespace: 'apps',
    });
  });
});
