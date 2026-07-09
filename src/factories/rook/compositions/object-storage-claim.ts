/** App-owned ObjectBucketClaim composition and S3 binding contract. */

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { objectBucketClaim } from '../resources/object-bucket-claim.js';
import {
  type RookObjectStorageClaimConfig,
  RookObjectStorageClaimConfigSchema,
  RookObjectStorageClaimStatusSchema,
} from '../types.js';

/**
 * Claim an S3-compatible bucket from a platform-provided StorageClass.
 *
 * The graph owns only its namespaced ObjectBucketClaim. Rook creates a Secret
 * and ConfigMap using the claim name; the returned status exposes those stable
 * binding names without trying to read or own the generated resources. The
 * binding names are anchored to the OBC resource in status so they are
 * projected onto the live KRO instance, not only hydrated client-side.
 */
export const rookObjectStorageClaim = kubernetesComposition(
  {
    name: 'rook-object-storage-claim',
    kind: 'RookObjectStorageClaim',
    spec: RookObjectStorageClaimConfigSchema,
    status: RookObjectStorageClaimStatusSchema,
  },
  (spec: RookObjectStorageClaimConfig) => {
    const claim = objectBucketClaim({
      name: spec.name,
      namespace: spec.namespace,
      spec: {
        storageClassName: spec.storageClassName,
        ...(spec.bucketName && { bucketName: spec.bucketName }),
        ...(spec.generateBucketName && { generateBucketName: spec.generateBucketName }),
        additionalConfig: {
          ...(spec.maxObjects && { maxObjects: spec.maxObjects }),
          ...(spec.maxSize && { maxSize: spec.maxSize }),
        },
      },
      id: 'objectBucketClaim',
    });

    return {
      ready: claim.status.phase === 'Bound',
      phase: claim.status.phase,
      claimName: Cel.expr<string>('objectBucketClaim.metadata.name'),
      credentialsSecretName: Cel.expr<string>('objectBucketClaim.metadata.name'),
      connectionConfigMapName: Cel.expr<string>('objectBucketClaim.metadata.name'),
      storageClassName: Cel.expr<string>('objectBucketClaim.spec.storageClassName'),
    };
  }
);
