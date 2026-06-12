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
  it('delegates to the deployer with alchemy mode + the resource namespace', async () => {
    const del = mock(() => Promise.resolve());
    const deployer = { deploy: mock(), delete: del } as unknown as TypeKroDeployer;

    await deleteKroResourceForTest(makeProps(deployer));

    expect(del).toHaveBeenCalledTimes(1);
    const [passedResource, opts] = del.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(passedResource).toBe(resource);
    expect(opts.mode).toBe('alchemy');
    expect(opts.namespace).toBe('ns');
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
