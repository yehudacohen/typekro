import { describe, expect, it } from 'bun:test';
import {
  detectKroResourceIdentityDriftForTest,
} from '../../../src/alchemy/resource-registration.js';
import type {
  TypeKroResource,
  TypeKroResourceProps,
} from '../../../src/alchemy/types.js';
import type {
  Enhanced,
  KubernetesResource,
} from '../../../src/core/types/kubernetes.js';

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
      }),
    ).resolves.toBeUndefined();
  });

  it('reconciles an object removed behind persisted Alchemy state', async () => {
    await expect(
      detectKroResourceIdentityDriftForTest(props, output, {
        read: async () => {
          throw Object.assign(new Error('not found'), { statusCode: 404 });
        },
      }),
    ).resolves.toEqual({ action: 'update' });
  });

  it('reconciles replacement and deletion', async () => {
    await expect(
      detectKroResourceIdentityDriftForTest(props, output, {
        read: async () => ({
          ...deployed,
          metadata: { ...deployed.metadata, uid: 'uid-2' },
        }),
      }),
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
      }),
    ).resolves.toEqual({ action: 'update' });
  });

  it('fails closed when Kubernetes cannot prove live state', async () => {
    await expect(
      detectKroResourceIdentityDriftForTest(props, output, {
        read: async () => {
          throw Object.assign(new Error('forbidden'), { statusCode: 403 });
        },
      }),
    ).rejects.toThrow(
      'Alchemy drift check could not read v1/Namespace application-system: forbidden',
    );
  });
});
