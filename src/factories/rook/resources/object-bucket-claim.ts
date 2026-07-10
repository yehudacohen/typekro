/** Typed `ObjectBucketClaim` factory used by Rook's bucket provisioner. */

import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { ObjectBucketClaimConfig, ObjectBucketClaimStatus } from '../types.js';

/** Evaluate the lib-bucket-provisioner ObjectBucketClaim phase. */
export function objectBucketClaimReadinessEvaluator(liveResource: unknown): ResourceStatus {
  const resource = liveResource as { status?: ObjectBucketClaimStatus } | null | undefined;
  const phase = resource?.status?.phase;

  if (!phase) {
    return {
      ready: false,
      reason: 'StatusMissing',
      message: 'ObjectBucketClaim has no status phase yet',
    };
  }

  if (phase === 'Bound') {
    return {
      ready: true,
      reason: 'Bound',
      message: 'ObjectBucketClaim is bound and connection resources are available',
    };
  }

  return {
    ready: false,
    reason: phase,
    message: `ObjectBucketClaim phase is ${phase}`,
  };
}

/**
 * Create an `objectbucket.io/v1alpha1` ObjectBucketClaim.
 *
 * On `Bound`, the Rook provisioner creates a Secret and ConfigMap with the
 * same name and namespace as the claim. The Secret contains
 * `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; the ConfigMap contains
 * `BUCKET_HOST`, `BUCKET_PORT`, `BUCKET_NAME`, and related endpoint data.
 */
export function objectBucketClaim(
  config: Composable<ObjectBucketClaimConfig>
): Enhanced<ObjectBucketClaimConfig['spec'], ObjectBucketClaimStatus> {
  return createResource(
    {
      apiVersion: 'objectbucket.io/v1alpha1',
      kind: 'ObjectBucketClaim',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
        labels: {
          'app.kubernetes.io/name': 'object-bucket-claim',
          'app.kubernetes.io/instance': config.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      spec: config.spec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced' }
  ).withReadinessEvaluator(objectBucketClaimReadinessEvaluator) as Enhanced<
    ObjectBucketClaimConfig['spec'],
    ObjectBucketClaimStatus
  >;
}
