/**
 * Barman Cloud plugin `ObjectStore` factory, for S3 with workload identity.
 *
 * The plugin's sidecar runs barman-cloud in each instance pod, as the cluster's service
 * account. With `s3Credentials.inheritFromIAMRole: true` it uses that account's IAM role, bound
 * by IRSA or an EKS Pod Identity association. The typed spec offers no static keys, and
 * `objectStore()` refuses them at runtime.
 */

import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import { BARMAN_CLOUD_API_VERSION } from '../constants.js';
import type { ObjectStoreConfig, ObjectStoreSpec, ObjectStoreStatus } from '../types.js';
import { assertWorkloadIdentityObjectStore } from '../utils/barman-cloud.js';

/**
 * ObjectStore readiness. The plugin reports no conditions on an `ObjectStore`: it is
 * configuration that the API server has admitted, CRD rules included, once it can be read
 * back. Readiness is that read, and the message adds the recovery windows the plugin records
 * after backups.
 */
export function objectStoreReadinessEvaluator(liveResource: unknown): ResourceStatus {
  const resource = liveResource as
    | { metadata?: { name?: string }; status?: ObjectStoreStatus }
    | null
    | undefined;
  if (!resource?.metadata?.name) {
    return { ready: false, reason: 'NotFound', message: 'ObjectStore has not been created yet' };
  }
  const servers = Object.keys(resource.status?.serverRecoveryWindow ?? {});
  return {
    ready: true,
    reason: 'Admitted',
    message:
      servers.length > 0
        ? `ObjectStore holds backups for ${servers.join(', ')}`
        : 'ObjectStore is admitted; no backups recorded yet',
  };
}

registerPortableReadinessEvaluator(
  'typekro.readiness.cnpg.barman-cloud.object-store',
  '1',
  objectStoreReadinessEvaluator
);

/**
 * Create a Barman Cloud `ObjectStore` (`barmancloud.cnpg.io/v1`) for S3.
 *
 * A `Cluster` uses it through `spec.plugins` (see `barmanCloudPlugin()`), and a recovering
 * cluster through an `externalClusters` entry (see `barmanCloudRecovery()`). It must be in the
 * cluster's namespace.
 */
export function objectStore(
  config: Composable<ObjectStoreConfig>
): Enhanced<ObjectStoreSpec, ObjectStoreStatus> {
  assertWorkloadIdentityObjectStore(config.spec);
  return createResource(
    {
      apiVersion: BARMAN_CLOUD_API_VERSION,
      kind: 'ObjectStore',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
      },
      spec: config.spec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced' }
  ).withReadinessEvaluator(objectStoreReadinessEvaluator) as Enhanced<
    ObjectStoreSpec,
    ObjectStoreStatus
  >;
}
