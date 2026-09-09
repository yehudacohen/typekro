/**
 * S3-backed ClickHouse storage — rendered XML, settings, credentials, and the
 * loud rejections.
 *
 * These tests are the contract for the durability design in issues #180-#182:
 * the discriminated `diskType`, the fact that the rendered configuration never
 * carries key material, and the refusal to mix PVC and S3 options.
 */
import { describe, expect, it } from 'bun:test';
import { clickHouseInstallation } from '../../../src/factories/clickhouse/resources/installation.js';
import { clickHouseS3BackupCronJob } from '../../../src/factories/clickhouse/resources/s3-backup.js';
import {
  CHI_STORAGE_CONFIG_FILE,
  MERGE_TREE_STORAGE_POLICY_SETTING,
  MIN_S3_PLAIN_REWRITABLE_VERSION,
  parseByteQuantity,
  parseClickHouseVersion,
  renderStorageConfigurationXml,
  resolveClickHouseStorage,
  S3_ACCESS_KEY_ID_ENV,
  S3_SECRET_ACCESS_KEY_ENV,
} from '../../../src/factories/clickhouse/utils/s3-storage.js';
import type { ClickHouseS3StorageOptions } from '../../../src/factories/clickhouse/types.js';
import { KUBERNETES_REF_BRAND } from '../../../src/shared/brands.js';

/** A fake schema-proxy ref, shaped like the analyzer's KubernetesRef marker. */
function fakeRef(path: string): unknown {
  return { [KUBERNETES_REF_BRAND]: true, resourceId: '__schema__', fieldPath: path };
}

const IRSA_S3: ClickHouseS3StorageOptions = {
  mode: 's3',
  bucket: 'example-observability',
  prefix: 'clickhouse',
  region: 'us-east-2',
  cache: { size: '50Gi' },
  auth: { irsa: { roleArn: 'arn:aws:iam::123456789012:role/clickhouse-s3' } },
};

const SECRET_S3: ClickHouseS3StorageOptions = {
  mode: 's3',
  bucket: 'clickhouse-data',
  endpoint: 'http://minio.minio.svc.cluster.local:9000',
  diskType: 's3_plain_rewritable',
  cache: { size: '1Gi' },
  auth: { secretRef: { name: 'minio-credentials' } },
};

function chiWith(storage: ClickHouseS3StorageOptions, version = '25.12.5') {
  return clickHouseInstallation({
    name: 'test-ch',
    namespace: 'observability',
    version,
    storage: { size: '100Gi', ...storage },
  });
}

describe('resolveClickHouseStorage', () => {
  it('defaults to PVC mode and emits no S3 configuration', () => {
    const resolved = resolveClickHouseStorage('test', { size: '10Gi' });
    expect(resolved.mode).toBe('pvc');
  });

  it('treats an explicit mode: pvc the same as omitting it', () => {
    const resolved = resolveClickHouseStorage('test', { size: '10Gi', mode: 'pvc' });
    expect(resolved.mode).toBe('pvc');
  });

  it('REJECTS mixing PVC mode with S3-only options', () => {
    expect(() =>
      resolveClickHouseStorage('test', {
        size: '10Gi',
        // No `mode: 's3'`, so the bucket can only be a mistake.
        bucket: 'my-bucket',
        region: 'us-east-2',
      })
    ).toThrow(/rejects the S3-only option\(s\) 'storage.bucket', 'storage.region'/);
  });

  it('names every stray S3 option in the mixing error', () => {
    expect(() =>
      resolveClickHouseStorage('test', { size: '10Gi', cache: { size: '1Gi' } })
    ).toThrow(/'storage.cache'/);
  });

  it('builds the AWS virtual-hosted endpoint from bucket, region and prefix', () => {
    const resolved = resolveClickHouseStorage('test', { size: '100Gi', ...IRSA_S3 });
    expect(resolved.mode).toBe('s3');
    if (resolved.mode !== 's3') throw new Error('expected S3 mode');
    expect(resolved.endpointUrl).toBe(
      'https://example-observability.s3.us-east-2.amazonaws.com/clickhouse/'
    );
  });

  it('builds a path-style endpoint for a custom S3-compatible service', () => {
    const resolved = resolveClickHouseStorage('test', { size: '10Gi', ...SECRET_S3 });
    if (resolved.mode !== 's3') throw new Error('expected S3 mode');
    expect(resolved.endpointUrl).toBe('http://minio.minio.svc.cluster.local:9000/clickhouse-data/');
  });

  it('normalizes a prefix with stray slashes', () => {
    const resolved = resolveClickHouseStorage('test', {
      size: '100Gi',
      ...IRSA_S3,
      prefix: '/nested/path/',
    });
    if (resolved.mode !== 's3') throw new Error('expected S3 mode');
    expect(resolved.prefix).toBe('nested/path');
    expect(resolved.endpointUrl).toContain('/nested/path/');
  });

  it('requires a region when no custom endpoint is given', () => {
    const { region: _region, ...withoutRegion } = IRSA_S3;
    expect(() => resolveClickHouseStorage('test', { size: '100Gi', ...withoutRegion })).toThrow(
      /'storage.region' is required for AWS S3/
    );
  });

  it('requires credentials and never accepts inline keys', () => {
    const { auth: _auth, ...withoutAuth } = IRSA_S3;
    expect(() => resolveClickHouseStorage('test', { size: '100Gi', ...withoutAuth })).toThrow(
      /'storage.auth' is required in S3 mode/
    );
  });

  it('rejects both credential transports at once', () => {
    expect(() =>
      resolveClickHouseStorage('test', {
        size: '100Gi',
        ...IRSA_S3,
        auth: {
          irsa: { roleArn: 'arn:aws:iam::1:role/a' },
          secretRef: { name: 's' },
        } as ClickHouseS3StorageOptions['auth'],
      })
    ).toThrow(/exactly one credential transport/);
  });

  it('requires a cache size, because the cache is the whole design', () => {
    const { cache: _cache, ...withoutCache } = IRSA_S3;
    expect(() => resolveClickHouseStorage('test', { size: '100Gi', ...withoutCache })).toThrow(
      /'storage.cache.size' is required in S3 mode/
    );
  });

  it('rejects a cache larger than the local volume that hosts it', () => {
    expect(() =>
      resolveClickHouseStorage('test', { size: '10Gi', ...IRSA_S3, cache: { size: '50Gi' } })
    ).toThrow(/exceeds 'storage.size'/);
  });

  it('rejects an invalid bucket name', () => {
    expect(() =>
      resolveClickHouseStorage('test', { size: '100Gi', ...IRSA_S3, bucket: 'Not_A_Bucket' })
    ).toThrow(/must be a valid S3 bucket name/);
  });

  it('rejects a schema reference anywhere in the S3 options', () => {
    expect(() =>
      resolveClickHouseStorage('test', {
        size: '100Gi',
        ...IRSA_S3,
        bucket: fakeRef('spec.bucket') as string,
      })
    ).toThrow(/contains a schema\/resource reference/);
  });
});

describe('s3_plain_rewritable version gate', () => {
  it('pins a documented minimum version', () => {
    expect(MIN_S3_PLAIN_REWRITABLE_VERSION).toBe('24.5');
  });

  it('rejects a server older than the minimum', () => {
    expect(() =>
      resolveClickHouseStorage('test', { size: '10Gi', ...SECRET_S3 }, '24.3.1.2')
    ).toThrow(/requires ClickHouse >= 24\.5/);
  });

  it('accepts the minimum version and anything newer', () => {
    expect(() =>
      resolveClickHouseStorage('test', { size: '10Gi', ...SECRET_S3 }, '24.5.0')
    ).not.toThrow();
    expect(() =>
      resolveClickHouseStorage('test', { size: '10Gi', ...SECRET_S3 }, '25.12.5')
    ).not.toThrow();
  });

  it('skips the gate for a version tag it cannot read, rather than guessing', () => {
    expect(parseClickHouseVersion('latest')).toBeUndefined();
    expect(() =>
      resolveClickHouseStorage('test', { size: '10Gi', ...SECRET_S3 }, 'latest')
    ).not.toThrow();
  });

  it('rejects more than one replica (no replication on plain_rewritable)', () => {
    expect(() =>
      clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        replicas: 2,
        storage: { size: '10Gi', ...SECRET_S3 },
      })
    ).toThrow(/does not support table replication/);
  });
});

describe('rendered storage_configuration XML', () => {
  it('renders the classic s3 disk, a cache disk, and the policy', () => {
    const resolved = resolveClickHouseStorage('test', { size: '100Gi', ...IRSA_S3 });
    if (resolved.mode !== 's3') throw new Error('expected S3 mode');
    const xml = renderStorageConfigurationXml(resolved);

    expect(xml).toContain('<clickhouse>');
    expect(xml).toContain('<storage_configuration>');
    expect(xml).toContain('<type>s3</type>');
    expect(xml).toContain(
      '<endpoint>https://example-observability.s3.us-east-2.amazonaws.com/clickhouse/</endpoint>'
    );
    expect(xml).toContain('<type>cache</type>');
    expect(xml).toContain('<disk>s3</disk>');
    expect(xml).toContain('<path>/var/lib/clickhouse/disks/s3_cache/</path>');
    // 50Gi in bytes — ClickHouse's cache max_size wants a byte count.
    expect(xml).toContain(`<max_size>${50 * 1024 ** 3}</max_size>`);
    expect(xml).toContain('<s3_main>');
    expect(xml).toContain('<main>');
    expect(xml).toContain('<disk>s3_cache</disk>');
  });

  it('renders the explicit plain_rewritable metadata form for s3_plain_rewritable', () => {
    const resolved = resolveClickHouseStorage('test', { size: '10Gi', ...SECRET_S3 });
    if (resolved.mode !== 's3') throw new Error('expected S3 mode');
    const xml = renderStorageConfigurationXml(resolved);

    expect(xml).toContain('<type>object_storage</type>');
    expect(xml).toContain('<object_storage_type>s3</object_storage_type>');
    expect(xml).toContain('<metadata_type>plain_rewritable</metadata_type>');
  });

  it('uses use_environment_credentials for IRSA and renders no key material', () => {
    const resolved = resolveClickHouseStorage('test', { size: '100Gi', ...IRSA_S3 });
    if (resolved.mode !== 's3') throw new Error('expected S3 mode');
    const xml = renderStorageConfigurationXml(resolved);

    expect(xml).toContain('<use_environment_credentials>true</use_environment_credentials>');
    expect(xml).not.toContain('access_key_id');
    expect(xml).not.toContain('secret_access_key');
    // The role ARN belongs on the ServiceAccount, not in server config.
    expect(xml).not.toContain('arn:aws:iam');
  });

  it('uses from_env for Secret-backed keys, never the values themselves', () => {
    const resolved = resolveClickHouseStorage('test', { size: '10Gi', ...SECRET_S3 });
    if (resolved.mode !== 's3') throw new Error('expected S3 mode');
    const xml = renderStorageConfigurationXml(resolved);

    expect(xml).toContain(`<access_key_id from_env="${S3_ACCESS_KEY_ID_ENV}">`);
    expect(xml).toContain(`<secret_access_key from_env="${S3_SECRET_ACCESS_KEY_ENV}">`);
    expect(xml).not.toContain('minio-credentials');
  });

  it('honors a custom policy name and cache path', () => {
    const resolved = resolveClickHouseStorage('test', {
      size: '100Gi',
      ...IRSA_S3,
      policyName: 'object_store',
      cache: { size: '10Gi', path: '/mnt/cache/' },
    });
    if (resolved.mode !== 's3') throw new Error('expected S3 mode');
    const xml = renderStorageConfigurationXml(resolved);

    expect(xml).toContain('<object_store>');
    expect(xml).toContain('<path>/mnt/cache/</path>');
  });

  it('renders an <s3> credential section for the backup destination', () => {
    const resolved = resolveClickHouseStorage('test', {
      size: '100Gi',
      ...IRSA_S3,
      backup: { schedule: '0 2 * * *' },
    });
    if (resolved.mode !== 's3') throw new Error('expected S3 mode');
    const xml = renderStorageConfigurationXml(resolved);

    // BACKUP ... TO S3 runs server-side, so its credentials must be in server
    // config rather than the query text.
    expect(xml).toContain('<s3>');
    expect(xml).toContain('<backup>');
    expect(xml).toContain(
      '<endpoint>https://example-observability.s3.us-east-2.amazonaws.com/backups/</endpoint>'
    );
  });
});

describe('clickHouseInstallation with S3 storage', () => {
  it('emits the storage XML under configuration.files', () => {
    const chi = chiWith(IRSA_S3);
    const files = chi.spec.configuration?.files;
    expect(files).toBeDefined();
    expect(Object.keys(files ?? {})).toContain(CHI_STORAGE_CONFIG_FILE);
    expect(files?.[CHI_STORAGE_CONFIG_FILE]).toContain('<storage_configuration>');
  });

  it('makes the policy the MergeTree default so external tooling needs no DDL', () => {
    const chi = chiWith(IRSA_S3);
    expect(chi.spec.configuration?.settings?.[MERGE_TREE_STORAGE_POLICY_SETTING]).toBe('s3_main');
  });

  it('runs the pod template as the IRSA ServiceAccount', () => {
    const chi = chiWith(IRSA_S3);
    const podTemplate = chi.spec.templates?.podTemplates?.[0];
    expect(podTemplate?.spec?.serviceAccountName).toBe('test-ch-s3');
  });

  it('honors an explicit ServiceAccount name', () => {
    const chi = chiWith({
      ...IRSA_S3,
      auth: { irsa: { roleArn: 'arn:aws:iam::1:role/a', serviceAccountName: 'byo-sa' } },
    });
    expect(chi.spec.templates?.podTemplates?.[0]?.spec?.serviceAccountName).toBe('byo-sa');
  });

  it('wires Secret-backed keys as required env vars and no plaintext', () => {
    const chi = chiWith(SECRET_S3, '25.12.5');
    const podTemplate = chi.spec.templates?.podTemplates?.[0];
    const container = (
      podTemplate?.spec?.containers as
        | {
            env?: { name: string; valueFrom?: { secretKeyRef?: Record<string, unknown> } }[];
          }[]
        | undefined
    )?.[0];
    const env = container?.env ?? [];

    expect(env.map((entry) => entry.name)).toEqual([
      S3_ACCESS_KEY_ID_ENV,
      S3_SECRET_ACCESS_KEY_ENV,
    ]);
    expect(env[0]?.valueFrom?.secretKeyRef).toEqual({
      name: 'minio-credentials',
      key: 'AWS_ACCESS_KEY_ID',
      optional: false,
    });
    // No ServiceAccount in Secret mode.
    expect(podTemplate?.spec?.serviceAccountName).toBeUndefined();
  });

  it('still emits the thin local volume claim', () => {
    const chi = chiWith(IRSA_S3);
    const claim = chi.spec.templates?.volumeClaimTemplates?.[0];
    expect(
      (claim?.spec as { resources?: { requests?: { storage?: string } } })?.resources?.requests
        ?.storage
    ).toBe('100Gi');
  });

  it('leaves a PVC-mode installation byte-for-byte unchanged', () => {
    const chi = clickHouseInstallation({
      name: 'test-ch',
      version: '25.12.5',
      storage: { size: '10Gi', storageClassName: 'gp3-expandable' },
    });
    expect(chi.spec.configuration?.files).toBeUndefined();
    expect(chi.spec.configuration?.settings).toBeUndefined();
    expect(chi.spec.templates?.podTemplates?.[0]?.spec?.serviceAccountName).toBeUndefined();
  });
});

describe('clickHouseS3BackupCronJob', () => {
  function resolvedWithBackup(
    backup: NonNullable<ClickHouseS3StorageOptions['backup']>,
    base: ClickHouseS3StorageOptions = IRSA_S3
  ) {
    const resolved = resolveClickHouseStorage('test', { size: '100Gi', ...base, backup });
    if (resolved.mode !== 's3') throw new Error('expected S3 mode');
    return resolved;
  }

  it('renders a single-container CronJob without retention', () => {
    const job = clickHouseS3BackupCronJob({
      name: 'test-ch',
      namespace: 'observability',
      version: '25.12.5',
      storage: resolvedWithBackup({ schedule: '0 2 * * *' }),
      nativePort: 9000,
    });

    expect(job.spec.schedule).toBe('0 2 * * *');
    expect(job.spec.concurrencyPolicy).toBe('Forbid');
    const podSpec = job.spec.jobTemplate.spec?.template.spec;
    expect(podSpec?.initContainers).toBeUndefined();
    expect(podSpec?.containers?.[0]?.name).toBe('backup');
    expect(podSpec?.containers?.[0]?.command?.[2]).toContain('BACKUP DATABASE');
    // Credentials come from the server's <s3> section, never the statement.
    expect(podSpec?.containers?.[0]?.command?.[2]).not.toContain('access_key');
    expect(podSpec?.serviceAccountName).toBe('test-ch-s3');
  });

  it('sequences the prune step after the backup when retention is set', () => {
    const job = clickHouseS3BackupCronJob({
      name: 'test-ch',
      namespace: 'observability',
      version: '25.12.5',
      storage: resolvedWithBackup({ schedule: '0 2 * * *', retention: { days: 14 } }),
      nativePort: 9000,
    });
    const podSpec = job.spec.jobTemplate.spec?.template.spec;

    expect(podSpec?.initContainers?.[0]?.name).toBe('backup');
    expect(podSpec?.containers?.[0]?.name).toBe('prune');
    const pruneEnv = podSpec?.containers?.[0]?.env ?? [];
    expect(pruneEnv.find((entry) => entry.name === 'RETENTION_DAYS')?.value).toBe('14');
    expect(pruneEnv.find((entry) => entry.name === 'BACKUP_PREFIX')?.value).toBe('backups');
  });

  it('maps Secret-backed S3 keys onto the AWS CLI variable names', () => {
    const job = clickHouseS3BackupCronJob({
      name: 'test-ch',
      namespace: 'observability',
      version: '25.12.5',
      storage: resolvedWithBackup({ schedule: '0 2 * * *', retention: { days: 3 } }, SECRET_S3),
      nativePort: 9000,
    });
    const pruneEnv = job.spec.jobTemplate.spec?.template.spec?.containers?.[0]?.env ?? [];

    expect(pruneEnv.find((entry) => entry.name === 'AWS_ACCESS_KEY_ID')?.valueFrom).toEqual({
      secretKeyRef: { name: 'minio-credentials', key: 'AWS_ACCESS_KEY_ID', optional: false },
    });
    expect(pruneEnv.find((entry) => entry.name === 'AWS_ENDPOINT_URL')?.value).toBe(
      'http://minio.minio.svc.cluster.local:9000'
    );
  });

  it('reads ClickHouse credentials from a Secret when asked', () => {
    const job = clickHouseS3BackupCronJob({
      name: 'test-ch',
      namespace: 'observability',
      version: '25.12.5',
      storage: resolvedWithBackup({
        schedule: '0 2 * * *',
        auth: { secretRef: { name: 'ch-backup-user' } },
      }),
      nativePort: 9000,
    });
    const env = job.spec.jobTemplate.spec?.template.spec?.containers?.[0]?.env ?? [];

    expect(env.find((entry) => entry.name === 'CLICKHOUSE_PASSWORD')?.valueFrom).toEqual({
      secretKeyRef: { name: 'ch-backup-user', key: 'password', optional: false },
    });
  });

  it('rejects a backup prefix that would collide with the data disk root', () => {
    expect(() => resolvedWithBackup({ schedule: '0 2 * * *', prefix: '/' })).toThrow(
      /must be a non-empty key prefix/
    );
  });

  it('rejects a non-identifier database name (it is interpolated into SQL)', () => {
    expect(() =>
      resolvedWithBackup({ schedule: '0 2 * * *', database: 'default; DROP DATABASE x' })
    ).toThrow(/must be a bare SQL identifier/);
  });

  it('rejects a non-positive retention', () => {
    expect(() => resolvedWithBackup({ schedule: '0 2 * * *', retention: { days: 0 } })).toThrow(
      /must be a positive integer/
    );
  });

  // ── Sharded clusters: BACKUP ... ON CLUSTER ────────────────────────────
  //
  // A single-host statement backs up only the shard the client connected to,
  // so on a distributed topology the CronJob has to fan the statement out.
  describe('ON CLUSTER rendering', () => {
    function script(overrides: Record<string, unknown> = {}) {
      const job = clickHouseS3BackupCronJob({
        name: 'test-ch',
        namespace: 'observability',
        version: '25.12.5',
        storage: resolvedWithBackup({ schedule: '0 2 * * *' }),
        nativePort: 9000,
        ...overrides,
      });
      const podSpec = job.spec.jobTemplate.spec?.template.spec;
      const container = podSpec?.initContainers?.[0] ?? podSpec?.containers?.[0];
      return { text: container?.command?.[2] ?? '', env: container?.env ?? [] };
    }

    it('renders a SINGLE-HOST statement for a single-node topology', () => {
      const { text, env } = script();
      expect(text).toContain('BACKUP DATABASE $CLICKHOUSE_DATABASE TO S3(');
      expect(text).not.toContain('ON CLUSTER');
      // No cluster env var is emitted at all, so nothing can be half-wired.
      expect(env.find((entry) => entry.name === 'CLICKHOUSE_CLUSTER')).toBeUndefined();
    });

    it('renders ON CLUSTER, taking the name from an env var', () => {
      const { text, env } = script({ onCluster: true, clusterName: 'cluster' });
      // The clause interpolates the CHECKED AND ESCAPED copy of the env var,
      // never the raw value — see the guard test below.
      expect(text).toContain(
        "BACKUP DATABASE $CLICKHOUSE_DATABASE ON CLUSTER '$CLUSTER_SQL' TO S3("
      );
      expect(text).toContain('CLUSTER="$CLICKHOUSE_CLUSTER"');
      // The name travels as an env value rather than being baked into the
      // script text, so a schema reference (the runtime `spec.clusterName`)
      // survives serialization.
      expect(env.find((entry) => entry.name === 'CLICKHOUSE_CLUSTER')?.value).toBe('cluster');
      expect(text).not.toContain("ON CLUSTER 'cluster'");
    });

    it('re-checks and escapes the cluster name INSIDE the container', () => {
      // Defence in depth: the build-time check only sees concrete strings, and
      // the KRO schema pattern only guards the instance — the value that
      // actually reaches the statement is an env var on a rendered CronJob.
      const { text } = script({ onCluster: true, clusterName: 'cluster' });
      expect(text).toContain('case "$CLUSTER" in');
      expect(text).toContain('"" | *[!A-Za-z0-9-]* | [!A-Za-z]* | *-)');
      expect(text).toContain('is not a cluster identifier');
      expect(text).toContain('exit 1');
      // The CRD's own 15-character cap, re-asserted at run time.
      expect(text).toContain('if [ "${#CLUSTER}" -gt 15 ]; then');
      // ClickHouse escapes a quote in a string literal by doubling it.
      expect(text).toContain(`CLUSTER_SQL="$(printf '%s' "$CLUSTER" | sed "s/'/''/g")"`);
    });

    it('emits no cluster guard at all for a single-host statement', () => {
      const { text } = script();
      expect(text).not.toContain('CLUSTER_SQL');
      expect(text).not.toContain('case "$CLUSTER" in');
    });

    it('uses ONE coordinated destination — no {shard}/{replica} macros', () => {
      // Macros in the destination would produce N independent per-shard
      // backups needing N restore statements; ON CLUSTER produces one.
      const { text } = script({ onCluster: true, clusterName: 'cluster' });
      expect(text).toContain("S3('$BACKUP_ENDPOINT$NAME')");
      expect(text).not.toContain('{shard}');
      expect(text).not.toContain('{replica}');
    });

    it('still carries no credentials in the ON CLUSTER statement', () => {
      const { text } = script({ onCluster: true, clusterName: 'cluster' });
      expect(text).not.toContain('access_key');
      expect(text).not.toContain('AWS_SECRET');
    });

    it('requires a cluster name when onCluster is set', () => {
      expect(() => script({ onCluster: true })).toThrow(/`onCluster` requires `clusterName`/);
    });

    it('accepts the cluster names the operator and ClickHouse both allow', () => {
      for (const clusterName of ['cluster', 'c', 'my-cluster', 'Cluster9', 'abcdefghijklmno']) {
        expect(() => script({ onCluster: true, clusterName })).not.toThrow();
      }
    });

    it('rejects a cluster name that could break out of the ON CLUSTER clause', () => {
      // A quote or a semicolon here is extra SQL, not a bad name.
      expect(() => script({ onCluster: true, clusterName: "c'; DROP DATABASE x; --" })).toThrow(
        /must match/
      );
      expect(() => script({ onCluster: true, clusterName: 'my cluster' })).toThrow(/must match/);
      expect(() => script({ onCluster: true, clusterName: 'a;b' })).toThrow(/must match/);
    });

    it('rejects names the operator or ClickHouse itself would refuse', () => {
      // Leading digit / dash: not an identifier. Underscore and >15 chars: the
      // Altinity CRD's own `^[a-zA-Z0-9-]{0,15}$` / maxLength 15 on
      // `clusters[].name`, so accepting them would just defer the failure to
      // apply time.
      expect(() => script({ onCluster: true, clusterName: '9cluster' })).toThrow(/must match/);
      expect(() => script({ onCluster: true, clusterName: '-cluster' })).toThrow(/must match/);
      expect(() => script({ onCluster: true, clusterName: 'cluster-' })).toThrow(/must match/);
      expect(() => script({ onCluster: true, clusterName: 'my_cluster' })).toThrow(/must match/);
      expect(() => script({ onCluster: true, clusterName: 'abcdefghijklmnop' })).toThrow(
        /must match/
      );
      expect(() => script({ onCluster: true, clusterName: '' })).toThrow(/must match/);
    });

    it('leaves a schema reference to KRO rather than rejecting it', () => {
      // In kro mode `spec.clusterName` is a reference at construction; the
      // pattern travels into the RGD schema instead of being checked here.
      expect(() =>
        script({ onCluster: true, clusterName: { __brand: 'KubernetesRef' } })
      ).not.toThrow();
    });
  });
});

describe('parseByteQuantity', () => {
  it('parses binary and decimal suffixes', () => {
    expect(parseByteQuantity('t', 'f', '1Ki')).toBe(1024);
    expect(parseByteQuantity('t', 'f', '1Mi')).toBe(1024 ** 2);
    expect(parseByteQuantity('t', 'f', '2Gi')).toBe(2 * 1024 ** 3);
    expect(parseByteQuantity('t', 'f', '1G')).toBe(1000 ** 3);
    expect(parseByteQuantity('t', 'f', '4096')).toBe(4096);
  });

  it('rejects an unparseable quantity loudly', () => {
    expect(() => parseByteQuantity('t', 'storage.cache.size', 'lots')).toThrow(
      /must be a Kubernetes-style byte quantity/
    );
  });
});
