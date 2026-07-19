/** Typed `CephObjectStore` factory for Rook's S3-compatible RGW service. */

import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { CephObjectStoreConfig, CephObjectStoreStatus } from '../types.js';

/** Evaluate Rook's authoritative `status.phase` for an object store. */
export function cephObjectStoreReadinessEvaluator(liveResource: unknown): ResourceStatus {
  const resource = liveResource as { status?: CephObjectStoreStatus } | null | undefined;
  const status = resource?.status;

  if (!status) {
    return { ready: false, reason: 'StatusMissing', message: 'CephObjectStore has no status yet' };
  }

  if (status.phase === 'Ready') {
    return { ready: true, reason: 'Ready', message: status.message ?? 'CephObjectStore is ready' };
  }

  return {
    ready: false,
    reason: status.phase ?? 'PhaseMissing',
    message: status.message ?? `CephObjectStore phase is ${status.phase ?? 'unknown'}`,
  };
}

/**
 * Create a Rook `ceph.rook.io/v1` CephObjectStore.
 *
 * This is platform infrastructure. Application graphs should normally consume
 * a pre-created bucket StorageClass through `rookObjectStorageClaim` instead
 * of owning this resource.
 *
 * @example
 * ```typescript
 * const store = cephObjectStore({
 *   name: 'object-store',
 *   namespace: 'rook-ceph',
 *   spec: {
 *     metadataPool: { replicated: { size: 3, requireSafeReplicaSize: true } },
 *     dataPool: { replicated: { size: 3, requireSafeReplicaSize: true } },
 *     gateway: { port: 80, instances: 2 },
 *   },
 * });
 * ```
 */
export function cephObjectStore(
  config: Composable<CephObjectStoreConfig>
): Enhanced<CephObjectStoreConfig['spec'], CephObjectStoreStatus> {
  return createResource(
    {
      apiVersion: 'ceph.rook.io/v1',
      kind: 'CephObjectStore',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
        labels: {
          'app.kubernetes.io/name': 'rook-ceph-object-store',
          'app.kubernetes.io/instance': config.name,
          'app.kubernetes.io/managed-by': 'typekro',
          ...config.labels,
        },
        ...(config.annotations && { annotations: config.annotations }),
      },
      spec: config.spec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced', dnsAddressable: true }
  ).withReadinessEvaluator(cephObjectStoreReadinessEvaluator) as Enhanced<
    CephObjectStoreConfig['spec'],
    CephObjectStoreStatus
  >;
}
