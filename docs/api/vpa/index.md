---
title: Vertical Pod Autoscaler
description: Install the Kubernetes Vertical Pod Autoscaler with Flux and declare typed VerticalPodAutoscalers
---

# Vertical Pod Autoscaler

`typekro/vpa` installs the [Vertical Pod Autoscaler](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler)
(VPA) through Flux and gives you a typed factory for its API:

- `verticalPodAutoscaler`: `autoscaling.k8s.io/v1` `VerticalPodAutoscaler`, which recommends
  CPU and memory requests for a workload and, depending on its mode, applies them
- `vpaRecommendOnly`: the same in `updateMode: 'Off'`, which records recommendations and changes
  nothing

Verified against the Fairwinds `vpa` chart **5.1.0** (VPA **1.7.1**,
`https://charts.fairwinds.com/stable`).

## Import

```typescript
import { verticalPodAutoscaler, vpaBootstrap, vpaRecommendOnly } from 'typekro/vpa';
```

`typekro/vpa` is a subpath export only; it is not re-exported from `typekro`.

## Quick example

```typescript
import { vpaBootstrap } from 'typekro/vpa';

const factory = vpaBootstrap.factory('direct', { namespace: 'flux-system', waitForReady: true });

// Recommend only: no evictions and no webhook.
await factory.deploy({
  name: 'vpa',
  updater: { enabled: false },
  admissionController: { enabled: false },
});
```

`'direct'` applies the resources immediately. `'kro'` emits a ResourceGraphDefinition and lets
KRO reconcile it. Both produce the same `HelmRelease`.

## Available factories

| Export | Kind | Scope | Description |
|---|---|---|---|
| `vpaBootstrap` | Composition | Cluster | Recommender, updater and admission controller |
| `makeVpaBootstrap(options)` | Composition | Cluster | The same, with build-time options |
| `vpaHelmRepositoryBootstrap` | Composition | Singleton | Shared Fairwinds `HelmRepository` owner |
| `verticalPodAutoscaler` | VerticalPodAutoscaler | Namespace | Typed `autoscaling.k8s.io/v1` VPA |
| `vpaRecommendOnly(target, options)` | VerticalPodAutoscaler | Namespace | An `Off`-mode VPA for a `targetRef` or a workload resource |
| `vpaRecommendationProvided(...vpas)` | Status helper | — | `true` once every VPA has a recommendation |
| `vpaHelmRepository`, `vpaHelmRelease` | Flux | Namespace | The Helm resources the bootstrap uses |
| `validateVerticalPodAutoscalerSpec`, `validateVpaBootstrapConfig`, `findVpaAutoscalerConflicts` | Validators | — | Common-mistake checks (below) |

## Chart choice

There are two maintained charts. The bootstrap uses the Fairwinds `vpa` chart, the
long-standing community chart that most clusters run. The `vertical-pod-autoscaler` chart in
[kubernetes/autoscaler](https://github.com/kubernetes/autoscaler/tree/master/charts/vertical-pod-autoscaler)
(0.13.0, VPA 1.8.0) is newer and tracks VPA releases sooner, but its README still says it is
under development and not ready for production use. Pin a different Fairwinds `version` to move
within that chart; the values below are for 5.1.0.

## Bootstrap composition

### Components

| Component | What it does | Needed for |
|---|---|---|
| Recommender | Watches usage and writes `status.recommendation` | every mode |
| Updater | Evicts, or resizes in place, pods whose requests are far from the recommendation | `Recreate`, `InPlaceOrRecreate`, `InPlace` |
| Admission controller | Mutating webhook that writes recommended requests into new pods | `Initial`, `Recreate`, `InPlaceOrRecreate` |

Each is switched with `<component>.enabled`. A recommend-only install, where every VPA uses
`updateMode: 'Off'`, needs only the recommender. The VPA reads usage from `metrics.k8s.io`:
install metrics-server first, or set `metricsServer.enabled` to install the chart's bundled
subchart.

### Runtime spec

| Field | Chart value | Default |
|---|---|---|
| `name` | release name, `fullnameOverride` | required |
| `namespace` | install namespace | `vpa` |
| `version` | chart version | `5.1.0` |
| `<component>.enabled` | `<component>.enabled` | `true` |
| `<component>.replicas` | `<component>.replicaCount` | `1` |
| `<component>.resources` | `<component>.resources`, merged by Helm with the chart's | requests 50m / 500Mi (recommender, updater), 50m / 200Mi (admission controller) |
| `<component>.podDisruptionBudget` | `<component>.podDisruptionBudget` (rendered only above 1 replica) | `{ maxUnavailable: 1 }` |
| `<component>.nodeSelector`, `.tolerations`, `.affinity` | placement | none |
| `priorityClassName` | every component | none |
| `serviceAccountAnnotations` | every component's ServiceAccount | none |
| `metricsServer.enabled` | `metrics-server.enabled` | `false` |

`<component>` is `recommender`, `updater` or `admissionController`. The chart grants the
recommender and updater no leader-election lease, so keep them at one replica; extra replicas
would work in parallel. The admission controller is stateless and can run more.

### Recommender flags

Every flag is rendered, with its default when unset, so the Deployment shows the full
configuration.

| Field | Flag | Default |
|---|---|---|
| `logLevel` | `--v` | `4` |
| `podRecommendationMinCpuMillicores` | `--pod-recommendation-min-cpu-millicores` | `15` (chart) |
| `podRecommendationMinMemoryMb` | `--pod-recommendation-min-memory-mb` | `100` (chart) |
| `targetCpuPercentile` | `--target-cpu-percentile` | `0.9` |
| `targetMemoryPercentile` | `--target-memory-percentile` | `0.9` |
| `recommendationMarginFraction` | `--recommendation-margin-fraction` | `0.15` |
| `cpuHistogramDecayHalfLife`, `memoryHistogramDecayHalfLife` | `--*-histogram-decay-half-life` | `24h` |
| `memoryAggregationInterval`, `memoryAggregationIntervalCount` | `--memory-aggregation-interval*` | `24h`, `8` (an 8-day memory window) |
| `storage` | `--storage` | `checkpoint` |
| `historyLength`, `prometheusAddress` | `--history-length`, `--prometheus-address` (used with `storage: 'prometheus'`) | `8d`, `http://prometheus.monitoring.svc` |
| `recommenderName` | `--recommender-name` | `default` |

With checkpoint storage the recommender keeps its own history in
`VerticalPodAutoscalerCheckpoint` objects and starts from scratch on a new cluster. With
Prometheus storage it reads up to `historyLength` of past usage on start.

The updater takes `minReplicas` (`--min-replicas`, default `2`: it does not evict a workload
with fewer live replicas) and `evictionTolerance` (`--eviction-tolerance`, default `0.5`).
Other flags go through the build-time `values`, as `<component>.extraArgs` entries:

```typescript
import { makeVpaBootstrap } from 'typekro/vpa';

const vpa = makeVpaBootstrap({
  values: { updater: { extraArgs: { 'in-place-skip-disruption-budget': true } } },
});
```

### Admission controller certificate

The webhook needs a serving certificate. By default (`certificate.generate: true`) the chart's
`kube-webhook-certgen` hook Jobs create the Secret `<name>-tls-secret` and patch the CA bundle
into the `MutatingWebhookConfiguration`.

To use cert-manager instead, issue a Certificate for `<name>-webhook.<namespace>.svc`, point the
controller at its Secret and let cainjector fill the CA bundle:

```typescript
import { VPA_CERT_MANAGER_TLS_SECRET_KEYS, makeVpaBootstrap } from 'typekro/vpa';

await makeVpaBootstrap({
  // Reload the certificate when cert-manager renews it.
  values: { admissionController: { extraArgs: { 'reload-cert': true } } },
})
  .factory('direct', { namespace: 'flux-system' })
  .deploy({
    name: 'vpa',
    admissionController: {
      certificate: {
        generate: false,
        secretName: 'vpa-webhook-tls',
        secretKeys: [...VPA_CERT_MANAGER_TLS_SECRET_KEYS],
      },
      webhook: { annotations: { 'cert-manager.io/inject-ca-from': 'vpa/vpa-webhook-tls' } },
    },
  });
```

`webhook.failurePolicy` defaults to `Ignore`: if the webhook is down, pods start with the
requests in their manifest. `webhook.namespaceSelector` and `objectSelector` limit which pods it
sees.

### Build-time options

| Option | Default | Effect |
|---|---|---|
| `namespaceOwnership` | `'external'` | `'external'` lets Flux create a missing namespace; `'owned'` makes it part of the graph |
| `values` | none | Raw chart values, deep-merged last (objects merge, lists replace) |
| `name`, `kind` | `vpa-bootstrap`, `VpaBootstrap` | RGD name and kind |

### CRDs

The chart ships the CRDs in `crds/`, which Helm installs but never upgrades. The `HelmRelease`
sets `install.crds` and `upgrade.crds` to `CreateReplace`, so Flux replaces them on every chart
upgrade. Helm never deletes `crds/` CRDs, so uninstalling the bootstrap keeps every VPA object.
The chart's ClusterRoles have fixed names (`vpa-actor`, ...), so install one bootstrap per
cluster.

### Teardown

Removing the bootstrap uninstalls the release, but two objects the components create at run time
stay in the install namespace: the certgen Secret `<name>-tls-secret` and the admission
controller's leader Lease. Delete the namespace afterwards to remove them.

### Status

| Field | Source |
|---|---|
| `ready` | `HelmRelease` `Ready=True` for its current generation |
| `failed` | `HelmRelease` `Ready=False` for its current generation |
| `phase` | `Ready`, `Installing` or `Failed` |
| `version` | Chart version Flux installed (`status.history`), `''` until then |

## VerticalPodAutoscaler

```typescript
import { verticalPodAutoscaler } from 'typekro/vpa';

verticalPodAutoscaler({
  name: 'worker',
  namespace: 'jobs',
  spec: {
    targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'worker' },
    updatePolicy: { updateMode: 'InPlaceOrRecreate', minReplicas: 2 },
    resourcePolicy: {
      containerPolicies: [
        {
          containerName: '*',
          minAllowed: { cpu: '100m', memory: '128Mi' },
          maxAllowed: { cpu: '2', memory: '4Gi' },
          controlledValues: 'RequestsOnly',
        },
        { containerName: 'log-shipper', mode: 'Off' },
      ],
    },
  },
  id: 'workerVpa',
});
```

| Field | Notes |
|---|---|
| `targetRef` | `kind` and `name` of a Deployment, StatefulSet, DaemonSet, Job, CronJob, ReplicaSet or any resource with a `scale` subresource |
| `updatePolicy.updateMode` | `Off`, `Initial`, `Recreate` (CRD default), `InPlaceOrRecreate`, `InPlace`; `Auto` is a deprecated alias of `Recreate` |
| `updatePolicy.minReplicas` | Overrides the updater's `--min-replicas` for this VPA |
| `updatePolicy.evictionRequirements` | Only evict when the target moved up (`TargetHigherThanRequests`) or down |
| `resourcePolicy.containerPolicies` | Per container (`'*'` for all): `mode`, `minAllowed`, `maxAllowed`, `controlledResources` (`cpu`, `memory`), `controlledValues` (`RequestsAndLimits` keeps the limit/request ratio, `RequestsOnly` leaves limits alone) |
| `recommenders` | At most one recommender name; the default recommender when empty |

`InPlaceOrRecreate` and `InPlace` resize running pods, which needs in-place pod resize in the
cluster (beta from Kubernetes 1.33, on by default). `InPlace` never evicts. In VPA 1.7 it is behind
the `InPlace` feature gate: without it the admission webhook rejects the VPA. Enable it on the
admission controller and the updater:

```typescript
import { makeVpaBootstrap } from 'typekro/vpa';

const gate = { 'feature-gates': 'InPlace=true' };
const vpa = makeVpaBootstrap({
  values: { admissionController: { extraArgs: gate }, updater: { extraArgs: gate } },
});
```

`vpaRecommendOnly` takes a `targetRef` or the workload resource itself:

```typescript
import { simple } from 'typekro';
import { vpaRecommendOnly } from 'typekro/vpa';

const api = simple.Deployment({ name: 'api', image: 'nginx', id: 'api' });
vpaRecommendOnly(api, { id: 'apiVpa' }); // name 'api', updateMode 'Off'
```

## Readiness and status

A VPA is ready when its `RecommendationProvided` condition is `True`. That needs a running
recommender, metrics, and pods of the target that have run for a while, typically a minute or
two. Pass `readiness: 'accepted'` to be ready as soon as the API server has stored the object,
for example when the workload is created in the same deploy, or deploy with
`waitForReady: false`.

| State | Ready | Reason |
|---|---|---|
| No conditions yet | no | `StatusMissing` (is the recommender running?) |
| `NoPodsMatched=True` | no | `NoPodsMatched` |
| `ConfigUnsupported=True` | no | `ConfigUnsupported` |
| `RecommendationProvided=True` | yes | `RecommendationProvided` |
| otherwise | no | `RecommendationPending` |

`status.recommendation.containerRecommendations[]` carries `target`, `lowerBound`, `upperBound`
and `uncappedTarget` (the target before `minAllowed`/`maxAllowed`) per container. In a
composition's status, use `vpaRecommendationProvided(...)` rather than joining checks with `&&`:

```typescript
return { recommended: vpaRecommendationProvided(apiVpa, workerVpa) };
```

## VPA and HPA together

Do not let a VPA and a HorizontalPodAutoscaler act on the same resource of the same workload.
An HPA scaling on CPU utilization divides usage by the CPU request; a VPA that changes that
request changes the HPA's input, and the two chase each other. A KEDA `ScaledObject` creates an
HPA, so the same applies to its `cpu` and `memory` triggers.

Safe combinations:

- the VPA in `updateMode: 'Off'` (`vpaRecommendOnly`), for recommendations only
- the VPA limited with `controlledResources: ['memory']` while the HPA scales on CPU
- the HPA scaling on a custom or external metric (requests per second, queue depth) rather than
  CPU or memory

`verticalPodAutoscaler` checks the other resources already declared in the same composition and
logs a warning when an `autoscaling` HPA or a `keda.sh` ScaledObject scales its target on a
resource the VPA sets. Autoscalers created elsewhere, or targets named by a schema reference,
are not visible to the check. `findVpaAutoscalerConflicts(spec, namespace)` returns the same
findings.

## Validation

`verticalPodAutoscaler` throws on mistakes the VPA rejects and logs warnings for legal but risky
settings. The validators return both. Values only known at reconcile time are skipped.

| Check | Severity |
|---|---|
| `targetRef` without `kind` or `name` | error |
| More than one entry in `recommenders` | error |
| Two container policies for the same `containerName` | error |
| `updateMode: 'Auto'` (deprecated) | warning |
| `updateMode: 'InPlace'` (needs the `InPlace` feature gate) | warning |
| `controlledResources: []` | warning |
| An HPA or ScaledObject in the composition on the same target and resource | warning |
| Bootstrap with the recommender off, the updater on without the admission controller, more than one recommender or updater replica, or Prometheus storage without an address | warning |

## Example

[`examples/vpa-rightsizing.ts`](https://github.com/yehudacohen/typekro/blob/master/examples/vpa-rightsizing.ts)
installs the recommender only, gives a CPU-scaled Deployment a recommend-only VPA next to its
HPA, and lets a second Deployment's VPA resize it in place within bounds.

## See also

- [VPA documentation](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler/docs)
- [Recommender, updater and admission controller flags](https://github.com/kubernetes/autoscaler/blob/vertical-pod-autoscaler-1.7.1/vertical-pod-autoscaler/docs/flags.md)
- [Fairwinds `vpa` chart](https://github.com/FairwindsOps/charts/tree/master/stable/vpa)
