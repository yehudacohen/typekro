# Migration Guide

Migrate to TypeKro from existing infrastructure tools incrementally.

## From Raw YAML

Use `YamlFile()` to include existing manifests while adding new TypeKro resources:

```typescript
import { kubernetesComposition } from 'typekro';
import { Service, YamlFile } from 'typekro/simple';
import { type } from 'arktype';

const app = kubernetesComposition({
  name: 'migrated-app',
  apiVersion: 'example.com/v1',
  kind: 'MigratedApp',
  spec: type({ name: 'string' }),
  status: type({ ready: 'boolean' })
}, (spec) => {
  // Include existing YAML - no changes needed
  YamlFile('./k8s/existing-deployment.yaml');

  // Add new TypeKro resources alongside
  const service = Service({
    id: 'svc',
    name: spec.name,
    selector: { app: spec.name },
    ports: [{ port: 80 }]
  });

  return { ready: true };
});
```

Migrate incrementally:
1. Start by wrapping existing YAML with `YamlFile()`
2. Add new resources using TypeKro factories
3. Gradually replace YAML files with TypeKro equivalents

## From Helm

### Option 1: Replace Helm Templates

Convert Helm templates to type-safe TypeKro:

```typescript
// Before: values.yaml + templates/deployment.yaml
// After: Pure TypeScript

import { kubernetesComposition } from 'typekro';
import { Deployment } from 'typekro/simple';
import { type } from 'arktype';

const app = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: type({
    name: 'string',
    replicas: 'number',
    image: 'string'
  }),
  status: type({ ready: 'boolean' })
}, (spec) => {
  const deploy = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    replicas: spec.replicas
  });

  return { ready: deploy.status.readyReplicas > 0 };
});
```

### Option 2: Keep Existing Charts

Use `helmRelease()` to deploy existing Helm charts with type-safe values:

```typescript
import { kubernetesComposition, helmRelease, helmRepository } from 'typekro';
import { type } from 'arktype';

const app = kubernetesComposition({
  name: 'nginx-app',
  apiVersion: 'example.com/v1',
  kind: 'NginxApp',
  spec: type({ replicas: 'number' }),
  status: type({ ready: 'boolean' })
}, (spec) => {
  const repo = helmRepository({
    id: 'bitnami',
    name: 'bitnami',
    url: 'https://charts.bitnami.com/bitnami'
  });

  const release = helmRelease({
    id: 'nginx',
    name: 'nginx',
    chart: {
      repository: 'https://charts.bitnami.com/bitnami',
      name: 'nginx'
    },
    values: {
      replicaCount: spec.replicas  // Type-safe values from spec
    }
  });

  return { ready: true };
});
```

## From CDK8s

Replace CDK8s constructs with TypeKro factories:

```typescript
// Before (CDK8s):
// new KubeDeployment(this, 'deployment', {
//   spec: { replicas: 3, ... }
// });

// After (TypeKro):
import { Deployment } from 'typekro/simple';

const deploy = Deployment({
  id: 'deployment',
  name: 'my-app',
  image: 'nginx',
  replicas: 3
});
```

Key differences from CDK8s:
- No construct tree - resources auto-register in composition context
- Runtime references via CEL expressions (not just deploy-time)
- Direct deployment without synth step
- Status expressions for runtime state

## From Pulumi

Replace Pulumi resources with TypeKro:

```typescript
// Before (Pulumi):
// const deployment = new k8s.apps.v1.Deployment(...);
// export const ip = deployment.status.loadBalancer.ingress[0].ip;

// After (TypeKro):
import { kubernetesComposition } from 'typekro';
import { Service } from 'typekro/simple';

const app = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: type({ name: 'string' }),
  status: type({ ip: 'string' })
}, (spec) => {
  const svc = Service({
    id: 'svc',
    name: spec.name,
    type: 'LoadBalancer',
    ports: [{ port: 80 }]
  });

  return {
    ip: svc.status.loadBalancer.ingress[0].ip  // ingress[0] is valid in CEL — Enhanced types are NonOptional in status builder context
  };
});
```

Key differences from Pulumi:
- Stateless - no state backend required
- GitOps-ready YAML output via `toYaml()`
- Runtime references via CEL (evaluated by Kro, not at deploy-time)
- No provider configuration needed

## Between TypeKro APIs

TypeKro has two composition APIs: `kubernetesComposition` (recommended) and `toResourceGraph` (advanced). Here's how to migrate between them.

### From `toResourceGraph` to `kubernetesComposition`

Most compositions should use `kubernetesComposition`. To migrate:

```typescript
// Before: toResourceGraph (separate builders, explicit CEL)
import { toResourceGraph, Cel, createDeployment, createService } from 'typekro';

const app = toResourceGraph(
  { name: 'app', apiVersion: 'example.com/v1', kind: 'App',
    spec: type({ name: 'string', replicas: 'number' }),
    status: type({ ready: 'boolean', url: 'string' }) },
  (schema) => ({
    deploy: createDeployment({ name: schema.spec.name, replicas: schema.spec.replicas }),
    svc: createService({ name: schema.spec.name, ports: [{ port: 80 }] }),
  }),
  (_schema, resources) => ({
    ready: Cel.expr<boolean>(resources.deploy.status.readyReplicas, ' > 0'),
    url: Cel.template('http://%s', resources.svc.status.clusterIP),
  })
);

// After: kubernetesComposition (single function, natural JS)
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

const app = kubernetesComposition(
  { name: 'app', apiVersion: 'example.com/v1', kind: 'App',
    spec: type({ name: 'string', replicas: 'number' }),
    status: type({ ready: 'boolean', url: 'string' }) },
  (spec) => {
    const deploy = Deployment({ id: 'deploy', name: spec.name, replicas: spec.replicas });
    const svc = Service({ id: 'svc', name: spec.name, ports: [{ port: 80 }] });

    return {
      ready: deploy.status.readyReplicas > 0,
      url: `http://${svc.status.clusterIP}`
    };
  }
);
```

**Key changes:**
1. Replace `createDeployment()` / `createService()` with `simple.Deployment()` / `simple.Service()` (or import from `typekro/simple`)
2. Merge the two builder functions into one — create resources, then return status
3. Replace `Cel.expr()` with natural JavaScript: `Cel.expr<boolean>(ref, ' > 0')` becomes `ref > 0`
4. Replace `Cel.template()` with template literals: `` Cel.template('http://%s', ref) `` becomes `` `http://${ref}` ``
5. Replace `schema.spec.name` with `spec.name` (parameter is the spec directly, not a schema wrapper)
6. Add `id` to every resource for cross-resource references

### From `kubernetesComposition` to `toResourceGraph`

Switch to `toResourceGraph` when you need explicit CEL control:

1. Split the composition function into a resource builder (returns a keyed object) and a status builder
2. Replace `simple.Deployment()` with `createDeployment()` etc.
3. Remove `id` from resources — the key in the returned object serves the same purpose
4. Convert JavaScript status expressions to `Cel.expr()` / `Cel.template()`
5. Replace `spec.name` with `schema.spec.name`

## Exporting Static YAML

Export compositions as static YAML for review or GitOps:

```typescript
import { writeFileSync } from 'fs';

// Generate YAML for review
const yaml = webapp.toYaml();
console.log(yaml);

// Write to file for GitOps
writeFileSync('./manifests/webapp.yaml', yaml);
```

The generated YAML works with any Kubernetes tooling:
- `kubectl apply -f manifests/`
- ArgoCD Application pointing to the manifests directory
- Flux Kustomization

## Compatibility Matrix

| Tool | Compatibility | Notes |
|------|--------------|-------|
| kubectl | ✅ Full | Apply generated YAML directly |
| ArgoCD | ✅ Full | GitOps workflows with generated manifests |
| Flux | ✅ Full | HelmRelease integration, Kustomization support |
| Kustomize | ✅ Full | Use `YamlFile()` with kustomization.yaml |
| Helm | ✅ Full | `helmRelease()` for existing charts |

## Kro Controller Requirements

Some TypeKro features require the Kro controller:

| Feature | Without Kro | With Kro |
|---------|-------------|----------|
| Resource deployment | ✅ Direct mode | ✅ Kro mode |
| Cross-resource references | ❌ Static only | ✅ Runtime CEL |
| Status expressions | ❌ Not evaluated | ✅ Runtime evaluation |
| Status propagation | ❌ Manual | ✅ Automatic |

For static deployments without runtime features, use Direct mode:

```typescript
const factory = webapp.factory('direct', { namespace: 'default' });
await factory.deploy({ name: 'app', image: 'nginx' });
```

For full runtime features, deploy the Kro controller first:

```typescript
import { typeKroRuntimeBootstrap } from 'typekro';

// Bootstrap Kro controller
const runtime = typeKroRuntimeBootstrap();
const runtimeFactory = runtime.factory('direct', { namespace: 'kro-system' });
await runtimeFactory.deploy({});

// Now use Kro mode for runtime features
const factory = webapp.factory('kro', { namespace: 'default' });
await factory.deploy({ name: 'app', image: 'nginx' });
```

## Gradual Adoption Strategy

1. **Week 1**: Wrap existing YAML with `yamlFile()`
2. **Week 2**: Add new resources using TypeKro factories
3. **Week 3**: Replace simple YAML files with TypeKro equivalents
4. **Week 4**: Add status expressions for runtime state
5. **Ongoing**: Migrate remaining resources as needed

## Upgrading a Self-Owned-Namespace Bootstrap (KRO)

If a composition **owns the Namespace its own instance lives in** (a bootstrap that
creates `spec.namespace` and places the CR inside it), recent TypeKro versions
**hoist that Namespace out of the RGD graph** and retain it, so deleting the
instance can never strand its finalizer by terminating its own namespace.

Upgrading from a **pre-hoist** release requires transferring the live workload
Namespace out of KRO's ApplySet **before** the new (hoisted) RGD reconciles.
Otherwise KRO's prune — whose scope still lists the Namespace's group-kind from the
parent's remembered ApplySet annotations — deletes the live Namespace (the
`applyset.kubernetes.io/part-of` label still matches), recreating the exact deadlock.

### Direct mode: automatic

The imperative `factory.deploy()` path performs this ownership transfer
**automatically and idempotently**: it discovers every live instance of the RGD,
suspends each (`kro.run/reconcile: suspended`), strips KRO's ApplySet/ownership
labels from each owned Namespace (identity-checked so it never touches a Namespace
owned by a different instance), applies the hoisted RGD, then resumes. It fails
closed — if the transfer can't complete it never applies the new RGD.

### GitOps / Alchemy: one-time manual migration required

Flux, Argo CD, and Alchemy apply manifests **declaratively** — there is no
in-process step to run the ownership transfer, so **this migration cannot happen
automatically** on those paths. Before rolling out the hoisted RGD via GitOps or
Alchemy for an existing (pre-hoist) deployment, run the one-time transfer below.
Skipping it risks KRO pruning the live workload Namespace on the next reconcile.

> ⚠️ The RGD is **shared by every instance** of a factory. You must run this as ONE
> GLOBAL, ORDERED pass over ALL affected instances — **not** the full script once per
> instance. If you migrated one instance and then applied the new (hoisted) RGD, every
> OTHER instance that still owns its Namespace via KRO's ApplySet would reconcile the
> new RGD and **prune its own Namespace** before you got to it. The safe order is:
> **(1) suspend ALL → (2) strip ALL their namespaces → (3) apply the new RGD ONCE →
> (4) resume ALL.**

List every instance of the CRD and its owned workload Namespace, then run the script
below. It is **at parity with the automatic direct-mode migration** — it (a) validates
each Namespace's **ApplySet identity** before stripping it (so it never steals a
Namespace owned by a *different* instance), (b) records **pre-existing suspension** and
only resumes what **it** suspended (so it never clears an operator's deliberate
`kro.run/reconcile: suspended`), (c) gates on the RGD's **`observedGeneration`** (status
reflects the generation you just applied, not a stale `Active`), and (d) confirms the
**specific self-owned Namespace** is gone from `spec.resources` (it does not reject a
graph that legitimately contains some *other* Namespace). It is **ordered and gated**:
step 4 (resume) is unreachable until step 3 (apply the new RGD) is **confirmed** applied —
resuming against the OLD (pre-hoist) RGD would let KRO immediately re-adopt and re-stamp
every workload Namespace, undoing the transfer. So step 3 is an **executable, BLOCKING**
step with a verification gate, not a comment.

```bash
#!/usr/bin/env bash
set -euo pipefail

CR_RESOURCE="nsmigrations.test.typekro.dev"   # <plural>.<group> of the instance CRD
RGD_NAME="ns-migration"                         # metadata.name of the SHARED RGD
PART_OF_LABEL='applyset.kubernetes.io/part-of'
INSTANCE_ID_LABEL='kro.run/instance-id'

# All affected instances, as "INSTANCE_NS/INSTANCE WORKLOAD_NS" triples. INSTANCE_NS
# is the namespace the CR lives in — the FACTORY namespace (TypeKro always places the
# CR in the factory namespace unless you set `instanceNamespace`); for a self-owned
# bootstrap the factory namespace and WORKLOAD_NS are typically the same value.
# e.g. discover them: kubectl get "${CR_RESOURCE}" -A
INSTANCES=(
  "dagster/ns-migration-instance dagster"
  # "dagster-prod/ns-migration-instance dagster-prod"
)

# RESUME_LIST records ONLY the instances THIS run suspended, so step 4 never clears an
# operator's deliberate suspend (parity with the code's migration marker, finding #3).
RESUME_LIST=()

# 1. SUSPEND — but only instances not ALREADY suspended. An instance an operator
#    intentionally suspended is left as-is and will NOT be resumed by step 4.
for entry in "${INSTANCES[@]}"; do
  read -r ref workload_ns <<<"${entry}"
  instance_ns="${ref%%/*}"; instance="${ref##*/}"
  current="$(kubectl get "${CR_RESOURCE}" "${instance}" -n "${instance_ns}" \
    -o jsonpath='{.metadata.annotations.kro\.run/reconcile}' 2>/dev/null || true)"
  if [ "${current}" = "suspended" ] || [ "${current}" = "disabled" ]; then
    echo "leave ${ref}: already suspended (operator intent) — will NOT resume it" >&2
    continue
  fi
  kubectl annotate "${CR_RESOURCE}" "${instance}" -n "${instance_ns}" \
    kro.run/reconcile=suspended --overwrite
  RESUME_LIST+=("${ref}")
done

# 2. For each instance, VALIDATE the owned Namespace's ownership identity belongs to
#    THAT instance BEFORE stripping (never steal a Namespace owned by another owner),
#    then strip KRO's ApplySet/ownership labels and stamp typekro's retention markers.
for entry in "${INSTANCES[@]}"; do
  read -r ref workload_ns <<<"${entry}"
  instance_ns="${ref%%/*}"; instance="${ref##*/}"
  instance_uid="$(kubectl get "${CR_RESOURCE}" "${instance}" -n "${instance_ns}" \
    -o jsonpath='{.metadata.uid}' 2>/dev/null || true)"
  ns_part_of="$(kubectl get namespace "${workload_ns}" \
    -o "jsonpath={.metadata.labels.${PART_OF_LABEL//./\\.}}" 2>/dev/null || true)"
  ns_instance_id="$(kubectl get namespace "${workload_ns}" \
    -o "jsonpath={.metadata.labels.${INSTANCE_ID_LABEL//./\\.}}" 2>/dev/null || true)"

  # Not KRO-owned (fresh / already transferred) → nothing to strip.
  if [ -z "${ns_part_of}" ] && [ -z "${ns_instance_id}" ]; then
    echo "skip ${workload_ns}: not a KRO ApplySet member (nothing to transfer)" >&2
    continue
  fi
  # Every PRESENT identity must AGREE with THIS instance; a present instance-id that
  # differs from the CR's UID means the Namespace is owned by ANOTHER instance → ABORT
  # (fail closed) rather than steal it. (part-of parity: recompute the ApplySet id as
  # applyset-<rawurl base64(sha256("<name>.<ns>.<kind>.<group>"))>-v1 if you want to
  # verify it too; the instance-id/UID check below is sufficient in practice.)
  if [ -n "${ns_instance_id}" ] && [ "${ns_instance_id}" != "${instance_uid}" ]; then
    echo "ABORT: ${workload_ns} is owned by a DIFFERENT KRO instance" \
         "(instance-id='${ns_instance_id}' != this instance UID '${instance_uid}')." >&2
    echo "Resolve the conflicting ownership before migrating. Suspended instances remain suspended (safe)." >&2
    exit 1
  fi

  kubectl label namespace "${workload_ns}" \
    applyset.kubernetes.io/part-of- \
    kro.run/owned- \
    kro.run/instance-id- \
    kro.run/node-id- \
    kro.run/resource-graph-definition-id- \
    app.kubernetes.io/managed-by- \
    typekro.io/kro-instance-namespace=true --overwrite
  kubectl annotate namespace "${workload_ns}" \
    kustomize.toolkit.fluxcd.io/prune=disabled \
    argocd.argoproj.io/sync-options=Prune=false,Delete=false --overwrite
done

# 3. APPLY the NEW (hoisted) RGD + retained Namespaces ONCE. Uncomment the line for
#    your delivery tool. All namespaces are already detached from KRO's ApplySet
#    (step 2), so applying the new RGD cannot cause any instance to prune its namespace.
#    ▶ Flux:    flux reconcile kustomization <name> -n flux-system --with-source
#    ▶ Argo CD: argocd app sync <app>
#    ▶ Alchemy: (cd <alchemy-project> && bun run alchemy.run.ts)   # `alchemy up`
#
#    DO NOT edit out the gate below. Until it PASSES, step 4 does not run — so a
#    forgotten/failed apply leaves every instance SUSPENDED (safe: KRO prunes nothing)
#    rather than resumed against the old RGD (unsafe: KRO re-adopts the namespaces).

# 3b. GATE — BLOCK until the new (hoisted) RGD is confirmed live before resuming:
#     (a) the RGD reports status.state == Active, AND
#     (b) the RGD's Ready condition's observedGeneration == metadata.generation (the
#         status reflects the generation you JUST applied — not a stale prior Active), AND
#     (c) the SPECIFIC self-owned Namespace (a Namespace template named
#         "${schema.spec.namespace}") is gone from spec.resources — a graph that
#         legitimately contains some OTHER (unrelated) Namespace is still accepted, AND
#     (d) every workload Namespace still lacks `applyset.kubernetes.io/part-of` (proof
#         the strip is still in effect and nothing re-adopted it).
gate_timeout=$((SECONDS + 600))   # wait up to 10 min for the apply to land
until
  state="$(kubectl get resourcegraphdefinition "${RGD_NAME}" -o jsonpath='{.status.state}' 2>/dev/null || true)"
  gen="$(kubectl get resourcegraphdefinition "${RGD_NAME}" -o jsonpath='{.metadata.generation}' 2>/dev/null || true)"
  obs="$(kubectl get resourcegraphdefinition "${RGD_NAME}" \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].observedGeneration}' 2>/dev/null || true)"
  observed="no"; [ -n "${obs}" ] && [ "${obs}" = "${gen}" ] && observed="yes"
  # jq -e: exit 0 only if NO resource template is the SELF-OWNED Namespace (a Namespace
  # whose name is the schema namespace expression) — i.e. it was hoisted out.
  hoisted="$(kubectl get resourcegraphdefinition "${RGD_NAME}" -o json 2>/dev/null \
    | jq -e '[.spec.resources[]? | select(.template.kind=="Namespace" and .template.metadata.name=="${schema.spec.namespace}")] | length == 0' >/dev/null 2>&1 && echo yes || echo no)"
  stripped="yes"
  for entry in "${INSTANCES[@]}"; do
    read -r _ref workload_ns <<<"${entry}"
    part_of="$(kubectl get namespace "${workload_ns}" \
      -o jsonpath='{.metadata.labels.applyset\.kubernetes\.io/part-of}' 2>/dev/null || true)"
    [ -n "${part_of}" ] && stripped="no"
  done
  [ "${state}" = "Active" ] && [ "${observed}" = "yes" ] && [ "${hoisted}" = "yes" ] && [ "${stripped}" = "yes" ]
do
  if [ "${SECONDS}" -ge "${gate_timeout}" ]; then
    echo "ABORT: hoisted RGD not confirmed (state='${state}', observedGen='${obs}' vs gen='${gen}', hoisted='${hoisted}', stripped='${stripped}')." >&2
    echo "Instances remain SUSPENDED (safe). Apply the new RGD (step 3) and re-run — do NOT resume manually." >&2
    exit 1
  fi
  echo "Waiting for the hoisted RGD (state='${state}', observedGen='${obs}' vs gen='${gen}', hoisted='${hoisted}', stripped='${stripped}')…" >&2
  sleep 5
done

# 4. RESUME — ONLY the instances THIS run suspended (RESUME_LIST). Reachable ONLY after
#    the gate confirmed the hoisted RGD is live and the strip is still in effect. Each
#    Namespace no longer carries `part-of`, so the prune cannot enumerate it — they all
#    survive. Operator-suspended instances are deliberately left suspended.
for ref in "${RESUME_LIST[@]:-}"; do
  [ -z "${ref}" ] && continue
  instance_ns="${ref%%/*}"; instance="${ref##*/}"
  kubectl annotate "${CR_RESOURCE}" "${instance}" -n "${instance_ns}" \
    kro.run/reconcile- --overwrite
done
```

Fresh installs (the workload Namespace does not exist yet, or carries no KRO
labels) need **no** migration — the hoisted Namespace is simply created as a
retained resource, deps-first.

## Next Steps

- [Getting Started](/guide/getting-started) - Quick start guide
- [Deployment Modes](/guide/deployment-modes) - Direct vs Kro deployment
- [YAML Integration](/api/yaml-closures) - YamlFile and HelmChart
- [Helm Integration](/examples/helm-integration) - HelmRelease examples
