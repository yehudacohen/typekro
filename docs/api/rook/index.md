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
  rookObjectStorageClaim,
} from 'typekro/rook';
```

The operator bootstrap wraps the official `rook-ceph` chart from
`https://charts.rook.io/release`. The default version is `v1.20.2`.

```ts
const operator = rookCephOperatorBootstrap.factory('kro', {
  namespace: 'platform-control-plane',
  waitForReady: true,
});

await operator.deploy({
  name: 'rook-ceph',
  namespace: 'rook-ceph',
  logLevel: 'INFO',
});
```

The bootstrap installs the official operator and its CRDs. It intentionally
does **not** create a `CephCluster`; devices, failure domains, replication, and
the cluster's destruction policy require explicit platform decisions. See the
[Rook prerequisites](https://rook.io/docs/rook/latest-release/Getting-Started/Prerequisites/prerequisites/)
before provisioning a Ceph cluster.

In KRO mode, create the factory's control-plane namespace before deploying and
keep it different from the child `rook-ceph` namespace. A KRO graph must not
own the namespace containing its own instance because namespace deletion and
the instance finalizer can otherwise deadlock.

The operator is shared cluster infrastructure by default. Set `shared: false`
only for disposable or isolated environments.

### Bootstrap options

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | required | Helm release name |
| `namespace` | `string` | `rook-ceph` | Operator namespace |
| `version` | `string` | `v1.20.2` | Official chart version, including the `v` prefix |
| `shared` | `boolean` | `true` | Preserve operator resources during consumer deletion |
| `logLevel` | enum | chart default | `ERROR`, `WARNING`, `INFO`, or `DEBUG` |
| `enableOBCWatchOperatorNamespace` | `boolean` | chart default | Controls the operator's OBC watch behavior |
| `obcProvisionerNamePrefix` | `string` | chart default | Overrides the bucket provisioner prefix |
| `obcAllowAdditionalConfigFields` | `string` | chart default | Comma-separated OBC fields allowed by the operator |
| `resources` | object | chart default | Operator pod requests and limits |
| `values` | object | `{}` | Raw chart values, merged last |

`values` is the passthrough for chart settings not modeled above. It is
graph-aware in KRO mode and merges after typed fields.

## Platform setup

After creating a `CephCluster`, a platform owner can define an RGW object store.
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
  provisionerNamePrefix: 'rook-ceph',
  reclaimPolicy: 'Retain',
});
```

The generated provisioner is
`<provisionerNamePrefix>.ceph.rook.io/bucket`. The prefix defaults to the
standard `rook-ceph` operator namespace. If the operator bootstrap configures
`obcProvisionerNamePrefix`, pass the same value as `provisionerNamePrefix` here.

For a brownfield bucket, set `existingBucketName` on the StorageClass and omit
both bucket-name fields on the application claim. Rook's API places the
existing bucket name on the StorageClass, not the claim.

## Application bucket claim

`rookObjectStorageClaim` owns only the namespaced OBC and references an
administrator-provided StorageClass.

```ts
const objectStorage = rookObjectStorageClaim.factory('kro', {
  namespace: 'my-app',
  waitForReady: true,
});

const instance = await objectStorage.deploy({
  name: 'uploads',
  namespace: 'my-app',
  storageClassName: 'rook-ceph-buckets-retain',
  generateBucketName: 'uploads',
  maxObjects: '1000000',
  maxSize: '100G',
});
```

Use exactly one of:

- `generateBucketName` for a collision-resistant new bucket (recommended)
- `bucketName` for a fixed new bucket name
- neither when the StorageClass references an existing bucket

When the claim reaches `Bound`, Rook creates a Secret and ConfigMap with the
same name and namespace as the claim. The composition projects these stable
binding names into KRO status:

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

## Readiness

| Resource | Ready condition |
| --- | --- |
| Rook operator bootstrap | Flux HelmRelease has `Ready=True` |
| `CephObjectStore` | `status.phase == "Ready"` |
| `CephObjectStoreUser` | `status.phase == "Ready"` |
| `ObjectBucketClaim` | `status.phase == "Bound"` |
| Bucket `StorageClass` | Kubernetes accepted the immutable resource |

The bootstrap exposes `failed` separately because the two-state `phase`
reports only `Ready` or `Installing`.

## Direct and KRO modes

All public compositions support both factory modes:

```ts
rookObjectStorageClaim.factory('direct', { namespace: 'my-app' });
rookObjectStorageClaim.factory('kro', { namespace: 'my-app' });
```

Direct mode applies the OBC itself. KRO mode generates an RGD and projects the
Bound phase plus binding names onto the live custom resource status.

## Current scope

This object-storage slice does not create `CephCluster`, Rook multisite
realms/zones, bucket notifications, or experimental COSI resources. Those are
platform capabilities with materially different lifecycle and security
decisions. Raw Rook resources can still be composed alongside these factories,
and future typed slices can be added without changing the application OBC
contract.

Upstream references:

- [Rook object storage overview](https://rook.io/docs/rook/latest/Storage-Configuration/Object-Storage-RGW/object-storage/)
- [CephObjectStore CRD](https://rook.io/docs/rook/latest/CRDs/Object-Storage/ceph-object-store-crd/)
- [ObjectBucketClaim](https://rook.io/docs/rook/latest/Storage-Configuration/Object-Storage-RGW/ceph-object-bucket-claim/)
- [Official Rook releases](https://github.com/rook/rook/releases)
