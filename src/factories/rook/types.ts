/**
 * Rook/Ceph object-storage integration types.
 *
 * Config types are inferred from ArkType schemas. The typed surface is
 * intentionally scoped to Rook's S3-compatible RGW path: operator bootstrap,
 * local CephObjectStore pools/gateways, users, bucket StorageClasses, and
 * ObjectBucketClaims.
 *
 * @see https://rook.io/docs/rook/latest/Storage-Configuration/Object-Storage-RGW/object-storage/
 */

import { type } from 'arktype';
import type { TypeKroChartValue } from '../../core/types/common.js';

const resourceRequirementsSchemaShape = {
  'requests?': { 'cpu?': 'string', 'memory?': 'string' },
  'limits?': { 'cpu?': 'string', 'memory?': 'string' },
} as const;

const replicatedPoolSchemaShape = {
  size: 'number.integer',
  'requireSafeReplicaSize?': 'boolean',
  'targetSizeRatio?': 'number',
  'replicasPerFailureDomain?': 'number.integer',
  'subFailureDomain?': 'string',
} as const;

const erasureCodedPoolSchemaShape = {
  dataChunks: 'number.integer',
  codingChunks: 'number.integer',
  'algorithm?': '"isa" | "jerasure"',
  'stripeUnit?': '"4Ki" | "16Ki" | "64Ki" | "256Ki" | "1Mi"',
} as const;

const commonPoolSchemaShape = {
  'failureDomain?': 'string',
  'crushRoot?': 'string',
  'deviceClass?': 'string',
  'enableCrushUpdates?': 'boolean',
  'parameters?': 'Record<string, string>',
  'application?': 'string',
} as const;

/** RGW metadata pools must use replication. */
const metadataPoolSchema = type({
  ...commonPoolSchemaShape,
  replicated: replicatedPoolSchemaShape,
});

/** RGW data pools use exactly one of replication or erasure coding. */
const dataPoolSchema = type({
  ...commonPoolSchemaShape,
  'replicated?': replicatedPoolSchemaShape,
  'erasureCoded?': erasureCodedPoolSchemaShape,
}).narrow((pool, ctx) => {
  if ((pool.replicated !== undefined) !== (pool.erasureCoded !== undefined)) return true;
  return ctx.mustBe('a data pool with exactly one of replicated or erasureCoded');
});

const secretKeySelectorSchemaShape = {
  name: 'string',
  key: 'string',
  'optional?': 'boolean',
} as const;

/** Rook operator bootstrap configuration. */
export const RookCephOperatorBootstrapConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'repositoryName?': 'string',
  'repositoryNamespace?': 'string',
  'repositoryNamespaceOwnership?': '"owned" | "external"',
  'repositoryUrl?': 'string',
  'logLevel?': '"ERROR" | "WARNING" | "INFO" | "DEBUG"',
  'enableOBCWatchOperatorNamespace?': 'boolean',
  'obcProvisionerNamePrefix?': 'string',
  'obcAllowAdditionalConfigFields?': 'string',
  'resources?': resourceRequirementsSchemaShape,
  'values?': 'Record<string, unknown>',
});

export type RookCephOperatorBootstrapConfig = typeof RookCephOperatorBootstrapConfigSchema.infer;

/** Observable Rook operator bootstrap status. */
export const RookCephOperatorBootstrapStatusSchema = type({
  ready: 'boolean',
  phase: '"Ready" | "Installing" | "Failed"',
  failed: 'boolean',
  'version?': 'string',
});

export type RookCephOperatorBootstrapStatus = typeof RookCephOperatorBootstrapStatusSchema.infer;

/** Typed local-RGW CephObjectStore configuration (`ceph.rook.io/v1`). */
export const CephObjectStoreConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'id?': 'string',
  'labels?': 'Record<string, string>',
  'annotations?': 'Record<string, string>',
  spec: {
    metadataPool: metadataPoolSchema,
    dataPool: dataPoolSchema,
    gateway: {
      port: '1 <= number.integer <= 65535',
      'securePort?': '1 <= number.integer <= 65535',
      instances: 'number.integer >= 1',
      'sslCertificateRef?': 'string',
      'caBundleRef?': 'string',
      'placement?': 'Record<string, unknown>',
      'annotations?': 'Record<string, string>',
      'labels?': 'Record<string, string>',
      'resources?': resourceRequirementsSchemaShape,
      'priorityClassName?': 'string',
      'service?': {
        'annotations?': 'Record<string, string>',
        'labels?': 'Record<string, string>',
      },
    },
    'preservePoolsOnDelete?': 'boolean',
    'healthCheck?': {
      'readinessProbe?': { 'disabled?': 'boolean' },
      'startupProbe?': { 'disabled?': 'boolean' },
    },
    'allowUsersInNamespaces?': 'string[]',
    'hosting?': {
      'advertiseEndpoint?': {
        dnsName: 'string',
        port: 'number.integer',
        useTls: 'boolean',
      },
      'dnsNames?': 'string[]',
    },
  },
});

export type CephObjectStoreConfig = typeof CephObjectStoreConfigSchema.infer;

/** Status condition emitted by Rook CRDs. */
export interface RookCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

/** Observable CephObjectStore status. */
export interface CephObjectStoreStatus {
  replicas?: number;
  selector?: string;
  phase?: 'Connecting' | 'Connected' | 'Progressing' | 'Ready' | 'Failure' | 'Deleting' | string;
  message?: string;
  endpoints?: { insecure?: string[]; secure?: string[] };
  info?: Record<string, string>;
  conditions?: RookCondition[];
  observedGeneration?: number;
}

/** Typed CephObjectStoreUser configuration (`ceph.rook.io/v1`). */
export const CephObjectStoreUserConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'id?': 'string',
  spec: {
    store: 'string',
    'displayName?': 'string',
    'capabilities?': {
      'user?': '"*" | "read" | "write" | "read, write"',
      'users?': '"*" | "read" | "write" | "read, write"',
      'bucket?': '"*" | "read" | "write" | "read, write"',
      'buckets?': '"*" | "read" | "write" | "read, write"',
      'metadata?': '"*" | "read" | "write" | "read, write"',
      'usage?': '"*" | "read" | "write" | "read, write"',
      'zone?': '"*" | "read" | "write" | "read, write"',
      'roles?': '"*" | "read" | "write" | "read, write"',
      'info?': '"*" | "read" | "write" | "read, write"',
      'amz-cache?': '"*" | "read" | "write" | "read, write"',
      'bilog?': '"*" | "read" | "write" | "read, write"',
      'mdlog?': '"*" | "read" | "write" | "read, write"',
      'datalog?': '"*" | "read" | "write" | "read, write"',
      'user-policy?': '"*" | "read" | "write" | "read, write"',
      'oidc-provider?': '"*" | "read" | "write" | "read, write"',
      'ratelimit?': '"*" | "read" | "write" | "read, write"',
    },
    'quotas?': {
      'maxBuckets?': 'number.integer',
      'maxSize?': 'string',
      'maxObjects?': 'number.integer',
    },
    'keys?': type({
      accessKeyRef: secretKeySelectorSchemaShape,
      secretKeyRef: secretKeySelectorSchemaShape,
    }).array(),
    'clusterNamespace?': 'string',
    'opMask?': type('"read" | "write" | "delete"').array(),
    'accountRef?': { name: 'string' },
  },
});

export type CephObjectStoreUserConfig = typeof CephObjectStoreUserConfigSchema.infer;

/** Observable CephObjectStoreUser status. */
export interface CephObjectStoreUserStatus {
  phase?: string;
  info?: Record<string, string>;
  observedGeneration?: number;
  keys?: Array<{
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
  }>;
}

const ObjectBucketClaimBaseConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'id?': 'string',
  spec: {
    storageClassName: 'string',
    'bucketName?': 'string',
    'generateBucketName?': 'string',
    'additionalConfig?': 'Record<string, string>',
  },
});

/** ObjectBucketClaim config; fixed and generated bucket names are mutually exclusive. */
export const ObjectBucketClaimConfigSchema = ObjectBucketClaimBaseConfigSchema.narrow(
  (config, ctx) => {
    if (!(config.spec.bucketName && config.spec.generateBucketName)) return true;
    return ctx.mustBe('an ObjectBucketClaim with only bucketName or generateBucketName, not both');
  }
);

export type ObjectBucketClaimConfig = typeof ObjectBucketClaimConfigSchema.infer;

/** ObjectBucketClaim lifecycle phase from lib-bucket-provisioner. */
export type ObjectBucketClaimPhase = 'Pending' | 'Bound' | 'Released' | 'Failed';

/** Observable ObjectBucketClaim status. */
export interface ObjectBucketClaimStatus {
  phase?: ObjectBucketClaimPhase;
}

/** Cluster-scoped Rook bucket StorageClass configuration. */
export const RookBucketStorageClassConfigSchema = type({
  name: 'string',
  objectStoreName: 'string',
  objectStoreNamespace: 'string',
  /** @deprecated Kept for source compatibility; Rook's default provisioner identity uses the cluster namespace. */
  'operatorNamespace?': 'string',
  'provisionerNamePrefix?': 'string',
  'reclaimPolicy?': '"Delete" | "Retain"',
  'existingBucketName?': 'string',
  'labels?': 'Record<string, string>',
  'annotations?': 'Record<string, string>',
  'id?': 'string',
});

export type RookBucketStorageClassConfig = typeof RookBucketStorageClassConfigSchema.infer;

/** App-owned bucket claim composition configuration. */
export const RookObjectStorageClaimConfigSchema = type({
  name: 'string',
  storageClassName: 'string',
  'namespace?': 'string',
  /** Omit for a StorageClass bound to an existing bucket. */
  'bucket?': {
    name: 'string',
    mode: '"fixed" | "generated"',
  },
  'maxObjects?': 'string',
  'maxSize?': 'string',
});

export type RookObjectStorageClaimConfig = typeof RookObjectStorageClaimConfigSchema.infer;

/** Stable binding contract for an app-owned Rook ObjectBucketClaim. */
export const RookObjectStorageClaimStatusSchema = type({
  ready: 'boolean',
  phase: '"Pending" | "Bound" | "Released" | "Failed"',
  claimName: 'string',
  credentialsSecretName: 'string',
  connectionConfigMapName: 'string',
  storageClassName: 'string',
});

export type RookObjectStorageClaimStatus = typeof RookObjectStorageClaimStatusSchema.infer;

/** Flux HelmRepository wrapper configuration. */
export const RookCephHelmRepositoryConfigSchema = type({
  'name?': 'string',
  'namespace?': 'string',
  'url?': 'string',
  'interval?': 'string',
  'id?': 'string',
});

export type RookCephHelmRepositoryConfig = typeof RookCephHelmRepositoryConfigSchema.infer;

/** Flux HelmRelease wrapper configuration. */
export const RookCephHelmReleaseConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'repositoryName?': 'string',
  'repositoryNamespace?': 'string',
  'repositoryUrl?': 'string',
  'values?': 'Record<string, unknown>',
  'id?': 'string',
});

export type RookCephHelmReleaseConfig = Omit<
  typeof RookCephHelmReleaseConfigSchema.infer,
  'values'
> & {
  values?: TypeKroChartValue<Record<string, unknown>>;
};

const cephDaemonResourcesSchemaShape = {
  mon: resourceRequirementsSchemaShape,
  mgr: resourceRequirementsSchemaShape,
  osd: resourceRequirementsSchemaShape,
  prepareosd: resourceRequirementsSchemaShape,
  rgw: resourceRequirementsSchemaShape,
} as const;

const optionalCephDaemonResourcesSchemaShape = {
  'mon?': resourceRequirementsSchemaShape,
  'mgr?': resourceRequirementsSchemaShape,
  'osd?': resourceRequirementsSchemaShape,
  'prepareosd?': resourceRequirementsSchemaShape,
  'rgw?': resourceRequirementsSchemaShape,
} as const;

const rookCephClusterCommonSchemaShape = {
  name: 'string',
  'namespace?': 'string',
  'operatorNamespace?': 'string',
  'version?': 'string',
  'repositoryName?': 'string',
  'repositoryNamespace?': 'string',
  'repositoryNamespaceOwnership?': '"owned" | "external"',
  'repositoryUrl?': 'string',
  storageClassName: 'string',
  'objectStoreName?': 'string',
  'bucketStorageClassName?': 'string',
  'cephImageRepository?': 'string',
  'cephImageTag?': 'string',
  'values?': 'Record<string, unknown>',
} as const;

/** Honest one-node development profile. Data is not highly available. */
export const RookCephSingleNodePlatformConfigSchema = type({
  ...rookCephClusterCommonSchemaShape,
  profile: '"single-node-development"',
  'storageSize?': 'string',
  'allowLoopDevices?': 'boolean',
  'resources?': optionalCephDaemonResourcesSchemaShape,
});

export type RookCephSingleNodePlatformConfig = typeof RookCephSingleNodePlatformConfigSchema.infer;

const {
  'operatorNamespace?': _optionalOperatorNamespace,
  ...rookCephExternalOperatorClusterCommonSchemaShape
} = rookCephClusterCommonSchemaShape;

/**
 * One-node cluster profile that consumes a separately owned Rook operator.
 *
 * This is the safe shape for shared platform clusters: the composition owns
 * only its Ceph cluster namespace, chart release, object store, and bucket
 * StorageClass. It observes but never adopts or deletes the operator.
 */
export const RookCephExternalOperatorSingleNodePlatformConfigSchema = type({
  ...rookCephExternalOperatorClusterCommonSchemaShape,
  profile: '"single-node-development"',
  operatorNamespace: 'string',
  'operatorDeploymentName?': 'string',
  'storageSize?': 'string',
  'resources?': optionalCephDaemonResourcesSchemaShape,
});

export type RookCephExternalOperatorSingleNodePlatformConfig =
  typeof RookCephExternalOperatorSingleNodePlatformConfigSchema.infer;

/** Production profile with explicit availability and operational decisions. */
export const RookCephProductionPlatformConfigSchema = type({
  ...rookCephClusterCommonSchemaShape,
  profile: '"production"',
  storageSize: 'string',
  osdCount: 'number.integer >= 3',
  monCount: 'number.integer >= 3',
  mgrCount: 'number.integer >= 2',
  poolReplicas: 'number.integer >= 3',
  failureDomain: 'string',
  portableVolumes: 'boolean',
  resources: cephDaemonResourcesSchemaShape,
  monitoring: {
    enabled: 'true',
    createPrometheusRules: 'boolean',
  },
  disruptionManagement: {
    managePodBudgets: 'true',
    'osdMaintenanceTimeoutMinutes?': 'number.integer >= 1',
  },
  backup: {
    strategy: '"external-s3-replication" | "ceph-multisite" | "documented-manual"',
    recoveryPointObjective: 'string',
    recoveryTimeObjective: 'string',
  },
});

export type RookCephProductionPlatformConfig = typeof RookCephProductionPlatformConfigSchema.infer;

/** Observable official cluster-chart platform status. */
export const RookCephPlatformStatusSchema = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Installing" | "Ready" | "Failed"',
  operatorReady: 'boolean',
  clusterReady: 'boolean',
  objectStoreReady: 'boolean',
  storageClassReady: 'boolean',
  cephHealth: 'string',
  endpoint: 'string',
  bucketStorageClassName: 'string',
  version: 'string',
  cephVersion: 'string',
  profile: '"single-node-development" | "production"',
});

export type RookCephPlatformStatus = typeof RookCephPlatformStatusSchema.infer;

/** Official `rook-ceph-cluster` chart release configuration. */
export const RookCephClusterHelmReleaseConfigSchema = RookCephHelmReleaseConfigSchema;
export type RookCephClusterHelmReleaseConfig = RookCephHelmReleaseConfig;

export interface CephClusterStatus {
  phase?: string;
  message?: string;
  observedGeneration?: number;
  ceph?: { health?: string };
  conditions?: RookCondition[];
}

/** Shared HelmRepository singleton spec. */
export const RookCephHelmRepositorySingletonSpecSchema = type({
  name: 'string',
  namespace: 'string',
  url: 'string',
});

/** Shared HelmRepository singleton status. */
export const RookCephHelmRepositorySingletonStatusSchema = type({ ready: 'boolean' });
