---
title: Harbor Registry Platform
description: Official Harbor, Rook/Ceph S3 storage, private projects, robots, and OCI delivery
---

# Harbor Registry Platform

TypeKro installs the official Harbor chart, binds its registry storage to an S3-compatible
provider such as Rook/Ceph, and reconciles private projects and purpose-scoped robot credentials.
The installation, project policy, credential storage, and image build are separate lifecycle
boundaries.

```ts
import {
  HarborApiClient,
  harborLocalInstallation,
  prepareHarborRookS3Binding,
  reconcileHarborProject,
} from 'typekro/harbor';
```

## Secret contract

Create the required Secrets in Harbor's workload Namespace before deploying the installation.
TypeKro observes these Secrets and makes the HelmRelease depend on them; it never accepts secret
values in the installation spec.

In KRO mode the Secrets are external observed nodes, so KRO does not create the HelmRelease until
they exist. In direct mode external observations are deliberately not treated as deployable graph
children: prepare the Secrets first, then call `deploy()`. Flux's generation-aware HelmRelease
readiness is the bounded acknowledgement that Harbor accepted the provider configuration.

| Purpose | Required key |
| --- | --- |
| Administrator password | `HARBOR_ADMIN_PASSWORD` (or `adminPasswordSecret.key`) |
| Encryption key | `secretKey` |
| Core secret | `secret` |
| Jobservice secret | `JOBSERVICE_SECRET` |
| Registry HTTP secret | `REGISTRY_HTTP_SECRET` |
| Registry basic authentication | `REGISTRY_PASSWD` and `REGISTRY_HTPASSWD` |
| Optional XSRF secret | `CSRF_KEY` |

Use names that are distinct from chart-owned resources such as `<release>-core`,
`<release>-jobservice`, and `<release>-registry`. The official chart always reconciles those
Secrets and omits externally sourced keys from them. Pointing an existing-Secret value at a
chart-owned Secret therefore creates an empty-key collision rather than external ownership.

## Rook/Ceph-backed local platform

Keep shared object storage and Harbor's workload Namespace outside the installation lifecycle.
The OBC produces a provider-neutral binding which TypeKro converts into the exact Secret fields
required by the official Harbor chart.

```ts
import { rookObjectStorageClaim } from 'typekro/rook';
import {
  harborLocalInstallation,
  prepareHarborRookS3Binding,
} from 'typekro/harbor';

const namespace = 'registry-system'; // pre-created and platform-owned

const claimFactory = rookObjectStorageClaim.factory('direct', {
  namespace,
  waitForReady: true,
});

await claimFactory.deploy({
  name: 'harbor-registry-storage',
  namespace,
  storageClassName: 'platform-object-storage',
  bucket: { name: 'harbor-registry', mode: 'generated' },
});

const storage = await prepareHarborRookS3Binding({
  sourceNamespace: namespace,
  claimName: 'harbor-registry-storage',
  targetNamespace: namespace,
  targetSecretName: 'platform-harbor-s3',
  rootDirectory: '/registry',
});

const harborFactory = harborLocalInstallation.factory('kro', {
  namespace: 'platform-control',
  waitForReady: true,
});

await harborFactory.deploy({
  name: 'harbor',
  namespace,
  namespaceOwnership: 'external',
  profile: 'local-development',
  exposure: {
    type: 'clusterIP',
    externalUrl: 'http://harbor.registry-system.svc',
    tls: { enabled: false, source: 'none' },
  },
  storage,
  adminPasswordSecret: { name: 'platform-harbor-admin' },
  componentSecrets: {
    encryptionKey: 'platform-harbor-encryption',
    core: 'platform-harbor-core',
    jobservice: 'platform-harbor-jobservice',
    registry: 'platform-harbor-registry',
    registryCredentials: 'platform-harbor-registry-credentials',
    xsrf: 'platform-harbor-xsrf',
  },
  trivyEnabled: false,
});
```

`harborLocalInstallation` intentionally permits the chart's internal PostgreSQL and Valkey for a
bounded development platform. It is not the production availability profile.

The installation owns a distinct custom `repositoryNamespace` by default. Set
`repositoryNamespaceOwnership: 'external'` only when another platform owner creates and retains
that Namespace. This is separate from `namespaceOwnership`, which controls the Harbor workload
Namespace. Owned Namespaces are hoisted out of KRO graphs and follow TypeKro's recorded,
ownership-gated instance lifecycle.

## Production profile

`harborProductionInstallation` requires TLS, external PostgreSQL, external Valkey, at least two
replicas of every stateless service, explicit resources, and a NetworkPolicy provider boundary.
Advanced official-chart values are deep-merged without mutating the caller's object. Additive
settings are preserved, while the typed production contract wins conflicts on availability,
credentials, TLS, storage, database/cache providers, and other modeled paths.
The production CRD carries the same essential safety contract in KRO mode: required literal
booleans remain booleans, TLS and ingress relationships are admission-validated, S3 must use
verified TLS, and the network boundary must declare non-empty ingress plus provider/CIDR egress.
The production certificate contract is explicit even when an existing TLS Secret is selected.

```ts
import { harborProductionInstallation } from 'typekro/harbor';

const storage = {
  bucket: 'harbor-registry',
  region: 'us-east-1',
  regionEndpoint: 'https://rook-ceph-rgw.registry-storage.svc',
  existingSecret: 'platform-harbor-s3',
  secure: true,
  skipVerify: false,
};
const resources = {
  requests: { cpu: '250m', memory: '512Mi' },
  limits: { cpu: '1', memory: '1Gi' },
};

const factory = harborProductionInstallation.factory('kro', {
  namespace: 'platform-control',
});

await factory.deploy({
  name: 'harbor',
  namespace: 'registry-system',
  namespaceOwnership: 'external',
  profile: 'production',
  exposure: {
    type: 'ingress',
    externalUrl: 'https://registry.example.com',
    tls: { enabled: true, source: 'cert-manager' },
    ingress: { host: 'registry.example.com', className: 'nginx' },
  },
  certificate: {
    secretName: 'platform-harbor-tls',
    issuerRef: { name: 'public', kind: 'ClusterIssuer' },
  },
  storage,
  adminPasswordSecret: { name: 'platform-harbor-admin' },
  componentSecrets: {
    encryptionKey: 'platform-harbor-encryption',
    core: 'platform-harbor-core',
    jobservice: 'platform-harbor-jobservice',
    registry: 'platform-harbor-registry',
    registryCredentials: 'platform-harbor-registry-credentials',
    xsrf: 'platform-harbor-xsrf',
  },
  database: {
    host: 'harbor-rw.database.svc',
    username: 'harbor',
    database: 'harbor',
    existingSecret: 'platform-harbor-database',
    sslMode: 'verify-full',
  },
  cache: {
    address: 'valkey-primary.valkey.svc:6379',
    existingSecret: 'platform-harbor-valkey',
    tls: { enabled: true, caBundleSecretName: 'platform-valkey-ca' },
  },
  networkPolicy: {
    enabled: true,
    ingressNamespaceLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' },
    egressNamespaceLabels: [
      { 'kubernetes.io/metadata.name': 'database' },
      { 'kubernetes.io/metadata.name': 'valkey' },
      { 'kubernetes.io/metadata.name': 'rook-ceph' },
    ],
  },
  replicas: { core: 2, portal: 2, registry: 2, jobservice: 2, exporter: 2 },
  resources: {
    core: resources,
    portal: resources,
    registry: resources,
    jobservice: resources,
    exporter: resources,
  },
});
```

## Private projects and robot credentials

The Harbor API provider is idempotent. Robot credentials are written directly to Kubernetes
Secrets and are not returned in logs or status. Pull and push identities are separate policies.

```ts
import { kubernetesSecretRegistryCredentials } from 'typekro/containers';

const client = new HarborApiClient({
  endpoint: 'https://registry.example.com',
  credentialProvider: kubernetesSecretRegistryCredentials({
    context: 'production',
    namespace: 'harbor-system',
    name: 'harbor-admin',
    username: 'admin',
    passwordKey: 'HARBOR_ADMIN_PASSWORD',
  }),
  ca: platformCa,
});

await reconcileHarborProject(client, {
  project: {
    name: 'chirp',
    public: false,
    autoScan: true,
    autoSbomGeneration: true,
    immutableTags: { tagPattern: 'sha-*' },
    retention: { keepMostRecent: 50 },
  },
  robots: [
    { name: 'chirp-pull', secretName: 'chirp-pull', access: 'pull' },
    { name: 'chirp-push', secretName: 'chirp-push', access: 'push' },
  ],
  secretNamespace: 'chirp-system',
  registry: 'registry.example.com',
});
```

Use `deleteHarborProject()` for explicit project destruction; it requires an exact-name
confirmation. Harbor rejects non-empty projects by default. Set `purgeRepositories: true` only
when the same confirmed operation should irreversibly delete every bounded repository first.
Pass `secretNamespace`, `robotSecretNames`, and the Kubernetes store when it should then remove
the named robot Secrets. Secrets are removed only after Harbor authoritatively reports the project
absent; a failed, timed-out, or mismatched deletion never removes credentials.

Use `factory.deleteInstance('harbor')` for the installation. With
`namespaceOwnership: 'external'`, TypeKro removes the KRO instance and chart resources while the
platform-owned Namespace, OBC, bucket, and retained data remain available for recovery or a new
installation.

## Live qualification

The opt-in OrbStack suite exercises both lifecycle modes against the official chart and retained
Rook/Ceph platform. It creates isolated projects, buckets, credentials, and NodePorts unless
`KEEP_HARBOR_PLATFORM=true` is selected deliberately.

```sh
RUN_HARBOR_PLATFORM_INTEGRATION=true KEEP_HARBOR_PLATFORM=true \
  bun test test/integration/harbor/harbor-platform.test.ts

RUN_HARBOR_PLATFORM_INTEGRATION=true HARBOR_DEPLOYMENT_MODE=direct \
  bun test test/integration/harbor/harbor-platform.test.ts

RUN_PRODUCTION_SCHEMA_ADMISSION=true \
  bun test test/integration/production-schema-admission.test.ts
```

Both paths install and update Harbor, wait for the current generation, restart a component,
reconcile private project policy and least-privilege robots twice, push a content-addressed image,
pull its digest from inside Kubernetes, and use TypeKro factory deletion for cleanup. Cleanup
timeouts fail the suite; the RGD remains available until KRO-owned instances have finished.
The admission-only suite installs uniquely named production RGDs through a TypeKro direct factory,
uses server-side dry-run for valid and unsafe Harbor/Rook instances, and then removes the RGDs
through that factory without deploying either data plane.
