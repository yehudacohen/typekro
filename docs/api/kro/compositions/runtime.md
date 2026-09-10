# TypeKro Runtime Bootstrap

Deploy the Kro controller and Flux CD with a single TypeKro composition.

## When You Need This

The runtime bootstrap is required when you want to use **Kro mode** deployment, which provides:

- Runtime CEL expression evaluation
- Continuous status reconciliation
- Cross-resource references resolved against live cluster state

If you only use **Direct mode**, you don't need the runtime bootstrap.

## Quick Start

```typescript
import { typeKroRuntimeBootstrap } from 'typekro';

const runtime = typeKroRuntimeBootstrap();

const factory = runtime.factory('direct', {
  namespace: 'flux-system',
  waitForReady: true,
  timeout: 300000  // 5 minutes - controllers take time to start
});

await factory.deploy({ namespace: 'flux-system' });
```

## What Gets Deployed

The bootstrap deploys:

1. **Flux CD** - GitOps toolkit (source-controller, helm-controller, etc.)
2. **Kro Controller** - ResourceGraphDefinition controller
3. **Required RBAC** - ClusterRoleBindings for controllers
4. **Namespaces** - `flux-system` and `kro-system`
5. **Label-propagation guard** - a `MutatingAdmissionPolicy` that stops anything
   other than Kro from introducing Kro's ownership labels on an object

## Label-Propagation Guard

Many operators copy the entire label map of the custom resource they reconcile
onto the children they create. When that CR is a node in a Kro graph, the
children inherit Kro's ApplySet labels, and Kro's pruner then deletes objects it
never applied — on every requeue, with the instance stuck `InProgress` and no
error anywhere.

The bootstrap installs a cluster-scoped `MutatingAdmissionPolicy` that enforces
the opposite invariant: **only Kro may introduce Kro's ownership labels.**

- **CREATE** by anyone other than the Kro controller: each label in
  `KRO_OWNERSHIP_LABELS` is removed if present.
- **UPDATE** by anyone other than the Kro controller: a label is removed only if
  it is *absent from the old object*. Labels Kro already placed are never
  touched, so Flux patching a HelmRelease, an HPA scaling a Deployment, or a
  human annotating an object are all left alone.

The same rule covers a Service's `spec.selector` and a workload's pod-template
labels, so the guard can never create a selector mismatch. `failurePolicy` is
`Ignore`: a guard that cannot evaluate must never block a write.

There is **no configuration option**. The guard is a floor, not a feature.

### Status

`status.labelPropagationGuard` is `'active'` when the policy is installed and
`'unavailable'` when it is not, so operator factories and e2e suites can branch
on it.

### How the group version is resolved

`MutatingAdmissionPolicy` is beta from Kubernetes 1.34
(`admissionregistration.k8s.io/v1beta1`) and GA from 1.36
(`admissionregistration.k8s.io/v1`); a given API server serves one or the
other, never both, and nothing below 1.34 serves the kind at all. TypeKro
therefore **never assumes** a group version — it is discovered from the target
cluster, or the guard is not emitted.

Direct mode does this for you. Before it materializes the graph, the direct
deployment path runs API discovery for `admissionregistration.k8s.io` against
the cluster it is deploying to and builds the guard at the version that cluster
actually serves:

```typescript
import { typeKroRuntimeBootstrap } from 'typekro';

const runtime = typeKroRuntimeBootstrap();
const factory = await runtime.factory('direct', { namespace: 'flux-system' });

// Discovery runs here. On 1.36+ the policy is applied as
// admissionregistration.k8s.io/v1; on 1.34/1.35 as .../v1beta1; on anything
// older the guard is skipped with a warning and
// status.labelPropagationGuard reports 'unavailable'.
await factory.deploy({ namespace: 'flux-system' });
```

The answer is cached per **cluster** — server URL, CA material and context
cluster name — with a bounded lifetime, so a process that talks to two clusters
never reuses one cluster's answer for the other. `resetLabelGuardCapabilityCache()`
clears it, which is what tests want between fixtures.

Resolution order, highest precedence first:

| Input | Result |
|-------|--------|
| `TYPEKRO_DISABLE_LABEL_GUARD=1` | Break-glass. Nothing is emitted; `status.labelPropagationGuard` is `'unavailable'`. |
| `TYPEKRO_LABEL_GUARD_API_VERSION` | Used verbatim, e.g. `admissionregistration.k8s.io/v1beta1`. No cluster is contacted. |
| A capability scoped to this build, or resolved for the deployment's target cluster | The served group version — `.../v1` or `.../v1beta1`. |
| The cluster serves neither | Skipped, with a warning naming the versions asked for; status `'unavailable'`. |
| Discovery against the cluster **failed** — unreachable, RBAC, timeout, TLS | Skipped, with a warning saying discovery failed; status `'unavailable'`. |
| Nothing above — no pin, no cluster | Skipped, with a warning; status `'unavailable'`. |

The last three rows all end in `'unavailable'`, but they are not the same
problem and the warning says which. "The cluster does not serve
`MutatingAdmissionPolicy`" is a statement about the cluster, and it is only made
when the API server actually answered — a 404 for the group version, or a
resource list without the kind. If the probe could not reach the server or was
refused by RBAC, nothing is known about the cluster, so the guard reports a
*discovery failure* instead, which points at the credentials or the network
rather than at the cluster's version. A failed probe is also not cached as an
answer: the next deployment re-probes instead of repeating a guess for five
minutes.

The "no pin, no cluster" row is the case that matters for a build with no
cluster connection: the guard is **not** emitted at a guessed GA version,
because a `.../v1` policy applied to a 1.34 cluster fails the apply of the whole
runtime bootstrap.

You can resolve the capability yourself when you build a graph outside a
deployment — a GitOps render aimed at a known cluster. Probe, then build inside
the capability's scope:

```typescript
import {
  probeLabelPropagationGuardSupport,
  typeKroRuntimeBootstrap,
  withLabelPropagationGuardCapability,
} from 'typekro';

// Ask that cluster once, then build with the answer carried explicitly.
const capability = await probeLabelPropagationGuardSupport(kubeConfig);
const runtime = withLabelPropagationGuardCapability(capability, () =>
  typeKroRuntimeBootstrap()
);
```

The capability has to be carried into the build, because probing a cluster does
not make it ambiently current. A build outside any scope targets no cluster and
gets no cluster's answer — deliberately: an implicit "last cluster anyone
probed" would render one cluster's group version into another cluster's graph
as soon as a process talks to more than one. Inside `factory('direct').deploy()`
none of this is your problem; the deployment publishes its own target for the
duration of the deploy, and concurrent deploys to different clusters stay
independent.

### Kro mode and offline renders

`toYaml()` and Kro-mode rendering have no cluster to ask, so they follow the
same rule: with no pin, the guard is left out of the rendered
ResourceGraphDefinition and the status projects `'unavailable'` — a rendered
manifest never carries an unverified group version. Set
`TYPEKRO_LABEL_GUARD_API_VERSION` to the version your target cluster serves to
render the guard into a GitOps artifact.

In practice the runtime bootstrap is deployed in **direct** mode — it is what
installs Kro, so there is no Kro controller yet to reconcile it — which is why
direct mode is the path that resolves the capability from the cluster.

When the guard is skipped, the two alternatives are the operator's own
propagation filter (configured from `KRO_OWNERSHIP_LABELS`) and isolating the CR
in its own single-kind ResourceGraphDefinition via `singleton()`. See
[Creating TypeKro Integrations](/advanced/integration-skill) for the full
decision order.

### Migration

Operator children that already carry the labels self-heal: where they are in a
prune scope Kro prunes them once, the operator recreates them, and the create is
stripped. Elsewhere they are harmless. There is no cleanup job — expect a
minute of churn the first time the guard is installed on a cluster that has been
running without it.

## Configuration

```typescript
interface TypeKroRuntimeConfig {
  namespace?: string;     // Target namespace (default: 'flux-system')
  fluxVersion?: string;   // Flux version (default: 'v2.7.5')
  kroVersion?: string;    // Kro version (default: '0.9.2')
  rbac?: RbacMode;        // Flux controller RBAC mode (default: 'cluster-admin')
}

type RbacMode = 'cluster-admin' | 'scoped' | { clusterRoleRef: string };
```

TypeKro requires KRO `0.9.2+` because generated ResourceGraphDefinitions use the `omit()` CEL function behind the `CELOmitFunction` feature gate.

`rbac` controls the permissions granted to Flux controllers:

| Value | Description |
|-------|-------------|
| `'cluster-admin'` | Default. Binds Flux controllers to the built-in `cluster-admin` ClusterRole for maximum compatibility |
| `'scoped'` | Creates a narrower ClusterRole with the permissions TypeKro's bundled controllers need |
| `{ clusterRoleRef: string }` | Binds Flux controllers to a pre-existing ClusterRole you manage |

### Example with Custom Versions

```typescript
const runtime = typeKroRuntimeBootstrap({
  namespace: 'flux-system',
  fluxVersion: 'v2.7.5',
  kroVersion: '0.9.2',
  rbac: 'scoped',
});
```

## Status

The composition provides status on component readiness:

```typescript
interface TypeKroRuntimeStatus {
  phase: 'Pending' | 'Installing' | 'Ready' | 'Failed' | 'Upgrading';
  components: {
    fluxSystem: boolean;
    kroSystem: boolean;
  };
  labelPropagationGuard: 'active' | 'unavailable';
}
```

## After Bootstrap

Once the runtime is deployed, you can use Kro mode:

```typescript
// Now Kro mode works
const factory = myComposition.factory('kro', { namespace: 'production' });
await factory.deploy({ name: 'my-app', image: 'nginx' });
```

## Verifying Installation

```bash
# Check Flux controllers
kubectl get pods -n flux-system

# Check Kro controller
kubectl get pods -n kro-system

# Check the label-propagation guard
kubectl get mutatingadmissionpolicy typekro-kro-label-propagation-guard

# Check ResourceGraphDefinitions
kubectl get rgd -A
```

## Troubleshooting

### Controllers Not Starting

```bash
# Check Flux controller logs
kubectl logs -n flux-system deployment/helm-controller

# Check Kro controller logs
kubectl logs -n kro-system deployment/kro-controller-manager
```

### CRD Validation Errors

The bootstrap includes fixes for Kubernetes 1.33+ CRD schema validation. If you see validation errors, ensure you're using the latest TypeKro version.

## Next Steps

- [Deployment Modes](/guide/deployment-modes) - Direct vs Kro comparison
- [Kro Overview](/api/kro/) - ResourceGraphDefinition details
