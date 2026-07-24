import { describe, expect, it } from 'bun:test';
import type { NamespaceInventory } from '../../src/core/deployment/kro-namespace-teardown.js';
import {
  assertTestNamespaceEmpty,
  assertTestNamespaceLease,
  initiateNamespaceDeletion,
  isNotFoundError,
  type NamespaceDeletionClient,
} from '../integration/shared-kubeconfig.js';

function inventory(overrides: Partial<NamespaceInventory> = {}): NamespaceInventory {
  return {
    discoverNamespacedTypes: async () => [],
    listObjectNames: async () => [],
    ...overrides,
  };
}

describe('test namespace finalizer recovery gate', () => {
  it('accepts a namespace whose discovered resource inventory is empty', async () => {
    await expect(assertTestNamespaceEmpty('test-empty', inventory())).resolves.toBeUndefined();
  });

  it('rejects recovery when a namespaced resource remains', async () => {
    await expect(
      assertTestNamespaceEmpty(
        'test-occupied',
        inventory({
          discoverNamespacedTypes: async () => [{ apiVersion: 'v1', kind: 'Pod' }],
          listObjectNames: async () => ['remaining-pod'],
        })
      )
    ).rejects.toThrow('still contains v1/Pod "remaining-pod"');
  });

  it('rejects recovery when discovery cannot prove emptiness', async () => {
    await expect(
      assertTestNamespaceEmpty(
        'test-unknown',
        inventory({
          discoverNamespacedTypes: async () => {
            throw new Error('discovery unavailable');
          },
        })
      )
    ).rejects.toThrow('API discovery of namespaced types failed');
  });

  it('rejects recovery when a resource type cannot be listed', async () => {
    await expect(
      assertTestNamespaceEmpty(
        'test-unknown',
        inventory({
          discoverNamespacedTypes: async () => [{ apiVersion: 'apps/v1', kind: 'Deployment' }],
          listObjectNames: async () => {
            throw new Error('list unavailable');
          },
        })
      )
    ).rejects.toThrow('could not list apps/v1/Deployment');
  });
});

describe('test namespace ownership lease', () => {
  it('accepts the exact namespace name and UID', () => {
    expect(() =>
      assertTestNamespaceLease(
        { metadata: { name: 'test-owned', uid: 'uid-1' } },
        { name: 'test-owned', uid: 'uid-1' }
      )
    ).not.toThrow();
  });

  it('rejects a replacement namespace with the same name and a different UID', () => {
    expect(() =>
      assertTestNamespaceLease(
        { metadata: { name: 'test-owned', uid: 'uid-2' } },
        { name: 'test-owned', uid: 'uid-1' }
      )
    ).toThrow('ownership lease does not match');
  });

  it('rejects a lease for a different namespace before cleanup', () => {
    expect(() =>
      assertTestNamespaceLease(
        { metadata: { name: 'other', uid: 'uid-1' } },
        { name: 'test-owned', uid: 'uid-1' }
      )
    ).toThrow('ownership lease does not match');
  });
});

describe('strict test namespace deletion ordering', () => {
  function client(options: { namespaceError?: unknown; pvcError?: unknown } = {}) {
    const operations: Array<{ operation: string; request: unknown }> = [];
    const api: NamespaceDeletionClient = {
      async listNamespacedPersistentVolumeClaim(request) {
        operations.push({ operation: 'list-pvcs', request });
        return { items: [{ metadata: { name: 'data-db-0', uid: 'pvc-uid-1' } }] };
      },
      async deleteNamespace(request) {
        operations.push({ operation: 'delete-namespace', request });
        if (options.namespaceError) throw options.namespaceError;
        return {};
      },
      async deleteNamespacedPersistentVolumeClaim(request) {
        operations.push({ operation: 'delete-pvc', request });
        if (options.pvcError) throw options.pvcError;
        return {};
      },
    };
    return { api, operations };
  }

  it('accepts the namespace UID before deleting PVCs with their own UID guards', async () => {
    const { api, operations } = client();

    await initiateNamespaceDeletion(api, 'owned', 'namespace-uid-1');

    expect(operations).toEqual([
      { operation: 'list-pvcs', request: { namespace: 'owned' } },
      {
        operation: 'delete-namespace',
        request: {
          name: 'owned',
          body: { preconditions: { uid: 'namespace-uid-1' } },
        },
      },
      {
        operation: 'delete-pvc',
        request: {
          name: 'data-db-0',
          namespace: 'owned',
          body: { preconditions: { uid: 'pvc-uid-1' } },
        },
      },
    ]);
  });

  it('never mutates PVCs when the namespace UID precondition fails', async () => {
    const { api, operations } = client({ namespaceError: { code: 409 } });

    await expect(
      initiateNamespaceDeletion(api, 'replacement', 'original-namespace-uid')
    ).rejects.toEqual({ code: 409 });
    expect(operations.map(({ operation }) => operation)).toEqual(['list-pvcs', 'delete-namespace']);
  });

  it('treats a code-only PVC 404 as already deleted', async () => {
    const { api } = client({ pvcError: { code: 404 } });

    await expect(
      initiateNamespaceDeletion(api, 'owned', 'namespace-uid-1')
    ).resolves.toBeUndefined();
    expect(isNotFoundError({ code: 404 })).toBe(true);
  });
});
