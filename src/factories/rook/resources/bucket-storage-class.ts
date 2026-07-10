/** Rook bucket-provisioner StorageClass factory. */

import type { V1StorageClass } from '@kubernetes/client-node';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import { storageClass } from '../../kubernetes/storage/storage-class.js';
import type { RookBucketStorageClassConfig } from '../types.js';

/**
 * Create the cluster-scoped StorageClass consumed by ObjectBucketClaims.
 *
 * Platform owners create this once for each object-store/lifecycle policy.
 * Application graphs should reference it by name and own only their claim.
 */
export function rookBucketStorageClass(
  config: Composable<RookBucketStorageClassConfig>
): V1StorageClass & Enhanced<V1StorageClass, object> {
  const provisionerNamePrefix = config.provisionerNamePrefix ?? config.objectStoreNamespace;

  return storageClass({
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: {
      name: config.name,
      ...(config.labels && { labels: config.labels }),
      ...(config.annotations && { annotations: config.annotations }),
    },
    provisioner: `${provisionerNamePrefix}.ceph.rook.io/bucket`,
    reclaimPolicy: config.reclaimPolicy ?? 'Retain',
    parameters: {
      objectStoreName: config.objectStoreName,
      objectStoreNamespace: config.objectStoreNamespace,
      ...(config.existingBucketName && { bucketName: config.existingBucketName }),
    },
    ...(config.id && { id: config.id }),
  });
}
