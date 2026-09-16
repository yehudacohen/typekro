/**
 * Unit tests for the alchemy v2 KRO resource DELETE path (`deleteKroResource`, via the exported
 * `deleteKroResourceForTest` hook). A mock deployer is injected through `props.deployer` so the
 * teardown logic is covered without a cluster.
 */
import { describe, expect, it, mock } from 'bun:test';
import { deleteKroResourceForTest } from '../../../src/alchemy/resource-registration.js';
import { ResourceGraphDefinitionDeletionDeferredError } from '../../../src/alchemy/deployers.js';
import type { TypeKroDeployer, TypeKroResourceProps } from '../../../src/alchemy/types.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';
import { createMockKubeConfig } from '../../utils/mock-factories.js';

const resource = {
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: { name: 'cfg', namespace: 'ns' },
} as unknown as Enhanced<unknown, unknown>;

const makeProps = (
  deployer: TypeKroDeployer
): TypeKroResourceProps<Enhanced<unknown, unknown>> => ({
  resource,
  namespace: 'ns',
  deploymentStrategy: 'kro',
  deployer,
});

describe('deleteKroResource', () => {
  it('delegates to the deployer with the KRO target, namespace, and cancellation signal', async () => {
    const del = mock(() => Promise.resolve());
    const deployer = { deploy: mock(), delete: del } as unknown as TypeKroDeployer;
    const abortController = new AbortController();

    await deleteKroResourceForTest(makeProps(deployer), abortController.signal);

    expect(del).toHaveBeenCalledTimes(1);
    const [passedResource, opts] = del.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(passedResource).toBe(resource);
    expect(opts.mode).toBe('kro');
    expect(opts.namespace).toBe('ns');
    expect(opts.abortSignal).toBe(abortController.signal);
  });

  it('swallows ResourceGraphDefinitionDeletionDeferredError (shared RGD still referenced)', async () => {
    const deployer = {
      deploy: mock(),
      delete: mock(() => Promise.reject(new ResourceGraphDefinitionDeletionDeferredError('my-rgd'))),
    } as unknown as TypeKroDeployer;

    // Should resolve (not reject) — the deferred RGD delete is intentionally swallowed.
    await expect(deleteKroResourceForTest(makeProps(deployer))).resolves.toBeUndefined();
  });

  it('rethrows non-deferred deletion errors', async () => {
    const deployer = {
      deploy: mock(),
      delete: mock(() => Promise.reject(new Error('boom'))),
    } as unknown as TypeKroDeployer;

    await expect(deleteKroResourceForTest(makeProps(deployer))).rejects.toThrow('boom');
  });
});

/**
 * Teardown polls (`delete`, then read to a real 404) re-check their deadline only BETWEEN
 * iterations, so they rely on each request settling. A wedged call would hang the destroy exactly
 * as it hung reconcile. The watchdog makes a lost bound RED rather than a hanging CI job.
 */
describe('KRO teardown bounds every cluster call it makes', () => {
  async function settlesWithin<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`call did not settle within ${ms}ms — it is UNBOUNDED`)),
            ms
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  it('honors a configured httpTimeouts.default rather than the built-in read budget', async () => {
    const { decideKroRgdDeletionForTest } = await import('../../../src/alchemy/kro-delete.js');

    await expect(
      settlesWithin(
        decideKroRgdDeletionForTest(
          createMockKubeConfig(),
          {
            apiVersion: 'demo.example/v1alpha1',
            kind: 'DemoApp',
            namespace: 'demo',
            rgdName: 'demo-owner',
            plural: 'demoapps',
            // No `timeout`: the budget must come from httpTimeouts, not from the defaults.
            httpTimeouts: { default: 30 },
          },
          { listClusterCustomObject: () => new Promise(() => undefined) } as never
        )
      )
    ).rejects.toThrow(/exceeded its 30ms request timeout/);
  });

  it('rejects a wedged instance listing instead of hanging the destroy', async () => {
    const { decideKroRgdDeletionForTest } = await import('../../../src/alchemy/kro-delete.js');
    const kubeConfig = createMockKubeConfig();

    await expect(
      settlesWithin(
        decideKroRgdDeletionForTest(
          kubeConfig,
          {
            apiVersion: 'demo.example/v1alpha1',
            kind: 'DemoApp',
            namespace: 'demo',
            rgdName: 'demo-owner',
            plural: 'demoapps',
            timeout: 40,
          },
          { listClusterCustomObject: () => new Promise(() => undefined) } as never
        )
      )
    ).rejects.toThrow(/exceeded its 40ms request timeout/);
  });
});
