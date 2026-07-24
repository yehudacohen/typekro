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

## KRO schema-changing upgrades

TypeKro waits for an updated `ResourceGraphDefinition` to report the current
`metadata.generation` in `status.observedGeneration` before applying its custom
resource instance. This prevents the API server from admitting an instance
against the previous generated CRD schema and silently pruning newly added
nested fields.

TypeKro also compares the API server's immediate apply response with the desired
instance spec. If structural-schema pruning still removes a desired path, the
deployment fails with `KRO_INSTANCE_SPEC_PRUNED` and lists only the omitted
paths, never their values. Do not retry around this error blindly: inspect the
RGD and generated CRD status, then resolve the schema or reconciliation problem.

## Upgrading from a pre-hoist TypeKro release (KRO)

TypeKro **never emits a `Namespace` into RGD YAML**. Every Namespace a composition
owns is applied as a **sibling** resource — created before the RGD (deps-first) and
deleted after it — so KRO never owns a namespace and deleting an instance can never
strand its finalizer by terminating the namespace that holds it.

**New deployments need no migration** — the sibling namespace is created automatically
(imperative `deploy()`, `toAlchemyResources()`, and `toYaml()` all lead with it).

**Upgrading an existing (pre-hoist) deployment** whose Namespace was a KRO graph child
is **not migrated automatically**. A pre-hoist RGD had the Namespace inside its
ApplySet; the new RGD does not. The previously KRO-owned live Namespace is left
carrying KRO's `applyset.kubernetes.io/part-of` / `kro.run/*` ownership labels, and
rolling the new (hoisted) RGD out over the old one would drop the Namespace from the
ApplySet — so KRO's prune would **delete the live namespace** and its workloads.

TypeKro **fails closed** on this: an imperative `deploy()` detects a to-be-hoisted
namespace that still carries KRO ApplySet ownership labels and **throws**
(`PRE_HOIST_NAMESPACE_CONFLICT`) before touching the RGD, rather than silently
pruning your namespace. There is no automatic reclaim. Choose one:

- **Recreate (simplest, recommended).** Delete the instance (which triggers KRO's
  finalizer-safe teardown), then redeploy with the current TypeKro version. The
  namespace is recreated as a sibling. Use this when the namespace holds no
  irreplaceable state.
- **Adopt the live namespace in place (advanced; requires quiescing KRO).** If the
  namespace must survive, remove KRO's ownership labels from it *before* rolling out
  the new RGD, so KRO's prune no longer enumerates it. **This label strip is racy
  against a live KRO controller**: if the controller reconciles the old RGD between
  your strip and the new-RGD apply, it can re-stamp the ownership labels (or prune the
  namespace) in that window. Do it only with the controller **quiesced** — scale the
  KRO controller deployment to `0` (or otherwise pause reconciliation of the old RGD),
  strip the labels, apply the new hoisted RGD, then resume the controller:

  ```bash
  # 1. Quiesce KRO so it cannot reconcile the old RGD mid-migration.
  kubectl -n kro-system scale deploy/kro --replicas=0

  # 2. Strip KRO's ownership labels so the new RGD's prune no longer enumerates the ns.
  kubectl label namespace <ns> \
    applyset.kubernetes.io/part-of- \
    kro.run/instance-group- kro.run/instance-id- \
    kro.run/instance-kind- kro.run/instance-name- \
    kro.run/instance-namespace- kro.run/instance-version- \
    kro.run/kro-version- kro.run/node-id- kro.run/owned- \
    app.kubernetes.io/managed-by- \
    typekro.io/kro-instance-namespace=true --overwrite

  # 3. Apply the new (hoisted) RGD, then resume the controller.
  kubectl -n kro-system scale deploy/kro --replicas=1
  ```

  Remove **every** `kro.run/*` label present on the Namespace, not only the
  currently known keys shown above. The deployment guard intentionally treats
  any remaining `kro.run/*` label as unresolved ApplySet ownership and continues
  to fail closed.

  The namespace is now a plain, TypeKro-marked sibling that the current empty-gated
  delete path manages. If you cannot quiesce the controller, prefer **Recreate**.

### How teardown deletes (order) and what it leaves behind

Deleting a KRO instance (imperative `deleteInstance`) tears its owned runtime footprint
down in this order. The generated CRD is a reusable cluster-level API definition and is
retained Active rather than being placed into a best-effort deletion state:

1. **Instance CR** — deleted and gated to a real `404`, so KRO's `kro.run/finalizer`
   has cleared (KRO graph-deleted every child) **before** the next step. Deleting the
   RGD while KRO is mid-finalizer orphans cleanup, so this gate is load-bearing.
2. **Owned workload Namespace(s)** — deleted **before** the RGD, gated to `404`.
   This ordering is what makes the namespace delete *reliable*: the RGD and generated
   CRD are still **healthy/Active** at this point, so the namespace controller enumerates
   that type's zero instances **instantly** to confirm the namespace is empty. (Only a
   *Terminating* CRD stalls a namespace — the apiextensions `customresourcecleanup`
   finalizer can hang for minutes even with zero instances, [kro#1171]. That is exactly
   why the CRD stays Active.) A namespace is deleted **only if** it is
   both owned by this RGD (carries the `typekro.io/created-by-rgd` record) **and** empty;
   otherwise it is retained.
3. **RGD** — deleted and gated to `404` (only when no other instance shares it, **and**
   only once owned-namespace cleanup is confirmed — see *retry-safety* below).
4. **Generated CRD** — deliberately **retained Active** with zero instances. KRO uses
   `allowCRDDeletion=false` by default, and TypeKro follows the same policy in both the
   imperative and Alchemy paths. A best-effort delete is unsafe because the
   apiextensions `customresourcecleanup` finalizer can leave the CRD `Terminating`; that
   state prevents a later deployment of the same RGD/kind from reusing the API.

**Which namespaces get cleaned (two durable records).** At deploy time TypeKro records
the concrete names of every hoisted Namespace on the instance CR
(`typekro.io/hoisted-namespaces`, a JSON array) **and** stamps each Namespace it creates
with `typekro.io/created-by-rgd=<rgd>`. Teardown reads the CR record to clean *this*
instance's namespaces right after its CR is gone. When it is the **last** instance of a
shared RGD, it then sweeps every Namespace carrying this RGD's `created-by-rgd` stamp
before removing the definitions.

**Retry-safety (the `created-by-rgd` sweep is CR-independent).** The CR's
`hoisted-namespaces` record dies *with* the CR. If an earlier teardown attempt deleted
the CR but crashed before cleaning its namespaces, a retry would find the CR `404` and
read no names. So the last-instance sweep does **not** depend on the CR: it finds owned
namespaces via the durable `created-by-rgd` **namespace** annotation (which survives the
CR), cleans each, and then **preserves the RGD/CRD until owned-namespace cleanup is
confirmed** — the RGD is not deleted while any `created-by-rgd` namespace still exists
(or cannot be confirmed gone). A retry after the CR is already gone therefore still
finds and cleans the leaked namespace, and only then removes the RGD.

**What can be left behind:** the generated CRD remains Active with zero instances. This
is intentional and lets a later deployment of the same composition reuse it. An
administrator may garbage-collect it out-of-band only after proving that the kind is
retired, no custom resources exist in any served version, and no RGD needs it
(`kubectl delete crd <plural>.<group>`). Do not make that delete a normal application
teardown step: a CRD stuck `Terminating` blocks redeployment. Likewise, an owned
namespace retained because another stack still has resources in it keeps the RGD alive
(conservative, by design); remove the other resources (or the namespace) to let a later
teardown complete.

### Ownership is decided create-first (owned iff we created it)

A hoisted Namespace's ownership is fixed **atomically** at create time: TypeKro issues a
`CREATE` (POST) carrying the `typekro.io/created-by-rgd` stamp. A `201` means TypeKro
created it → it is **owned** (and a candidate for the empty-gated delete at teardown). A
`409 AlreadyExists` means the namespace pre-existed → TypeKro **adopts** it and treats it
as owned only if it already carried *this* RGD's stamp (a prior create by us); an adopted
namespace never gains the stamp and is never deleted. This replaces the old
`GET`→(if 404)→patch-with-stamp sequence, which was raceable (a namespace created by
another actor between the GET and the patch could be wrongly stamped and later deleted).

### Namespace deletion is best-effort-safe, not atomic (ownership primary, emptiness secondary)

The empty-gate reads the namespace's contents and then deletes it — a check→delete
window that is **inherently racy** for a namespace another actor might write to
concurrently. TypeKro treats this as acceptable by design:

- **Ownership is the PRIMARY guard** (record-based, not racy): a namespace is a deletion
  candidate only if it carries this RGD's `typekro.io/created-by-rgd` annotation, stamped
  **only** when TypeKro actually created it. An adopted or pre-existing namespace never
  carries the record and is **never** deleted, regardless of emptiness.
- **Emptiness is the SECONDARY backstop** (best-effort): a fail-safe net that RETAINS on
  *any* doubt. Its cluster discovery enumerates every served namespaced API group; if it
  cannot enumerate one (a native group whose discovery fails, or an unreachable
  aggregated APIService backend), it treats that as uncertainty and **retains** the
  namespace rather than risk deleting an occupied one.

The net contract: namespace deletion is **best-effort-safe** — never atomic, and
retained on any doubt. The residual check→delete race can, at worst, leave an
owned-but-now-occupied namespace deleted if another actor writes into it in the exact
window between the emptiness check and the delete; ownership scoping keeps this confined
to namespaces TypeKro itself created for this composition.

[kro#1171]: https://github.com/kro-run/kro/issues/1171

### Status fields that reference an owned namespace's name

A status field whose value resolves **only** to a hoisted Namespace's `metadata.name`
(e.g. `status.namespace: ${ownedNamespace.metadata.name}`) cannot be represented in
the KRO status once the Namespace leaves the RGD — in **either** shape:

- a **schema-named** Namespace rewrites the field to `schema.spec.namespace`, which
  KRO status CEL cannot evaluate; and
- a **literally-named** Namespace rewrites it to a bare constant, which KRO rejects
  (KRO requires every status field to reference a resource) and TypeKro would drop as
  a static field.

TypeKro **rejects** such a composition at serialization (naming the field) in both
cases — one consistent behavior — rather than silently shipping a weaker status API.
Derive the value from a managed resource, or drop the field.

### Helm-backed integration status now reports failures consistently

The CNPG, Valkey, Inngest, NATS, Rook, ClickHouse operator, ClickStack telemetry,
cert-manager, and external-dns compositions now derive their aggregate status from one
shared Flux HelmRelease condition policy:

- integration authors pass whole HelmRelease resources to
  `helmReleaseConditionSummary(release, ...releases)`, allowing the helper to compare
  `status.observedGeneration` and condition generations with `metadata.generation`;
- `ready` is true only when every required HelmRelease has a current-generation
  `Ready=True`;
- where exposed, `failed` is true when any required HelmRelease has a
  current-generation `Ready=False`; and
- `phase` is now `Ready | Installing | Failed`.

Missing or stale Flux status remains `Installing`; readiness from a previous generation
is never reused for the new desired state. Concrete condition arrays are no longer a
supported input to this newly public helper.

This tightens several public status schemas. CNPG, ClickHouse, and ClickStack telemetry
gain a required `failed` field. Valkey, Inngest, NATS, and Rook already exposed
`failed`, but their `phase` unions gain `Failed`. cert-manager and external-dns keep
their existing status fields while their `phase` can now emit `Failed`. Update
exhaustive `phase` switches, typed fixtures, and hand-written status mocks before
upgrading. This is a public API compatibility change and should be consumed as a
pre-1.0 minor release rather than a patch release.

## Next Steps

- [Getting Started](/guide/getting-started) - Quick start guide
- [Deployment Modes](/guide/deployment-modes) - Direct vs Kro deployment
- [YAML Integration](/api/yaml-closures) - YamlFile and HelmChart
- [Helm Integration](/examples/helm-integration) - HelmRelease examples
