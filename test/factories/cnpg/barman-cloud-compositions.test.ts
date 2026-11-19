import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  BARMAN_CLOUD_PLUGIN_NAME,
  barmanCloudPluginBootstrap,
  cnpgS3BackedCluster,
} from '../../../src/factories/cnpg/index.js';
import { crdSchemaFromJson, crdSchemaFromYaml, crdSpecErrors } from '../../utils/crd-schema.js';
import { admissionErrors } from '../../utils/kro-admission.js';

const fixtures = join(import.meta.dir, '../../fixtures/cnpg');
const objectStoreCrd = crdSchemaFromYaml(
  join(fixtures, 'barman-cloud-v0.16.0-objectstores.yaml'),
  'objectstores.barmancloud.cnpg.io'
);
const cnpgCrd = (name: string) =>
  crdSchemaFromJson(join(fixtures, 'cnpg-1.30.2-crd-schemas.json'), name);

interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; annotations?: Record<string, string> };
  spec: Record<string, any>;
}

const clusterSpec = {
  name: 'orders',
  namespace: 'databases',
  instances: 3,
  storageSize: '20Gi',
  bucket: 'example-backups',
  prefix: 'cnpg/production',
  schedule: '0 0 2 * * *',
};

const pluginSpec = { name: 'barman-cloud', namespace: 'cnpg-system' };

async function clusterManifests(input: Record<string, unknown> = clusterSpec) {
  const factory = await cnpgS3BackedCluster.factory('direct', { namespace: 'databases' });
  return (yaml.loadAll(factory.toYaml(input as typeof clusterSpec)) as Manifest[]).filter(Boolean);
}

async function pluginManifests(input: Record<string, unknown> = pluginSpec) {
  const factory = await barmanCloudPluginBootstrap.factory('direct', { namespace: 'cnpg-system' });
  return (yaml.loadAll(factory.toYaml(input as typeof pluginSpec)) as Manifest[]).filter(Boolean);
}

const byKind = (items: Manifest[], kind: string) => {
  const found = items.find((item) => item.kind === kind);
  if (!found) throw new Error(`no ${kind}`);
  return found;
};

describe('barmanCloudPluginBootstrap (direct mode)', () => {
  it('renders the chart repository and the pinned plugin release in the operator namespace', async () => {
    const items = await pluginManifests();
    expect(items.map((item) => `${item.kind}/${item.metadata.name}`).sort()).toEqual([
      'HelmRelease/barman-cloud',
      'HelmRepository/cnpg-repo',
    ]);
    const release = byKind(items, 'HelmRelease');
    expect(release.metadata.namespace).toBe('cnpg-system');
    expect(release.spec.chart.spec.chart).toBe('plugin-barman-cloud');
    expect(release.spec.chart.spec.version).toBe('0.9.0');
    expect(release.spec.values).toEqual({ crds: { create: true } });
  });

  it('refuses any chart version but the pinned one', async () => {
    await expect(pluginManifests({ ...pluginSpec, version: '0.8.1' })).rejects.toThrow(
      'pinned at 0.9.0'
    );
  });
});

describe('cnpgS3BackedCluster (direct mode)', () => {
  it('renders an ObjectStore, a Cluster archiving to it, and a ScheduledBackup', async () => {
    const items = await clusterManifests();
    expect(items.map((item) => `${item.kind}/${item.metadata.name}`).sort()).toEqual([
      'Cluster/orders',
      'ObjectStore/orders-backups',
      'ScheduledBackup/orders-scheduled',
    ]);
    expect(new Set(items.map((item) => item.metadata.namespace))).toEqual(new Set(['databases']));
  });

  it('points the ObjectStore at s3://<bucket>/<prefix> with workload identity only', async () => {
    const store = byKind(await clusterManifests(), 'ObjectStore');
    expect(store.spec.configuration.destinationPath).toBe('s3://example-backups/cnpg/production');
    expect(store.spec.configuration.s3Credentials).toEqual({ inheritFromIAMRole: true });
    expect(store.spec.retentionPolicy).toBe('30d');
    expect(crdSpecErrors(objectStoreCrd, store.spec)).toEqual([]);
  });

  it('wires the Cluster, the ScheduledBackup and the ObjectStore together', async () => {
    const items = await clusterManifests();
    const store = byKind(items, 'ObjectStore');
    const db = byKind(items, 'Cluster');
    const schedule = byKind(items, 'ScheduledBackup');

    expect(db.spec.plugins).toEqual([
      {
        name: BARMAN_CLOUD_PLUGIN_NAME,
        isWALArchiver: true,
        parameters: { barmanObjectName: store.metadata.name },
      },
    ]);
    expect(schedule.spec).toEqual({
      cluster: { name: db.metadata.name },
      schedule: '0 0 2 * * *',
      backupOwnerReference: 'self',
      method: 'plugin',
      pluginConfiguration: { name: BARMAN_CLOUD_PLUGIN_NAME },
    });
    expect(crdSpecErrors(cnpgCrd('clusters.postgresql.cnpg.io'), db.spec)).toEqual([]);
    expect(crdSpecErrors(cnpgCrd('scheduledbackups.postgresql.cnpg.io'), schedule.spec)).toEqual(
      []
    );
  });

  it('annotates the cluster service account for IRSA when asked', async () => {
    const roleArn = 'arn:aws:iam::111122223333:role/orders-backups';
    const db = byKind(
      await clusterManifests({
        ...clusterSpec,
        serviceAccountAnnotations: { 'eks.amazonaws.com/role-arn': roleArn },
      }),
      'Cluster'
    );
    expect(db.spec.serviceAccountTemplate).toEqual({
      metadata: { annotations: { 'eks.amazonaws.com/role-arn': roleArn } },
    });
  });

  it('refuses an empty or malformed bucket or prefix', async () => {
    for (const bucket of ['', 'Example_Backups']) {
      await expect(clusterManifests({ ...clusterSpec, bucket })).rejects.toThrow(
        'bucket must be an S3 bucket name'
      );
    }
    for (const prefix of ['', '/cnpg', 'cnpg/', 'cnpg//production']) {
      await expect(clusterManifests({ ...clusterSpec, prefix })).rejects.toThrow(
        'prefix must be a non-empty key prefix'
      );
    }
  });
});

type Rgd = {
  kind: string;
  spec: {
    resources: Array<{
      id: string;
      template: { metadata: { name?: string }; spec?: Record<string, any> };
    }>;
  };
};

const rgdOf = (composition: { toYaml(): string }): Rgd => {
  const docs = (yaml.loadAll(composition.toYaml()) as Rgd[]).filter(Boolean);
  const graph = docs.find((doc) => doc.kind === 'ResourceGraphDefinition');
  if (!graph) throw new Error('no RGD');
  return graph;
};

describe('barmanCloudPluginBootstrap (KRO admission)', () => {
  const yamlText = barmanCloudPluginBootstrap.toYaml();

  it('admits the pinned version, or none', () => {
    expect(admissionErrors(yamlText, 'BarmanCloudPluginBootstrap', pluginSpec)).toEqual([]);
    expect(
      admissionErrors(yamlText, 'BarmanCloudPluginBootstrap', { ...pluginSpec, version: '0.9.0' })
    ).toEqual([]);
  });

  it('refuses another chart version at admission, where the body check never runs', () => {
    expect(
      admissionErrors(yamlText, 'BarmanCloudPluginBootstrap', { ...pluginSpec, version: '0.8.1' })
    ).toHaveLength(1);
  });
});

describe('cnpgS3BackedCluster (KRO admission)', () => {
  const yamlText = cnpgS3BackedCluster.toYaml();
  const kind = 'CnpgS3BackedCluster';

  it('admits a complete instance', () => {
    expect(admissionErrors(yamlText, kind, clusterSpec)).toEqual([]);
  });

  it('refuses an empty bucket or prefix', () => {
    expect(admissionErrors(yamlText, kind, { ...clusterSpec, bucket: '' })).toHaveLength(1);
    expect(admissionErrors(yamlText, kind, { ...clusterSpec, prefix: '' })).toHaveLength(1);
    expect(admissionErrors(yamlText, kind, { ...clusterSpec, prefix: '/cnpg' })).toHaveLength(1);
  });

  it('refuses credential fields: the instance schema has none', () => {
    for (const field of ['s3Credentials', 'accessKeyId', 'secretAccessKey']) {
      expect(
        admissionErrors(yamlText, kind, {
          ...clusterSpec,
          [field]: { name: 'aws-creds', key: 'ACCESS_KEY_ID' },
        })
      ).toEqual([`spec.${field}: unknown field`]);
    }
  });

  it('serializes the ObjectStore with inheritFromIAMRole and no secret references', () => {
    const store = rgdOf(cnpgS3BackedCluster).spec.resources.find(
      (resource) => resource.id === 'objectStore'
    );
    expect(store?.template.spec?.configuration.s3Credentials).toEqual({
      inheritFromIAMRole: true,
    });
    expect(store?.template.spec?.configuration.destinationPath).toBe(
      's3://${schema.spec.bucket}/${schema.spec.prefix}'
    );
  });
});
