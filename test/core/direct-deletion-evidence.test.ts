import { describe, expect, it, mock } from 'bun:test';
import { KubeConfig } from '@kubernetes/client-node';
import { type } from 'arktype';
import { DependencyGraph } from '../../src/core/dependencies/graph.js';
import { createDirectResourceFactory } from '../../src/core/deployment/direct-factory.js';
import { DirectDeploymentEngine } from '../../src/core/deployment/engine.js';
import { setMetadataField } from '../../src/core/metadata/index.js';
import type { DeployedResource, DeploymentStateRecord } from '../../src/core/types/deployment.js';
import type { KubernetesResource } from '../../src/core/types/kubernetes.js';
import { createMockK8sApi } from '../utils/mock-factories.js';

const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 });

function resource(name: string, kind = 'Widget'): DeployedResource {
  const manifest: KubernetesResource = {
    apiVersion: kind === 'Namespace' ? 'v1' : 'example.test/v1',
    kind,
    metadata: { name, uid: `${name}-uid`, ...(kind === 'Namespace' ? {} : { namespace: 'apps' }) },
  };
  if (kind === 'Namespace') setMetadataField(manifest, 'scope', 'cluster');
  return {
    id: name,
    kind,
    name,
    namespace: 'apps',
    manifest,
    status: 'deployed',
    deployedAt: new Date(),
  };
}

function fixture(
  resources: DeployedResource[],
  read: (name: string) => Promise<KubernetesResource>
) {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [{ name: 'inert', server: 'https://example.invalid', skipTLSVerify: false }],
    users: [{ name: 'inert' }],
    contexts: [{ name: 'inert', cluster: 'inert', user: 'inert' }],
    currentContext: 'inert',
  });
  const api = createMockK8sApi();
  const readCall = mock(async (target: { metadata?: { name?: string } }) =>
    read(target.metadata?.name ?? '')
  );
  const deleteCall = mock(async (..._args: unknown[]) => ({}));
  Object.defineProperty(api, 'read', { value: readCall, writable: true });
  Object.defineProperty(api, 'delete', { value: deleteCall, writable: true });
  const engine = new DirectDeploymentEngine(kubeConfig, api);
  // An empty legacy graph exercises the existing reverse-deployment fallback.
  const record: DeploymentStateRecord = {
    deploymentId: 'record',
    resources,
    dependencyGraph: new DependencyGraph(),
    startTime: new Date(),
    status: 'completed',
    options: { mode: 'direct' },
  };
  engine.loadDeploymentByInstance = async () => record;
  const factory = createDirectResourceFactory(
    'cleanup-evidence',
    {},
    {
      apiVersion: 'example.test/v1',
      kind: 'Example',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    undefined,
    { kubeConfig }
  );
  Object.defineProperty(factory, 'getDeploymentEngine', { value: () => engine });
  return { factory, engine, api, readCall, deleteCall, record };
}

describe('direct deletion evidence through manager and engine', () => {
  it('reports the observed same-UID finalizer and preserves earlier confirmed progress', async () => {
    const pending = resource('pending');
    const done = resource('done');
    const f = fixture([pending, done], async (name) => {
      if (name === 'done') throw notFound();
      return {
        ...pending.manifest,
        metadata: {
          ...pending.manifest.metadata,
          deletionTimestamp: '2026-01-01T00:00:00.000Z',
          finalizers: ['example.test/controller'],
          ownerReferences: [
            { apiVersion: 'example.test/v1', kind: 'Owner', name: 'owner', uid: 'owner-uid' },
          ],
          annotations: { private: 'not-for-the-result' },
        },
        spec: { private: 'not-for-the-result' },
        status: { phase: 'Pending' },
      };
    });

    const result = await f.factory.deleteInstance('demo', { timeout: 1 });

    expect(result.status).toBe('blocked');
    expect(result.deleted.map(({ name }) => name)).toEqual(['done']);
    expect(result.remaining).toEqual([
      {
        apiVersion: 'example.test/v1',
        kind: 'Widget',
        name: 'pending',
        namespace: 'apps',
        uid: 'pending-uid',
        deletionTimestamp: '2026-01-01T00:00:00.000Z',
        finalizers: ['example.test/controller'],
        owners: [{ apiVersion: 'example.test/v1', kind: 'Owner', name: 'owner', uid: 'owner-uid' }],
      },
    ]);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]?.code).toBe('FINALIZERS_REMAIN');
    expect(result.blockers[0]?.resource).toEqual(result.remaining[0]);
    expect(JSON.stringify(result)).not.toContain('not-for-the-result');
    expect(f.readCall).toHaveBeenCalledTimes(2); // existing polling only, no diagnostic read
    expect(f.deleteCall).toHaveBeenCalledTimes(2);
  });

  it('does not claim a known UID remains when the polling response omits its identity', async () => {
    const f = fixture([resource('unknown')], async () => ({
      metadata: { finalizers: ['unproven-owner'] },
    }));

    const result = await f.factory.deleteInstance('demo', { timeout: 1 });

    expect(result.status).toBe('blocked');
    expect(result.deleted).toEqual([]);
    expect(result.remaining).toEqual([]);
    expect(result.blockers[0]).toMatchObject({
      code: 'CLEANUP_ERROR',
      resource: { name: 'unknown', uid: 'unknown-uid' },
    });
    expect(JSON.stringify(result)).not.toContain('unproven-owner');
    expect(f.readCall).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a stale observation after a later read failure or expose SDK error text', async () => {
    let reads = 0;
    const pending = resource('pending');
    const privateFailure = new Error('Cannot rollback: private SDK response material');
    const f = fixture([pending], async () => {
      if (++reads === 1)
        return {
          ...pending.manifest,
          metadata: { ...pending.manifest.metadata, finalizers: ['old-finalizer'] },
        };
      throw privateFailure;
    });

    const result = await f.factory.deleteInstance('demo', { timeout: 10_000 });

    expect(result.status).toBe('blocked');
    expect(result.deleted).toEqual([]);
    expect(result.remaining).toEqual([]);
    expect(result.blockers).toMatchObject([
      {
        code: 'CLEANUP_ERROR',
        resource: { kind: 'Widget', name: 'pending', uid: 'pending-uid' },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private SDK');
    expect(JSON.stringify(result)).not.toContain('old-finalizer');
    expect(f.readCall).toHaveBeenCalledTimes(2);
  });

  it('retains the original error internally and reports a failed DELETE without assuming presence', async () => {
    const target = resource('refused');
    const failure = new Error('private DELETE response');
    const f = fixture([target], async () => {
      throw notFound();
    });
    f.api.delete = mock(async () => {
      throw failure;
    });

    const result = await f.engine.rollbackRecord(f.record);

    expect(result.errors[0]?.error).toBe(failure);
    expect(result.deletedResources).toEqual([]);
    expect(result.remainingResources).toEqual([]);
    expect(result.deletionBlockers).toMatchObject([
      {
        code: 'CLEANUP_ERROR',
        resource: { kind: 'Widget', name: 'refused', uid: 'refused-uid' },
      },
    ]);
    expect(JSON.stringify(result.deletionBlockers)).not.toContain('private DELETE');
    expect(f.readCall).not.toHaveBeenCalled();
  });

  it('keeps confirmed progress when fresh authorization rejects a later target', async () => {
    const f = fixture([resource('refused'), resource('done')], async () => {
      throw notFound();
    });

    const result = await f.factory.deleteInstance('demo', {
      beforeDeleteResource: async ({ name }) => {
        if (name === 'refused') throw new Error('private authorization cause');
        return { presence: 'present', uid: 'done-uid', resourceVersion: '7' };
      },
    });

    expect(result.status).toBe('blocked');
    expect(result.deleted.map(({ name }) => name)).toEqual(['done']);
    expect(result.remaining).toEqual([]);
    expect(result.blockers[0]).toMatchObject({
      code: 'CLEANUP_ERROR',
      resource: { name: 'refused' },
    });
    expect(f.deleteCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('private authorization cause');
  });

  it('accepts fresh authorized absence without a DELETE or diagnostic read', async () => {
    const f = fixture([resource('absent')], async () => {
      throw new Error('must not read');
    });

    const result = await f.factory.deleteInstance('demo', {
      beforeDeleteResource: async () => ({ presence: 'absent' }),
    });

    expect(result.status).toBe('complete');
    expect(result.deleted.map(({ name }) => name)).toEqual(['absent']);
    expect(result.remaining).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(f.deleteCall).not.toHaveBeenCalled();
    expect(f.readCall).not.toHaveBeenCalled();
  });

  it('confirms the original UID gone without waiting on or deleting its replacement', async () => {
    const target = resource('replaced');
    const f = fixture([target], async () => ({
      ...target.manifest,
      metadata: { ...target.manifest.metadata, uid: 'replacement-uid' },
    }));

    const result = await f.factory.deleteInstance('demo', {
      beforeDeleteResource: async () => ({
        presence: 'present',
        uid: 'replaced-uid',
        resourceVersion: '7',
      }),
    });

    expect(result.status).toBe('complete');
    expect(result.deleted[0]?.uid).toBe('replaced-uid');
    expect(result.remaining).toEqual([]);
    expect(f.deleteCall).toHaveBeenCalledTimes(1);
    expect(f.deleteCall.mock.calls[0]?.[6]).toEqual({
      preconditions: { uid: 'replaced-uid', resourceVersion: '7' },
    });
    expect(f.readCall).toHaveBeenCalledTimes(1);
  });

  it('preserves completed children and an earlier absent Namespace after later completion fails', async () => {
    const f = fixture(
      [resource('later', 'Namespace'), resource('gone', 'Namespace'), resource('done')],
      async (name) => {
        if (name === 'later') throw new Error('private namespace read response');
        throw notFound();
      }
    );

    const result = await f.factory.deleteInstance('demo', { timeout: 1 });

    expect(result.status).toBe('blocked');
    expect(result.deleted.map(({ name }) => name)).toEqual(['done', 'gone']);
    expect(result.remaining).toEqual([]);
    expect(result.blockers).toMatchObject([
      {
        code: 'CLEANUP_ERROR',
        resource: { apiVersion: 'v1', kind: 'Namespace', name: 'later', uid: 'later-uid' },
      },
    ]);
    expect(result.deleted.some(({ name }) => name === 'later')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private namespace read response');
    expect(f.deleteCall).toHaveBeenCalledTimes(3);
    expect(f.readCall).toHaveBeenCalledTimes(3);
  });

  it('preserves cancellation identity before effects', async () => {
    const f = fixture([resource('pending')], async () => {
      throw notFound();
    });
    const controller = new AbortController();
    const reason = new Error('caller cancellation');
    controller.abort(reason);

    await expect(f.factory.deleteInstance('demo', { abortSignal: controller.signal })).rejects.toBe(
      reason
    );
    expect(f.deleteCall).not.toHaveBeenCalled();
    expect(f.readCall).not.toHaveBeenCalled();
  });
});
