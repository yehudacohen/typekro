# Rook/Ceph Object Storage

TypeKro's Rook integration provides a typed, graph-aware path from the official
Rook Ceph operator to application-scoped S3-compatible bucket claims.

The integration keeps platform and application ownership separate:

| Owner | Resources |
| --- | --- |
| Platform | Rook operator, `CephCluster`, `CephObjectStore`, bucket `StorageClass` |
| Application | Namespaced `ObjectBucketClaim` |
| Rook provisioner | Bucket, credentials `Secret`, connection `ConfigMap` |

An application claim never installs Rook or owns a `CephCluster`. This prevents
deleting one application graph from tearing down shared storage infrastructure.

## Installation

```ts
import {
  cephObjectStore,
  rookBucketStorageClass,
  rookCephOperatorBootstrap,
  rookCephSingleNodePlatform,
  rookCephProductionPlatform,
  rookCephExternalOperatorSingleNodePlatform,
  rookObjectStorageClaim,
} from 'typekro/rook';
```

The operator bootstrap wraps the official `rook-ceph` chart from
`https://charts.rook.io/release`. The default version is `v1.20.2`.

```ts
const operator = rookCephOperatorBootstrap.factory('kro', {
  waitForReady: true,
});

await operator.deploy({
  name: 'rook-ceph',
  namespace: 'rook-ceph',
  logLevel: 'INFO',
});
```

The operator-only bootstrap installs the official operator and its CRDs. It
intentionally does **not** create a `CephCluster`; use one of the complete
platform compositions below when TypeKro should own the storage platform too.
Devices, failure domains, replication, and the cluster's destruction policy
remain explicit platform decisions. See the
[Rook prerequisites](https://rook.io/docs/rook/latest-release/Getting-Started/Prerequisites/prerequisites/)
before provisioning a Ceph cluster.

`rookCephOperatorBootstrap` creates and owns the `rook-ceph` workload Namespace
(from `spec.namespace`), so TypeKro **auto-detects** this and **hoists that
Namespace out of the RGD graph**, emitting it as a retained resource created
outside the KRO graph (deps-first) — you do **not** need to create any namespace
yourself, and no flag is required. The instance CR stays in its natural
`rook-ceph` namespace. A KRO graph must not own the namespace containing its own
instance (namespace deletion and the instance finalizer would otherwise
deadlock), and hoisting the namespace out of the graph is what avoids it.

The bootstrap is the explicit owner of the complete operator installation:
Namespace, HelmRepository, and HelmRelease. Deleting its KRO instance therefore
uninstalls that installation. Application compositions that consume a shared
operator should place `rookCephOperatorBootstrap` behind TypeKro's `singleton()`
boundary; deleting a consumer then leaves the singleton owner intact.

### Bootstrap options

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | required | Helm release name |
| `namespace` | `string` | `rook-ceph` | Operator namespace |
| `version` | `string` | `v1.20.2` | Official chart version, including the `v` prefix |
| `repositoryName` | `string` | `rook-release` | Flux source name |
| `repositoryNamespace` | `string` | operator namespace | Flux source namespace |
| `repositoryNamespaceOwnership` | `owned \| external` | `owned` | Whether a distinct custom source Namespace is created and lifecycle-owned |
| `repositoryUrl` | `string` | official Rook repository | Flux source URL |
| `logLevel` | enum | chart default | `ERROR`, `WARNING`, `INFO`, or `DEBUG` |
| `enableOBCWatchOperatorNamespace` | `boolean` | chart default | Controls the operator's OBC watch behavior |
| `obcProvisionerNamePrefix` | `string` | chart default | Overrides the bucket provisioner prefix |
| `obcAllowAdditionalConfigFields` | `string` | chart default | Comma-separated OBC fields allowed by the operator |
| `resources` | object | chart default | Operator pod requests and limits |
| `values` | object | `{}` | Raw chart values, merged last |

`values` is the passthrough for chart settings not modeled above. It is
graph-aware in KRO mode and merges after typed fields.

## Complete platform compositions

TypeKro provides three complete cluster-chart compositions in addition to the
operator-only bootstrap:

| Composition | Intended use | Operator ownership |
| --- | --- | --- |
| `rookCephSingleNodePlatform` | Bounded one-node development | Installs and owns the official operator |
| `rookCephProductionPlatform` | Explicit multi-node production contract | Installs and owns the official operator |
| `rookCephExternalOperatorSingleNodePlatform` | One-node cluster on a shared operator | Observes an existing operator Deployment; never adopts or deletes it |

The managed variants own the operator and cluster HelmReleases, their
Namespaces, the `CephObjectStore`, and the bucket `StorageClass`. The cluster
chart creates the `CephCluster`; TypeKro observes it for readiness and orders
the object store after it. The external-operator variant omits the operator
release and Namespace, and requires their names explicitly.

The development profile is intentionally replication-one and is not highly
available. Its managed-operator composition disables the `rook-ceph` operator
chart's CSI dependency because this object-storage-only profile owns no block
pools or filesystems. This avoids installing unused CSI `ClientProfile`
finalizers whose lifecycle would otherwise need to precede operator teardown:

```ts
const local = rookCephSingleNodePlatform.factory('kro', {
  namespace: 'platform-control',
  waitForReady: true,
});

await local.deploy({
  name: 'rook-local',
  profile: 'single-node-development',
  namespace: 'rook-ceph',
  operatorNamespace: 'rook-ceph-operator',
  storageClassName: 'local-block',
  storageSize: '16Gi',
  // Development-only escape hatch for loop-backed local block fixtures.
  allowLoopDevices: true,
  objectStoreName: 'application-objects',
  bucketStorageClassName: 'application-buckets-retain',
  resources: {
    // Each supplied daemon entry replaces that daemon's development default.
    // This cluster has enough memory for a less constrained OSD.
    osd: {
      requests: { cpu: '500m', memory: '2Gi' },
      limits: { memory: '4Gi' },
    },
  },
});
```

The development profile has deliberately small defaults for `mon`, `mgr`,
`osd`, `prepareosd`, and `rgw`. Use the optional `resources` map when the
defaults do not fit the target node. Each daemon entry is independent, so an
OSD override does not require restating the monitor, manager, prepare job, or
gateway defaults. A supplied entry replaces that daemon's complete resource
requirements; specify every request and limit that the daemon should retain.
The same values are admitted and rendered in direct and KRO modes, including
the OSD resource requirements on its storage device set and the RGW gateway
requirements on the separately materialized `CephObjectStore`.

`allowLoopDevices` defaults to `false`. Enable it only for an explicitly
loop-backed development fixture, never as a production storage substitute.

The production profile requires the availability and operational decisions
that the local profile deliberately supplies as unsafe single-node defaults:

```ts
const resource = {
  requests: { cpu: '500m', memory: '1Gi' },
  limits: { memory: '2Gi' },
};

await rookCephProductionPlatform
  .factory('kro', { namespace: 'platform-control', waitForReady: true })
  .deploy({
    name: 'rook-production',
    profile: 'production',
    storageClassName: 'production-block',
    storageSize: '500Gi',
    osdCount: 6,
    monCount: 3,
    mgrCount: 2,
    poolReplicas: 3,
    failureDomain: 'host',
    portableVolumes: true,
    resources: {
      mon: resource,
      mgr: resource,
      osd: resource,
      prepareosd: resource,
      rgw: resource,
    },
    monitoring: { enabled: true, createPrometheusRules: true },
    disruptionManagement: {
      managePodBudgets: true,
      osdMaintenanceTimeoutMinutes: 45,
    },
    backup: {
      strategy: 'ceph-multisite',
      recoveryPointObjective: '5m',
      recoveryTimeObjective: '1h',
    },
  });
```

Production singleton booleans such as `monitoring.enabled: true` and
`managePodBudgets: true` are emitted as Kubernetes booleans with CRD admission
rules in KRO mode. A GitOps-authored instance cannot replace them with strings
or disable the mandatory controls.

For a shared operator, use the explicit observer boundary:

```ts
await rookCephExternalOperatorSingleNodePlatform
  .factory('kro', { namespace: 'platform-control', waitForReady: true })
  .deploy({
    name: 'application-storage',
    profile: 'single-node-development',
    namespace: 'application-ceph',
    operatorNamespace: 'shared-rook-operator',
    operatorDeploymentName: 'rook-ceph-operator',
    storageClassName: 'local-block',
  });
```

The external operator remains the authority for its CSI controllers and
finalizers. Its platform owner must keep that operator running until the
external-operator cluster and all of its operator-owned descendants have
finished deletion; TypeKro deliberately does not mutate the external
operator's Helm values.

All three compositions create a distinct custom `repositoryNamespace` by
default. Set `repositoryNamespaceOwnership: 'external'` only when another
platform owner guarantees that Namespace exists. In KRO mode, owned
Namespaces are lifecycle-safe siblings: TypeKro creates them before the RGD,
records ownership on the instance, and deletes them only after the instance
finalizer has cleared and emptiness/ownership guards pass.

Their public status is:

```ts
type RookCephPlatformStatus = {
  ready: boolean;
  failed: boolean;
  phase: 'Installing' | 'Ready' | 'Failed';
  operatorReady: boolean;
  clusterReady: boolean;
  objectStoreReady: boolean;
  storageClassReady: boolean;
  cephHealth: string;
  endpoint: string;
  bucketStorageClassName: string;
  version: string;
  cephVersion: string;
  profile: 'single-node-development' | 'production';
};
```

`ready` means complete platform health, not only data-plane health: the
operator, `CephCluster`, `CephObjectStore`, and bucket `StorageClass` must all
be available. The external-operator composition derives `operatorReady` from
the observed Deployment's available replicas.

## Low-level platform setup

For custom cluster topologies, a platform owner can compose the low-level
resources directly. After creating a `CephCluster`, define an RGW object store.
The metadata pool must be replicated. The data pool may be replicated or
erasure-coded.

```ts
const store = cephObjectStore({
  name: 'application-objects',
  namespace: 'rook-ceph',
  spec: {
    metadataPool: {
      failureDomain: 'host',
      replicated: { size: 3, requireSafeReplicaSize: true },
    },
    dataPool: {
      failureDomain: 'host',
      erasureCoded: { dataChunks: 2, codingChunks: 1 },
      parameters: { bulk: 'true' },
    },
    preservePoolsOnDelete: true,
    gateway: { port: 80, instances: 2 },
    healthCheck: {
      startupProbe: { disabled: false },
      readinessProbe: { disabled: false },
    },
  },
});
```

Create one or more cluster-scoped bucket StorageClasses. Lifecycle policy is a
platform choice; `Retain` is TypeKro's default because deleting an application
claim should not silently destroy its object data.

```ts
const buckets = rookBucketStorageClass({
  name: 'rook-ceph-buckets-retain',
  objectStoreName: 'application-objects',
  objectStoreNamespace: 'rook-ceph',
  operatorNamespace: 'rook-ceph',
  reclaimPolicy: 'Retain',
});
```

The generated provisioner is
`<provisionerNamePrefix>.ceph.rook.io/bucket`. By default, the prefix is the
Ceph cluster/object-store namespace because Rook registers one bucket
provisioner for each Ceph cluster. This remains true when the shared operator
runs in a different namespace. If the operator bootstrap configures
`obcProvisionerNamePrefix`, pass the same value explicitly as
`provisionerNamePrefix` here.

For a brownfield bucket, set `existingBucketName` on the StorageClass and omit
both bucket-name fields on the application claim. Rook's API places the
existing bucket name on the StorageClass, not the claim.

## Application bucket claim

`rookObjectStorageClaim` owns only the namespaced OBC and references an
administrator-provided StorageClass.

```ts
const objectStorage = rookObjectStorageClaim.factory('direct', {
  namespace: 'my-app',
  waitForReady: true,
});

const instance = await objectStorage.deploy({
  name: 'uploads',
  namespace: 'my-app',
  storageClassName: 'rook-ceph-buckets-retain',
  bucket: { name: 'uploads', mode: 'generated' },
  maxObjects: '1000000',
  maxSize: '100G',
});
```

Use one structurally valid `bucket` value:

- `{ name, mode: 'generated' }` for a collision-resistant new bucket in direct mode
- `{ name, mode: 'fixed' }` for a fixed new bucket name in direct mode
- omit `bucket` when the StorageClass references an existing bucket

This structural shape prevents callers from specifying fixed and generated
bucket names at the same time.

Application claims are direct-only. The OBC provisioner mutates claim metadata
and status during binding; KRO's continuous server-side apply can repeatedly
invalidate those updates and leave an already-provisioned bucket stuck in
`Pending`. Its composition-level mode contract rejects KRO factories,
graph-level KRO YAML serialization, and nesting the claim inside another KRO
composition.

When the claim reaches `Bound`, Rook creates a Secret and ConfigMap with the
same name and namespace as the claim. The composition returns these stable
binding names in hydrated status:

```ts
type RookObjectStorageClaimStatus = {
  ready: boolean;
  phase: 'Pending' | 'Bound' | 'Released' | 'Failed';
  claimName: string;
  credentialsSecretName: string;
  connectionConfigMapName: string;
  storageClassName: string;
};
```

The generated Secret contains `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`. The ConfigMap contains `BUCKET_HOST`, `BUCKET_PORT`,
`BUCKET_NAME`, and related connection metadata. Applications can inject those
resources into an ordinary S3-compatible client. See the upstream
[ObjectBucketClaim documentation](https://rook.io/docs/rook/latest/Storage-Configuration/Object-Storage-RGW/ceph-object-bucket-claim/)
for the full generated contract.

`maxObjects` and `maxSize` map to Rook's default-safe OBC quota fields. More
powerful fields such as bucket policies and lifecycle documents must first be
enabled by the platform through `obcAllowAdditionalConfigFields`; they are not
exposed by the high-level claim composition.

## Low-level resources

The package also exports:

- `objectBucketClaim()` for direct control of `objectbucket.io/v1alpha1`
- `cephObjectStoreUser()` for an explicit RGW identity
- `rookCephHelmRepository()` and `rookCephOperatorHelmRelease()` for low-level Flux use

OBCs normally create purpose-scoped bucket credentials automatically. Prefer
that path over `cephObjectStoreUser()` unless a stable shared RGW identity is
specifically required.

When `CephObjectStoreUser.spec.keys` is supplied, every entry must contain both
`accessKeyRef` and `secretKeyRef`; Rook requires the pair during reconciliation.

## Readiness

| Resource | Ready condition |
| --- | --- |
| Rook operator bootstrap | Flux HelmRelease has `Ready=True` |
| Complete Rook platform | Operator, `CephCluster`, `CephObjectStore`, and bucket `StorageClass` are all ready |
| `CephObjectStore` | `status.phase == "Ready"` |
| `CephObjectStoreUser` | `status.phase == "Ready"` |
| `ObjectBucketClaim` | `status.phase == "Bound"` |
| Bucket `StorageClass` | Kubernetes accepted the immutable resource |

The bootstrap reports `Ready`, `Installing`, or `Failed` and also exposes the
underlying failure signal as `failed`.

## Direct and KRO boundaries

Operator ownership and all three complete platform graphs support both factory modes.
The application OBC claim is deliberately direct-only:

```ts
rookObjectStorageClaim.factory('direct', { namespace: 'my-app' });
rookCephOperatorBootstrap.factory('kro', { namespace: 'platform-control' });
rookCephProductionPlatform.factory('kro', { namespace: 'platform-control' });
```

This is an explicit controller-ownership boundary, not a missing implementation:
Rook must remain the sole active reconciler for an ObjectBucketClaim while it
binds. KRO can safely own the operator, `CephObjectStore`, and bucket
`StorageClass`; direct mode applies and hydrates the application OBC.

## Current scope

The complete platform compositions create a `CephCluster` through the official
cluster chart, but intentionally model only one-node development and an
explicit replicated production profile. They do not model Rook multisite
realms/zones, bucket notifications, arbitrary device discovery, or experimental
COSI resources. Those capabilities have materially different lifecycle and
security decisions. Raw Rook resources can still be composed alongside these
factories, and future typed slices can be added without changing the
application OBC contract.

Upstream references:

- [Rook object storage overview](https://rook.io/docs/rook/latest/Storage-Configuration/Object-Storage-RGW/object-storage/)
- [CephObjectStore CRD](https://rook.io/docs/rook/latest/CRDs/Object-Storage/ceph-object-store-crd/)
- [ObjectBucketClaim](https://rook.io/docs/rook/latest/Storage-Configuration/Object-Storage-RGW/ceph-object-bucket-claim/)
- [Official Rook releases](https://github.com/rook/rook/releases)
