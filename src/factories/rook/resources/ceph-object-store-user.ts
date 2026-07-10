/** Typed `CephObjectStoreUser` factory for explicit RGW users. */

import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { CephObjectStoreUserConfig, CephObjectStoreUserStatus } from '../types.js';

/** Evaluate Rook's authoritative user `status.phase`. */
export function cephObjectStoreUserReadinessEvaluator(liveResource: unknown): ResourceStatus {
  const resource = liveResource as { status?: CephObjectStoreUserStatus } | null | undefined;
  const phase = resource?.status?.phase;

  if (!phase) {
    return {
      ready: false,
      reason: 'StatusMissing',
      message: 'CephObjectStoreUser has no status phase yet',
    };
  }

  return phase === 'Ready'
    ? { ready: true, reason: 'Ready', message: 'CephObjectStoreUser is ready' }
    : { ready: false, reason: phase, message: `CephObjectStoreUser phase is ${phase}` };
}

/**
 * Create a Rook `ceph.rook.io/v1` CephObjectStoreUser.
 *
 * ObjectBucketClaims normally create purpose-scoped credentials automatically;
 * use this factory only when a stable, explicitly managed RGW identity is
 * required.
 */
export function cephObjectStoreUser(
  config: Composable<CephObjectStoreUserConfig>
): Enhanced<CephObjectStoreUserConfig['spec'], CephObjectStoreUserStatus> {
  return createResource(
    {
      apiVersion: 'ceph.rook.io/v1',
      kind: 'CephObjectStoreUser',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
        labels: {
          'app.kubernetes.io/name': 'rook-ceph-object-store-user',
          'app.kubernetes.io/instance': config.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      spec: config.spec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced' }
  ).withReadinessEvaluator(cephObjectStoreUserReadinessEvaluator) as Enhanced<
    CephObjectStoreUserConfig['spec'],
    CephObjectStoreUserStatus
  >;
}
