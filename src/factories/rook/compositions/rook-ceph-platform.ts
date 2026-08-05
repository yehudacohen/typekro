import { kubernetesComposition } from '../../../core/composition/imperative.js';
import type { V1Deployment } from '@kubernetes/client-node';
import {
  isValuesMergeExpression,
  mergeValuesExpression,
} from '../../../core/aspects/values-merge.js';
import { Cel } from '../../../core/references/cel.js';
import { observedResource } from '../../../core/references/external-refs.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { cephObjectStore } from '../resources/ceph-object-store.js';
import { rookBucketStorageClass } from '../resources/bucket-storage-class.js';
import {
  DEFAULT_ROOK_CEPH_REPO_NAME,
  DEFAULT_ROOK_CEPH_REPO_URL,
  DEFAULT_ROOK_CEPH_VERSION,
  rookCephClusterHelmRelease,
  rookCephHelmRepository,
  rookCephOperatorHelmRelease,
} from '../resources/helm.js';
import {
  type CephClusterStatus,
  type RookCephProductionPlatformConfig,
  RookCephProductionPlatformConfigSchema,
  RookCephPlatformStatusSchema,
  type RookCephSingleNodePlatformConfig,
  type RookCephExternalOperatorSingleNodePlatformConfig,
  RookCephExternalOperatorSingleNodePlatformConfigSchema,
  RookCephSingleNodePlatformConfigSchema,
} from '../types.js';
import {
  mapRookCephProductionPlatformToHelmValues,
  mapRookCephProductionObjectStoreSpec,
  mapRookCephSingleNodePlatformToHelmValues,
  mapRookCephSingleNodeObjectStoreSpec,
} from '../utils/helm-values-mapper.js';

type CephClusterSpec = Record<string, never>;

/**
 * Complete one-node Rook/Ceph platform for local development.
 *
 * This profile is deliberately replication-one and not highly available. It owns the operator and
 * cluster lifecycle but leaves OBC claims and retained buckets outside consumer graphs.
 */
export const rookCephSingleNodePlatform = kubernetesComposition(
  {
    name: 'rook-ceph-single-node-platform',
    kind: 'RookCephSingleNodePlatform',
    spec: RookCephSingleNodePlatformConfigSchema,
    status: RookCephPlatformStatusSchema,
  },
  (spec: RookCephSingleNodePlatformConfig) => {
    const platformNamespace = spec.namespace ?? 'rook-ceph';
    const operatorNamespace = spec.operatorNamespace ?? 'rook-ceph-operator';
    const version = spec.version ?? DEFAULT_ROOK_CEPH_VERSION;
    const cephVersion = spec.cephImageTag ?? 'v20.2.2';
    const storageSize = spec.storageSize ?? '8Gi';
    const repositoryName = spec.repositoryName ?? DEFAULT_ROOK_CEPH_REPO_NAME;
    const repositoryNamespace = spec.repositoryNamespace ?? operatorNamespace;
    const repositoryUrl = spec.repositoryUrl ?? DEFAULT_ROOK_CEPH_REPO_URL;
    const objectStoreName = spec.objectStoreName ?? 'harbor-object-store';
    const bucketStorageClassName = spec.bucketStorageClassName ?? 'harbor-ceph-bucket-retain';
    const profile: 'single-node-development' = 'single-node-development';

    namespace({
      metadata: {
        name: operatorNamespace,
        labels: {
          'app.kubernetes.io/name': 'rook-ceph',
          'app.kubernetes.io/managed-by': 'typekro',
          'typekro.dev/profile': profile,
        },
      },
      id: 'operatorNamespace',
    });
    namespace({
      metadata: {
        name: platformNamespace,
        labels: {
          'app.kubernetes.io/name': 'rook-ceph-cluster',
          'app.kubernetes.io/managed-by': 'typekro',
          'typekro.dev/profile': profile,
        },
      },
      id: 'platformNamespace',
    });
    createOwnedRepositoryNamespace(spec, repositoryNamespace, operatorNamespace, profile);
    const repository = rookCephHelmRepository({
      name: repositoryName,
      namespace: repositoryNamespace,
      url: repositoryUrl,
      id: 'rookRepository',
    });
    const operatorRelease = rookCephOperatorHelmRelease({
      name: `${spec.name}-operator`,
      namespace: operatorNamespace,
      version,
      repositoryName,
      repositoryNamespace,
      repositoryUrl,
      values: {
        enableOBCWatchOperatorNamespace: false,
        resources: { requests: { cpu: '100m', memory: '128Mi' } },
        // The object-only development profile owns no block pools or file
        // systems. Disable the operator chart's CSI dependency so its
        // ClientProfile finalizers cannot outlive this owned operator.
        csi: { installCsiOperator: false },
      },
      id: 'operatorRelease',
    });
    operatorRelease.dependsOn(repository);
    const clusterRelease = rookCephClusterHelmRelease({
      name: `${spec.name}-cluster`,
      namespace: platformNamespace,
      version,
      repositoryName,
      repositoryNamespace,
      repositoryUrl,
      values: clusterOnlyValues(mapRookCephSingleNodePlatformToHelmValues(spec, storageSize)),
      id: 'clusterRelease',
    });
    clusterRelease.dependsOn(operatorRelease);

    const cluster = observedResource<CephClusterSpec, CephClusterStatus>({
      apiVersion: 'ceph.rook.io/v1',
      kind: 'CephCluster',
      metadata: { name: spec.name, namespace: platformNamespace },
      id: 'cluster',
    });
    cluster.dependsOn(clusterRelease);
    const objectStore = cephObjectStore({
      name: objectStoreName,
      namespace: platformNamespace,
      annotations: {
        'typekro.dev/rook-version': version,
        'typekro.dev/ceph-version': cephVersion,
      },
      spec: mapRookCephSingleNodeObjectStoreSpec(spec),
      id: 'objectStore',
    });
    objectStore.dependsOn(cluster);
    // `cluster` is an observed prerequisite rather than an applied graph node.
    // Preserve the executable lifecycle edge explicitly so direct/Alchemy
    // teardown removes the object store before deleting the HelmRelease that
    // owns the CephCluster and its finalizer.
    objectStore.dependsOn(clusterRelease);
    const bucketStorageClass = rookBucketStorageClass({
      name: bucketStorageClassName,
      objectStoreName,
      objectStoreNamespace: platformNamespace,
      operatorNamespace,
      reclaimPolicy: 'Retain',
      id: 'bucketStorageClass',
    });
    bucketStorageClass.dependsOn(objectStore);

    const operatorReady = Cel.expr<boolean>(
      operatorRelease.status.conditions,
      '.exists(c, c.type == "Ready" && c.status == "True")'
    );
    const storageClassReady = Cel.expr<boolean>('bucketStorageClass.metadata.name != ""');
    return {
      ready: Cel.expr<boolean>(
        'operatorRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True") && cluster.status.phase == "Ready" && objectStore.status.phase == "Ready" && bucketStorageClass.metadata.name != ""'
      ),
      failed: Cel.expr<boolean>(
        'operatorRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "False") || cluster.status.phase == "Failure" || objectStore.status.phase == "Failure"'
      ),
      phase: Cel.expr<'Installing' | 'Ready' | 'Failed'>(
        'operatorRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "False") || cluster.status.phase == "Failure" || objectStore.status.phase == "Failure" ? "Failed" : (operatorRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True") && cluster.status.phase == "Ready" && objectStore.status.phase == "Ready" && bucketStorageClass.metadata.name != "" ? "Ready" : "Installing")'
      ),
      operatorReady,
      clusterReady: cluster.status.phase === 'Ready',
      objectStoreReady: objectStore.status.phase === 'Ready',
      storageClassReady,
      cephHealth: cluster.status.ceph.health,
      endpoint: objectStoreEndpoint(),
      bucketStorageClassName: Cel.expr<string>('bucketStorageClass.metadata.name'),
      version: Cel.expr<string>('objectStore.metadata.annotations["typekro.dev/rook-version"]'),
      cephVersion: Cel.expr<string>('objectStore.metadata.annotations["typekro.dev/ceph-version"]'),
      profile: Cel.expr<'single-node-development'>(
        'cluster.metadata.labels["typekro.dev/profile"]'
      ),
    };
  }
);

/** Complete multi-node production Rook/Ceph platform with mandatory safety decisions. */
export const rookCephProductionPlatform = kubernetesComposition(
  {
    name: 'rook-ceph-production-platform',
    kind: 'RookCephProductionPlatform',
    spec: RookCephProductionPlatformConfigSchema,
    status: RookCephPlatformStatusSchema,
  },
  (spec: RookCephProductionPlatformConfig) => {
    const platformNamespace = spec.namespace ?? 'rook-ceph';
    const operatorNamespace = spec.operatorNamespace ?? 'rook-ceph-operator';
    const version = spec.version ?? DEFAULT_ROOK_CEPH_VERSION;
    const cephVersion = spec.cephImageTag ?? 'v20.2.2';
    const repositoryName = spec.repositoryName ?? DEFAULT_ROOK_CEPH_REPO_NAME;
    const repositoryNamespace = spec.repositoryNamespace ?? operatorNamespace;
    const repositoryUrl = spec.repositoryUrl ?? DEFAULT_ROOK_CEPH_REPO_URL;
    const objectStoreName = spec.objectStoreName ?? 'harbor-object-store';
    const bucketStorageClassName = spec.bucketStorageClassName ?? 'harbor-ceph-bucket-retain';
    const profile: 'production' = 'production';

    namespace({
      metadata: {
        name: operatorNamespace,
        labels: {
          'app.kubernetes.io/name': 'rook-ceph',
          'app.kubernetes.io/managed-by': 'typekro',
          'typekro.dev/profile': profile,
        },
      },
      id: 'operatorNamespace',
    });
    namespace({
      metadata: {
        name: platformNamespace,
        labels: {
          'app.kubernetes.io/name': 'rook-ceph-cluster',
          'app.kubernetes.io/managed-by': 'typekro',
          'typekro.dev/profile': profile,
        },
      },
      id: 'platformNamespace',
    });
    createOwnedRepositoryNamespace(spec, repositoryNamespace, operatorNamespace, profile);
    const repository = rookCephHelmRepository({
      name: repositoryName,
      namespace: repositoryNamespace,
      url: repositoryUrl,
      id: 'rookRepository',
    });
    const operatorRelease = rookCephOperatorHelmRelease({
      name: `${spec.name}-operator`,
      namespace: operatorNamespace,
      version,
      repositoryName,
      repositoryNamespace,
      repositoryUrl,
      id: 'operatorRelease',
    });
    operatorRelease.dependsOn(repository);
    const clusterRelease = rookCephClusterHelmRelease({
      name: `${spec.name}-cluster`,
      namespace: platformNamespace,
      version,
      repositoryName,
      repositoryNamespace,
      repositoryUrl,
      values: clusterOnlyValues(mapRookCephProductionPlatformToHelmValues(spec)),
      id: 'clusterRelease',
    });
    clusterRelease.dependsOn(operatorRelease);

    const cluster = observedResource<CephClusterSpec, CephClusterStatus>({
      apiVersion: 'ceph.rook.io/v1',
      kind: 'CephCluster',
      metadata: { name: spec.name, namespace: platformNamespace },
      id: 'cluster',
    });
    cluster.dependsOn(clusterRelease);
    const objectStore = cephObjectStore({
      name: objectStoreName,
      namespace: platformNamespace,
      annotations: {
        'typekro.dev/rook-version': version,
        'typekro.dev/ceph-version': cephVersion,
      },
      spec: mapRookCephProductionObjectStoreSpec(spec),
      id: 'objectStore',
    });
    objectStore.dependsOn(cluster);
    objectStore.dependsOn(clusterRelease);
    const bucketStorageClass = rookBucketStorageClass({
      name: bucketStorageClassName,
      objectStoreName,
      objectStoreNamespace: platformNamespace,
      operatorNamespace,
      reclaimPolicy: 'Retain',
      id: 'bucketStorageClass',
    });
    bucketStorageClass.dependsOn(objectStore);

    const operatorReady = Cel.expr<boolean>(
      operatorRelease.status.conditions,
      '.exists(c, c.type == "Ready" && c.status == "True")'
    );
    const storageClassReady = Cel.expr<boolean>('bucketStorageClass.metadata.name != ""');
    return {
      ready: Cel.expr<boolean>(
        'operatorRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True") && cluster.status.phase == "Ready" && objectStore.status.phase == "Ready" && bucketStorageClass.metadata.name != ""'
      ),
      failed: Cel.expr<boolean>(
        'operatorRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "False") || cluster.status.phase == "Failure" || objectStore.status.phase == "Failure"'
      ),
      phase: Cel.expr<'Installing' | 'Ready' | 'Failed'>(
        'operatorRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "False") || cluster.status.phase == "Failure" || objectStore.status.phase == "Failure" ? "Failed" : (operatorRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True") && cluster.status.phase == "Ready" && objectStore.status.phase == "Ready" && bucketStorageClass.metadata.name != "" ? "Ready" : "Installing")'
      ),
      operatorReady,
      clusterReady: cluster.status.phase === 'Ready',
      objectStoreReady: objectStore.status.phase === 'Ready',
      storageClassReady,
      cephHealth: cluster.status.ceph.health,
      endpoint: objectStoreEndpoint(),
      bucketStorageClassName: Cel.expr<string>('bucketStorageClass.metadata.name'),
      version: Cel.expr<string>('objectStore.metadata.annotations["typekro.dev/rook-version"]'),
      cephVersion: Cel.expr<string>('objectStore.metadata.annotations["typekro.dev/ceph-version"]'),
      profile: Cel.expr<'production'>('cluster.metadata.labels["typekro.dev/profile"]'),
    };
  }
);

/**
 * Complete one-node Ceph cluster that references an already managed Rook
 * operator. The operator Deployment is an observed prerequisite and is never
 * emitted, adopted, or deleted by this composition. Its platform owner must
 * keep it running until this cluster and any operator-owned CSI descendants
 * have completed deletion.
 */
export const rookCephExternalOperatorSingleNodePlatform = kubernetesComposition(
  {
    name: 'rook-ceph-external-operator-single-node-platform',
    kind: 'RookCephExternalOperatorSingleNodePlatform',
    spec: RookCephExternalOperatorSingleNodePlatformConfigSchema,
    status: RookCephPlatformStatusSchema,
  },
  (spec: RookCephExternalOperatorSingleNodePlatformConfig) => {
    const platformNamespace = spec.namespace ?? 'rook-ceph';
    const operatorNamespace = spec.operatorNamespace;
    const operatorDeploymentName = spec.operatorDeploymentName ?? 'rook-ceph-operator';
    const version = spec.version ?? DEFAULT_ROOK_CEPH_VERSION;
    const cephVersion = spec.cephImageTag ?? 'v20.2.2';
    const storageSize = spec.storageSize ?? '8Gi';
    const repositoryName = spec.repositoryName ?? DEFAULT_ROOK_CEPH_REPO_NAME;
    const repositoryNamespace = spec.repositoryNamespace ?? platformNamespace;
    const repositoryUrl = spec.repositoryUrl ?? DEFAULT_ROOK_CEPH_REPO_URL;
    const objectStoreName = spec.objectStoreName ?? 'harbor-object-store';
    const bucketStorageClassName = spec.bucketStorageClassName ?? 'harbor-ceph-bucket-retain';
    const profile: 'single-node-development' = 'single-node-development';

    namespace({
      metadata: {
        name: platformNamespace,
        labels: {
          'app.kubernetes.io/name': 'rook-ceph-cluster',
          'app.kubernetes.io/managed-by': 'typekro',
          'typekro.dev/profile': profile,
        },
      },
      id: 'platformNamespace',
    });
    createOwnedRepositoryNamespace(spec, repositoryNamespace, platformNamespace, profile);

    const externalOperator = observedResource<
      NonNullable<V1Deployment['spec']>,
      NonNullable<V1Deployment['status']>
    >({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: operatorDeploymentName, namespace: operatorNamespace },
      id: 'externalOperator',
    });
    const repository = rookCephHelmRepository({
      name: repositoryName,
      namespace: repositoryNamespace,
      url: repositoryUrl,
      id: 'rookRepository',
    });
    const clusterRelease = rookCephClusterHelmRelease({
      name: `${spec.name}-cluster`,
      namespace: platformNamespace,
      version,
      repositoryName,
      repositoryNamespace,
      repositoryUrl,
      values: clusterOnlyValues(mapRookCephSingleNodePlatformToHelmValues(spec, storageSize)),
      id: 'clusterRelease',
    });
    clusterRelease.dependsOn(externalOperator);
    clusterRelease.dependsOn(repository);

    const cluster = observedResource<CephClusterSpec, CephClusterStatus>({
      apiVersion: 'ceph.rook.io/v1',
      kind: 'CephCluster',
      metadata: { name: spec.name, namespace: platformNamespace },
      id: 'cluster',
    });
    cluster.dependsOn(clusterRelease);
    const objectStore = cephObjectStore({
      name: objectStoreName,
      namespace: platformNamespace,
      annotations: {
        'typekro.dev/rook-version': version,
        'typekro.dev/ceph-version': cephVersion,
      },
      spec: mapRookCephSingleNodeObjectStoreSpec(spec),
      id: 'objectStore',
    });
    objectStore.dependsOn(cluster);
    objectStore.dependsOn(clusterRelease);
    const bucketStorageClass = rookBucketStorageClass({
      name: bucketStorageClassName,
      objectStoreName,
      objectStoreNamespace: platformNamespace,
      operatorNamespace,
      reclaimPolicy: 'Retain',
      id: 'bucketStorageClass',
    });
    bucketStorageClass.dependsOn(objectStore);

    const operatorReady = Cel.expr<boolean>(
      'has(externalOperator.status.availableReplicas) && externalOperator.status.availableReplicas > 0'
    );
    const storageClassReady = Cel.expr<boolean>('bucketStorageClass.metadata.name != ""');
    return {
      ready: Cel.expr<boolean>(
        'has(externalOperator.status.availableReplicas) && externalOperator.status.availableReplicas > 0 && cluster.status.phase == "Ready" && objectStore.status.phase == "Ready" && bucketStorageClass.metadata.name != ""'
      ),
      failed: Cel.expr<boolean>(
        'cluster.status.phase == "Failure" || objectStore.status.phase == "Failure"'
      ),
      phase: Cel.expr<'Installing' | 'Ready' | 'Failed'>(
        'cluster.status.phase == "Failure" || objectStore.status.phase == "Failure" ? "Failed" : (has(externalOperator.status.availableReplicas) && externalOperator.status.availableReplicas > 0 && cluster.status.phase == "Ready" && objectStore.status.phase == "Ready" && bucketStorageClass.metadata.name != "" ? "Ready" : "Installing")'
      ),
      operatorReady,
      clusterReady: cluster.status.phase === 'Ready',
      objectStoreReady: objectStore.status.phase === 'Ready',
      storageClassReady,
      cephHealth: cluster.status.ceph.health,
      endpoint: objectStoreEndpoint(),
      bucketStorageClassName: Cel.expr<string>('bucketStorageClass.metadata.name'),
      version: Cel.expr<string>('objectStore.metadata.annotations["typekro.dev/rook-version"]'),
      cephVersion: Cel.expr<string>('objectStore.metadata.annotations["typekro.dev/ceph-version"]'),
      profile: Cel.expr<'single-node-development'>(
        'cluster.metadata.labels["typekro.dev/profile"]'
      ),
    };
  }
);

function createOwnedRepositoryNamespace(
  spec:
    | RookCephSingleNodePlatformConfig
    | RookCephProductionPlatformConfig
    | RookCephExternalOperatorSingleNodePlatformConfig,
  repositoryNamespace: string,
  existingOwnedNamespace: string,
  profile: 'single-node-development' | 'production'
) {
  const graphMode = isKubernetesRef(spec.name);
  const ownsRepositoryNamespace = graphMode
    ? Cel.expr<boolean>(
        '!has(schema.spec.repositoryNamespaceOwnership) || schema.spec.repositoryNamespaceOwnership == "owned"'
      )
    : spec.repositoryNamespaceOwnership !== 'external';
  return namespace({
    metadata: {
      name: repositoryNamespace,
      labels: {
        'app.kubernetes.io/name': 'rook-ceph-helm-source',
        'app.kubernetes.io/managed-by': 'typekro',
        'typekro.dev/profile': profile,
      },
    },
    id: 'repositoryNamespace',
  }).withIncludeWhen(
    graphMode
      ? Cel.expr<boolean>(
          ownsRepositoryNamespace,
          ' && ',
          repositoryNamespace,
          ' != ',
          existingOwnedNamespace
        )
      : ownsRepositoryNamespace && repositoryNamespace !== existingOwnedNamespace
  );
}

function objectStoreEndpoint() {
  return Cel.expr<string>(
    'has(objectStore.status.endpoints.secure) && size(objectStore.status.endpoints.secure) > 0 ? objectStore.status.endpoints.secure[0] : (has(objectStore.status.endpoints.insecure) && size(objectStore.status.endpoints.insecure) > 0 ? objectStore.status.endpoints.insecure[0] : "")'
  );
}

/**
 * The cluster chart owns only the CephCluster. TypeKro materializes stores and
 * StorageClasses as separate dependency-ordered children so deletion cannot
 * race a CephCluster finalizer against its dependents.
 */
function clusterOnlyValues(values: unknown) {
  const clusterOnly = {
    cephBlockPools: [],
    cephFileSystems: [],
    cephObjectStores: [],
  };
  if (isKubernetesRef(values) || isCelExpression(values) || isValuesMergeExpression(values)) {
    return mergeValuesExpression(values, clusterOnly);
  }
  return { ...(structuredClone(values) as Record<string, unknown>), ...clusterOnly };
}
