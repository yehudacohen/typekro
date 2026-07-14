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
below. It is **at parity with the automatic direct-mode migration**:

- **(a) Identity-checked strip.** Before stripping a Namespace it recomputes the
  instance's **ApplySet ID** exactly as the code does —
  `applyset-<base64url(sha256("<name>.<ns>.<kind>.<group>"))>-v1` — and requires
  **every present identity** (`applyset.kubernetes.io/part-of` **and**
  `kro.run/instance-id`) to MATCH that instance. Any foreign or disagreeing identity
  **aborts** (never steals a Namespace owned by a different instance).
- **(b) Persistent, crash-safe suspend/resume marker.** On suspend it stamps the SAME
  annotation the code uses — `typekro.io/kro-migration-suspended=true` — alongside
  `kro.run/reconcile=suspended`. Resume clears suspension for **exactly the instances
  carrying OUR marker on the cluster** (not a shell variable), so a **gate timeout +
  re-run** still resumes what a prior run suspended and **never** touches an operator's
  deliberate `kro.run/reconcile: suspended` (which has no marker).
- **(c) Positive "new RGD is live" gate.** Step 4 (resume) is unreachable until the gate
  confirms the NEW RGD is applied: the RGD's **Ready condition is `status: "True"` AT the
  current `metadata.generation`** (not merely an observedGeneration present, and not a
  stale prior `Active`), and the **specific hoisted resource id** is gone from
  `spec.resources` (a robust removed-id signal — not "contains no Namespace", which
  misses guarded/nested name forms the code also hoists).
- **(d) Executable apply.** Step 3 actually RUNS your delivery command (`APPLY_CMD`),
  it is not a comment. Resuming against the OLD (pre-hoist) RGD would let KRO re-adopt
  and re-stamp every workload Namespace, so the gate stays closed until the new RGD is
  confirmed live.

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Configure for your deployment ────────────────────────────────────────────
CR_RESOURCE="nsmigrations.test.typekro.dev"   # <plural>.<group> of the instance CRD
CR_KIND="NsMigration"                           # the instance CRD KIND (schema.kind)
CR_GROUP="test.typekro.dev"                     # the instance CRD GROUP (schema.group)
RGD_NAME="ns-migration"                         # metadata.name of the SHARED RGD
HOISTED_RESOURCE_ID="ownedNamespace"            # spec.resources[].id of the Namespace
                                                # that the new RGD hoists OUT (removed).
# APPLY_CMD: the command that applies the NEW (hoisted) RGD via your delivery tool, e.g.
#   Flux:    flux reconcile kustomization <name> -n flux-system --with-source
#   Argo CD: argocd app sync <app>
#   Alchemy: cd <alchemy-project> && bun run alchemy.run.ts
: "${APPLY_CMD:?Set APPLY_CMD to the command that applies the new (hoisted) RGD}"

PART_OF_LABEL='applyset.kubernetes.io/part-of'
INSTANCE_ID_LABEL='kro.run/instance-id'
SUSPEND_MARKER='typekro.io/kro-migration-suspended'   # our persistent, crash-safe marker

# All affected instances, as "INSTANCE_NS/INSTANCE WORKLOAD_NS" entries. INSTANCE_NS is
# the namespace the CR lives in — the FACTORY namespace (TypeKro always places the CR in
# the factory namespace unless you set `instanceNamespace`); for a self-owned bootstrap
# the factory namespace and WORKLOAD_NS are typically the same value.
# Discover them: kubectl get "${CR_RESOURCE}" -A
INSTANCES=(
  "dagster/ns-migration-instance dagster"
  # "dagster-prod/ns-migration-instance dagster-prod"
)

# Recompute the ApplySet ID KRO stamps on an instance's children (KEP-3659), the SAME
# way the code does: applyset-<RawURLBase64(sha256("<name>.<ns>.<kind>.<group>"))>-v1.
compute_applyset_id() {
  local name="$1" ns="$2" kind="$3" group="$4"
  local b64
  b64="$(printf '%s' "${name}.${ns}.${kind}.${group}" \
    | openssl dgst -sha256 -binary \
    | openssl base64 -A \
    | tr '+/' '-_' | tr -d '=')"        # standard base64 → base64url, strip padding
  printf 'applyset-%s-v1' "${b64}"
}

# 1. SUSPEND every instance that is not ALREADY suspended, stamping OUR persistent
#    marker so a later re-run knows WE suspended it (crash-safe, not shell-state). An
#    instance an operator suspended (no marker) is left as-is — never resumed by step 4.
for entry in "${INSTANCES[@]}"; do
  read -r ref workload_ns <<<"${entry}"
  instance_ns="${ref%%/*}"; instance="${ref##*/}"
  current="$(kubectl get "${CR_RESOURCE}" "${instance}" -n "${instance_ns}" \
    -o jsonpath='{.metadata.annotations.kro\.run/reconcile}' 2>/dev/null || true)"
  marker="$(kubectl get "${CR_RESOURCE}" "${instance}" -n "${instance_ns}" \
    -o "jsonpath={.metadata.annotations.${SUSPEND_MARKER//./\\.}}" 2>/dev/null || true)"
  if { [ "${current}" = "suspended" ] || [ "${current}" = "disabled" ]; } && [ "${marker}" != "true" ]; then
    echo "leave ${ref}: operator-suspended (no ${SUSPEND_MARKER}) — will NOT resume it" >&2
    continue
  fi
  # Not suspended, OR already suspended-by-us from a prior run: (re)stamp both so resume
  # (step 4) — which keys off the marker on the cluster — always covers it.
  kubectl annotate "${CR_RESOURCE}" "${instance}" -n "${instance_ns}" \
    kro.run/reconcile=suspended "${SUSPEND_MARKER}=true" --overwrite
done

# 2. For each instance, VALIDATE the owned Namespace's ownership identity belongs to
#    THAT instance BEFORE stripping — EVERY present identity (part-of AND instance-id)
#    must agree — then strip KRO's ApplySet/ownership labels and stamp retention markers.
for entry in "${INSTANCES[@]}"; do
  read -r ref workload_ns <<<"${entry}"
  instance_ns="${ref%%/*}"; instance="${ref##*/}"
  instance_uid="$(kubectl get "${CR_RESOURCE}" "${instance}" -n "${instance_ns}" \
    -o jsonpath='{.metadata.uid}' 2>/dev/null || true)"
  expected_applyset_id="$(compute_applyset_id "${instance}" "${instance_ns}" "${CR_KIND}" "${CR_GROUP}")"
  ns_part_of="$(kubectl get namespace "${workload_ns}" \
    -o "jsonpath={.metadata.labels.${PART_OF_LABEL//./\\.}}" 2>/dev/null || true)"
  ns_instance_id="$(kubectl get namespace "${workload_ns}" \
    -o "jsonpath={.metadata.labels.${INSTANCE_ID_LABEL//./\\.}}" 2>/dev/null || true)"

  # Not KRO-owned (fresh / already transferred) → nothing to strip.
  if [ -z "${ns_part_of}" ] && [ -z "${ns_instance_id}" ]; then
    echo "skip ${workload_ns}: not a KRO ApplySet member (nothing to transfer)" >&2
    continue
  fi
  # IDENTITY CHECK (finding #3) — every PRESENT identity must AGREE with THIS instance.
  # A present part-of that isn't this instance's ApplySet ID, or a present instance-id
  # that isn't this CR's UID, means the Namespace belongs to ANOTHER instance → ABORT
  # (fail closed) rather than steal it.
  if [ -n "${ns_part_of}" ] && [ "${ns_part_of}" != "${expected_applyset_id}" ]; then
    echo "ABORT: ${workload_ns} part-of='${ns_part_of}' != this instance's ApplySet ID" \
         "'${expected_applyset_id}' — it is owned by a DIFFERENT KRO instance." >&2
    echo "Resolve the conflicting ownership before migrating. Suspended instances remain suspended (safe)." >&2
    exit 1
  fi
  if [ -n "${ns_instance_id}" ] && [ "${ns_instance_id}" != "${instance_uid}" ]; then
    echo "ABORT: ${workload_ns} instance-id='${ns_instance_id}' != this CR's UID" \
         "'${instance_uid}' — it is owned by a DIFFERENT KRO instance." >&2
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

# 3. APPLY the NEW (hoisted) RGD + retained Namespaces ONCE — EXECUTABLE, not a comment.
#    All namespaces are already detached from KRO's ApplySet (step 2), so applying the
#    new RGD cannot cause any instance to prune its namespace.
echo "Applying the new (hoisted) RGD: ${APPLY_CMD}" >&2
eval "${APPLY_CMD}"

# 3b. GATE — BLOCK until the new (hoisted) RGD is confirmed live before resuming. Until
#     it PASSES, step 4 does not run, so a forgotten/failed apply leaves every instance
#     SUSPENDED (safe: KRO prunes nothing) rather than resumed against the old RGD
#     (unsafe: KRO re-adopts the namespaces). It gates on:
#       (a) status.state == Active, AND
#       (b) the Ready condition is status=="True" AT the current generation
#           (ready==metadata.generation) — the applied generation is Ready, not a stale
#           prior Active and not merely "observedGeneration present", AND
#       (c) the SPECIFIC hoisted resource id (HOISTED_RESOURCE_ID) is GONE from
#           spec.resources — a positive "new RGD is live" signal that is robust to
#           guarded/nested Namespace name forms (unlike matching a literal name), AND
#       (d) every workload Namespace still lacks part-of (the strip is still in effect).
gate_timeout=$((SECONDS + 600))   # wait up to 10 min for the apply to land
until
  state="$(kubectl get resourcegraphdefinition "${RGD_NAME}" -o jsonpath='{.status.state}' 2>/dev/null || true)"
  gen="$(kubectl get resourcegraphdefinition "${RGD_NAME}" -o jsonpath='{.metadata.generation}' 2>/dev/null || true)"
  # observedGeneration of the Ready condition, but ONLY when that condition is status=True.
  ready_gen="$(kubectl get resourcegraphdefinition "${RGD_NAME}" \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].observedGeneration}' 2>/dev/null || true)"
  ready_status="$(kubectl get resourcegraphdefinition "${RGD_NAME}" \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
  ready="no"
  [ "${ready_status}" = "True" ] && [ -n "${ready_gen}" ] && [ "${ready_gen}" = "${gen}" ] && ready="yes"
  # jq -e: exit 0 only if the HOISTED resource id is ABSENT from spec.resources[].id —
  # i.e. the NEW (hoisted) RGD, which removed it, is the live one.
  removed="$(kubectl get resourcegraphdefinition "${RGD_NAME}" -o json 2>/dev/null \
    | jq -e --arg id "${HOISTED_RESOURCE_ID}" \
        '[.spec.resources[]? | select(.id == $id)] | length == 0' >/dev/null 2>&1 && echo yes || echo no)"
  stripped="yes"
  for entry in "${INSTANCES[@]}"; do
    read -r _ref workload_ns <<<"${entry}"
    part_of="$(kubectl get namespace "${workload_ns}" \
      -o jsonpath='{.metadata.labels.applyset\.kubernetes\.io/part-of}' 2>/dev/null || true)"
    [ -n "${part_of}" ] && stripped="no"
  done
  [ "${state}" = "Active" ] && [ "${ready}" = "yes" ] && [ "${removed}" = "yes" ] && [ "${stripped}" = "yes" ]
do
  if [ "${SECONDS}" -ge "${gate_timeout}" ]; then
    echo "ABORT: hoisted RGD not confirmed (state='${state}', ready='${ready}' [status='${ready_status}', gen='${ready_gen}' vs '${gen}'], removed='${removed}', stripped='${stripped}')." >&2
    echo "Instances remain SUSPENDED (safe). Fix/re-apply the new RGD (step 3) and re-run — the marker makes resume idempotent; do NOT resume manually." >&2
    exit 1
  fi
  echo "Waiting for the hoisted RGD (state='${state}', ready='${ready}', removed='${removed}', stripped='${stripped}')…" >&2
  sleep 5
done

# 4. RESUME — ONLY the instances carrying OUR persistent marker ON THE CLUSTER (finding
#    #2). This does NOT rely on a shell variable, so a gate timeout + re-run still
#    resumes exactly what a prior run suspended and never resumes an operator-suspended
#    instance (which has no marker). Clearing the marker with the annotation makes the
#    step idempotent. Each Namespace no longer carries part-of, so the prune cannot
#    enumerate it — they all survive.
for entry in "${INSTANCES[@]}"; do
  read -r ref _workload_ns <<<"${entry}"
  instance_ns="${ref%%/*}"; instance="${ref##*/}"
  marker="$(kubectl get "${CR_RESOURCE}" "${instance}" -n "${instance_ns}" \
    -o "jsonpath={.metadata.annotations.${SUSPEND_MARKER//./\\.}}" 2>/dev/null || true)"
  if [ "${marker}" != "true" ]; then
    echo "leave ${ref}: no ${SUSPEND_MARKER} marker (we did not suspend it)" >&2
    continue
  fi
  kubectl annotate "${CR_RESOURCE}" "${instance}" -n "${instance_ns}" \
    "kro.run/reconcile-" "${SUSPEND_MARKER}-" --overwrite
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
