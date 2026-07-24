import { describe, expect, it } from 'bun:test';
import type { NamespaceInventory } from '../../src/core/deployment/kro-namespace-teardown.js';
import { assertTestNamespaceEmpty } from '../integration/shared-kubeconfig.js';

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
