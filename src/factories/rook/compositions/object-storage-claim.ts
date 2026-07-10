/** App-owned ObjectBucketClaim composition and S3 binding contract. */

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { TypeKroError } from '../../../core/errors.js';
import { Cel } from '../../../core/references/cel.js';
import type {
  DirectResourceFactory,
  KroResourceFactory,
  PublicFactoryOptions,
} from '../../../core/types/deployment.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
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
 * binding names are anchored to the OBC resource and hydrated from the live
 * direct deployment.
 * ObjectBucketClaims are controller-mutated resources and therefore direct-only.
 * KRO's continuous server-side apply races the OBC provisioner's metadata and
 * status updates, even for fixed-name buckets.
 */
const rookObjectStorageClaimComposition = kubernetesComposition(
  {
    name: 'rook-object-storage-claim',
    kind: 'RookObjectStorageClaim',
    spec: RookObjectStorageClaimConfigSchema,
    status: RookObjectStorageClaimStatusSchema,
  },
  (spec: RookObjectStorageClaimConfig) => {
    const bucketFields = !spec.bucket
      ? {}
      : isKubernetesRef(spec.bucket.mode)
        ? {
            bucketName: Cel.expr<string>(
              'has(schema.spec.bucket) && schema.spec.bucket.mode == "fixed" ? dyn(schema.spec.bucket.name) : omit()'
            ),
            generateBucketName: Cel.expr<string>(
              'has(schema.spec.bucket) && schema.spec.bucket.mode == "generated" ? dyn(schema.spec.bucket.name) : omit()'
            ),
          }
        : spec.bucket.mode === 'fixed'
          ? { bucketName: spec.bucket.name }
          : { generateBucketName: spec.bucket.name };

    const claim = objectBucketClaim({
      name: spec.name,
      namespace: spec.namespace,
      spec: {
        storageClassName: spec.storageClassName,
        ...bucketFields,
        additionalConfig: {
          ...(spec.maxObjects && { maxObjects: spec.maxObjects }),
          ...(spec.maxSize && { maxSize: spec.maxSize }),
        },
      },
      id: 'objectBucketClaim',
    });

    const claimNameStatus = isKubernetesRef(claim.metadata.name)
      ? Cel.expr<string>(claim.metadata.name)
      : claim.metadata.name;
    const storageClassNameStatus = isKubernetesRef(claim.spec.storageClassName)
      ? Cel.expr<string>(claim.spec.storageClassName)
      : claim.spec.storageClassName;

    return {
      ready: claim.status.phase === 'Bound',
      phase: claim.status.phase,
      claimName: claimNameStatus,
      credentialsSecretName: claimNameStatus,
      connectionConfigMapName: claimNameStatus,
      storageClassName: storageClassNameStatus,
    };
  }
);

type ClaimStatus = typeof RookObjectStorageClaimStatusSchema.infer;

const baseFactory = rookObjectStorageClaimComposition.factory.bind(
  rookObjectStorageClaimComposition
);

function rookObjectStorageClaimFactory(
  mode: 'kro',
  options?: PublicFactoryOptions
): KroResourceFactory<RookObjectStorageClaimConfig, ClaimStatus>;
function rookObjectStorageClaimFactory(
  mode: 'direct',
  options?: PublicFactoryOptions
): DirectResourceFactory<RookObjectStorageClaimConfig, ClaimStatus>;
function rookObjectStorageClaimFactory(
  mode: 'kro' | 'direct',
  options?: PublicFactoryOptions
):
  | KroResourceFactory<RookObjectStorageClaimConfig, ClaimStatus>
  | DirectResourceFactory<RookObjectStorageClaimConfig, ClaimStatus> {
  if (mode === 'kro') {
    throw new TypeKroError(
      'rookObjectStorageClaim is direct-only because the OBC provisioner mutates claim metadata and status while KRO continuously server-side applies graph resources. Managing an OBC as a KRO child can leave a provisioned bucket stuck in Pending. Use direct mode for claims; KRO mode remains supported for the operator and object-store platform graph.',
      'UNSUPPORTED_KRO_CONFIG',
      { resource: 'ObjectBucketClaim', mode: 'kro' }
    );
  }
  return baseFactory('direct', options);
}

Object.defineProperty(rookObjectStorageClaimComposition, 'factory', {
  value: rookObjectStorageClaimFactory,
  writable: true,
  enumerable: true,
  configurable: true,
});

export const rookObjectStorageClaim = rookObjectStorageClaimComposition;
