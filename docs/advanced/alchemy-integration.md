# Alchemy Integration

TypeKro integrates with [Alchemy](https://alchemy.run) to deploy your TypeKro resources through Alchemy's declarative, stateful runtime — so they get per-resource state, dependency-ordered deployment, idempotent reconcile, and reverse-topological teardown alongside the rest of your Alchemy-managed infrastructure.

> **Alchemy v2.** This integration targets Alchemy v2 (the Effect-based `2.0.0-beta` line). It is declarative: TypeKro emits resource *declarations*, and your Alchemy runtime materializes them as Alchemy resources. The older v1 imperative model (`graph.deployWithAlchemy(...)`, the `alchemyScope` factory option, the global `alchemy(...)` scope-driven deploy) has been **removed**.

## What is Alchemy?

Alchemy is an infrastructure-as-TypeScript tool with a stateful runtime: it tracks every resource it manages in a state store, deploys them in dependency order, reconciles them idempotently, and tears them down in reverse-topological order. TypeKro's integration represents each TypeKro KRO resource as an Alchemy resource, so a TypeKro deployment becomes a first-class part of an Alchemy stack.

## The v2 model

TypeKro exports a declarative Alchemy v2 integration from `typekro/alchemy`:

- **`KroResource`** — a declarative Alchemy v2 `Resource` representing one TypeKro KRO resource. That single resource can be an RGD (ResourceGraphDefinition), a CR instance, or a direct-mode Kubernetes resource.
- **`kroProvider`** — the Alchemy `Provider` (an Effect `Layer`) that backs `KroResource`. Merge it into your Alchemy runtime's providers.
- **`materializeAlchemyResources(KroResource, declarations)`** — a helper that returns an Effect. Run it *inside* an Alchemy `Stack` body to instantiate a list of declarations as `KroResource`s. It wires each declaration's `dependsOn` into Alchemy `Output` dependencies, so resources deploy in dependency order and direct-mode cross-resource references resolve against their dependencies' live state.
- **`AlchemyResourceDeclaration`** — `{ id: string; props; dependsOn: string[] }`. This is what `toAlchemyResources` returns.

Both `DirectResourceFactory` and `KroResourceFactory` expose:

```typescript
toAlchemyResources(spec, opts?): Promise<AlchemyResourceDeclaration[]>
```

It emits the resource(s) as declarations:

- **KRO mode** → a declaration for each discovered **singleton owner** (its own RGD + CR instance), then the composition's RGD, then its CR instance. The instance `dependsOn` the RGD and any singleton instances, so a deployment with no singletons is just two declarations (RGD + instance), and one that depends on shared singletons emits those first.
- **Direct mode** → one declaration per resolved Kubernetes resource, topologically ordered, with `dependsOn` taken from the resource dependency graph.

The result is the same per-resource state granularity as the old v1 integration — one Alchemy state entry per resource, reverse-topological teardown, idempotent reconcile — but expressed declaratively.

## Canonical Usage

This is the verified pattern (see `test/integration/alchemy/direct-fan-out-e2e.test.ts`):

```typescript
import { Cel, simple, toResourceGraph } from 'typekro';
import { KroResource, kroProvider, materializeAlchemyResources } from 'typekro/alchemy';
// + your Alchemy v2 runtime — its `providers` must include `kroProvider`, plus a state backend.

// 1. Build the factory as usual.
const factory = await graph.factory('direct', { namespace: 'apps', waitForReady: true });

// 2. Emit per-resource declarations (topologically ordered, dependsOn wired).
const decls = await factory.toAlchemyResources(spec);

// 3. Inside an Alchemy Stack body (an Effect generator), with kroProvider in the runtime:
const outputs = yield* materializeAlchemyResources(KroResource, decls);
```

Once deployed, each TypeKro resource is a per-resource entry in Alchemy's state: Alchemy reconciles them idempotently and tears them down in reverse-topological order.

The Alchemy *runtime* itself — how you construct the runtime, which providers and state backend you supply — is part of your own Alchemy v2 setup and is not provided by TypeKro. The only TypeKro requirement is that `kroProvider` is merged into the runtime's providers, and that a state backend is configured. Everything above the `toAlchemyResources` / `materializeAlchemyResources` calls is TypeKro-side and is what this page documents.

## Direct mode: per-resource fan-out

In direct mode, `toAlchemyResources` returns one declaration per resolved Kubernetes resource, ordered so that dependencies come first:

```typescript
import { Cel, simple, toResourceGraph } from 'typekro';
import { KroResource, kroProvider, materializeAlchemyResources } from 'typekro/alchemy';
import { type } from 'arktype';

const graph = toResourceGraph(
  {
    name: 'fanoutapp',
    apiVersion: 'v1alpha1',
    kind: 'FanoutApp',
    spec: type({ name: 'string', image: 'string', replicas: 'number%1' }),
    status: type({ readyReplicas: 'number%1' }),
  },
  (schema) => {
    const deployment = simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      id: 'appDeployment',
    });
    return {
      deployment,
      // Reads the Deployment's LIVE status → a genuine cross-resource dependency.
      config: simple.ConfigMap({
        name: Cel.template('%s-cfg', schema.spec.name),
        data: { readyReplicas: Cel.template('%s', deployment.status.readyReplicas) },
        id: 'appConfig',
      }),
    };
  },
  (_schema, resources) => ({ readyReplicas: resources.deployment?.status.readyReplicas })
);

const factory = await graph.factory('direct', { namespace: 'apps', waitForReady: true });

// One declaration per resource; the ConfigMap dependsOn the Deployment.
const decls = await factory.toAlchemyResources({ name: 'fanapp', image: 'nginx', replicas: 1 });

// In the Stack body, with kroProvider in the runtime's providers:
const outputs = yield* materializeAlchemyResources(KroResource, decls);
```

Because the ConfigMap reads the Deployment's live `status.readyReplicas`, its declaration `dependsOn` the Deployment. Alchemy therefore deploys the Deployment first, captures its live status, and only then deploys the ConfigMap — resolving the cross-resource reference against real cluster state.

## Kro mode: RGD + instance (+ singleton owners)

In KRO mode, `toAlchemyResources` returns the composition's RGD and a CR instance that `dependsOn` it — preceded by a declaration for each **singleton owner** the composition depends on (each its own RGD + instance). A composition with no singletons therefore yields exactly two declarations:

```typescript
const factory = await graph.factory('kro', { namespace: 'apps' });

const decls = await factory.toAlchemyResources({ name: 'web', image: 'nginx', replicas: 3 });
// (any singleton owners' RGD + instance come first, deps-first)
// decls[-2] → the composition's RGD
// decls[-1] → its CR instance (dependsOn the RGD + any singleton instances)

const outputs = yield* materializeAlchemyResources(KroResource, decls);
```

Alchemy applies singleton owners and the RGD first, then the instance, and the Kro controller reconciles the rest at runtime — each piece tracked as its own state entry. Singleton owners use deterministic ids, so a singleton shared across compositions is deduplicated to one state entry. Singleton **spec-drift protection** is enforced at reconcile time: deploying a singleton identity whose live spec fingerprint differs from the one being applied fails rather than silently clobbering the shared owner.

## Security: kubeconfig in Alchemy state

`toAlchemyResources` captures the factory's kubeconfig into each declaration's `kubeConfigOptions`, and Alchemy persists that to its state store — so that a later state-driven delete can reconnect to the cluster to remove the resource.

This means: **if the kubeconfig uses static credentials (`token`, `certData`, `keyData`), those credentials land in Alchemy's state store.** To avoid persisting long-lived secrets:

- Prefer **re-derived auth** — an `exec` credential plugin (e.g. `aws eks get-token`) or an `authProvider` — so each operation mints fresh, short-lived credentials instead of storing static ones.
- Use a **secured state backend** for your Alchemy runtime regardless, since the state store may hold connection details.

## Without Alchemy

If you don't need Alchemy's state and lifecycle management, TypeKro deploys standalone — just call the factory directly:

```typescript
const factory = await graph.factory('direct', { namespace: 'default' });
await factory.deploy({ name: 'app', image: 'nginx' });
```

## Next Steps

- [Deployment Modes](/guide/deployment-modes) - Direct vs Kro deployment
- [Custom Integrations](/advanced/custom-integrations) - Create custom factories
- [Examples](/examples/basic-webapp) - See more patterns
