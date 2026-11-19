import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  BARMAN_CLOUD_PLUGIN_CHART_VERSION,
  BARMAN_CLOUD_PLUGIN_NAME,
  backup,
  barmanCloudBackupMethod,
  barmanCloudPlugin,
  barmanCloudPluginHelmRelease,
  barmanCloudRecovery,
  cluster,
  objectStore,
  objectStoreReadinessEvaluator,
  scheduledBackup,
} from '../../../src/factories/cnpg/index.js';
import { crdSchemaFromJson, crdSchemaFromYaml, crdSpecErrors } from '../../utils/crd-schema.js';

const fixtures = join(import.meta.dir, '../../fixtures/cnpg');
const objectStoreCrd = crdSchemaFromYaml(
  join(fixtures, 'barman-cloud-v0.16.0-objectstores.yaml'),
  'objectstores.barmancloud.cnpg.io'
);
const cnpgCrd = (name: string) =>
  crdSchemaFromJson(join(fixtures, 'cnpg-1.30.2-crd-schemas.json'), name);

/** A rendered spec as plain data: what the API server receives, not the resource proxy. */
const plain = (spec: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(spec));

const storeSpec = {
  configuration: {
    destinationPath: 's3://example-backups/cnpg/production',
    s3Credentials: { inheritFromIAMRole: true as const },
    wal: { compression: 'gzip' as const },
  },
  retentionPolicy: '30d',
};

/** An object store spec with arbitrary, untyped changes, as a JavaScript caller could pass. */
function storeWith(configuration: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    name: 'orders-backups',
    spec: {
      ...storeSpec,
      ...extra,
      configuration: { ...storeSpec.configuration, ...configuration },
    },
  } as unknown as Parameters<typeof objectStore>[0];
}

describe('objectStore', () => {
  it('renders a barmancloud.cnpg.io/v1 ObjectStore the published CRD admits', () => {
    const store = objectStore({ name: 'orders-backups', namespace: 'databases', spec: storeSpec });
    expect(store.apiVersion).toBe('barmancloud.cnpg.io/v1');
    expect(store.kind).toBe('ObjectStore');
    expect(store.metadata.namespace).toBe('databases');
    expect(crdSpecErrors(objectStoreCrd, plain(store.spec))).toEqual([]);
  });

  it('checks the fixture: the CRD refuses a serverName and an empty destination', () => {
    expect(
      crdSpecErrors(objectStoreCrd, {
        configuration: { ...storeSpec.configuration, serverName: 'orders' },
      })
    ).toEqual(['spec.configuration: failed rule: !has(self.serverName)']);
    expect(
      crdSpecErrors(objectStoreCrd, {
        configuration: { ...storeSpec.configuration, destinationPath: '' },
      })
    ).toEqual(['spec.configuration.destinationPath: shorter than 1']);
  });

  it('refuses static access keys, as the CRD alone would admit them', () => {
    const keys = {
      s3Credentials: {
        accessKeyId: { name: 'aws-creds', key: 'ACCESS_KEY_ID' },
        secretAccessKey: { name: 'aws-creds', key: 'ACCESS_SECRET_KEY' },
      },
    };
    expect(
      crdSpecErrors(objectStoreCrd, { configuration: { ...storeSpec.configuration, ...keys } })
    ).toEqual([]);
    expect(() => objectStore(storeWith(keys))).toThrow(
      'remove s3Credentials.accessKeyId, s3Credentials.secretAccessKey'
    );
    expect(() =>
      objectStore(
        storeWith({
          s3Credentials: {
            inheritFromIAMRole: true,
            sessionToken: { name: 'aws-creds', key: 'ACCESS_SESSION_TOKEN' },
          },
        })
      )
    ).toThrow('remove s3Credentials.sessionToken');
  });

  it('requires inheritFromIAMRole: true', () => {
    for (const s3Credentials of [undefined, {}, { inheritFromIAMRole: false }]) {
      expect(() => objectStore(storeWith({ s3Credentials }))).toThrow(
        's3Credentials.inheritFromIAMRole: true'
      );
    }
  });

  it('refuses static AWS keys in the sidecar environment', () => {
    const env = [{ name: 'AWS_SECRET_ACCESS_KEY', value: 'x' }];
    expect(() => objectStore(storeWith({}, { instanceSidecarConfiguration: { env } }))).toThrow(
      'remove AWS_SECRET_ACCESS_KEY'
    );
  });

  it('refuses non-S3 providers', () => {
    expect(() =>
      objectStore(storeWith({ azureCredentials: { storageKey: { name: 'azure', key: 'KEY' } } }))
    ).toThrow('remove configuration.azureCredentials');
  });

  it('refuses a destination without a bucket or a prefix', () => {
    for (const destinationPath of ['s3:///cnpg', 's3://example-backups', 's3://example-backups/']) {
      expect(() => objectStore(storeWith({ destinationPath }))).toThrow(
        'non-empty bucket and prefix'
      );
    }
    expect(() => objectStore(storeWith({ destinationPath: 'gs://example/cnpg' }))).toThrow(
      's3://<bucket>/<prefix>'
    );
  });

  it('is ready once the API server returns it, since the plugin reports no conditions', () => {
    expect(objectStoreReadinessEvaluator(undefined).ready).toBe(false);
    expect(objectStoreReadinessEvaluator({ metadata: { name: 'orders-backups' } })).toMatchObject({
      ready: true,
      reason: 'Admitted',
    });
    expect(
      objectStoreReadinessEvaluator({
        metadata: { name: 'orders-backups' },
        status: {
          serverRecoveryWindow: { orders: { lastSuccessfulBackupTime: '2026-11-19T02:00:00Z' } },
        },
      }).message
    ).toBe('ObjectStore holds backups for orders');
  });
});

describe('barmanCloudPluginHelmRelease', () => {
  it('installs the pinned plugin chart from the CloudNativePG repository with its CRDs', () => {
    const release = barmanCloudPluginHelmRelease({ name: 'barman-cloud' });
    expect(release.metadata.namespace).toBe('cnpg-system');
    expect(release.spec.chart.spec).toEqual({
      chart: 'plugin-barman-cloud',
      version: BARMAN_CLOUD_PLUGIN_CHART_VERSION,
      sourceRef: { kind: 'HelmRepository', name: 'cnpg-repo', namespace: 'flux-system' },
    });
    expect(BARMAN_CLOUD_PLUGIN_CHART_VERSION).toBe('0.9.0');
    expect(release.spec.values).toEqual({ crds: { create: true } });
  });
});

describe('a Cluster wired to the Barman Cloud plugin', () => {
  const store = objectStore({ name: 'orders-backups', namespace: 'databases', spec: storeSpec });

  const source = cluster({
    name: 'orders',
    namespace: 'databases',
    spec: {
      instances: 3,
      storage: { size: '20Gi' },
      plugins: [barmanCloudPlugin({ objectStoreName: store.metadata.name as string })],
      serviceAccountTemplate: {
        metadata: {
          annotations: { 'eks.amazonaws.com/role-arn': 'arn:aws:iam::111122223333:role/orders' },
        },
      },
    },
  });

  const nightly = scheduledBackup({
    name: 'orders-nightly',
    namespace: 'databases',
    spec: { cluster: { name: 'orders' }, schedule: '0 0 2 * * *', ...barmanCloudBackupMethod() },
  });

  const restored = cluster({
    name: 'orders-restore',
    namespace: 'databases',
    spec: {
      instances: 3,
      storage: { size: '20Gi' },
      ...barmanCloudRecovery({ objectStoreName: 'orders-backups', serverName: 'orders' }),
      plugins: [barmanCloudPlugin({ objectStoreName: 'orders-backups' })],
    },
  });

  it('archives WAL to the ObjectStore through spec.plugins, and the CNPG CRD admits it', () => {
    expect(source.spec.plugins).toEqual([
      {
        name: 'barman-cloud.cloudnative-pg.io',
        isWALArchiver: true,
        parameters: { barmanObjectName: 'orders-backups' },
      },
    ]);
    expect(plain(source.spec).backup).toBeUndefined();
    expect(crdSpecErrors(cnpgCrd('clusters.postgresql.cnpg.io'), plain(source.spec))).toEqual([]);
  });

  it('schedules plugin backups of that cluster', () => {
    expect(nightly.spec).toMatchObject({
      cluster: { name: source.metadata.name },
      method: 'plugin',
      pluginConfiguration: { name: BARMAN_CLOUD_PLUGIN_NAME },
    });
    expect(
      crdSpecErrors(cnpgCrd('scheduledbackups.postgresql.cnpg.io'), plain(nightly.spec))
    ).toEqual([]);
  });

  it('recovers from the plugin through an externalClusters entry named by bootstrap.recovery', () => {
    const recovery = restored.spec.bootstrap?.recovery;
    const sourceEntry = restored.spec.externalClusters?.find(
      (entry) => entry.name === recovery?.source
    );
    expect(sourceEntry).toEqual({
      name: 'origin',
      plugin: {
        name: BARMAN_CLOUD_PLUGIN_NAME,
        parameters: { barmanObjectName: 'orders-backups', serverName: 'orders' },
      },
    });
    // The restored cluster archives under its own name, so it doesn't overwrite the source.
    expect(restored.spec.plugins?.[0]?.parameters).toEqual({ barmanObjectName: 'orders-backups' });
    expect(crdSpecErrors(cnpgCrd('clusters.postgresql.cnpg.io'), plain(restored.spec))).toEqual([]);
  });

  it('passes a point-in-time target through to bootstrap.recovery', () => {
    const fragment = barmanCloudRecovery({
      sourceName: 'orders-source',
      objectStoreName: 'orders-backups',
      serverName: 'orders',
      recoveryTarget: { targetTime: '2026-11-19 02:00:00.000000+00' },
    });
    expect(fragment.bootstrap.recovery).toEqual({
      source: 'orders-source',
      recoveryTarget: { targetTime: '2026-11-19 02:00:00.000000+00' },
    });
  });

  it('refuses a plugin Backup or ScheduledBackup that names no plugin', () => {
    expect(() =>
      backup({
        name: 'manual',
        namespace: 'databases',
        spec: { cluster: { name: 'orders' }, method: 'plugin' },
      })
    ).toThrow('must name the plugin in pluginConfiguration');
    expect(() =>
      scheduledBackup({
        name: 'nightly',
        namespace: 'databases',
        spec: { cluster: { name: 'orders' }, schedule: '0 0 2 * * *', method: 'plugin' },
      })
    ).toThrow('must name the plugin in pluginConfiguration');
    const manual = backup({
      name: 'manual',
      namespace: 'databases',
      spec: { cluster: { name: 'orders' }, ...barmanCloudBackupMethod() },
    });
    expect(crdSpecErrors(cnpgCrd('backups.postgresql.cnpg.io'), plain(manual.spec))).toEqual([]);
  });
});
