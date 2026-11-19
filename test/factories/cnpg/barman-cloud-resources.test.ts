import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { type Type, type } from 'arktype';
import { TypeKroError } from '../../../src/core/errors.js';
import {
  BARMAN_CLOUD_PLUGIN_CHART_VERSION,
  BARMAN_CLOUD_PLUGIN_MINIMUM_CNPG_VERSION,
  CNPG_CHART_VERSION,
  CNPG_OPERATOR_VERSION,
  cnpgHelmRelease,
  BARMAN_CLOUD_PLUGIN_NAME,
  backup,
  barmanCloudBackupMethod,
  barmanCloudPlugin,
  barmanCloudPluginHelmRelease,
  barmanCloudRecovery,
  cluster,
  objectStore,
  objectStoreReadinessEvaluator,
  type ObjectStoreSpec,
  scheduledBackup,
} from '../../../src/factories/cnpg/index.js';
import { Cel, kubernetesComposition } from '../../../src/index.js';
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
    for (const s3Credentials of [
      undefined,
      {},
      { inheritFromIAMRole: false },
      { inheritFromIAMRole: 'true' },
      { region: { name: 'aws', key: 'REGION' } },
    ]) {
      expect(() => objectStore(storeWith({ s3Credentials }))).toThrow(
        's3Credentials.inheritFromIAMRole: true'
      );
    }
  });

  it('refuses s3Credentials fields it does not know, and accepts secret references it does', () => {
    expect(() =>
      objectStore(storeWith({ s3Credentials: { inheritFromIAMRole: true, profile: 'default' } }))
    ).toThrow('remove s3Credentials.profile');
    const store = objectStore(
      storeWith({
        s3Credentials: { inheritFromIAMRole: true, region: { name: 'aws', key: 'REGION' } },
      })
    );
    expect(crdSpecErrors(objectStoreCrd, plain(store.spec))).toEqual([]);
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

  it('refuses a destination without a valid bucket or a prefix', () => {
    for (const destinationPath of [
      's3:///cnpg',
      's3://example-backups',
      's3://example-backups/',
      's3://example..backups/cnpg',
      's3://192.168.5.4/cnpg',
      's3://example-backups.mrap/cnpg',
      's3://example-backups//cnpg',
    ]) {
      expect(() => objectStore(storeWith({ destinationPath }))).toThrow(
        'with a valid S3 bucket name and a non-empty prefix'
      );
    }
    for (const destinationPath of ['s3://example.backups/cnpg', 's3://example-backups/cnpg/']) {
      expect(() => objectStore(storeWith({ destinationPath }))).not.toThrow();
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

describe('objectStore with values from the composition spec', () => {
  const status = type({ ready: 'boolean' });
  type Make = (spec: never) => unknown;

  /**
   * A composition passing `make(spec)` as the ObjectStore spec, rendered in KRO mode (building
   * the RGD runs the body against the schema proxy) and in direct mode with `instance`.
   */
  function render(schema: Type<object>, make: Make, instance: Record<string, unknown>) {
    const define = () =>
      kubernetesComposition(
        { name: 'store-probe', kind: 'StoreProbe', spec: schema, status },
        (spec) => {
          objectStore({
            name: 'orders-backups',
            namespace: 'databases',
            spec: make(spec as never) as ObjectStoreSpec,
            id: 'store',
          });
          return { ready: true };
        }
      );
    return {
      kro: () => define().toYaml(),
      direct: () =>
        define()
          .factory('direct')
          .toYaml(instance as never),
    };
  }

  /** The refusal codes of both modes, or `undefined` for a mode that renders. */
  function refusals(rendered: ReturnType<typeof render>) {
    return { kro: refusalCode(rendered.kro), direct: refusalCode(rendered.direct) };
  }

  /** The code of the innermost TypeKroError `run` throws, through composition wrappers. */
  function refusalCode(run: () => unknown): string | undefined {
    try {
      run();
    } catch (error) {
      let code: string | undefined;
      for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
        if (cause instanceof TypeKroError) code = cause.code;
      }
      return code ?? `untyped: ${String(error)}`;
    }
    return undefined;
  }

  const concrete = storeSpec.configuration;

  it('accepts a store written out with its leaf values from the spec', () => {
    const schema = type({
      destination: 'string',
      endpoint: 'string',
      retention: 'string',
      compression: "'gzip' | 'zstd'",
      logLevel: "'info' | 'debug'",
      region: 'string',
    });
    const make = (spec: {
      destination: string;
      endpoint: string;
      retention: string;
      compression: 'gzip';
      logLevel: 'info';
      region: string;
    }) => ({
      configuration: {
        destinationPath: spec.destination,
        endpointURL: spec.endpoint,
        s3Credentials: { inheritFromIAMRole: true },
        wal: { compression: spec.compression },
        data: { compression: spec.compression },
      },
      retentionPolicy: spec.retention,
      instanceSidecarConfiguration: {
        logLevel: spec.logLevel,
        env: [{ name: 'AWS_REGION', value: spec.region }],
      },
    });
    expect(
      refusals(
        render(schema, make, {
          destination: 's3://example-backups/cnpg',
          endpoint: 'https://s3.us-east-1.amazonaws.com',
          retention: '30d',
          compression: 'gzip',
          logLevel: 'info',
          region: 'us-east-1',
        })
      )
    ).toEqual({ kro: undefined, direct: undefined });
  });

  it('refuses when the RGD is built credentials an instance could change', () => {
    const credentials = type({
      'inheritFromIAMRole?': 'boolean',
      'accessKeyId?': { name: 'string', key: 'string' },
      'secretAccessKey?': { name: 'string', key: 'string' },
    });
    const symbolic: [string, Type<object>, Make, Record<string, unknown>, string][] = [
      [
        'the whole s3Credentials object from a field an instance could add keys to',
        type({ credentials }),
        (spec: { credentials: unknown }) => ({
          configuration: { ...concrete, s3Credentials: spec.credentials },
        }),
        { credentials: { inheritFromIAMRole: true } },
        'CNPG_BARMAN_CLOUD_NOT_CONCRETE',
      ],
      [
        'the whole configuration',
        type({ configuration: 'Record<string, unknown>' }),
        (spec: { configuration: unknown }) => ({ configuration: spec.configuration }),
        { configuration: concrete },
        'CNPG_BARMAN_CLOUD_NOT_CONCRETE',
      ],
      [
        'the whole spec',
        type({ store: 'Record<string, unknown>' }),
        (spec: { store: unknown }) => spec.store,
        { store: storeSpec },
        'CNPG_BARMAN_CLOUD_NOT_CONCRETE',
      ],
      [
        'inheritFromIAMRole from a field an instance could set to false',
        type({ inherit: 'boolean' }),
        (spec: { inherit: unknown }) => ({
          configuration: { ...concrete, s3Credentials: { inheritFromIAMRole: spec.inherit } },
        }),
        { inherit: true },
        'CNPG_BARMAN_CLOUD_STATIC_CREDENTIALS',
      ],
      [
        'inheritFromIAMRole from an expression',
        type({ inherit: 'boolean' }),
        (spec: { inherit: unknown }) => ({
          configuration: {
            ...concrete,
            s3Credentials: { inheritFromIAMRole: Cel.expr<boolean>(spec.inherit, ' == true') },
          },
        }),
        { inherit: true },
        'CNPG_BARMAN_CLOUD_STATIC_CREDENTIALS',
      ],
      [
        'a static key from the spec',
        type({ key: { name: 'string', key: 'string' } }),
        (spec: { key: unknown }) => ({
          configuration: {
            ...concrete,
            s3Credentials: { inheritFromIAMRole: true, accessKeyId: spec.key },
          },
        }),
        { key: { name: 'aws', key: 'ID' } },
        'CNPG_BARMAN_CLOUD_STATIC_CREDENTIALS',
      ],
      [
        'the sidecar env from the spec',
        type({ env: 'Record<string, unknown>[]' }),
        (spec: { env: unknown }) => ({
          configuration: concrete,
          instanceSidecarConfiguration: { env: spec.env },
        }),
        { env: [] },
        'CNPG_BARMAN_CLOUD_NOT_CONCRETE',
      ],
      [
        'an env variable name from the spec',
        type({ variable: 'string' }),
        (spec: { variable: unknown }) => ({
          configuration: concrete,
          instanceSidecarConfiguration: { env: [{ name: spec.variable, value: 'x' }] },
        }),
        { variable: 'AWS_REGION' },
        'CNPG_BARMAN_CLOUD_NOT_CONCRETE',
      ],
      [
        'extra barman-cloud arguments from the spec',
        type({ args: 'string[]' }),
        (spec: { args: unknown }) => ({
          configuration: { ...concrete, wal: { archiveAdditionalCommandArgs: spec.args } },
        }),
        { args: [] },
        'CNPG_BARMAN_CLOUD_NOT_CONCRETE',
      ],
    ];
    for (const [label, schema, make, instance, code] of symbolic) {
      // Refused in KRO mode, where the RGD is built, so no instance of it ever reaches admission.
      expect([label, refusals(render(schema, make, instance))]).toEqual([
        label,
        { kro: code, direct: code },
      ]);
    }
  });

  it('refuses a missing or false inheritFromIAMRole written in the composition', () => {
    const refused = {
      kro: 'CNPG_BARMAN_CLOUD_STATIC_CREDENTIALS',
      direct: 'CNPG_BARMAN_CLOUD_STATIC_CREDENTIALS',
    };
    for (const s3Credentials of [{}, { inheritFromIAMRole: false }]) {
      expect(
        refusals(
          render(
            type({ name: 'string' }),
            () => ({ configuration: { ...concrete, s3Credentials } }),
            { name: 'x' }
          )
        )
      ).toEqual(refused);
    }
    expect(
      refusals(
        render(
          type({ name: 'string' }),
          () => ({
            configuration: { destinationPath: concrete.destinationPath, wal: concrete.wal },
          }),
          { name: 'x' }
        )
      )
    ).toEqual(refused);
  });
});

describe('barmanCloudPluginHelmRelease', () => {
  it('installs the pinned plugin chart from the CloudNativePG repository with its CRDs', () => {
    const release = barmanCloudPluginHelmRelease({
      name: 'barman-cloud',
      operatorVersion: '1.30.2',
    });
    expect(release.metadata.namespace).toBe('cnpg-system');
    expect(release.spec.chart.spec).toEqual({
      chart: 'plugin-barman-cloud',
      version: BARMAN_CLOUD_PLUGIN_CHART_VERSION,
      sourceRef: { kind: 'HelmRepository', name: 'cnpg-repo', namespace: 'flux-system' },
    });
    expect(BARMAN_CLOUD_PLUGIN_CHART_VERSION).toBe('0.9.0');
    expect(release.spec.values).toEqual({
      crds: { create: true },
      service: { name: 'barman-cloud' },
    });
  });

  it('requires a CloudNativePG operator the plugin supports', () => {
    expect(BARMAN_CLOUD_PLUGIN_MINIMUM_CNPG_VERSION).toBe('1.30.0');
    for (const operatorVersion of [undefined, '', '1.25.0', '1.29.9', 'v1.30.2', '1.30.2-rc1']) {
      expect(() =>
        barmanCloudPluginHelmRelease({
          name: 'barman-cloud',
          operatorVersion: operatorVersion as string,
        })
      ).toThrow('needs CloudNativePG 1.30.0 or later');
    }
  });

  it('pairs with the operator cnpgHelmRelease installs by default', () => {
    expect(CNPG_CHART_VERSION).toBe('0.29.2');
    expect(CNPG_OPERATOR_VERSION).toBe('1.30.2');
    expect(cnpgHelmRelease({ name: 'cnpg' }).spec.chart.spec.version).toBe(CNPG_CHART_VERSION);
    expect(() =>
      barmanCloudPluginHelmRelease({ name: 'barman-cloud', operatorVersion: CNPG_OPERATOR_VERSION })
    ).not.toThrow();
  });

  it('refuses values that change crds.create or the service name, and keeps the others', () => {
    for (const [values, field] of [
      [{ crds: { create: false } }, 'crds.create'],
      [{ crds: false }, 'crds'],
      [{ service: { name: 'backups' } }, 'service.name'],
      [{ service: 'backups' }, 'service'],
    ] as const) {
      expect(() =>
        barmanCloudPluginHelmRelease({
          name: 'barman-cloud',
          operatorVersion: '1.30.2',
          values: values as Record<string, unknown>,
        })
      ).toThrow(`can't override ${field}`);
    }
    const release = barmanCloudPluginHelmRelease({
      name: 'barman-cloud',
      operatorVersion: '1.30.2',
      values: {
        crds: { create: true },
        service: { name: 'barman-cloud', port: 9091 },
        logLevel: 'debug',
      },
    });
    expect(release.spec.values).toEqual({
      crds: { create: true },
      service: { name: 'barman-cloud', port: 9091 },
      logLevel: 'debug',
    });
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
