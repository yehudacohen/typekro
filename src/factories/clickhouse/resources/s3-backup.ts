/**
 * Scheduled `BACKUP ... TO S3(...)` CronJob for an S3-backed ClickHouse.
 *
 * WHY this exists: with `storage.diskType: 's3'` the bucket holds the part
 * DATA but the part METADATA lives on the node's local disk, so the bucket is
 * not self-describing — losing the node loses the map to the objects. That
 * makes durability a backup story, and an "S3-backed" cluster with no backup
 * is a trap. This factory renders that backup explicitly rather than leaving
 * it to a README.
 *
 * SHAPE OF THE JOB
 * - A timestamped backup name (`%Y%m%d%H%M%S`) is generated per run, so each
 *   run is a separate, independently restorable backup under
 *   `s3://<bucket>/<prefix>/<timestamp>`.
 * - The `BACKUP` statement carries NO credentials: it executes SERVER-side, and
 *   the server picks the destination credentials up from the `<s3>` section the
 *   storage compiler renders into `config.d/storage.xml` (matched by endpoint
 *   prefix). Keys therefore never reach the query text — and never reach
 *   `system.query_log`.
 * - With `retention.days`, the backup runs as an initContainer and a prune
 *   container follows it, deleting expired timestamped prefixes. The prune step
 *   needs S3 `DeleteObject` on the backup prefix (see the IAM policy in the
 *   docs).
 *
 * RESTORE is deliberately NOT automated — restoring over a live database is a
 * decision, not a schedule. The procedure is documented in
 * `docs/api/clickhouse/index.md`; in short:
 * `RESTORE DATABASE <db> FROM S3('<endpoint>/<timestamp>')`.
 */

import type {
  V1Container,
  V1CronJobSpec,
  V1CronJobStatus,
  V1EnvVar,
} from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { cronJob } from '../../kubernetes/workloads/cron-job.js';
import type { ResolvedClickHouseS3Storage } from '../utils/s3-storage.js';
import {
  S3_ACCESS_KEY_ID_ENV,
  S3_SECRET_ACCESS_KEY_ENV,
  clickHouseS3ContainerEnv,
  clickHouseS3ServiceAccountName,
} from '../utils/s3-storage.js';

/** Image used for the prune step (the ClickHouse image has no AWS CLI). */
export const DEFAULT_S3_PRUNE_IMAGE = 'amazon/aws-cli:2.22.35';

/** Configuration for {@link clickHouseS3BackupCronJob}. */
export interface ClickHouseS3BackupCronJobConfig {
  /** CHI name — anchors the CronJob name and the ClickHouse service host. */
  name: string;
  /** CHI namespace. */
  namespace: string;
  /** ClickHouse server version, used for the `clickhouse-client` image. */
  version: string;
  /** Resolved S3 storage (must carry a `backup` schedule). */
  storage: ResolvedClickHouseS3Storage;
  /** Native TCP port of the ClickHouse service. */
  nativePort: number;
  /** Resource id for composition references. */
  id?: string;
}

/**
 * Shell script for the backup step.
 *
 * `set -eu` plus an explicit `--query` exit code means a failed BACKUP fails
 * the Job (and, with `retention`, skips the prune step) rather than reporting
 * success on an empty backup.
 */
function backupScript(): string {
  return [
    'set -eu',
    'NAME="$(date -u +%Y%m%d%H%M%S)"',
    'echo "Backing up database $CLICKHOUSE_DATABASE to $BACKUP_ENDPOINT$NAME"',
    // The destination credentials come from the server's `<s3>` config section
    // (rendered by the storage compiler and matched by endpoint prefix), so the
    // statement itself carries none — nothing sensitive reaches query_log.
    // The database name is validated as a bare SQL identifier at resolve time,
    // so it needs no quoting here.
    'clickhouse-client --host "$CLICKHOUSE_HOST" --port "$CLICKHOUSE_PORT"' +
      ' --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD"' +
      ' --query "BACKUP DATABASE $CLICKHOUSE_DATABASE TO' +
      " S3('$BACKUP_ENDPOINT$NAME')\"",
    'echo "Backup $NAME complete"',
  ].join('\n');
}

/**
 * Shell script for the retention prune step.
 *
 * Backup prefixes are pure-numeric timestamps, so expiry is a string
 * comparison against a cutoff stamp — no date parsing of listing output, and
 * anything that is not a timestamped backup directory is skipped rather than
 * deleted.
 */
function pruneScript(): string {
  return [
    'set -eu',
    'CUTOFF="$(date -u -d "-$RETENTION_DAYS days" +%Y%m%d%H%M%S)"',
    'echo "Pruning backups older than $CUTOFF"',
    // The braced form here is a POSIX default-value expansion (the variable is
    // absent for real AWS), the one place braces are actually required.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell default value
    'if [ -n "${AWS_ENDPOINT_URL:-}" ]; then ENDPOINT_ARGS="--endpoint-url $AWS_ENDPOINT_URL";',
    'else ENDPOINT_ARGS=""; fi',
    // ENDPOINT_ARGS must word-split into two arguments, so it stays unquoted.
    '# shellcheck disable=SC2086',
    'aws s3 ls "s3://$BACKUP_BUCKET/$BACKUP_PREFIX/" $ENDPOINT_ARGS |',
    '  awk \'$1 == "PRE" { print $2 }\' | tr -d "/" | while read -r NAME; do',
    // Skip anything that is not a pure-numeric backup timestamp rather than
    // deleting it — the bucket prefix may hold other objects.
    '    case "$NAME" in "" | *[!0-9]*) continue ;; esac',
    '    if [ "$NAME" -lt "$CUTOFF" ]; then',
    '      echo "Deleting expired backup $NAME"',
    '      aws s3 rm --recursive "s3://$BACKUP_BUCKET/$BACKUP_PREFIX/$NAME" $ENDPOINT_ARGS',
    '    fi',
    '  done',
  ].join('\n');
}

/** ClickHouse connection env for the backup step. */
function clickHouseConnectionEnv(config: ClickHouseS3BackupCronJobConfig): V1EnvVar[] {
  const backup = config.storage.backup;
  const auth = backup?.auth;
  return [
    {
      name: 'CLICKHOUSE_HOST',
      value: `clickhouse-${config.name}.${config.namespace}.svc.cluster.local`,
    },
    { name: 'CLICKHOUSE_PORT', value: String(config.nativePort) },
    { name: 'CLICKHOUSE_DATABASE', value: backup?.database ?? 'default' },
    auth === undefined
      ? { name: 'CLICKHOUSE_USER', value: 'default' }
      : {
          name: 'CLICKHOUSE_USER',
          valueFrom: {
            secretKeyRef: { name: auth.secretName, key: auth.usernameKey, optional: false },
          },
        },
    auth === undefined
      ? { name: 'CLICKHOUSE_PASSWORD', value: '' }
      : {
          name: 'CLICKHOUSE_PASSWORD',
          valueFrom: {
            secretKeyRef: { name: auth.secretName, key: auth.passwordKey, optional: false },
          },
        },
    { name: 'BACKUP_ENDPOINT', value: backup?.endpointUrl ?? '' },
  ];
}

/** AWS env for the prune step: bucket coordinates plus the same credentials. */
function pruneEnv(config: ClickHouseS3BackupCronJobConfig): V1EnvVar[] {
  const backup = config.storage.backup;
  const env: V1EnvVar[] = [
    { name: 'BACKUP_BUCKET', value: backup?.bucket ?? '' },
    { name: 'BACKUP_PREFIX', value: backup?.prefix ?? '' },
    { name: 'RETENTION_DAYS', value: String(backup?.retentionDays ?? 0) },
  ];
  if (config.storage.region !== undefined) {
    env.push({ name: 'AWS_REGION', value: config.storage.region });
  }
  if (config.storage.endpoint !== undefined) {
    env.push({ name: 'AWS_ENDPOINT_URL', value: config.storage.endpoint });
  }
  // The AWS CLI reads the standard variable names while the storage compiler's
  // env helper emits ClickHouse-specific ones, so map them here rather than
  // duplicating the secretKeyRef shape. IRSA needs no mapping at all — the CLI
  // picks up the same projected web-identity token as the server.
  const awsNameByChName: Readonly<Record<string, string>> = {
    [S3_ACCESS_KEY_ID_ENV]: 'AWS_ACCESS_KEY_ID',
    [S3_SECRET_ACCESS_KEY_ENV]: 'AWS_SECRET_ACCESS_KEY',
  };
  for (const entry of clickHouseS3ContainerEnv(config.storage)) {
    const awsName = awsNameByChName[entry.name];
    if (awsName === undefined) {
      throw new Error(
        `clickHouseS3BackupCronJob: unexpected S3 credential env var '${entry.name}'.`
      );
    }
    env.push({ name: awsName, valueFrom: entry.valueFrom });
  }
  return env;
}

/**
 * Create the scheduled backup CronJob for an S3-backed ClickHouse cluster.
 *
 * @param config - Backup CronJob configuration
 * @returns Enhanced CronJob resource with schedule-based readiness evaluation
 * @throws Error when the resolved storage carries no `backup` schedule
 *
 * @example
 * ```typescript
 * const backup = clickHouseS3BackupCronJob({
 *   name: 'observability',
 *   namespace: 'observability',
 *   version: '25.12.5',
 *   storage: resolved,
 *   nativePort: 9000,
 *   id: 'clickhouseBackup',
 * });
 * ```
 */
export function clickHouseS3BackupCronJob(
  config: ClickHouseS3BackupCronJobConfig
): Enhanced<V1CronJobSpec, V1CronJobStatus> {
  const backup = config.storage.backup;
  if (backup === undefined) {
    throw new Error(
      'clickHouseS3BackupCronJob: the resolved storage carries no backup schedule. ' +
        'Set storage.backup.schedule to render a backup CronJob.'
    );
  }

  const backupContainer: V1Container = {
    name: 'backup',
    image: `clickhouse/clickhouse-server:${config.version}`,
    command: ['sh', '-c', backupScript()],
    env: clickHouseConnectionEnv(config),
  };
  const prune: V1Container | undefined =
    backup.retentionDays === undefined
      ? undefined
      : {
          name: 'prune',
          image: DEFAULT_S3_PRUNE_IMAGE,
          command: ['sh', '-c', pruneScript()],
          env: pruneEnv(config),
        };

  const serviceAccountName = clickHouseS3ServiceAccountName(config.storage, config.name);

  return cronJob({
    ...(config.id !== undefined && { id: config.id }),
    metadata: {
      name: `${config.name}-s3-backup`,
      namespace: config.namespace,
      labels: {
        'app.kubernetes.io/name': 'clickhouse-s3-backup',
        'app.kubernetes.io/instance': config.name,
        'app.kubernetes.io/managed-by': 'typekro',
      },
    },
    spec: {
      schedule: backup.schedule,
      // A backup that overlaps its predecessor competes for the same server
      // and the same object keys; skip instead.
      concurrencyPolicy: 'Forbid',
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          backoffLimit: 2,
          template: {
            metadata: {
              labels: {
                'app.kubernetes.io/name': 'clickhouse-s3-backup',
                'app.kubernetes.io/instance': config.name,
              },
            },
            spec: {
              restartPolicy: 'Never',
              ...(serviceAccountName !== undefined && { serviceAccountName }),
              // Sequencing: with retention the backup must COMPLETE before the
              // prune reads the listing, and Job containers run in parallel —
              // so the backup becomes an initContainer.
              ...(prune === undefined
                ? { containers: [backupContainer] }
                : { initContainers: [backupContainer], containers: [prune] }),
            },
          },
        },
      },
    },
  });
}
