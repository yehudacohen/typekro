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

### Clusters without the API

`MutatingAdmissionPolicy` is beta from Kubernetes 1.34
(`admissionregistration.k8s.io/v1beta1`) and GA from 1.36
(`admissionregistration.k8s.io/v1`); a given API server serves one or the
other, never both. A composition is built synchronously with no cluster
connection, so the group version is settled before the graph is rendered:

```typescript
import { probeLabelPropagationGuardSupport, typeKroRuntimeBootstrap } from 'typekro';

// Ask the cluster once, then build. Only needed when the target may predate
// 1.36 — with no probe the bootstrap assumes the GA group version.
await probeLabelPropagationGuardSupport(kubeConfig);
const runtime = typeKroRuntimeBootstrap();
```

Two environment variables, both read at build time:

| Variable | Effect |
|----------|--------|
| `TYPEKRO_DISABLE_LABEL_GUARD=1` | Break-glass. Builds the bootstrap without the guard and reports `status.labelPropagationGuard: 'unavailable'`. Use it only when the policy misbehaves on a specific cluster. |
| `TYPEKRO_LABEL_GUARD_API_VERSION` | Pins the group version, e.g. `admissionregistration.k8s.io/v1beta1` for a 1.34/1.35 cluster or an offline `toYaml()` render. |

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
