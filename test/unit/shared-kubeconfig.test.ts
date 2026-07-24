import { describe, expect, it } from 'bun:test';
import type { NamespaceInventory } from '../../src/core/deployment/kro-namespace-teardown.js';
import type { ResourceDeletionResult } from '../../src/core/types/deployment.js';
import {
  assertTestNamespaceEmpty,
  assertTestNamespaceLease,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  initiateNamespaceDeletion,
  type NamespaceDeletionClient,
  TestFactoryCleanupRegistry,
  waitForTestNamespaceEmpty,
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

  it('waits for controller-owned resources to drain before finalizer recovery', async () => {
    let reads = 0;
    await expect(
      waitForTestNamespaceEmpty(
        'test-draining',
        inventory({
          discoverNamespacedTypes: async () => [{ apiVersion: 'v1', kind: 'Pod' }],
          listObjectNames: async () => (++reads < 2 ? ['terminating-pod'] : []),
        }),
        50,
        0
      )
    ).resolves.toBeUndefined();
    expect(reads).toBe(2);
  });

  it('fails closed when controller-owned resources remain at the drain deadline', async () => {
    await expect(
      waitForTestNamespaceEmpty(
        'test-still-occupied',
        inventory({
          discoverNamespacedTypes: async () => [{ apiVersion: 'v1', kind: 'Pod' }],
          listObjectNames: async () => ['remaining-pod'],
        }),
        0,
        0
      )
    ).rejects.toThrow('still contains v1/Pod "remaining-pod"');
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

describe('strict test namespace deletion', () => {
  function client(options: { namespaceError?: unknown } = {}) {
    const operations: Array<{ operation: string; request: unknown }> = [];
    const api: NamespaceDeletionClient = {
      async deleteNamespace(request) {
        operations.push({ operation: 'delete-namespace', request });
        if (options.namespaceError) throw options.namespaceError;
        return {};
      },
    };
    return { api, operations };
  }

  it('deletes only the leased namespace and leaves child lifecycle to the factory and controller', async () => {
    const { api, operations } = client();

    await initiateNamespaceDeletion(api, 'owned', 'namespace-uid-1');

    expect(operations).toEqual([
      {
        operation: 'delete-namespace',
        request: {
          name: 'owned',
          body: { preconditions: { uid: 'namespace-uid-1' } },
        },
      },
    ]);
  });

  it('surfaces a namespace UID precondition failure without mutating children', async () => {
    const { api, operations } = client({ namespaceError: { code: 409 } });

    await expect(
      initiateNamespaceDeletion(api, 'replacement', 'original-namespace-uid')
    ).rejects.toEqual({ code: 409 });
    expect(operations.map(({ operation }) => operation)).toEqual(['delete-namespace']);
  });
});

describe('factory-first integration cleanup', () => {
  function deletionResult(status: ResourceDeletionResult['status']): ResourceDeletionResult {
    return {
      status,
      mode: 'direct',
      factoryName: 'test-factory',
      instanceName: 'app',
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      durationMs: 1,
      deleted: [],
      retained: [],
      remaining: [],
      blockers: [],
      retry: { safe: true, guidance: 'test' },
    };
  }

  it('passes a bounded timeout and scope options to normal factory teardown', async () => {
    const calls: unknown[] = [];
    const factory = {
      async deleteInstance(instanceName: string, options?: unknown) {
        calls.push({ instanceName, options });
        return deletionResult('complete');
      },
    };

    await deleteTestFactoryInstanceAndRecoverNamespaces(factory, 'app', [], undefined, 1_234, {
      scopes: ['cluster'],
    });

    expect(calls).toEqual([
      {
        instanceName: 'app',
        options: { scopes: ['cluster'], timeout: 1_234 },
      },
    ]);
  });

  it('rejects incomplete deletion when no leased namespace can be recovered', async () => {
    const factory = {
      async deleteInstance() {
        return deletionResult('blocked');
      },
    };

    await expect(
      deleteTestFactoryInstanceAndRecoverNamespaces(factory, 'app', [], undefined, 1)
    ).rejects.toThrow('no test-owned Namespace lease');
  });

  it('retries bounded controller cleanup when TypeKro marks the result safe to retry', async () => {
    const calls: unknown[] = [];
    const factory = {
      async deleteInstance(instanceName: string, options?: unknown) {
        calls.push({ instanceName, options });
        if (calls.length === 1) {
          return {
            ...deletionResult('blocked'),
            blockers: [
              {
                code: 'CLEANUP_ERROR' as const,
                message: 'HelmRelease is still finalizing',
                retryable: true,
                retryGuidance: 'Retry after the controller drains.',
              },
            ],
            retry: { safe: true, afterMs: 0, guidance: 'Retry safely.' },
          };
        }
        return deletionResult('complete');
      },
    };

    await deleteTestFactoryInstanceAndRecoverNamespaces(factory, 'app', [], undefined, 1_234);

    expect(calls).toHaveLength(2);
  });

  it('does not retry a non-retryable cleanup blocker', async () => {
    let calls = 0;
    const factory = {
      async deleteInstance() {
        calls += 1;
        return {
          ...deletionResult('blocked'),
          blockers: [
            {
              code: 'CLEANUP_ERROR' as const,
              message: 'Ownership is ambiguous',
              retryable: false,
              retryGuidance: 'Inspect ownership.',
            },
          ],
          retry: { safe: true, guidance: 'Retry only after ownership is resolved.' },
        };
      },
    };

    await expect(
      deleteTestFactoryInstanceAndRecoverNamespaces(factory, 'app', [], undefined, 1)
    ).rejects.toThrow('reasons other than a leased Namespace finalizer');
    expect(calls).toBe(1);
  });

  it('cleans registered deployments in reverse ownership order', async () => {
    const calls: string[] = [];
    const factory = {
      async deleteInstance(instanceName: string) {
        calls.push(instanceName);
        return deletionResult('complete');
      },
    };
    const registry = new TestFactoryCleanupRegistry();
    registry.track(factory, 'dependency');
    registry.track(factory, 'consumer');

    await registry.cleanup(undefined, 1_234);

    expect(calls).toEqual(['consumer', 'dependency']);
  });

  it('runs generated fixture cleanup after factory teardown', async () => {
    const calls: string[] = [];
    const factory = {
      async deleteInstance(instanceName: string) {
        calls.push(`factory:${instanceName}`);
        return deletionResult('complete');
      },
    };
    const registry = new TestFactoryCleanupRegistry();
    registry.track(factory, 'certificate');
    registry.trackPostFactoryCleanup(async () => {
      calls.push('fixture:secret');
    });

    await registry.cleanup();

    expect(calls).toEqual(['factory:certificate', 'fixture:secret']);
  });

  it('continues teardown and aggregates all factory cleanup failures', async () => {
    const calls: string[] = [];
    const factory = {
      async deleteInstance(instanceName: string) {
        calls.push(instanceName);
        throw new Error(`cannot delete ${instanceName}`);
      },
    };
    const registry = new TestFactoryCleanupRegistry();
    registry.track(factory, 'first');
    registry.track(factory, 'second');

    await expect(registry.cleanup()).rejects.toBeInstanceOf(AggregateError);
    expect(calls).toEqual(['second', 'first']);
  });
});
