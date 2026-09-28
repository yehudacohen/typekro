import { describe, expect, it } from 'bun:test';
import type { KubernetesObject, V1DeleteOptions } from '@kubernetes/client-node';
import { guardKubernetesObjectApi } from '../../src/alchemy/kubernetes-effect-gate.js';

const resource: KubernetesObject = {
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: { name: 'settings', namespace: 'default' },
};

describe('effect-time Kubernetes mutation admission', () => {
  it('leaves a direct resource outside the guarded scope unchanged', async () => {
    let written: KubernetesObject | undefined;
    const api = guardKubernetesObjectApi(
      {
        async create(input: KubernetesObject) {
          written = input;
          return input;
        },
      },
      async () => undefined
    );
    await api.create(resource);
    expect(written).toBe(resource);
  });

  it('authorizes immediately before each create attempt, including a retry', async () => {
    const events: string[] = [];
    const fake = {
      async create(input: KubernetesObject) {
        events.push(`write:${input.metadata?.name}`);
        return input;
      },
    };
    const api = guardKubernetesObjectApi(fake, async ({ method }) => {
      events.push(`authorize:${method}`);
      return { operation: 'create' };
    });

    await api.create(resource);
    await api.create(resource);
    expect(events).toEqual([
      'authorize:create',
      'write:settings',
      'authorize:create',
      'write:settings',
    ]);
  });

  it('places fresh update preconditions on patch and delete without changing the caller resource', async () => {
    const writes: Array<{ method: string; resource?: KubernetesObject; body?: V1DeleteOptions }> =
      [];
    const fake = {
      async patch(input: KubernetesObject) {
        writes.push({ method: 'patch', resource: input });
        return input;
      },
      async delete(
        input: KubernetesObject,
        _pretty?: string,
        _dryRun?: string,
        _grace?: number,
        _orphan?: boolean,
        _policy?: string,
        body?: V1DeleteOptions
      ) {
        writes.push({ method: 'delete', resource: input, ...(body ? { body } : {}) });
        return {};
      },
    };
    let version = 4;
    const api = guardKubernetesObjectApi(fake, async () => ({
      operation: 'update',
      uid: 'retained-uid',
      resourceVersion: String(version++),
    }));

    await api.patch(resource);
    await api.delete(resource);
    expect(writes[0]?.resource?.metadata).toMatchObject({
      name: 'settings',
      uid: 'retained-uid',
      resourceVersion: '4',
    });
    expect(writes[1]?.body?.preconditions).toEqual({
      uid: 'retained-uid',
      resourceVersion: '5',
    });
    expect(resource.metadata?.resourceVersion).toBeUndefined();
  });

  it('rejects a changed incumbent or a create authority on a patch before writing', async () => {
    let writes = 0;
    const fake = {
      async patch(input: KubernetesObject) {
        writes++;
        return input;
      },
    };
    const api = guardKubernetesObjectApi(fake, async () => ({
      operation: 'update',
      uid: 'current-uid',
      resourceVersion: '8',
    }));
    await expect(
      api.patch({
        ...resource,
        metadata: { ...resource.metadata, uid: 'stale-uid' },
      })
    ).rejects.toThrow('conflicting incumbent');
    const createOnlyApi = guardKubernetesObjectApi(fake, async () => ({ operation: 'create' }));
    await expect(createOnlyApi.patch(resource)).rejects.toThrow('Only server-side apply');
    expect(writes).toBe(0);
  });

  it('uses atomic create for a proven absent server-side apply and preserves request options', async () => {
    const writes: Array<{ method: string; args: unknown[] }> = [];
    const api = guardKubernetesObjectApi(
      {
        async patch(...args: unknown[]) {
          writes.push({ method: 'patch', args });
          return resource;
        },
        async create(...args: unknown[]) {
          writes.push({ method: 'create', args });
          return resource;
        },
      },
      async () => ({ operation: 'create' })
    );
    const options = { authMethods: {} };
    await api.patch(
      resource,
      undefined,
      'All',
      'typekro',
      false,
      'application/apply-patch+yaml',
      options
    );
    expect(writes).toEqual([
      {
        method: 'create',
        args: [resource, undefined, 'All', 'typekro', options],
      },
    ]);
  });

  it('refuses a merge patch or incumbent metadata with create-only authority', async () => {
    let writes = 0;
    const api = guardKubernetesObjectApi(
      {
        async patch(..._args: unknown[]) {
          writes++;
        },
        async create(..._args: unknown[]) {
          writes++;
        },
      },
      async () => ({ operation: 'create' })
    );
    await expect(
      api.patch(resource, undefined, undefined, undefined, false, 'application/merge-patch+json')
    ).rejects.toThrow('Only server-side apply');
    await expect(
      api.patch(
        { ...resource, metadata: { ...resource.metadata, uid: 'incumbent' } },
        undefined,
        undefined,
        'typekro',
        false,
        'application/apply-patch+yaml'
      )
    ).rejects.toThrow('cannot carry incumbent metadata');
    expect(writes).toBe(0);
  });

  it('holds and releases a host permit through a failed Kubernetes write', async () => {
    const events: string[] = [];
    const api = guardKubernetesObjectApi(
      {
        async create(_input: KubernetesObject) {
          events.push('write');
          throw new Error('API unavailable');
        },
      },
      async () => {
        events.push('authorize');
        return {
          precondition: { operation: 'create' },
          release() {
            events.push('release');
          },
        };
      }
    );
    await expect(api.create(resource)).rejects.toThrow('API unavailable');
    expect(events).toEqual(['authorize', 'write', 'release']);
  });

  it('skips a proven absent delete without calling Kubernetes', async () => {
    const events: string[] = [];
    const api = guardKubernetesObjectApi(
      {
        async delete(_input: KubernetesObject) {
          events.push('write');
          return { status: 'Success' };
        },
      },
      async () => ({
        skip: 'already-absent',
        release() {
          events.push('release');
        },
      })
    );
    await api.delete(resource);
    expect(events).toEqual(['release']);
  });
});
