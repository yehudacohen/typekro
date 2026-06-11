---
title: Dagster
description: Deploy Dagster OSS to Kubernetes with TypeKro using the official Dagster Helm chart.
---

# Dagster

TypeKro's Dagster integration deploys Dagster OSS through the official Dagster Helm chart.
It creates the Kubernetes Namespace, Flux HelmRepository, and Flux HelmRelease needed to run
Dagster, while leaving chart-generated webserver, daemon, user-code, run-worker, PostgreSQL,
Redis, RabbitMQ, ingress, and pod resources owned by Helm and Flux.

```ts
import {
  dagsterBootstrap,
  dagsterHelmRelease,
  dagsterHelmRepository,
  mapDagsterConfigToHelmValues,
} from 'typekro/dagster';
```

## What Gets Created

Each `dagsterBootstrap` instance owns:

- A `Namespace` for the Dagster deployment namespace.
- A Flux `HelmRelease` for chart `dagster`, default version `1.13.8`.

The Flux `HelmRepository` for `https://dagster-io.github.io/helm` is a **shared
cluster-level singleton** (`DagsterHelmRepository`), deployed once and referenced by every
Dagster instance. Modelling it per-instance would make each instance's KRO ApplySet try to
own the same `flux-system/dagster` HelmRepository exclusively, so a second instance (e.g. a
dev + prod pair) would fail to reconcile. The singleton owner lives in the `typekro-singletons`
namespace; the factory's `deploy()` creates it automatically. See
[Singletons & GitOps](#singletons-and-gitops) for the GitOps (`toYaml`) workflow.

The bootstrap status is derived from owned Flux resources only. Component booleans such as
`webserver`, `daemon`, and `userDeployments` mean the owning HelmRelease is ready, not that
TypeKro inspected chart-generated Deployments or Pods.

## Minimal Bootstrap

```ts
import { dagsterBootstrap } from 'typekro/dagster';

const factory = dagsterBootstrap.factory('kro', {
  namespace: 'dagster',
});

await factory.deploy({
  name: 'analytics',
  namespace: 'dagster',
  userDeployments: {
    enabled: true,
    deployments: [
      {
        name: 'analytics-repo',
        image: {
          repository: 'ghcr.io/acme/dagster-analytics',
          tag: '2026.06.01',
        },
        codeServerArgs: ['-m', 'analytics.definitions'],
      },
    ],
  },
});
```

Use `dagsterApiGrpcArgs` instead of `codeServerArgs` when your image starts a gRPC server with
`dagster api grpc`. Typed user deployments must set exactly one of those fields. If omitted,
TypeKro defaults the user-code port to `3030` and image pull policy to `IfNotPresent`.

## Direct, KRO, And YAML Workflows

Use direct mode for immediate apply/read/delete operations:

```ts
const direct = dagsterBootstrap.factory('direct', {
  namespace: 'dagster',
});

await direct.deploy({
  name: 'analytics',
  namespace: 'dagster',
  userDeployments: {
    enabled: true,
    deployments: [
      {
        name: 'analytics-repo',
        image: { repository: 'ghcr.io/acme/dagster-analytics', tag: '2026.06.01' },
        dagsterApiGrpcArgs: ['-m', 'analytics.grpc'],
      },
    ],
  },
});
```

Use YAML generation for GitOps:

```ts
// RGDs: the shared HelmRepository singleton owner RGD plus the bootstrap RGD,
// emitted deps-first as a multi-document stream.
const rgdYaml = dagsterBootstrap.toYaml();

// Instances: the shared singleton owner instance plus this Dagster instance.
const instanceYaml = dagsterBootstrap
  .factory('kro', { namespace: 'analytics' })
  .toYaml({ name: 'analytics', namespace: 'analytics' });
```

Generated ResourceGraphDefinition YAML does not read the cluster. Raw `values` are serialized as
runtime graph-aware Helm values, so schema refs and CEL values are preserved instead of being
stringified.

### Singletons and GitOps

Because the HelmRepository is a shared singleton, the GitOps bundle has **two RGDs** and (per
instance) **two custom resources**:

- `dagsterBootstrap.toYaml()` emits the `dagster-helm-repository` singleton RGD **before** the
  `dagster-bootstrap` RGD (deps-first), as a multi-document YAML stream.
- `factory.toYaml(spec)` emits the shared `DagsterHelmRepository` owner instance (in the
  `typekro-singletons` namespace, carrying the `typekro.io/singleton-spec-fingerprint`
  annotation) **before** the `DagsterBootstrap` instance.

Apply all of them. The owner instance is identical to what `deploy()` creates, so mixing GitOps
and imperative `deploy()` against the same cluster is safe — the second writer finds the existing
owner and passes its drift check. Deploying multiple Dagster instances? They all share the one
owner; emit its RGD/instance once.

## Low-Level Helm Wrappers

Use low-level wrappers when you want to compose your own resource graph:

```ts
const repo = dagsterHelmRepository({
  id: 'dagsterHelmRepository',
});

const release = dagsterHelmRelease({
  id: 'dagsterHelmRelease',
  name: 'analytics',
  namespace: 'dagster',
  values: mapDagsterConfigToHelmValues({
    name: 'analytics',
    userDeployments: {
      enabled: true,
      deployments: [
        {
          name: 'analytics-repo',
          image: { repository: 'ghcr.io/acme/dagster-analytics', tag: '2026.06.01' },
          codeServerArgs: ['-m', 'analytics.definitions'],
        },
      ],
    },
  }),
});
```

Defaults:

- Repository URL: `https://dagster-io.github.io/helm`
- Repository name: `dagster`
- Chart name: `dagster`
- Chart version: `1.13.8`
- Repository namespace: `flux-system`

## Typed Configuration

Common chart areas have typed convenience fields:

```ts
await factory.deploy({
  name: 'analytics',
  namespace: 'dagster',
  serviceAccountName: 'dagster-runtime',
  rbacEnabled: true,
  imagePullSecrets: [{ name: 'dagster-registry' }],
  webserver: {
    replicaCount: 2,
    pathPrefix: '/dagster',
    service: { type: 'ClusterIP', port: 8080 },
    logFormat: 'json',
  },
  daemon: {
    enabled: true,
    runRetries: { enabled: true, maxRetries: 2 },
    runMonitoring: { enabled: true },
  },
  userDeployments: {
    enabled: true,
    deployments: [
      {
        name: 'analytics-repo',
        image: { repository: 'ghcr.io/acme/dagster-analytics', tag: '2026.06.01' },
        codeServerArgs: ['-m', 'analytics.definitions'],
        envSecrets: [{ name: 'analytics-dagster-env' }],
        resources: { requests: { cpu: '250m', memory: '512Mi' } },
      },
    ],
  },
  runLauncher: {
    type: 'K8sRunLauncher',
    k8sRunLauncher: {
      jobNamespace: 'dagster-runs',
      envSecrets: [{ name: 'dagster-run-env' }],
    },
  },
  computeLogManager: {
    type: 'S3ComputeLogManager',
    config: { bucket: 'dagster-compute-logs', prefix: 'runs' },
  },
});
```

Typed fields cover the common chart surface for webserver, daemon, user deployments, PostgreSQL,
run launcher, scheduler, compute logs, Flower, ingress, RabbitMQ, Redis, image pull Secrets,
RBAC, and global chart settings.

## Raw Values Passthrough

Use `values` for official chart fields not modeled as typed convenience config. Raw `values` merge
last, so they can override typed fields when needed.

```ts
await factory.deploy({
  name: 'analytics',
  namespace: 'dagster',
  userDeployments: {
    enabled: true,
    deployments: [
      {
        name: 'analytics-repo',
        image: { repository: 'ghcr.io/acme/dagster-analytics', tag: '2026.06.01' },
        codeServerArgs: ['-m', 'analytics.definitions'],
      },
    ],
  },
  values: {
    busybox: { image: { repository: 'busybox', tag: '1.36' } },
    dagsterWebserver: { replicaCount: 3 },
    extraManifests: [],
  },
});
```

Plain objects merge recursively. Arrays replace earlier arrays. Primitive raw values override typed
values. Kubernetes refs, CEL expressions, and TypeKro values-merge expressions are preserved. In KRO
mode, partial raw `dagsterWebserver` or `dagsterDaemon` overrides preserve typed image settings such
as architecture-compatible validation images while still applying the raw chart fields last.

## External PostgreSQL And Secrets

For production, prefer externally managed Secrets and external PostgreSQL databases. TypeKro does
not generate hidden credentials.

```ts
await factory.deploy({
  name: 'analytics',
  namespace: 'dagster',
  userDeployments: {
    enabled: true,
    deployments: [
      {
        name: 'analytics-repo',
        image: { repository: 'ghcr.io/acme/dagster-analytics', tag: '2026.06.01' },
        codeServerArgs: ['-m', 'analytics.definitions'],
      },
    ],
  },
  postgresql: {
    enabled: false,
    host: 'dagster-postgres.postgres.svc.cluster.local',
    username: 'dagster',
    database: 'dagster',
    passwordSecretName: 'dagster-postgres',
    servicePort: 5432,
  },
});
```

This maps to chart PostgreSQL values such as `postgresql.postgresqlHost`,
`postgresql.postgresqlUsername`, `postgresql.postgresqlDatabase`, and
`global.postgresqlSecretName`. When `passwordSecretName` is set, the mapper sets
`generatePostgresqlPasswordSecret: false`.

Literal passwords are accepted only when explicitly supplied by the caller and are intended for
local development. Production configs should reference Secrets through chart-supported Secret
fields, `envSecrets`, `imagePullSecrets`, or raw `values`.

## Celery Run Launcher

Celery mode requires a broker/backend path. Configure RabbitMQ, Redis, an existing Celery config
Secret, or raw chart values.

```ts
await factory.deploy({
  name: 'analytics',
  namespace: 'dagster',
  global: {
    celeryConfigSecretName: 'dagster-celery-config',
  },
  runLauncher: {
    type: 'CeleryK8sRunLauncher',
    celeryK8sRunLauncher: {
      workerQueues: [{ name: 'default', replicaCount: 2 }],
    },
  },
  rabbitmq: {
    enabled: true,
    servicePort: 5672,
    values: { persistence: { enabled: true } },
  },
  userDeployments: {
    enabled: true,
    deployments: [
      {
        name: 'analytics-repo',
        image: { repository: 'ghcr.io/acme/dagster-analytics', tag: '2026.06.01' },
        codeServerArgs: ['-m', 'analytics.definitions'],
      },
    ],
  },
});
```

If `global.celeryConfigSecretName` is set, TypeKro sets `generateCeleryConfigSecret: false`.
RabbitMQ and Redis `values` merge into their official chart blocks; they do not appear as nested
`.values` keys.

## Ingress

```ts
await factory.deploy({
  name: 'analytics',
  namespace: 'dagster',
  ingress: {
    enabled: true,
    ingressClassName: 'nginx',
    dagsterWebserver: {
      host: 'dagster.example.com',
      path: '/',
      tls: { enabled: true, secretName: 'dagster-tls' },
    },
  },
  userDeployments: {
    enabled: true,
    deployments: [
      {
        name: 'analytics-repo',
        image: { repository: 'ghcr.io/acme/dagster-analytics', tag: '2026.06.01' },
        codeServerArgs: ['-m', 'analytics.definitions'],
      },
    ],
  },
});
```

You must provide the ingress controller, DNS, and TLS Secret or cert-manager policy appropriate for
your cluster.

## Validation

TypeKro validates common impossible or unsafe typed configurations before deploy or YAML generation:

- A typed user-code deployment must set exactly one of `dagsterApiGrpcArgs` or `codeServerArgs`.
- `CeleryK8sRunLauncher` requires RabbitMQ, Redis, an existing Celery Secret, or raw Celery values.
- External PostgreSQL typed config with `enabled: false` requires `host` or raw PostgreSQL values.

Validation failures throw `DagsterConfigurationError`, a structured `TypeKroError` with safe issue
metadata. Error messages do not include secret values.

## Operations

Recommended rollout checks:

- Inspect the TypeKro instance status for `ready`, `phase`, and `failed`.
- Inspect the Flux HelmRepository and HelmRelease Ready conditions.
- Inspect Flux controller logs for chart fetch, install, and upgrade failures.
- Inspect chart-generated pods for webserver, daemon, user-code, run workers, and step workers.
- Inspect PostgreSQL, Redis, RabbitMQ, ingress, DNS, TLS, and object-storage dependencies owned by
your platform.

Recommended alerts:

- HelmRelease Ready is false or not ready longer than the expected rollout window.
- Dagster daemon is unavailable while schedules or sensors should run.
- User-code deployment pods are unavailable or restarting.
- PostgreSQL, Redis, RabbitMQ, image pull, or ingress failures appear in pod events.

## Troubleshooting

Start from TypeKro status, then move to Flux and chart-generated resources:

```sh
kubectl get helmrepository -n flux-system
kubectl get helmrelease -n dagster
kubectl describe helmrelease -n dagster analytics
kubectl get pods -n dagster
```

Common issues:

- Image pull failures: verify the configured image tag, registry access, and `imagePullSecrets`.
- Database failures: verify `postgresql.host`, Secret name/key, database name, and network policy.
- Celery failures: verify run launcher type, RabbitMQ/Redis settings, and Celery Secret wiring.
- User-code load failures: inspect user-code pod logs and gRPC/code-server arguments.
- KRO-only image or pod config failures: verify partial raw `values.dagsterWebserver` or
  `values.dagsterDaemon` overrides are not replacing typed image settings you need for the cluster
  architecture.
- Ingress failures: verify ingress class, DNS, TLS Secret, and controller logs.
- Upgrade failures: inspect HelmRelease conditions, then roll back by changing `version` or `values`.

## Live Validation

The integration test can prove the direct-mode path reaches HelmRelease `Ready=True` when a live
cluster has Flux Helm CRDs/controllers and a Dagster image that matches the cluster architecture.

For arm64 local clusters, build the checked-in validation fixture image through TypeKro's
container builder:

```ts
import { buildContainer } from 'typekro/containers';

await buildContainer({
  context: 'test/integration/dagster/fixtures/arm64-validation',
  imageName: 'typekro-dagster-validation',
  tag: '1.13.8',
  platform: 'linux/arm64',
  registry: { type: 'orbstack' },
  timeout: 900000,
});
```

Then run the live test:

```sh
bun test test/integration/dagster/bootstrap-composition.test.ts --timeout 900000
```

The test also auto-detects `typekro-dagster-validation:1.13.8` on arm64 when it is available in the
local Docker image store. If the image is absent and Docker is available, the test builds it with
TypeKro's `buildContainer` helper before deploying. For remote clusters, push that fixture to a
registry the cluster can pull and set `DAGSTER_TEST_VALIDATION_IMAGE` to the registry reference.
Direct `docker build` is not required for the local validation path.

On amd64 clusters, the official Dagster example image can be used for user code. To override both
the user-code and Dagster system images explicitly, set `DAGSTER_TEST_USER_CODE_IMAGE` and
`DAGSTER_TEST_DAGSTER_IMAGE` to architecture-compatible, pullable images before running the test.

## Next Steps

- Build and push a Dagster project image that contains your definitions.
- Decide whether to use bundled PostgreSQL or an external managed PostgreSQL service.
- Create required Secrets for database credentials, image pulls, Celery, and object storage.
- Add ingress, TLS, compute log storage, and run launcher configuration for production.
- Generate YAML with `dagsterBootstrap.toYaml()` for GitOps or use a direct factory for local tests.
