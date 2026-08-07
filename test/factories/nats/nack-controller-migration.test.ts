import { describe, expect, it } from 'bun:test';
import type { KubernetesObject, KubernetesObjectApi } from '@kubernetes/client-node';
import { retireLegacyNackController } from '../../../src/factories/nats/compositions/nack-controller-migration.js';

function legacyRelease(overrides: Partial<KubernetesObject['metadata']> = {}): KubernetesObject {
  return {
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: {
      name: 'nack',
      namespace: 'nats-system',
      uid: 'legacy-uid',
      labels: {
        'typekro.io/factory-name': 'nats-bootstrap',
        'typekro.io/instance-name': 'nats',
      },
      annotations: {
        'typekro.io/factory-name': 'nats-bootstrap',
        'typekro.io/instance-name': 'nats',
        'typekro.io/resource-id': 'nackHelmRelease',
      },
      ...overrides,
    },
    spec: {
      chart: {
        spec: {
          chart: 'nack',
        },
      },
    },
  } as unknown as KubernetesObject;
}

describe('legacy NACK controller retirement', () => {
  it('deletes only the exact v0.33.5 child with a UID precondition', async () => {
    const live = legacyRelease();
    const reads: unknown[] = [live, { code: 404 }];
    const deletions: unknown[][] = [];
    const api = {
      read: async () => {
        const result = reads.shift();
        if (result instanceof Error) throw result;
        if (
          result &&
          typeof result === 'object' &&
          'code' in result &&
          (result as { code?: number }).code === 404
        ) {
          throw result;
        }
        return result;
      },
      delete: async (...args: unknown[]) => {
        deletions.push(args);
        return {};
      },
    } as unknown as KubernetesObjectApi;

    await retireLegacyNackController({
      namespace: 'nats-system',
      instanceName: 'nats',
      kubernetesApi: api,
    });

    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.[0]).toBe(live);
    expect(deletions[0]?.[5]).toBe('Foreground');
    expect(deletions[0]?.[6]).toEqual({ preconditions: { uid: 'legacy-uid' } });
  });

  it('is idempotent when the legacy release is already absent', async () => {
    let deleted = false;
    const api = {
      read: async () => {
        throw { code: 404 };
      },
      delete: async () => {
        deleted = true;
        return {};
      },
    } as unknown as KubernetesObjectApi;

    await retireLegacyNackController({
      namespace: 'nats-system',
      instanceName: 'nats',
      kubernetesApi: api,
    });
    expect(deleted).toBe(false);
  });

  it('fails closed for a same-named release without exact TypeKro ownership', async () => {
    let deleted = false;
    const api = {
      read: async () =>
        legacyRelease({
          annotations: {
            'typekro.io/factory-name': 'another-factory',
            'typekro.io/instance-name': 'nats',
            'typekro.io/resource-id': 'nackHelmRelease',
          },
        }),
      delete: async () => {
        deleted = true;
        return {};
      },
    } as unknown as KubernetesObjectApi;

    await expect(
      retireLegacyNackController({
        namespace: 'nats-system',
        instanceName: 'nats',
        kubernetesApi: api,
      })
    ).rejects.toThrow(/Refusing to retire HelmRelease/);
    expect(deleted).toBe(false);
  });

  it('fails closed if a replacement object appears while deletion is pending', async () => {
    const api = {
      read: async () => legacyRelease({ uid: crypto.randomUUID() }),
      delete: async () => ({}),
    } as unknown as KubernetesObjectApi;

    await expect(
      retireLegacyNackController({
        namespace: 'nats-system',
        instanceName: 'nats',
        kubernetesApi: api,
      })
    ).rejects.toThrow(/UID changed/);
  });
});
