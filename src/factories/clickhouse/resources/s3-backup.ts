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
 * SHARDED CLUSTERS — WHY `ON CLUSTER` IS NOT OPTIONAL
 * A plain `BACKUP DATABASE db TO S3(...)` is executed by the ONE server the
 * client happened to connect to, and that server only holds its own shard's
 * parts. On a multi-shard cluster that silently produces a PARTIAL backup: it
 * succeeds, it is restorable, and it is missing every other shard's data.
 * ClickHouse's answer is `BACKUP ... ON CLUSTER '<cluster>' TO S3(...)`, which
 * fans the statement out to every host of the cluster and coordinates them
 * through [Zoo]Keeper so that all of them contribute to ONE backup at ONE
 * destination path (the `backup_restore_keeper_*` settings in the BACKUP/
 * RESTORE reference exist for exactly this coordination). No `{shard}` /
 * `{replica}` macros belong in the destination: that convention produces N
 * INDEPENDENT per-shard backups, which is a different (external-tool) design
 * and would need N restore statements.
 *
 * Because the coordination is Keeper-based, `ON CLUSTER` is only rendered for
 * topologies that actually have a Keeper — {@link makeClickHouseCluster}
 * REJECTS a multi-shard/multi-replica topology with a backup schedule and no
 * keeper at construction rather than emitting a statement that would back up
 * one shard.
 *
 * RESTORE is deliberately NOT automated — restoring over a live database is a
 * decision, not a schedule. The procedure is documented in
 * `docs/api/clickhouse/index.md`; in short (matching the backup's own shape):
 * `RESTORE DATABASE <db> [ON CLUSTER '<cluster>'] FROM S3('<endpoint>/<timestamp>')`.
 */

import type {
  V1Container,
  V1CronJobSpec,
  V1CronJobStatus,
  V1EnvVar,
} from '@kubernetes/client-node';
import { type } from 'arktype';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import { cronJob } from '../../kubernetes/workloads/cron-job.js';
import type { ResolvedClickHouseS3Storage } from '../utils/s3-storage.js';
import { assertClickHouseClusterName } from '../utils/validation.js';
import {
  S3_ACCESS_KEY_ID_ENV,
  S3_SECRET_ACCESS_KEY_ENV,
  clickHouseS3ContainerEnv,
  clickHouseS3ServiceAccountName,
} from '../utils/s3-storage.js';

/** Image used for the prune step (the ClickHouse image has no AWS CLI). */
export const DEFAULT_S3_PRUNE_IMAGE = 'amazon/aws-cli:2.22.35';

/**
 * The composition-facing form of {@link ClickHouseS3BackupCronJobConfig}.
 *
 * `Composable<T>` everywhere EXCEPT `storage`: the resolved S3 storage is
 * build-time concrete by construction (`resolveClickHouseStorage` rejects a
 * schema reference in S3 mode, because the values compile into a
 * `storage_configuration` XML document), so loosening it into proxy form would
 * describe a value this factory can never receive — and would make every
 * optional field of the resolution nullable for no reason. The RUNTIME fields
 * (`name`, `namespace`, `version`, `clusterName`) are exactly the ones that may
 * be schema references, and they are the ones `Composable` covers here.
 */
export type ComposableClickHouseS3BackupCronJobConfig = Composable<
  Omit<ClickHouseS3BackupCronJobConfig, 'storage'>
> & {
  storage: ResolvedClickHouseS3Storage;
};

/** What `storage` has to be, quoted into the ArkType error on a bad value. */
export const RESOLVED_S3_STORAGE_REQUIREMENT =
  "a resolved S3 storage (mode: 's3'), as returned by resolveClickHouseStorage()";

/**
 * The `storage` input: an already-RESOLVED S3 storage.
 *
 * `ResolvedClickHouseS3Storage` is a RESULT shape, not user input — it is what
 * `resolveClickHouseStorage()` returns after defaulting and validating the
 * user-facing `ClickHouseInstallationStorageSchema`, and every invariant
 * it carries has already been enforced there. So this schema does not restate
 * that shape field by field (which would be a second source of truth for the
 * resolution, exactly the drift the schema-first rule exists to prevent): it
 * checks the discriminant that says the value came out of the S3 branch of the
 * resolver, and carries the resolved type through `.narrow()`'s predicate so
 * {@link ClickHouseS3BackupCronJobConfig} is still inferred WHOLE from this
 * schema — no hand-written widening layer on top of `.infer`.
 */
export const ClickHouseS3BackupStorageSchema = type('object').narrow(
  (storage, ctx): storage is ResolvedClickHouseS3Storage =>
    (storage as ResolvedClickHouseS3Storage).mode === 's3' ||
    ctx.mustBe(RESOLVED_S3_STORAGE_REQUIREMENT)
);

/**
 * ArkType schema for ClickHouseS3BackupCronJobConfig.
 *
 * Configuration for {@link clickHouseS3BackupCronJob}.
 */
export const ClickHouseS3BackupCronJobConfigSchema = type({
  /** CHI name — anchors the CronJob name and the ClickHouse service host. */
  name: 'string',
  /** CHI namespace. */
  namespace: 'string',
  /** ClickHouse server version, used for the `clickhouse-client` image. */
  version: 'string',
  /** Resolved S3 storage (must carry a `backup` schedule). */
  storage: ClickHouseS3BackupStorageSchema,
  /** Native TCP port of the ClickHouse service. */
  nativePort: 'number',
  /**
   * CHI cluster name, required when `onCluster` is set — it becomes the
   * `ON CLUSTER '<name>'` target. Passed to the container as an env var rather
   * than baked into the script text so a schema reference (the runtime
   * `spec.clusterName`) survives serialization the way `database` does.
   */
  'clusterName?': 'string',
  /**
   * Render `BACKUP ... ON CLUSTER` instead of a single-host statement.
   *
   * BUILD-TIME: true iff the topology has more than one shard or replica, or a
   * Keeper is configured. See the module doc for why a single-host statement is
   * a partial backup on a sharded cluster.
   */
  'onCluster?': 'boolean',
  /** Resource id for composition references. */
  'id?': 'string',
});

/**
 * Configuration for {@link clickHouseS3BackupCronJob}.
 *
 * INFERRED WHOLE from {@link ClickHouseS3BackupCronJobConfigSchema}, including
 * `storage` — a field cannot exist in the type without existing in the schema
 * that validates it.
 */
export type ClickHouseS3BackupCronJobConfig =
  typeof ClickHouseS3BackupCronJobConfigSchema.infer;

/**
 * Env var carrying the `ON CLUSTER` target into the backup container.
 *
 * `CLICKHOUSE_CLUSTER` is NOT a name `clickhouse-client` interprets, so it
 * cannot collide with the client's own configuration.
 */
export const BACKUP_CLUSTER_ENV = 'CLICKHOUSE_CLUSTER';

/**
 * Shell script for the backup step.
 *
 * `set -eu` plus an explicit `--query` exit code means a failed BACKUP fails
 * the Job (and, with `retention`, skips the prune step) rather than reporting
 * success on an empty backup.
 */
function backupScript(onCluster: boolean): string {
  // `ON CLUSTER '<name>'` fans the statement out to every host of the cluster
  // and coordinates them into ONE backup through Keeper. Without it the
  // connected host backs up only its own shard — see the module doc.
  //
  // The clause interpolates `$CLUSTER_SQL`, not the raw env var: see
  // `clusterNameGuard()` for why the value is re-checked and re-escaped inside
  // the container even though it is validated on the way in.
  const onClusterClause = onCluster ? " ON CLUSTER '$CLUSTER_SQL'" : '';
  return [
    'set -eu',
    ...(onCluster ? clusterNameGuard() : []),
    // DEFENCE IN DEPTH, mirroring `clusterNameGuard()`: the destination URL is
    // composed and validated as a WHOLE at construction time (see
    // `composeS3EndpointUrl` in `utils/s3-storage.ts`), and by that check it
    // cannot contain a quote at all. But the value reaching this statement is an
    // env var on a rendered CronJob, so the script escapes it the way
    // ClickHouse escapes a quote in a string literal — doubling it — rather
    // than trusting that the manifest was never edited. The pair's failure mode
    // is a backup written to a nonsense path, never an injected statement; the
    // construction-time validation is what makes the path correct, and this is
    // only what keeps the LITERAL closed if that validation is ever weakened.
    'ENDPOINT_SQL="$(printf \'%s\' "$BACKUP_ENDPOINT" | sed "s/\'/\'\'/g")"',
    'NAME="$(date -u +%Y%m%d%H%M%S)"',
    onCluster
      ? 'echo "Backing up database $CLICKHOUSE_DATABASE on cluster' +
        ` $${BACKUP_CLUSTER_ENV} to $BACKUP_ENDPOINT$NAME"`
      : 'echo "Backing up database $CLICKHOUSE_DATABASE to $BACKUP_ENDPOINT$NAME"',
    // The destination credentials come from the server's `<s3>` config section
    // (rendered by the storage compiler and matched by endpoint prefix), so the
    // statement itself carries none — nothing sensitive reaches query_log.
    // The database name is validated as a bare SQL identifier at resolve time;
    // the cluster name and the endpoint are checked and escaped above.
    'clickhouse-client --host "$CLICKHOUSE_HOST" --port "$CLICKHOUSE_PORT"' +
      ' --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD"' +
      ` --query "BACKUP DATABASE $CLICKHOUSE_DATABASE${onClusterClause} TO` +
      " S3('$ENDPOINT_SQL$NAME')\"",
    'echo "Backup $NAME complete"',
  ].join('\n');
}

/**
 * Re-validate and escape the `ON CLUSTER` target inside the container.
 *
 * DEFENCE IN DEPTH, and the depth is real: the name is checked on the way in
 * ({@link assertClickHouseClusterName}) only when it is a CONCRETE string, and
 * carried into the RGD as a `pattern=` marker for the kro path — but the value
 * that actually reaches this script is an environment variable, resolved by
 * KRO at instance time and editable on the rendered CronJob afterwards. So the
 * script asserts the same rule itself and REFUSES to run rather than issue a
 * statement built from a name it does not recognise.
 *
 * The escape (doubling `'`, ClickHouse's own string-literal escape) is
 * redundant after that check by construction. It is emitted anyway so the
 * statement stays well-formed if the guard is ever relaxed — the failure mode
 * of the pair is a refused backup, never an injected one.
 */
function clusterNameGuard(): string[] {
  return [
    `CLUSTER="$${BACKUP_CLUSTER_ENV}"`,
    // POSIX `case` globs, matched against the WHOLE word: empty, any
    // disallowed character (the `-` sits last in the bracket expression, where
    // it is literal), a first character that is not a letter, or a trailing
    // dash. Same rule as CLICKHOUSE_CLUSTER_NAME_PATTERN.
    'case "$CLUSTER" in',
    '  "" | *[!A-Za-z0-9-]* | [!A-Za-z]* | *-)',
    `    echo "Refusing to back up: $${BACKUP_CLUSTER_ENV} is not a cluster identifier" >&2`,
    '    exit 1 ;;',
    'esac',
    // The Altinity CRD caps `clusters[].name` at 15 characters; a longer value
    // cannot name a real cluster, so it is a bug or an edit, not a backup.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell string length
    'if [ "${#CLUSTER}" -gt 15 ]; then',
    `  echo "Refusing to back up: $${BACKUP_CLUSTER_ENV} is longer than 15 characters" >&2`,
    '  exit 1',
    'fi',
    // ClickHouse escapes a quote inside a string literal by doubling it.
    'CLUSTER_SQL="$(printf \'%s\' "$CLUSTER" | sed "s/\'/\'\'/g")"',
  ];
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
function clickHouseConnectionEnv(
  config: ComposableClickHouseS3BackupCronJobConfig
): V1EnvVar[] {
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
    ...(config.onCluster === true
      ? // `clusterName` is required when `onCluster` is set (checked by the
        // factory below), but it may legitimately be a schema reference, so it
        // travels as an env value exactly like `database` does.
        [{ name: BACKUP_CLUSTER_ENV, value: config.clusterName as string }]
      : []),
  ];
}

/** AWS env for the prune step: bucket coordinates plus the same credentials. */
function pruneEnv(config: ComposableClickHouseS3BackupCronJobConfig): V1EnvVar[] {
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
  //
  // A `Map`, not an object literal, so the lookup below cannot read
  // `Object.prototype`: `({})['constructor']` is a FUNCTION, not `undefined`,
  // so the "unexpected env var" guard would have passed such a name straight
  // through and pushed a container env var whose `name` is not a string. The
  // env names are ours today, but the guard is the thing that has to hold.
  const awsNameByChName = new Map<string, string>([
    [S3_ACCESS_KEY_ID_ENV, 'AWS_ACCESS_KEY_ID'],
    [S3_SECRET_ACCESS_KEY_ENV, 'AWS_SECRET_ACCESS_KEY'],
  ]);
  for (const entry of clickHouseS3ContainerEnv(config.storage)) {
    const awsName = awsNameByChName.get(entry.name);
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
 * @throws Error when the resolved storage carries no `backup` schedule, when
 *   `onCluster` is set without a `clusterName`, or when a concrete
 *   `clusterName` is not a bare identifier
 *
 * @example
 * ```typescript
 * const backup = clickHouseS3BackupCronJob({
 *   name: 'observability',
 *   namespace: 'observability',
 *   version: '25.12.5',
 *   storage: resolved,
 *   nativePort: 9000,
 *   // Sharded/replicated topology: back up EVERY shard, coordinated by Keeper.
 *   onCluster: true,
 *   clusterName: 'cluster',
 *   id: 'clickhouseBackup',
 * });
 * ```
 */
export function clickHouseS3BackupCronJob(
  config: ComposableClickHouseS3BackupCronJobConfig
): Enhanced<V1CronJobSpec, V1CronJobStatus> {
  const backup = config.storage.backup;
  if (backup === undefined) {
    throw new Error(
      'clickHouseS3BackupCronJob: the resolved storage carries no backup schedule. ' +
        'Set storage.backup.schedule to render a backup CronJob.'
    );
  }
  const onCluster = config.onCluster === true;
  if (onCluster && config.clusterName === undefined) {
    throw new Error(
      'clickHouseS3BackupCronJob: `onCluster` requires `clusterName` — it is the ' +
        "`ON CLUSTER '<name>'` target of the BACKUP statement."
    );
  }
  if (onCluster) {
    // Concrete names only — a schema reference is validated by the generated
    // KRO schema (`ClickHouseClusterNameSchema`) and, at run time, by the
    // guard the script itself carries.
    assertClickHouseClusterName(
      'clickHouseS3BackupCronJob',
      'clusterName',
      config.clusterName
    );
  }

  const backupContainer: V1Container = {
    name: 'backup',
    image: `clickhouse/clickhouse-server:${config.version}`,
    command: ['sh', '-c', backupScript(onCluster)],
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
