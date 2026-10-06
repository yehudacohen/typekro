---
title: KEDA
description: Install KEDA with Flux and declare typed ScaledObjects, ScaledJobs and trigger authentications
---

# KEDA

`typekro/keda` installs [KEDA](https://keda.sh/) (Kubernetes Event-driven Autoscaling) through
Flux and gives you typed factories for its `keda.sh/v1alpha1` API:

- `scaledObject`: scale a Deployment, StatefulSet or any `scale` subresource on external
  metrics, down to zero
- `scaledJob`: start Jobs as work arrives
- `triggerAuthentication` / `clusterTriggerAuthentication`: credentials for the triggers

Verified against the official kedacore `keda` chart **2.21.0** (KEDA 2.21.0,
`https://kedacore.github.io/charts`).

## Import

```typescript
import { kedaBootstrap, scaledObject, triggerAuthentication } from 'typekro/keda';
```

`typekro/keda` is a subpath export only; it is not re-exported from `typekro`.

## Quick example

```typescript
import { kedaBootstrap } from 'typekro/keda';

await kedaBootstrap
  .factory('direct', { namespace: 'flux-system', waitForReady: true })
  .deploy({ name: 'keda' });
```

`'direct'` applies the resources immediately. `'kro'` emits a ResourceGraphDefinition and lets
KRO reconcile it. Both produce the same `HelmRelease`.

## Available factories

| Export | Kind | Scope | Description |
|---|---|---|---|
| `kedaBootstrap` | Composition | Cluster | Operator, metrics API server and webhooks, CRDs included |
| `makeKedaBootstrap(options)` | Composition | Cluster | The same, with build-time options |
| `kedaHelmRepositoryBootstrap` | Composition | Singleton | Shared kedacore `HelmRepository` owner |
| `scaledObject` | ScaledObject | Namespace | Typed ScaledObject |
| `scaledJob` | ScaledJob | Namespace | Typed ScaledJob |
| `triggerAuthentication` | TriggerAuthentication | Namespace | Secrets, ConfigMaps, env, pod identity, bound tokens |
| `clusterTriggerAuthentication` | ClusterTriggerAuthentication | Cluster | The same, shared across namespaces |
| `kedaTrigger(type, metadata, options)` | Trigger | — | An untyped trigger for any other scaler |
| `kedaReady(...)`, `kedaActive(...)` | Status helpers | — | `Ready=True` / `Active=True` on every given resource |
| `kedaHelmRepository`, `kedaHelmRelease` | Flux | Namespace | The Helm resources the bootstrap uses |
| `validateScaledObjectSpec`, `validateScaledJobSpec`, `validateKedaBootstrapConfig`, `findKedaAutoscalerConflicts` | Validators | — | Common-mistake checks (below) |

## Bootstrap composition

### Runtime spec

| Field | Chart value | Default |
|---|---|---|
| `name` | release name | required |
| `namespace` | install namespace | `keda` |
| `version` | chart version | `2.21.0` |
| `watchNamespace` | `watchNamespace` (comma-separated) | all namespaces |
| `logFormat` | `logging.*.format` / `zapEncoder` | `console` |
| `<component>.replicas` | `operator.replicaCount`, `metricsServer.replicaCount`, `webhooks.replicaCount` | `1` |
| `<component>.resources` | `resources.operator`, `.metricServer`, `.webhooks` | requests 100m / 100Mi, limits 1 CPU / 1000Mi |
| `<component>.podDisruptionBudget` | `podDisruptionBudget.operator`, `.metricServer`, `.webhooks` | none |
| `<component>.nodeSelector`, `.tolerations`, `.affinity` | per-component placement | none |
| `<component>.topologySpreadConstraints` | `topologySpreadConstraints.*` | none |
| `<component>.logLevel` | `logging.operator.level`, `logging.metricServer.zapLevel`, `logging.webhooks.level` | `info` |
| `operator.serviceAccountAnnotations` | `serviceAccount.operator.annotations` | none |
| `webhooks.enabled`, `webhooks.failurePolicy` | `webhooks.*` | `true`, `Ignore` |
| `podIdentity.awsIrsa` | `podIdentity.aws.irsa.enabled` / `.roleArn` | off |
| `podIdentity.azureWorkload` | `podIdentity.azureWorkload.*` | off |
| `podIdentity.gcp` | `podIdentity.gcp.enabled` / `.gcpIAMServiceAccount` | off |
| `certManager` | `certificates.certManager.enabled` | `false` (the operator issues its own certificates) |
| `priorityClassName` | every component | none |

`<component>` is `operator`, `metricsServer` or `webhooks`. The operator and the metrics server
elect a leader, so extra replicas shorten a failover but do not add capacity. With two replicas,
add a PDB such as `{ maxUnavailable: 1 }`; with one, a `minAvailable: 1` PDB blocks every node
drain, and the validator warns about it.

### Identity for the AWS scalers

The `aws-sqs-queue` and `aws-cloudwatch` scalers call AWS APIs. With
`podIdentity: { provider: 'aws' }` in a trigger authentication they use the KEDA operator's
identity, or assume `roleArn` from it:

- **EKS Pod Identity:** associate the IAM role with the `keda-operator` ServiceAccount in the
  install namespace. Nothing to set on the bootstrap.
- **IRSA:** `podIdentity: { awsIrsa: { enabled: true, roleArn: '<role arn>' } }` annotates the
  operator ServiceAccount.

`identityOwner: 'workload'` uses the scaled workload's own ServiceAccount role instead.

### Build-time options

| Option | Default | Effect |
|---|---|---|
| `keepCrdsOnUninstall` | `true` | Annotate the CRDs with `helm.sh/resource-policy: keep` |
| `namespaceOwnership` | `'external'` | `'external'` lets Flux create a missing namespace; `'owned'` makes it part of the graph |
| `install`, `upgrade`, `driftDetection` | see below | The Flux lifecycle options every TypeKro HelmRelease factory takes. See [Install, upgrade and CRD policy](/api/flux/#install-upgrade-and-crd-policy) |
| `values` | none | Raw chart values, deep-merged last (objects merge, lists replace) |
| `name`, `kind` | `keda-bootstrap`, `KedaBootstrap` | RGD name and kind |

Prometheus metrics, OpenTelemetry, network policies and the other chart options go through
`values`, for example `values: { prometheus: { operator: { enabled: true } } }`.

### CRDs and teardown

The chart renders its CRDs as templates, so they upgrade with the release. They are kept on
uninstall: without `keep`, an uninstall would delete every ScaledObject and ScaledJob in the
cluster.

Delete your ScaledObjects and ScaledJobs **before** removing the bootstrap. Each carries a
finalizer that only the KEDA operator removes, and the operator also deletes the HPA it created.
Remove the operator first and those objects stay stuck in deletion while their HPAs keep running.

### Status

| Field | Source |
|---|---|
| `ready` | `HelmRelease` `Ready=True` for its current generation |
| `failed` | `HelmRelease` `Ready=False` for its current generation |
| `phase` | `Ready`, `Installing` or `Failed` |
| `version` | Chart version Flux installed (`status.history`), `''` until then |

## ScaledObject

```typescript
import { scaledObject } from 'typekro/keda';

scaledObject({
  name: 'worker',
  namespace: 'jobs',
  spec: {
    scaleTargetRef: { name: 'worker' }, // kind defaults to Deployment
    minReplicaCount: 0,
    maxReplicaCount: 50,
    pollingInterval: 15,
    cooldownPeriod: 300,
    triggers: [
      {
        type: 'aws-sqs-queue',
        metadata: {
          queueURL: 'https://sqs.us-east-1.amazonaws.com/111122223333/jobs',
          queueLength: '10',
          awsRegion: 'us-east-1',
        },
        authenticationRef: { name: 'aws-keda', kind: 'ClusterTriggerAuthentication' },
      },
    ],
  },
  id: 'workerScaler',
});
```

| Field | Notes |
|---|---|
| `scaleTargetRef` | `name`, optional `apiVersion`/`kind` (Deployment by default), `envSourceContainerName`; or the workload resource itself (below) |
| `minReplicaCount` / `maxReplicaCount` | `0` / `100` by default. `0` scales to zero while no trigger is active |
| `idleReplicaCount` | Replicas while idle; KEDA only supports `0`, below `minReplicaCount` |
| `pollingInterval`, `cooldownPeriod`, `initialCooldownPeriod` | Seconds; `30`, `300`, `0` by default |
| `fallback` | `failureThreshold` and `replicas` to hold when a scaler keeps failing; `behavior` picks `static`, `currentReplicas`, `currentReplicasIfHigher`, `currentReplicasIfLower` or per-trigger `scalingModifiers` |
| `advanced.horizontalPodAutoscalerConfig` | `name` and `behavior` (`scaleUp`/`scaleDown` stabilization windows and policies) of the HPA KEDA creates |
| `advanced.restoreToOriginalReplicaCount` | Restore the replica count when the ScaledObject is deleted |
| `advanced.scalingModifiers` | Combine triggers into one metric: `formula`, `target`, `activationTarget`, `metricType` |
| `triggers` | At least one (below) |

### Apply order: pass the workload as `scaleTargetRef`

KEDA's webhook rejects a ScaledObject whose target does not exist yet, which matters on the
first deploy, when both are created together. (A server-side dry run skips that check, so it
only shows up on a real apply.) Pass the workload resource itself:

```typescript
const checkout = deployment({ metadata: { name: 'checkout' }, spec: { /* ... */ }, id: 'checkout' });

scaledObject({
  name: 'checkout',
  spec: { scaleTargetRef: checkout, triggers: [/* ... */] },
});
```

The ScaledObject takes the workload's `apiVersion`, `kind` and name, and TypeKro applies it
after the workload, in direct mode and in KRO. With a plain `{ name: 'checkout' }`, nothing
orders the two; `{ name: checkout.metadata.name }` orders them through the reference.

### Triggers

`triggers` is a union typed per scaler. Metadata values are strings, as in the CRD (`threshold:
'20'`). Every trigger takes `name`, `authenticationRef` and `metricType`:

| `type` | Required metadata | Notes |
|---|---|---|
| `prometheus` | `serverAddress`, `query`, `threshold` | `activationThreshold`, `namespace`, `customHeaders`, `authModes`, `ignoreNullValues`, `unsafeSsl`, `timeout` |
| `cpu`, `memory` | `value` | `metricType` is required: `Utilization` (percent of the request) or `AverageValue`. Needs requests on the pods |
| `aws-sqs-queue` | `awsRegion`, and `queueURL` or `queueURLFromEnv` | `queueLength` (per replica), `scaleOnInFlight`, `scaleOnDelayed` |
| `aws-cloudwatch` | `awsRegion`, `targetMetricValue`, `minMetricValue`, and `namespace`/`metricName`/dimensions or `expression` | `metricStat`, `metricStatPeriod`, `ignoreNullValues`, ... |
| `cron` | `timezone`, `start`, `end`, `desiredReplicas` | Holds `desiredReplicas` inside the window |
| `metrics-api` | `url`, `valueLocation`, `targetValue` | `format`, `authMode`, `aggregateFromKubeServiceEndpoints` |
| `postgresql` | `query`, `targetQueryValue` | `connectionFromEnv`, or `host`/`port`/`userName`/`dbName`/`sslmode` with a password from auth |
| `redis` | `listName` | `address` or `host`/`port`, `listLength` (per replica), `enableTLS` |

`metricType` decides how the HPA reads a value. `AverageValue` (the default) divides it by the
current replica count and compares that with the target, so `threshold: '20'` means 20 per pod.
`Value` compares the raw value, which suits ratios and latencies.

For any other scaler, use `kedaTrigger`, which takes free-form metadata:

```typescript
import { kedaTrigger } from 'typekro/keda';

kedaTrigger(
  'kafka',
  { bootstrapServers: 'kafka.messaging.svc:9092', consumerGroup: 'orders', topic: 'orders', lagThreshold: '50' },
  { authenticationRef: { name: 'kafka-auth' } }
);
```

`kedaTrigger` refuses the typed scaler names at compile time, so a typo in a Prometheus trigger's
metadata is still a type error.

### Several triggers, and how KEDA combines them

KEDA hands every trigger to its HPA as a separate metric. The HPA computes the replica count
each metric asks for and uses the **largest**. A second trigger can therefore only add replicas,
never remove them.

[`examples/keda-inflight-scaling.ts`](https://github.com/yehudacohen/typekro/blob/master/examples/keda-inflight-scaling.ts)
scales a checkout API on Prometheus in-flight requests, with p95 latency as a backstop:

```typescript
import { scaledObject } from 'typekro/keda';

const prometheus = 'http://prometheus-operated.monitoring.svc:9090';

scaledObject({
  name: 'checkout',
  spec: {
    scaleTargetRef: { name: 'checkout' },
    minReplicaCount: 2,
    maxReplicaCount: 30,
    triggers: [
      {
        // AverageValue: total in-flight requests / replicas, against 20 per pod.
        type: 'prometheus',
        name: 'inflight',
        metadata: {
          serverAddress: prometheus,
          query: 'sum(http_server_active_requests{service="checkout"})',
          threshold: '20',
        },
      },
      {
        // Value: p95 latency in seconds against 300ms, not divided by pods.
        type: 'prometheus',
        name: 'latency',
        metricType: 'Value',
        metadata: {
          serverAddress: prometheus,
          query:
            'histogram_quantile(0.95, sum(rate(http_server_request_duration_seconds_bucket{service="checkout"}[2m])) by (le))',
          threshold: '0.3',
        },
      },
    ],
  },
});
```

With 4 pods and 120 requests in flight, `inflight` asks for ceil(4 × 30 / 20) = 6 replicas.
With p95 at 450ms, `latency` asks for ceil(4 × 0.45 / 0.3) = 6. The HPA scales to 6. When
latency recovers to 150ms, `latency` asks for 2, but `inflight` still asks for 6, so the
deployment stays at 6.

To express the relationship in one metric instead, use `scalingModifiers`. The formula sees
each named trigger's raw value (here, the in-flight total) and the result is compared with
`target`:

```typescript
advanced: {
  scalingModifiers: {
    formula: 'latency > 0.3 ? inflight * 1.5 : inflight',
    target: '20',
    metricType: 'AverageValue',
  },
},
```

Name every trigger the formula uses. With `fallback.behavior: 'scalingModifiers'`, a failing
trigger reaches the formula as `nil`, so `inflight ?? 40` can supply a default.

### The target must not have its own HPA

KEDA creates and owns an HPA named `keda-hpa-<name>` for the target. Do not declare another
HPA for the same workload: KEDA's webhook rejects a ScaledObject whose target already has one,
and two HPAs would fight over the replica count. `scaledObject` warns when an HPA in the same
composition targets the same workload.

Leave `spec.replicas` unset on the target, as in the example. A replica count in the manifest
is re-applied on every deploy and every KRO reconcile, which resets whatever the HPA chose.
The `deployment` factory takes a spec without `replicas`; `simple.Deployment` always sets one.

### VPA on the same workload

A VerticalPodAutoscaler that sets CPU or memory requests on a workload this ScaledObject scales
on `cpu` or `memory` changes the base the utilization is measured against, and the two
autoscalers chase each other. `scaledObject` warns when such a VPA is declared in the same
composition. Containers without a policy of their own follow the VPA's `'*'` policy, or get both
resources when there is none, so a policy list that only excludes a sidecar still counts. Use the
VPA in `updateMode: 'Off'`, or scale on a metric other than the resource it controls. The `typekro/vpa` factory makes the same check from its side.

## ScaledJob

```typescript
import { scaledJob } from 'typekro/keda';

scaledJob({
  name: 'transcode',
  spec: {
    jobTargetRef: {
      backoffLimit: 2,
      template: {
        spec: { restartPolicy: 'Never', containers: [{ name: 'transcode', image: 'transcoder:1.4' }] },
      },
    },
    maxReplicaCount: 10,
    scalingStrategy: { strategy: 'accurate' },
    triggers: [
      { type: 'redis', metadata: { address: 'redis.queues.svc:6379', listName: 'transcode', listLength: '1' } },
    ],
  },
});
```

`jobTargetRef` is a Kubernetes `JobSpec`. `scalingStrategy`, `rollout`, the history limits and
`pollingInterval` follow the [ScaledJob spec](https://keda.sh/docs/2.21/reference/scaledjob-spec/).

ScaledJob triggers are typed separately (`KedaScaledJobTrigger`): the ScaledJob CRD has no
`metricType`, and Jobs are not scaled on `cpu` or `memory`. `scalingStrategy.multipleScalersCalculation`
decides how several triggers combine.

## Trigger authentication

```typescript
import { clusterTriggerAuthentication, triggerAuthentication } from 'typekro/keda';

// A bearer token from a Secret, for `authModes: 'bearer'` on a prometheus trigger.
triggerAuthentication({
  name: 'prometheus-auth',
  namespace: 'shop',
  spec: { secretTargetRef: [{ parameter: 'bearerToken', name: 'prometheus-reader', key: 'token' }] },
});

// AWS scalers in every namespace, as the KEDA operator.
clusterTriggerAuthentication({ name: 'aws-keda', spec: { podIdentity: { provider: 'aws' } } });
```

| Field | Source of the trigger parameter |
|---|---|
| `secretTargetRef` | A Secret key. For a ClusterTriggerAuthentication, the Secret lives in the KEDA namespace |
| `configMapTargetRef` | A ConfigMap key |
| `env` | An environment variable of the scale target's container |
| `podIdentity` | `aws`, `azure-workload` or `gcp` workload identity (`roleArn`, `identityOwner`, `identityId`, ...) |
| `boundServiceAccountToken` | A token for the named ServiceAccount |
| `filePath` | A file mounted into the operator |
| `hashiCorpVault`, `azureKeyVault`, `azureServicePrincipal`, `awsSecretManager`, `gcpSecretManager`, `oauth2` | Untyped, passed through as written; see [Authentication](https://keda.sh/docs/2.21/concepts/authentication/) |

`podIdentity` also takes `externalID` for an `aws` `roleArn` whose trust policy requires one.

Reference a cluster-scoped one with `authenticationRef: { name, kind: 'ClusterTriggerAuthentication' }`.

## Readiness and status

`scaledObject` and `scaledJob` are ready on `Ready=True`: KEDA built the scalers and, for a
ScaledObject, the HPA. `Active=False` is the normal idle state of a workload scaled to zero, so it
does not hold readiness back; the readiness message says `active` or `idle`, and notes fallback
and pause. Trigger authentications are ready once stored.

| State | Ready | Reason |
|---|---|---|
| No `Ready` condition, or `Unknown` | no | `StatusMissing` (is the operator running?) |
| `Ready=False` | no | the condition's reason, e.g. `ScaledObjectCheckFailed` |
| `Ready=True` | yes | `Ready` |

ScaledObject status also carries `hpaName`, `externalMetricNames`, `health` per trigger and
`triggersActivity`. In a composition's status:

```typescript
return { ready: kedaReady(scaler), active: kedaActive(scaler), hpa: scaler.status.hpaName };
```

## Validation

The factories throw on mistakes KEDA rejects and log warnings for legal but risky settings. The
validators return both. Values only known at reconcile time are skipped.

| Check | Severity |
|---|---|
| No triggers; a trigger name used twice | error |
| `minReplicaCount` above `maxReplicaCount` (100 when unset); `idleReplicaCount` not below `minReplicaCount` | error |
| `idleReplicaCount` other than `0` (KEDA documents 0 as the only value that works, an HPA limitation); `idleReplicaCount: 0` with `minReplicaCount` unset (an explicit `minReplicaCount: 0` is fine, as in KEDA's webhook) | error |
| Values below the CRD minimums: `pollingInterval` or `maxReplicaCount` below 1, negative cooldowns, `minReplicaCount`, `fallback.failureThreshold`/`replicas` or ScaledJob history limits | error |
| `useCachedMetrics` on a `cpu`, `memory` or `cron` trigger; `scalingModifiers` without a `formula`, or with a `target` that is not a number above 0 | error |
| A ScaledObject name over 63 characters, or over 54 without `advanced.horizontalPodAutoscalerConfig.name` (KEDA's webhook caps the generated `keda-hpa-<name>` at 63); an explicit HPA name over 63 characters or not a DNS-1123 subdomain; a ScaledJob name over 63 characters (a label value on every Job) | error |
| Only `cpu`/`memory` triggers with `minReplicaCount` 0 (they cannot scale from zero) | error |
| `metricType: 'Value'` on `cpu`/`memory`; `Utilization` on any other trigger | error |
| `scalingModifiers` without a `target`; `fallback.behavior: 'scalingModifiers'` without a formula | error |
| An unnamed trigger under a `scalingModifiers` formula | warning |
| `fallback` with only `cpu`/`memory` triggers and no `scalingModifiers` (KEDA's webhook rejects it) | error |
| `fallback` with some `cpu`/`memory` triggers (fallback ignores them) | warning |
| A ScaledJob trigger on `cpu`/`memory` or with `metricType` | error |
| An HPA on the same target in the composition; a VPA there setting a resource a trigger uses | warning |
| Bootstrap with the webhooks off, a PDB that blocks every eviction, or IRSA without a role | warning |

## Example

[`examples/keda-inflight-scaling.ts`](https://github.com/yehudacohen/typekro/blob/master/examples/keda-inflight-scaling.ts)
installs KEDA and scales a Deployment on in-flight requests per pod with a latency backstop,
both as two triggers and as one `scalingModifiers` formula.

## See also

- [KEDA documentation](https://keda.sh/docs/2.21/)
- [ScaledObject spec](https://keda.sh/docs/2.21/reference/scaledobject-spec/)
- [Scalers](https://keda.sh/docs/2.21/scalers/)
- [Authentication](https://keda.sh/docs/2.21/concepts/authentication/)
