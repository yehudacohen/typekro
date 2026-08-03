import { describe, expect, it } from 'bun:test';
import * as Diff from 'alchemy/Diff';
import type { Input } from 'alchemy/Input';
import * as Output from 'alchemy/Output';
import {
  detectKroResourceIdentityDriftForTest,
  shouldReplaceKroResourceNamespaceForTest,
  waitForPersistedIdentityDeletionForTest,
} from '../../../src/alchemy/resource-registration.js';
import type { TypeKroResource, TypeKroResourceProps } from '../../../src/alchemy/types.js';
import type { Enhanced, KubernetesResource } from '../../../src/core/types/kubernetes.js';

type Resource = Enhanced<unknown, unknown>;

const deployed: KubernetesResource = {
  apiVersion: 'v1',
  kind: 'Namespace',
  metadata: {
    name: 'application-system',
    uid: 'uid-1',
    resourceVersion: '10',
  },
  status: { phase: 'Active' },
};

const props = {
  resource: deployed,
  namespace: 'default',
  deploymentStrategy: 'direct',
} as TypeKroResourceProps<Resource>;

const output = {
  ...props,
  deployedResource: deployed,
  ready: true,
  deployedAt: 1,
} as TypeKroResource<Resource>;

describe('Alchemy persisted TypeKro resource drift', () => {
  it('preserves a real no-op across server fields and controller status evolution', async () => {
    await expect(
      detectKroResourceIdentityDriftForTest(props, output, {
        read: async () => ({
          ...deployed,
          metadata: {
            ...deployed.metadata,
            resourceVersion: '11',
            labels: { 'server-owned': 'value' },
          },
          status: {
            phase: 'Active',
            controllerObservation: 'changed-after-readiness',
          },
        }),
      })
    ).resolves.toBeUndefined();
  });

  it('reconciles an object removed behind persisted Alchemy state', async () => {
    await expect(
      detectKroResourceIdentityDriftForTest(props, output, {
        read: async () => {
          throw Object.assign(new Error('not found'), { statusCode: 404 });
        },
      })
    ).resolves.toEqual({ action: 'update' });
  });

  it('reconciles replacement and deletion', async () => {
    await expect(
      detectKroResourceIdentityDriftForTest(props, output, {
        read: async () => ({
          ...deployed,
          metadata: { ...deployed.metadata, uid: 'uid-2' },
        }),
      })
    ).resolves.toEqual({ action: 'update' });

    await expect(
      detectKroResourceIdentityDriftForTest(props, output, {
        read: async () => ({
          ...deployed,
          metadata: {
            ...deployed.metadata,
            deletionTimestamp: new Date('2026-08-02T00:00:00.000Z'),
          },
        }),
      })
    ).resolves.toEqual({ action: 'update' });
  });

  it('waits for a terminating persisted identity to reach 404 before reconciliation', async () => {
    let reads = 0;
    let sleeps = 0;
    await waitForPersistedIdentityDeletionForTest(props, output, undefined, {
      reader: {
        read: async () => {
          reads += 1;
          if (reads === 1) {
            return {
              ...deployed,
              metadata: {
                ...deployed.metadata,
                deletionTimestamp: new Date('2026-08-02T00:00:00.000Z'),
              },
            };
          }
          throw Object.assign(new Error('not found'), { statusCode: 404 });
        },
      },
      sleep: async () => {
        sleeps += 1;
      },
    });
    expect(reads).toBe(2);
    expect(sleeps).toBe(1);
  });

  it('fails rather than reporting success while a persisted identity remains terminating', async () => {
    const owner = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      name: 'namespace-owner',
      uid: 'owner-uid',
      controller: true,
    };
    const promise = waitForPersistedIdentityDeletionForTest(
      {
        ...props,
        options: { timeout: 0 },
      },
      output,
      undefined,
      {
        reader: {
          read: async () => ({
            ...deployed,
            metadata: {
              ...deployed.metadata,
              deletionTimestamp: new Date('2026-08-02T00:00:00.000Z'),
              finalizers: ['tests.typekro.dev/hold-termination'],
              ownerReferences: [owner],
            },
          }),
        },
      }
    );
    await expect(promise).rejects.toMatchObject({
      name: 'ResourceReplacementTimeoutError',
      code: 'RESOURCE_REPLACEMENT_TIMEOUT',
      resource: {
        apiVersion: 'v1',
        kind: 'Namespace',
        name: 'application-system',
        uid: 'uid-1',
        deletionTimestamp: '2026-08-02T00:00:00.000Z',
        finalizers: ['tests.typekro.dev/hold-termination'],
        owners: [owner],
      },
      context: {
        resource: {
          uid: 'uid-1',
          finalizers: ['tests.typekro.dev/hold-termination'],
        },
      },
    });
    await expect(promise).rejects.toThrow(
      'blocking finalizers: tests.typekro.dev/hold-termination'
    );
  });

  it('replaces a changed namespace even when a sibling input is unresolved', () => {
    const news: Input<TypeKroResourceProps<Resource>> = {
      ...props,
      namespace: 'replacement-system',
      artifactOutputs: {
        image: {
          digest: Output.asOutput('sha256:pending'),
        },
      },
    };
    expect(Diff.isResolved(news)).toBe(false);
    expect(shouldReplaceKroResourceNamespaceForTest(props, news)).toBe(true);
  });

  it('defers an unresolved namespace identity decision until reconciliation', () => {
    const news: Input<TypeKroResourceProps<Resource>> = {
      ...props,
      namespace: Output.asOutput('replacement-system'),
    };
    expect(Diff.isResolved(news.namespace)).toBe(false);
    expect(shouldReplaceKroResourceNamespaceForTest(props, news)).toBe(false);
  });

  it('fails closed when Kubernetes cannot prove live state', async () => {
    await expect(
      detectKroResourceIdentityDriftForTest(props, output, {
        read: async () => {
          throw Object.assign(new Error('forbidden'), { statusCode: 403 });
        },
      })
    ).rejects.toThrow(
      'Alchemy drift check could not read v1/Namespace application-system: forbidden'
    );
  });
});
