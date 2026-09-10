/**
 * makeClickHouseCluster with S3-backed storage.
 *
 * Storage is a BUILD-TIME topology choice here for the same reason `zones` is:
 * it compiles into server-configuration text and selects which resources exist
 * (the IRSA ServiceAccount, the backup CronJob). These tests pin that split,
 * the rendered pod template + ServiceAccount pairing (#181), and the status
 * storage contract (#182) — all under TYPEKRO_STRICT_CEL=1, so every status
 * expression the new fields add is proven strict-CEL-clean.
 */

import { type } from 'arktype';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  clickHouseCluster,
  ClickHouseS3PlainRewritableVersionSchema,
  makeClickHouseCluster,
  S3_PLAIN_REWRITABLE_VERSION_PATTERN,
} from '../../../src/factories/clickhouse/index.js';
import type { ClickHouseS3StorageOptions } from '../../../src/factories/clickhouse/types.js';
import { KUBERNETES_REF_BRAND } from '../../../src/shared/brands.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
});

afterAll(() => {
  if (ORIGINAL_STRICT_ENV === undefined) delete process.env.TYPEKRO_STRICT_CEL;
  else process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT_ENV;
});

const IRSA_S3: ClickHouseS3StorageOptions = {
  mode: 's3',
  bucket: 'example-observability',
  prefix: 'clickhouse',
  region: 'us-east-2',
  cache: { size: '50Gi' },
  auth: { irsa: { roleArn: 'arn:aws:iam::123456789012:role/clickhouse-s3' } },
};

const PLAIN_REWRITABLE_S3: ClickHouseS3StorageOptions = {
  ...IRSA_S3,
  diskType: 's3_plain_rewritable',
};

const BACKED_UP_S3: ClickHouseS3StorageOptions = {
  ...IRSA_S3,
  backup: { schedule: '0 2 * * *', retention: { days: 14 } },
};

describe('makeClickHouseCluster({ storage: { mode: "s3" } })', () => {
  it('serializes the storage XML, the policy default, and the IRSA ServiceAccount', () => {
    const clickhouse = makeClickHouseCluster({ storage: IRSA_S3 });
    const yaml = clickhouse.toYaml();

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('kind: ClickHouseInstallation');
    expect(yaml).toContain('kind: ServiceAccount');
    expect(yaml).toContain(
      'eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/clickhouse-s3'
    );
    expect(yaml).toContain('<storage_configuration>');
    expect(yaml).toContain('merge_tree/storage_policy: s3_main');
    // The local volume size stays a runtime schema ref — it is the ONLY
    // per-instance half of storage.
    expect(yaml).toContain('${schema.spec.storage.size}');
  });

  it('names the ServiceAccount after the instance and runs the pod template as it', () => {
    const yaml = makeClickHouseCluster({ storage: IRSA_S3 }).toYaml();
    // Both the SA metadata.name and the pod template's serviceAccountName are
    // derived from the same instance name expression, so they always match.
    expect(yaml).toContain('serviceAccountName: ${string(schema.spec.name)}-s3');
    expect(yaml).toContain('name: ${string(schema.spec.name)}-s3');
  });

  it('honors an explicit ServiceAccount name', () => {
    const yaml = makeClickHouseCluster({
      storage: {
        ...IRSA_S3,
        auth: { irsa: { roleArn: 'arn:aws:iam::1:role/a', serviceAccountName: 'byo-sa' } },
      },
    }).toYaml();
    expect(yaml).toContain('serviceAccountName: byo-sa');
  });

  it('creates NO ServiceAccount for Secret-backed credentials', () => {
    const yaml = makeClickHouseCluster({
      storage: {
        mode: 's3',
        bucket: 'clickhouse-data',
        endpoint: 'http://minio.minio.svc.cluster.local:9000',
        diskType: 's3_plain_rewritable',
        cache: { size: '5Gi' },
        auth: { secretRef: { name: 'minio-credentials' } },
      },
    }).toYaml();

    expect(yaml).not.toContain('kind: ServiceAccount');
    expect(yaml).toContain('CLICKHOUSE_S3_ACCESS_KEY_ID');
    expect(yaml).toContain('<metadata_type>plain_rewritable</metadata_type>');
    // The Secret is referenced, never inlined.
    expect(yaml).toContain('name: minio-credentials');
  });

  it('renders the backup CronJob only when a schedule is declared', () => {
    const withoutBackup = makeClickHouseCluster({ storage: IRSA_S3 }).toYaml();
    expect(withoutBackup).not.toContain('kind: CronJob');

    const withBackup = makeClickHouseCluster({ storage: BACKED_UP_S3 }).toYaml();
    expect(withBackup).toContain('kind: CronJob');
    expect(withBackup).toContain('BACKUP DATABASE');
    expect(withBackup).toContain('amazon/aws-cli');
  });

  // ── Every shard gets backed up ─────────────────────────────────────────
  //
  // A plain `BACKUP DATABASE db TO S3(...)` runs on the ONE host the client
  // connected to, which on a sharded cluster is a backup that succeeds while
  // capturing a single shard.
  it('keeps the single-host statement on a 1-shard, 1-replica topology', () => {
    const yaml = makeClickHouseCluster({ storage: BACKED_UP_S3 }).toYaml();
    expect(yaml).toContain('BACKUP DATABASE $CLICKHOUSE_DATABASE TO S3(');
    expect(yaml).not.toContain('ON CLUSTER');
    expect(yaml).not.toContain('CLICKHOUSE_CLUSTER');
  });

  it('renders ON CLUSTER for a multi-SHARD topology, off the CHI cluster name', () => {
    const yaml = makeClickHouseCluster({
      shards: 3,
      keeper: true,
      storage: BACKED_UP_S3,
    }).toYaml();
    expect(yaml).toContain(
      "BACKUP DATABASE $CLICKHOUSE_DATABASE ON CLUSTER '$CLUSTER_SQL' TO S3("
    );
    // The name comes from the same runtime expression the CHI's cluster is
    // named after, so the statement and the cluster cannot drift.
    expect(yaml).toContain('CLICKHOUSE_CLUSTER');
    expect(yaml).toContain('shardsCount: 3');
  });

  it('renders ON CLUSTER for a multi-REPLICA topology (keeper defaults on)', () => {
    const yaml = makeClickHouseCluster({ replicas: 2, storage: BACKED_UP_S3 }).toYaml();
    expect(yaml).toContain("ON CLUSTER '$CLUSTER_SQL'");
  });

  it('rejects a multi-shard backup with no keeper at CONSTRUCTION time', () => {
    // `ON CLUSTER` coordination is Keeper-based, so without a keeper the only
    // statement available would silently capture one shard. Note that `keeper`
    // does NOT default on for shards, only for replicas.
    expect(() => makeClickHouseCluster({ shards: 2, storage: BACKED_UP_S3 })).toThrow(
      /requires a keeper/
    );
    expect(() =>
      makeClickHouseCluster({ replicas: 2, keeper: false, storage: BACKED_UP_S3 })
    ).toThrow(/requires a keeper/);
  });

  it('leaves a keeperless SHARDED topology alone when no backup is declared', () => {
    // The rejection is about a backup that would be partial, not about
    // sharding — a cluster with no backup schedule is unaffected.
    expect(() => makeClickHouseCluster({ shards: 2, storage: IRSA_S3 })).not.toThrow();
  });

  it('surfaces the durability decision on the status contract', () => {
    const plainRewritable = makeClickHouseCluster({ storage: PLAIN_REWRITABLE_S3 });
    const plan = plainRewritable.plan?.(
      {
        name: 'observability',
        namespace: 'observability',
        version: '25.12.5',
        storage: { size: '100Gi' },
      },
      { strict: true }
    );
    const serialized = JSON.stringify(plan);

    // The durability decision is a CONSTRUCTION-TIME value, so it lives as a
    // literal in the contract ConfigMap this composition owns...
    expect(serialized).toContain(
      '"key":"storageDiskType","value":{"kind":"literal","value":"s3_plain_rewritable"}'
    );
    expect(serialized).toContain(
      '"key":"storageSelfDescribingBucket","value":{"kind":"literal","value":"true"}'
    );
    expect(serialized).toContain(
      '"key":"storageBucket","value":{"kind":"literal","value":"example-observability"}'
    );

    // ...and the STATUS reads it back from that resource, so it survives KRO
    // instead of being a literal leaf KRO drops from the instance.
    const outputs = serialized.slice(serialized.indexOf('"outputs"'));
    for (const field of ['diskType', 'selfDescribingBucket', 'bucket', 'policyName', 'mode']) {
      expect(outputs).toContain(`"key":"${field}"`);
    }
    expect(outputs).toContain('clickhouseContract.data.storageDiskType');
    expect(outputs).toContain('clickhouseContract.data.storageSelfDescribingBucket ==');
    // Nothing in the status is a literal any more: every leaf is an
    // expression, a template, or a reference over a resource in the graph.
    expect(outputs).not.toContain('"kind":"literal","value":"s3_plain_rewritable"');
  });

  it('reports pvc mode on the default topology', () => {
    const plan = clickHouseCluster.plan?.(
      {
        name: 'observability',
        namespace: 'observability',
        version: '25.12.5',
        storage: { size: '10Gi' },
      },
      { strict: true }
    );
    const serialized = JSON.stringify(plan);

    // The storage block carries just the mode — no S3 fields at all on the
    // PVC default — and it is projected from the contract ConfigMap.
    expect(serialized).toContain('"key":"storageMode","value":{"kind":"literal","value":"pvc"}');
    expect(serialized).toContain('clickhouseContract.data.storageMode');
    // The S3 fields appear in the status SCHEMA (they are optional) but must
    // not be PROJECTED — nor written to the contract — for a PVC cluster.
    expect(serialized).not.toContain('"key":"selfDescribingBucket"');
    expect(serialized).not.toContain('storageSelfDescribingBucket');
    expect(serialized).not.toContain('storageBucket');
    expect(serialized).not.toContain('storageDiskType');
  });

  it('leaves the PVC default byte-for-byte unchanged', () => {
    const explicitPvc = makeClickHouseCluster({ storage: { mode: 'pvc' } }).toYaml();
    expect(explicitPvc).toBe(clickHouseCluster.toYaml());
  });

  it('rejects a schema reference in the build-time storage option', () => {
    expect(() =>
      makeClickHouseCluster({
        storage: {
          ...IRSA_S3,
          bucket: {
            [KUBERNETES_REF_BRAND]: true,
            resourceId: '__schema__',
            fieldPath: 'spec.bucket',
          } as unknown as string,
        },
      })
    ).toThrow(/contains a schema\/resource reference/);
  });

  it('rejects s3_plain_rewritable with more than one replica at CONSTRUCTION time', () => {
    expect(() => makeClickHouseCluster({ replicas: 2, storage: PLAIN_REWRITABLE_S3 })).toThrow(
      /requires replicas: 1/
    );
  });

  it('rejects a bad S3 shape at CONSTRUCTION time, not first serialization', () => {
    expect(() =>
      makeClickHouseCluster({
        storage: {
          mode: 's3',
          bucket: 'example-observability',
          region: 'us-east-2',
          cache: { size: '1Gi' },
        } as ClickHouseS3StorageOptions,
      })
    ).toThrow(/'storage.auth' is required in S3 mode/);
  });
});

describe('the s3_plain_rewritable version floor travels into the generated schema', () => {
  it('carries the floor as a pattern on spec.version so KRO rejects a bad instance', () => {
    // The finding this covers: the build-time gate silently skipped a version
    // it could not read, and in kro mode `spec.version` is a REFERENCE at
    // construction — so an instance could select a server that cannot run the
    // plain_rewritable metadata type with nothing rejecting it. The floor is
    // now a `pattern=` marker in the RGD schema, which the API server
    // enforces with RE2 before the CHI is ever created.
    const yaml = makeClickHouseCluster({ storage: PLAIN_REWRITABLE_S3 }).toYaml();
    const versionLine = yaml
      .split('\n')
      .find((line) => line.trim().startsWith('version: string'));

    expect(versionLine).toBeDefined();
    expect(versionLine).toContain('pattern=');
    expect(versionLine).toContain(S3_PLAIN_REWRITABLE_VERSION_PATTERN.source.replace(/\\/g, '\\\\'));
  });

  it('leaves spec.version unconstrained for diskType: s3 and for PVC mode', () => {
    // The floor is specific to the plain_rewritable metadata type; `s3` and
    // PVC topologies must not inherit a constraint they do not need.
    for (const storage of [IRSA_S3, undefined]) {
      const yaml = makeClickHouseCluster(
        storage === undefined ? {} : { storage }
      ).toYaml();
      const versionLine = yaml
        .split('\n')
        .find((line) => line.trim().startsWith('version: string'));
      expect(versionLine?.trim()).toBe('version: string');
    }
  });

  it('accepts the versions the floor allows and rejects the ones it does not', () => {
    const spec = makeClickHouseCluster({ storage: PLAIN_REWRITABLE_S3 });
    // The same pattern is the direct-mode gate: ArkType validates the spec
    // before deploy, so both modes reject an unsupported server.
    expect(ClickHouseS3PlainRewritableVersionSchema('24.5') instanceof type.errors).toBe(false);
    expect(ClickHouseS3PlainRewritableVersionSchema('24.4') instanceof type.errors).toBe(true);
    expect(spec).toBeDefined();
  });
});
