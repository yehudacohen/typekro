import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import type { Enhanced } from '../../../core/types/index.js';
import { cluster } from '../resources/cluster.js';
import { objectStore } from '../resources/object-store.js';
import { scheduledBackup } from '../resources/scheduled-backup.js';
import {
  type ClusterConfig,
  type ClusterStatus,
  type CnpgS3BackedClusterConfig,
  CnpgS3BackedClusterConfigSchema,
  type CnpgS3BackedClusterStatus,
  CnpgS3BackedClusterStatusSchema,
} from '../types.js';
import { barmanCloudBackupMethod, barmanCloudPlugin } from '../utils/barman-cloud.js';
import {
  BARMAN_CLOUD_BUCKET_CONSTRAINT,
  BARMAN_CLOUD_PREFIX_CONSTRAINT,
} from '../utils/barman-cloud-constraints.js';

/** CEL: the cluster reports condition `type` as True. */
function clusterCondition(
  db: Enhanced<ClusterConfig['spec'], ClusterStatus>,
  type: 'Ready' | 'ContinuousArchiving'
) {
  return Cel.expr<boolean>(
    'has(',
    db.status.conditions,
    ') && ',
    db.status.conditions,
    `.exists(c, c.type == "${type}" && c.status == "True")`
  );
}

// Credentials come only from the pod's workload identity: the ObjectStore sets
// `s3Credentials.inheritFromIAMRole: true` and the spec has no credential inputs, so static keys
// can't be passed in either mode. barman-cloud runs in the instance pods as the cluster's service
// account (named after the cluster); an EKS Pod Identity association or IRSA
// (`serviceAccountAnnotations`) binds the IAM role. `bucket` and `prefix` patterns are on the
// instance schema (KRO admission) and checked in the body (direct mode). The plugin, and for KRO
// mode its ObjectStore CRD, must be installed first.

/**
 * An `ObjectStore` for `s3://<bucket>/<prefix>`, a `Cluster` archiving WAL and base backups to
 * it through the Barman Cloud plugin, and a `ScheduledBackup` with `method: plugin`.
 *
 * @see docs/api/cnpg/index.md#barman-cloud-plugin
 */
export const cnpgS3BackedCluster: CallableComposition<
  CnpgS3BackedClusterConfig,
  CnpgS3BackedClusterStatus
> = kubernetesComposition(
  {
    name: 'cnpg-s3-backed-cluster',
    kind: 'CnpgS3BackedCluster',
    spec: CnpgS3BackedClusterConfigSchema,
    status: CnpgS3BackedClusterStatusSchema,
  },
  (spec: CnpgS3BackedClusterConfig) => {
    BARMAN_CLOUD_BUCKET_CONSTRAINT.enforce(spec.bucket);
    BARMAN_CLOUD_PREFIX_CONSTRAINT.enforce(spec.prefix);

    const objectStoreName = Cel.template('%s-backups', spec.name);
    const store = objectStore({
      name: objectStoreName,
      namespace: spec.namespace,
      spec: {
        configuration: {
          destinationPath: Cel.template('s3://%s/%s', spec.bucket, spec.prefix),
          s3Credentials: { inheritFromIAMRole: true },
          wal: { compression: 'gzip' },
          data: { compression: 'gzip' },
        },
        retentionPolicy: Cel.default(spec.retentionPolicy, '30d'),
      },
      id: 'objectStore',
    });

    const db = cluster({
      name: spec.name,
      namespace: spec.namespace,
      spec: {
        instances: spec.instances,
        storage: { size: spec.storageSize },
        plugins: [barmanCloudPlugin({ objectStoreName })],
        serviceAccountTemplate: {
          metadata: { annotations: Cel.default(spec.serviceAccountAnnotations, {}) },
        },
      },
      id: 'cluster',
    });
    db.dependsOn(store);

    const schedule = scheduledBackup({
      name: Cel.template('%s-scheduled', spec.name),
      namespace: spec.namespace,
      spec: {
        cluster: { name: spec.name },
        schedule: spec.schedule,
        backupOwnerReference: 'self',
        ...barmanCloudBackupMethod(),
      },
      id: 'scheduledBackup',
    });
    schedule.dependsOn(db);

    const clusterReady = clusterCondition(db, 'Ready');
    const walArchiving = clusterCondition(db, 'ContinuousArchiving');
    return {
      ready: Cel.expr<boolean>(clusterReady, ' && ', walArchiving),
      clusterReady,
      walArchiving,
    };
  }
);
