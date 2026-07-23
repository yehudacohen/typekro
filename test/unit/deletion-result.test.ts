import { describe, expect, it } from 'bun:test';

import {
  blockerForRemainingResource,
  createDeletionResultState,
  deletionTarget,
  finishDeletionResult,
  readDeletionResourceIdentity,
} from '../../src/core/deployment/deletion-result.js';

describe('structured deletion evidence', () => {
  it('captures live finalizers, owners, and deletion progress', async () => {
    const read = async () => ({
      metadata: {
        uid: 'instance-uid',
        deletionTimestamp: '2026-07-22T12:00:00.000Z',
        finalizers: ['kro.run/finalizer'],
        ownerReferences: [
          {
            apiVersion: 'kro.run/v1alpha1',
            kind: 'ResourceGraphDefinition',
            name: 'example-rgd',
            uid: 'owner-uid',
            controller: true,
          },
        ],
      },
    });
    const target = deletionTarget('example.test/v1alpha1', 'Example', 'demo', 'apps');

    const live = await readDeletionResourceIdentity({ read }, target);

    expect(live).toEqual({
      ...target,
      uid: 'instance-uid',
      deletionTimestamp: '2026-07-22T12:00:00.000Z',
      finalizers: ['kro.run/finalizer'],
      owners: [
        {
          apiVersion: 'kro.run/v1alpha1',
          kind: 'ResourceGraphDefinition',
          name: 'example-rgd',
          uid: 'owner-uid',
          controller: true,
        },
      ],
    });
    expect(blockerForRemainingResource(live!)).toMatchObject({
      code: 'FINALIZERS_REMAIN',
      retryable: true,
      resource: live,
    });
  });

  it('treats a live 404 as confirmed absence', async () => {
    const read = async () => {
      throw Object.assign(new Error('not found'), { statusCode: 404 });
    };

    await expect(
      readDeletionResourceIdentity(
        { read },
        deletionTarget('v1', 'ConfigMap', 'already-gone', 'apps')
      )
    ).resolves.toBeUndefined();
  });

  it('deduplicates repeated evidence without erasing policy distinctions', () => {
    const state = createDeletionResultState('kro', 'example', 'demo');
    const target = deletionTarget('v1', 'Namespace', 'apps');
    state.remaining.push(target, target);
    state.retained.push(
      { resource: target, policy: 'occupied-namespace', reason: 'still occupied' },
      { resource: target, policy: 'occupied-namespace', reason: 'still occupied' },
      { resource: target, policy: 'adopted-resource', reason: 'not owned' }
    );

    const result = finishDeletionResult(state, 'blocked', {
      safe: true,
      guidance: 'Retry after cleanup.',
    });

    expect(result.remaining).toEqual([target]);
    expect(result.retained).toHaveLength(2);
  });
});
