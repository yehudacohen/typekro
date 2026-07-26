import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import {
  DEFAULT_ROOK_CEPH_VERSION,
  mapRookCephProductionPlatformToHelmValues,
  mapRookCephSingleNodePlatformToHelmValues,
  ROOK_CEPH_CLUSTER_CHART_NAME,
  rookCephClusterHelmRelease,
  RookCephProductionPlatformConfigSchema,
  rookCephExternalOperatorSingleNodePlatform,
  rookCephProductionPlatform,
  rookCephSingleNodePlatform,
} from '../../../src/factories/rook/index.js';

function expectCleanYaml(yaml: string): void {
  expect(yaml).not.toContain('__KUBERNETES_REF__');
  expect(yaml).not.toContain('__typekroSchemaKey');
  expect(yaml).not.toContain('[object Object]');
  expect(yaml).not.toContain('undefined');
  expect(yaml).not.toContain('__typekroValuesMerge');
}

describe('official Rook Ceph cluster chart platform', () => {
  it('pins the cluster chart to the operator-compatible release', () => {
    const release = rookCephClusterHelmRelease({ name: 'rook-cluster' });
    expect(release.spec.chart.spec.chart).toBe(ROOK_CEPH_CLUSTER_CHART_NAME);
    expect(release.spec.chart.spec.version).toBe(DEFAULT_ROOK_CEPH_VERSION);
  });

  it('maps an honest bounded one-node profile with retained object storage', () => {
    const values = mapRookCephSingleNodePlatformToHelmValues({
      name: 'rook-local',
      profile: 'single-node-development',
      storageClassName: 'local-path',
    });
    expect(values).toMatchObject({
      operatorNamespace: 'rook-ceph-operator',
      clusterName: 'rook-local',
      cephImage: { tag: 'v20.2.2', allowUnsupported: false },
      monitoring: { enabled: false },
      cephClusterSpec: {
        mon: { count: 1, allowMultiplePerNode: true },
        mgr: { count: 1, allowMultiplePerNode: true },
        storage: {
          useAllDevices: false,
          storageClassDeviceSets: [
            {
              count: 1,
              portable: false,
              volumeClaimTemplates: [
                {
                  spec: {
                    storageClassName: 'local-path',
                    volumeMode: 'Block',
                    resources: { requests: { storage: '8Gi' } },
                  },
                },
              ],
            },
          ],
        },
      },
      cephObjectStores: [
        {
          spec: {
            metadataPool: { replicated: { size: 1, requireSafeReplicaSize: false } },
            dataPool: { replicated: { size: 1, requireSafeReplicaSize: false } },
            preservePoolsOnDelete: true,
          },
          storageClass: { reclaimPolicy: 'Retain' },
        },
      ],
    });
  });

  it('overrides individual development daemon resources without restating every daemon', () => {
    const osd = {
      requests: { cpu: '500m', memory: '2Gi' },
      limits: { memory: '4Gi' },
    };
    const rgw = {
      requests: { cpu: '250m', memory: '512Mi' },
      limits: { memory: '2Gi' },
    };
    const values = mapRookCephSingleNodePlatformToHelmValues({
      name: 'rook-local',
      profile: 'single-node-development',
      storageClassName: 'local-path',
      resources: { osd, rgw },
    });
    expect(values).toMatchObject({
      cephClusterSpec: {
        resources: {
          mon: {
            requests: { cpu: '100m', memory: '256Mi' },
            limits: { memory: '1Gi' },
          },
          osd,
        },
        storage: {
          storageClassDeviceSets: [{ resources: osd }],
        },
      },
      cephObjectStores: [{ spec: { gateway: { resources: rgw } } }],
    });
  });

  it('deep-merges raw chart values last without erasing unrelated safe defaults', () => {
    const values = mapRookCephSingleNodePlatformToHelmValues({
      name: 'rook-local',
      profile: 'single-node-development',
      storageClassName: 'local-path',
      values: {
        cephClusterSpec: { dashboard: { enabled: true } },
        cephObjectStores: [{ name: 'custom-store' }],
      },
    });
    expect(values).toMatchObject({
      cephClusterSpec: {
        dashboard: { enabled: true },
        mon: { count: 1 },
        storage: { useAllDevices: false },
      },
      cephObjectStores: [{ name: 'custom-store' }],
    });
  });

  it('requires production availability, monitoring, disruption, resources, and backup decisions', () => {
    const invalid = RookCephProductionPlatformConfigSchema({
      name: 'rook-prod',
      profile: 'production',
      storageClassName: 'fast-block',
      storageSize: '100Gi',
      osdCount: 1,
      monCount: 1,
      mgrCount: 1,
      poolReplicas: 1,
      failureDomain: 'host',
      portableVolumes: true,
      resources: {},
      monitoring: { enabled: true, createPrometheusRules: true },
      disruptionManagement: { managePodBudgets: true },
      backup: {
        strategy: 'documented-manual',
        recoveryPointObjective: '24h',
        recoveryTimeObjective: '8h',
      },
    });
    expect(invalid instanceof type.errors).toBe(true);
  });

  it('renders complete direct chart values and consistently propagates custom namespaces', () => {
    const yaml = rookCephSingleNodePlatform.factory('direct', { namespace: 'control' }).toYaml({
      name: 'rook-local',
      profile: 'single-node-development',
      namespace: 'ceph-data',
      operatorNamespace: 'ceph-operator',
      repositoryNamespace: 'ceph-sources',
      storageClassName: 'local-path',
      bucketStorageClassName: 'harbor-retain',
    });
    expect(yaml).toContain('name: ceph-operator');
    expect(yaml).toContain('name: ceph-data');
    expect(yaml).toContain('name: ceph-sources');
    expect(yaml.match(/kind: Namespace/g)).toHaveLength(3);
    expect(yaml).toMatch(/name: rook-release\n {2}namespace: ceph-sources/);
    expect(yaml).toContain('chart: rook-ceph-cluster');
    expect(yaml).toContain('operatorNamespace: ceph-operator');
    expect(yaml).toContain('storageClassName: local-path');
    expect(yaml).toContain('name: harbor-retain');
    expect(yaml).toContain('reclaimPolicy: Retain');
    expectCleanYaml(yaml);
  });

  it('generates a KRO graph with complete public status and graph-aware defaults', () => {
    const yaml = rookCephSingleNodePlatform
      .factory('kro', { namespace: 'typekro-control' })
      .toYaml();
    for (const field of [
      'ready',
      'failed',
      'phase',
      'operatorReady',
      'clusterReady',
      'objectStoreReady',
      'storageClassReady',
      'cephHealth',
      'endpoint',
      'bucketStorageClassName',
      'version',
      'cephVersion',
      'profile',
    ]) {
      expect(yaml).toContain(`${field}:`);
    }
    expect(yaml).toContain('storageSize: string | default="8Gi"');
    expect(yaml).toContain('storageClassDeviceSets');
    expect(yaml).toContain('reclaimPolicy');
    expect(yaml).toContain('Retain');
    expect(yaml).toContain('kind: CephCluster');
    expect(yaml).toContain('kind: CephObjectStore');
    expect(yaml).toContain('kind: StorageClass');
    expectCleanYaml(yaml);
  });

  it('admits and renders development daemon resource overrides in direct and KRO modes', () => {
    const config = {
      name: 'rook-local',
      profile: 'single-node-development' as const,
      storageClassName: 'local-path',
      resources: {
        osd: {
          requests: { cpu: '500m', memory: '2Gi' },
          limits: { memory: '4Gi' },
        },
        rgw: {
          requests: { memory: '512Mi' },
          limits: { memory: '2Gi' },
        },
      },
    };
    const factory = rookCephSingleNodePlatform.factory('kro', {
      namespace: 'typekro-control',
    });
    const directYaml = rookCephSingleNodePlatform
      .factory('direct', { namespace: 'typekro-control' })
      .toYaml(config);
    const kroYaml = factory.toYaml(config);
    const rgdYaml = factory.toYaml();

    for (const yaml of [directYaml, kroYaml]) {
      expect(yaml).toContain('memory: 4Gi');
      expect(yaml).toContain('memory: 2Gi');
      expect(yaml).toContain('memory: 512Mi');
      expectCleanYaml(yaml);
    }
    expect(rgdYaml).toContain('resources:');
    expect(rgdYaml).toContain('osd:');
    expect(rgdYaml).toContain('rgw:');
    expectCleanYaml(rgdYaml);
  });

  it('renders production singleton booleans as admission-enforced booleans', () => {
    const yaml = rookCephProductionPlatform
      .factory('kro', { namespace: 'typekro-control' })
      .toYaml();
    expect(yaml).toContain('enabled: boolean | validation="self == true"');
    expect(yaml).toContain('managePodBudgets: boolean | validation="self == true"');
    expect(yaml).not.toContain('enabled: string');
    expect(yaml).not.toContain('managePodBudgets: string');
    expectCleanYaml(yaml);
  });

  it('owns custom repository namespaces by default and supports an explicit external source', () => {
    const base = {
      name: 'rook-local',
      profile: 'single-node-development' as const,
      namespace: 'ceph-data',
      operatorNamespace: 'ceph-operator',
      repositoryNamespace: 'ceph-sources',
      storageClassName: 'local-path',
    };
    const factory = rookCephSingleNodePlatform.factory('kro', { namespace: 'control' });
    const owned = factory.toYaml(base);
    expect(owned).toContain(
      'typekro.io/hoisted-namespaces: \'["ceph-operator","ceph-data","ceph-sources"]\''
    );

    const external = factory.toYaml({
      ...base,
      repositoryNamespaceOwnership: 'external',
    });
    expect(external).toContain('typekro.io/hoisted-namespaces: \'["ceph-operator","ceph-data"]\'');
    expect(external).not.toMatch(/kind: Namespace[\s\S]*?name: ceph-sources/);
  });

  it('supports shared operator and cluster namespaces without duplicate emitted siblings', () => {
    const yaml = rookCephSingleNodePlatform.factory('kro', { namespace: 'control' }).toYaml({
      name: 'rook-local',
      profile: 'single-node-development',
      namespace: 'rook-ceph',
      operatorNamespace: 'rook-ceph',
      storageClassName: 'local-path',
    });
    expect(yaml.match(/kind: Namespace/g)).toHaveLength(1);
    expect(yaml).toContain('typekro.io/hoisted-namespaces: \'["rook-ceph"]\'');
  });

  it('can safely consume a separately owned operator without emitting or adopting it', () => {
    const config = {
      name: 'rook-local',
      profile: 'single-node-development' as const,
      namespace: 'ceph-data',
      operatorNamespace: 'shared-rook-operator',
      operatorDeploymentName: 'rook-ceph-operator',
      storageClassName: 'csi-hostpath-sc',
      bucketStorageClassName: 'harbor-retain',
    };
    const directYaml = rookCephExternalOperatorSingleNodePlatform
      .factory('direct', { namespace: 'control' })
      .toYaml(config);
    expect(directYaml.match(/kind: Namespace/g)).toHaveLength(1);
    // Observed prerequisites are deliberately absent from direct-mode output:
    // they participate in readiness/dependency evaluation, not ownership.
    expect(directYaml).not.toContain('kind: Deployment');
    expect(directYaml).toContain('operatorNamespace: shared-rook-operator');
    expect(directYaml).not.toContain('chart: rook-ceph\n');
    expect(directYaml).toContain('chart: rook-ceph-cluster');
    expect(directYaml).toContain('cephObjectStores: []');
    expect(directYaml.match(/kind: CephObjectStore/g)).toHaveLength(1);
    expect(directYaml.match(/kind: StorageClass/g)).toHaveLength(1);
    expectCleanYaml(directYaml);

    const kroYaml = rookCephExternalOperatorSingleNodePlatform
      .factory('kro', { namespace: 'control' })
      .toYaml();
    expect(kroYaml).toContain('externalOperator');
    expect(kroYaml).toContain('availableReplicas');
    expect(kroYaml).not.toContain('id: operatorRelease');
    expectCleanYaml(kroYaml);
  });

  it('renders the mandatory production safety controls into official chart values', () => {
    const resources = {
      mon: { requests: { cpu: '1', memory: '2Gi' }, limits: { memory: '4Gi' } },
      mgr: { requests: { cpu: '500m', memory: '1Gi' }, limits: { memory: '2Gi' } },
      osd: { requests: { cpu: '1', memory: '4Gi' }, limits: { memory: '8Gi' } },
      prepareosd: { requests: { cpu: '500m', memory: '1Gi' }, limits: { memory: '2Gi' } },
      rgw: { requests: { cpu: '500m', memory: '1Gi' }, limits: { memory: '2Gi' } },
    };
    const values = mapRookCephProductionPlatformToHelmValues({
      name: 'rook-prod',
      profile: 'production',
      storageClassName: 'fast-block',
      storageSize: '500Gi',
      osdCount: 6,
      monCount: 3,
      mgrCount: 2,
      poolReplicas: 3,
      failureDomain: 'host',
      portableVolumes: true,
      resources,
      monitoring: { enabled: true, createPrometheusRules: true },
      disruptionManagement: { managePodBudgets: true, osdMaintenanceTimeoutMinutes: 45 },
      backup: {
        strategy: 'ceph-multisite',
        recoveryPointObjective: '5m',
        recoveryTimeObjective: '1h',
      },
    });
    expect(values).toMatchObject({
      monitoring: { enabled: true, createPrometheusRules: true },
      cephClusterSpec: {
        mon: { count: 3, allowMultiplePerNode: false },
        mgr: { count: 2, allowMultiplePerNode: false },
        disruptionManagement: { managePodBudgets: true, osdMaintenanceTimeout: 45 },
        storage: { storageClassDeviceSets: [{ count: 6, portable: true }] },
      },
      cephObjectStores: [
        {
          spec: {
            metadataPool: { replicated: { size: 3 } },
            dataPool: { replicated: { size: 3 } },
          },
        },
      ],
    });
    expect(rookCephProductionPlatform).toBeDefined();
  });
});
