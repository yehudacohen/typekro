/** Map typed bootstrap options into official `rook-ceph` chart values. */

import {
  isValuesMergeExpression,
  mergeValuesExpression,
  type ValuesMergeExpression,
} from '../../../core/aspects/values-merge.js';
import { Cel } from '../../../core/references/cel.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import type {
  CephObjectStoreConfig,
  RookCephOperatorBootstrapConfig,
  RookCephProductionPlatformConfig,
  RookCephSingleNodePlatformConfig,
} from '../types.js';

export interface RookCephOperatorHelmValues {
  logLevel?: 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG';
  enableOBCWatchOperatorNamespace?: boolean;
  obcProvisionerNamePrefix?: string;
  obcAllowAdditionalConfigFields?: string;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  [key: string]: unknown;
}

export type RookCephOperatorMappedHelmValues = RookCephOperatorHelmValues | ValuesMergeExpression;

type RookCephOperatorHelmValuesInput = {
  [K in keyof Pick<
    RookCephOperatorBootstrapConfig,
    | 'logLevel'
    | 'enableOBCWatchOperatorNamespace'
    | 'obcProvisionerNamePrefix'
    | 'obcAllowAdditionalConfigFields'
    | 'resources'
    | 'values'
  >]: RookCephOperatorBootstrapConfig[K] | undefined;
};

/**
 * Map typed fields and merge raw chart `values` last.
 *
 * Whole-map schema refs use TypeKro's runtime values merge so KRO mode does
 * not lose user overrides or stringify graph markers.
 */
export function mapRookCephOperatorConfigToHelmValues(
  config: RookCephOperatorHelmValuesInput
): RookCephOperatorMappedHelmValues {
  const values: RookCephOperatorHelmValues = {};

  if (config.logLevel !== undefined) values.logLevel = config.logLevel;
  if (config.enableOBCWatchOperatorNamespace !== undefined) {
    values.enableOBCWatchOperatorNamespace = config.enableOBCWatchOperatorNamespace;
  }
  if (config.obcProvisionerNamePrefix !== undefined) {
    values.obcProvisionerNamePrefix = config.obcProvisionerNamePrefix;
  }
  if (config.obcAllowAdditionalConfigFields !== undefined) {
    values.obcAllowAdditionalConfigFields = config.obcAllowAdditionalConfigFields;
  }
  if (config.resources !== undefined) values.resources = config.resources;

  return mergeValuesLast(values, config.values);
}

function mergeValuesLast<T extends Record<string, unknown>>(
  base: T,
  overrides: unknown
): T | ValuesMergeExpression {
  if (overrides === undefined) return base;

  if (
    isKubernetesRef(overrides) ||
    isCelExpression(overrides) ||
    isValuesMergeExpression(overrides)
  ) {
    return mergeValuesExpression(base, overrides);
  }

  if (isPlainObject(overrides)) deepMerge(base, overrides);
  return base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isKubernetesRef(value) &&
    !isCelExpression(value) &&
    !isValuesMergeExpression(value)
  );
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const targetValue = target[key];
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      deepMerge(targetValue, sourceValue);
    } else {
      target[key] = sourceValue;
    }
  }
}

interface RookCephClusterChartValues {
  operatorNamespace: string;
  clusterName: string;
  cephImage: { repository: string; tag: string; allowUnsupported: false };
  monitoring: { enabled: boolean; createPrometheusRules: boolean };
  toolbox: { enabled: false };
  cephClusterMetadata: {
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
  cephClusterSpec: Record<string, unknown>;
  cephBlockPools: [];
  cephFileSystems: [];
  cephObjectStores: Record<string, unknown>[];
  [key: string]: unknown;
}

function objectStoreValues(config: {
  name: string;
  storageClassName: string;
  spec: CephObjectStoreConfig['spec'];
}): Record<string, unknown> {
  return {
    name: config.name,
    spec: config.spec,
    storageClass: {
      enabled: true,
      name: config.storageClassName,
      reclaimPolicy: 'Retain',
      volumeBindingMode: 'Immediate',
      annotations: {},
      labels: { 'app.kubernetes.io/managed-by': 'typekro' },
    },
    ingress: { enabled: false },
  };
}

const singleNodeResources = {
  mon: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '1Gi' } },
  mgr: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '1Gi' } },
  osd: { requests: { cpu: '250m', memory: '1Gi' }, limits: { memory: '2Gi' } },
  prepareosd: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '1Gi' } },
  rgw: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '1Gi' } },
};

function resolveSingleNodeResources(config: RookCephSingleNodePlatformConfig) {
  return {
    mon: Cel.default(config.resources?.mon, singleNodeResources.mon),
    mgr: Cel.default(config.resources?.mgr, singleNodeResources.mgr),
    osd: Cel.default(config.resources?.osd, singleNodeResources.osd),
    prepareosd: Cel.default(config.resources?.prepareosd, singleNodeResources.prepareosd),
    rgw: Cel.default(config.resources?.rgw, singleNodeResources.rgw),
  };
}

/** Canonical single-node RGW spec shared by chart and composition materialization. */
export function mapRookCephSingleNodeObjectStoreSpec(
  config: RookCephSingleNodePlatformConfig
): CephObjectStoreConfig['spec'] {
  const resources = resolveSingleNodeResources(config);
  return {
    metadataPool: {
      failureDomain: 'osd',
      replicated: { size: 1, requireSafeReplicaSize: false },
    },
    dataPool: {
      failureDomain: 'osd',
      replicated: { size: 1, requireSafeReplicaSize: false },
    },
    preservePoolsOnDelete: true,
    gateway: { port: 80, instances: 1, resources: resources.rgw },
  };
}

/** Canonical production RGW spec shared by chart and composition materialization. */
export function mapRookCephProductionObjectStoreSpec(
  config: RookCephProductionPlatformConfig
): CephObjectStoreConfig['spec'] {
  return {
    metadataPool: {
      failureDomain: config.failureDomain,
      replicated: { size: config.poolReplicas },
    },
    dataPool: {
      failureDomain: config.failureDomain,
      replicated: { size: config.poolReplicas },
    },
    preservePoolsOnDelete: true,
    gateway: { port: 80, instances: 2, resources: config.resources.rgw },
  };
}

function storageDeviceSet(config: {
  storageClassName: string;
  storageSize: string;
  count: number;
  portable: boolean;
  resources: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
}): Record<string, unknown> {
  return {
    name: 'data',
    count: config.count,
    portable: config.portable,
    tuneDeviceClass: false,
    tuneFastDeviceClass: false,
    encrypted: false,
    resources: config.resources,
    volumeClaimTemplates: [
      {
        metadata: { name: 'data' },
        spec: {
          storageClassName: config.storageClassName,
          resources: { requests: { storage: config.storageSize } },
          volumeMode: 'Block',
          accessModes: ['ReadWriteOnce'],
        },
      },
    ],
  };
}

/** Official chart values for the explicit non-HA, one-node development profile. */
export function mapRookCephSingleNodePlatformToHelmValues(
  config: RookCephSingleNodePlatformConfig,
  storageSize: string = config.storageSize ?? '8Gi'
): RookCephClusterChartValues | ValuesMergeExpression {
  const objectStoreName = config.objectStoreName ?? 'harbor-object-store';
  const storageClassName = config.bucketStorageClassName ?? 'harbor-ceph-bucket-retain';
  const resources = resolveSingleNodeResources(config);
  const values: RookCephClusterChartValues = {
    operatorNamespace: config.operatorNamespace ?? 'rook-ceph-operator',
    clusterName: config.name,
    cephImage: {
      repository: config.cephImageRepository ?? 'quay.io/ceph/ceph',
      tag: config.cephImageTag ?? 'v20.2.2',
      allowUnsupported: false,
    },
    monitoring: { enabled: false, createPrometheusRules: false },
    toolbox: { enabled: false },
    cephClusterMetadata: {
      labels: { 'typekro.dev/profile': 'single-node-development' },
      annotations: {
        'typekro.dev/ceph-version': config.cephImageTag ?? 'v20.2.2',
        'typekro.dev/rook-version': config.version ?? 'v1.20.2',
      },
    },
    cephClusterSpec: {
      dataDirHostPath: `/var/lib/rook/${config.name}`,
      skipUpgradeChecks: false,
      continueUpgradeAfterChecksEvenIfNotHealthy: false,
      mon: { count: 1, allowMultiplePerNode: true },
      mgr: { count: 1, allowMultiplePerNode: true },
      dashboard: { enabled: false },
      crashCollector: { disable: true },
      logCollector: { enabled: true, periodicity: 'daily', maxLogSize: '100M' },
      cleanupPolicy: { confirmation: '' },
      resources: {
        mon: resources.mon,
        mgr: resources.mgr,
        osd: resources.osd,
        prepareosd: resources.prepareosd,
      },
      storage: {
        useAllNodes: false,
        useAllDevices: false,
        storageClassDeviceSets: [
          storageDeviceSet({
            storageClassName: config.storageClassName,
            storageSize,
            count: 1,
            portable: false,
            resources: resources.osd,
          }),
        ],
      },
      disruptionManagement: { managePodBudgets: false, osdMaintenanceTimeout: 30 },
    },
    cephBlockPools: [],
    cephFileSystems: [],
    cephObjectStores: [
      objectStoreValues({
        name: objectStoreName,
        storageClassName,
        spec: mapRookCephSingleNodeObjectStoreSpec(config),
      }),
    ],
  };
  return mergeValuesLast(values, config.values);
}

/** Official chart values for an explicit multi-node production profile. */
export function mapRookCephProductionPlatformToHelmValues(
  config: RookCephProductionPlatformConfig
): RookCephClusterChartValues | ValuesMergeExpression {
  const objectStoreName = config.objectStoreName ?? 'harbor-object-store';
  const storageClassName = config.bucketStorageClassName ?? 'harbor-ceph-bucket-retain';
  const values: RookCephClusterChartValues = {
    operatorNamespace: config.operatorNamespace ?? 'rook-ceph-operator',
    clusterName: config.name,
    cephImage: {
      repository: config.cephImageRepository ?? 'quay.io/ceph/ceph',
      tag: config.cephImageTag ?? 'v20.2.2',
      allowUnsupported: false,
    },
    monitoring: config.monitoring,
    toolbox: { enabled: false },
    cephClusterMetadata: {
      labels: { 'typekro.dev/profile': 'production' },
      annotations: {
        'typekro.dev/ceph-version': config.cephImageTag ?? 'v20.2.2',
        'typekro.dev/rook-version': config.version ?? 'v1.20.2',
      },
    },
    cephClusterSpec: {
      dataDirHostPath: `/var/lib/rook/${config.name}`,
      skipUpgradeChecks: false,
      continueUpgradeAfterChecksEvenIfNotHealthy: false,
      upgradeOSDRequiresHealthyPGs: true,
      mon: { count: config.monCount, allowMultiplePerNode: false },
      mgr: { count: config.mgrCount, allowMultiplePerNode: false },
      dashboard: { enabled: true, ssl: true },
      crashCollector: { disable: false },
      logCollector: { enabled: true, periodicity: 'daily', maxLogSize: '500M' },
      cleanupPolicy: { confirmation: '', allowUninstallWithVolumes: false },
      resources: {
        mon: config.resources.mon,
        mgr: config.resources.mgr,
        osd: config.resources.osd,
        prepareosd: config.resources.prepareosd,
      },
      storage: {
        useAllNodes: false,
        useAllDevices: false,
        storageClassDeviceSets: [
          storageDeviceSet({
            storageClassName: config.storageClassName,
            storageSize: config.storageSize,
            count: config.osdCount,
            portable: config.portableVolumes,
            resources: config.resources.osd,
          }),
        ],
      },
      disruptionManagement: {
        managePodBudgets: true,
        osdMaintenanceTimeout: config.disruptionManagement.osdMaintenanceTimeoutMinutes ?? 30,
      },
    },
    cephBlockPools: [],
    cephFileSystems: [],
    cephObjectStores: [
      objectStoreValues({
        name: objectStoreName,
        storageClassName,
        spec: mapRookCephProductionObjectStoreSpec(config),
      }),
    ],
  };
  return mergeValuesLast(values, config.values);
}
