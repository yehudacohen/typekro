# RFP: TypeKro Semantic Planning Architecture

- **Status:** Proposed, implementation-informed revision
- **Audience:** TypeKro maintainers, Alchemy maintainers, integration authors, and downstream platform teams
- **Baseline:** TypeKro v0.28.1 (`744ba08`)
- **Estimate rebaseline:** 2026-07-22 against the current experimental branch
- **Estimate confidence:** High for semantic/compiler completion; medium-high for the bounded
  lifecycle and host-parity tail after the corrected representative matrix and focused reruns
- **Purpose:** Define TypeKro's eventual planning and compilation architecture, its boundary with durable execution systems, and the migration required to reach that architecture without overstating portability or losing existing semantics.

## 1. Executive Summary

TypeKro is already a capable TypeScript authoring system for Kubernetes and KRO. It contains mature machinery for resource identity, dependency tracking, conditional resources, aspects, schema generation, CEL expressions, direct deployment, KRO compilation, singleton ownership, prerequisites, readiness, discovery, deletion, Alchemy declarations, container builds, and several integration-specific lifecycle workflows.

The architectural problem is not a lack of execution features. It is the lack of one public representation that faithfully describes the Kubernetes intent accepted by TypeKro. Integrations currently recover that intent from a mixture of resource objects, WeakMap metadata, private composition fields, singleton definitions, YAML, factory behavior, and deployment results. Deployment targets, execution hosts, and serializers can consequently reinterpret the same composition in different ways.

This proposal establishes the following boundary:

> **TypeKro owns a lossless semantic plan for accepted Kubernetes intent and compiles it into target-specific artifact plans. Alchemy owns durable orchestration, state, and non-Kubernetes provider lifecycles.**

Four concerns that are easy to conflate are explicitly orthogonal in this architecture:

- the **deployment target** is `direct` or `kro` and decides how application resources are
  represented and who, if anyone, continuously reconciles them;
- the **execution host** is standalone TypeKro or Alchemy and decides who invokes operations and
  persists lifecycle state;
- the **output form** is live execution or static serialization; and
- the **artifact apply mechanism** is create-or-patch, create-only, server-side apply, or replace
  for Kubernetes artifacts TypeKro itself writes.

Alchemy and server-side apply are therefore not deployment targets. KRO already uses
server-side apply internally for graph children; TypeKro does not replace or configure that child
reconciler merely because it supports server-side apply for its own artifacts.

The word **accepted** is important. TypeKro cannot promise lossless planning for arbitrary JavaScript, ambient filesystem state, runtime callbacks, plaintext secrets, or imperative provider calls. A planning language subset and explicit declared inputs define the portability boundary. Unsupported behavior must produce structured diagnostics rather than silently changing meaning.

This is an evolutionary change, not a flag-day rewrite. Existing public deployment and YAML APIs remain facades while the plan and compilers gain parity behind them. The first funding decision should cover the responsibility boundary, conformance fixtures, and an internal IR prototype. Public DTOs and representation migrations should not freeze until the prototype proves that TypeKro's difficult existing cases can be represented.

The existing authoring surface is a protected asset, not scaffolding to replace. In particular,
this proposal preserves `aspect.on(...)`, callable compositions and proxies, direct and KRO factory
interfaces, the existing `toYaml()` overloads, deployment closures, eager `container()`, standalone
Harbor APIs, Promise-returning operations, and the current JS-to-CEL analyzer corpus. New planning,
compiler, materialization, and Effect boundaries must attach behind those APIs or be introduced as
clearly separate lower-level operations.

## 2. Goals

1. Make ordinary TypeScript composition authoring predictable across direct and KRO modes.
2. Expose complete accepted Kubernetes intent without private reflection, YAML parsing, or execution.
3. Preserve values, references, expressions, arrays, omissions, sensitivity, identity, activation, aspects, ownership, readiness, and dependencies through canonical serialization.
4. Compile one target-neutral desired-state plan into direct Kubernetes or KRO artifact plans.
5. Make standalone execution, Alchemy-hosted execution, and YAML serialization consume artifact
   plans instead of reconstructing semantics.
6. Fail explicitly when planning is nondeterministic or a target or adapter cannot represent a required capability.
7. Unify validation, readiness, status, diagnostics, and lifecycle semantics across execution paths.
8. Retain safe standalone Kubernetes deployment, discovery, compensation, and deletion without creating a general durable state engine.
9. Establish permanent direct/KRO conformance coverage for public integrations and semantic features.

## 3. Non-Goals

TypeKro will not own:

- A generic durable infrastructure state backend.
- Cross-provider revision management or transactional orchestration.
- A general provider plugin runtime for DNS, object storage, Harbor APIs, databases, or cloud APIs.
- Generic retry queues, worker leasing, concurrency scheduling, or durable rate limiting.
- Encryption and persistence of provider secrets and outputs.
- Generic provider compensation or recovery after process interruption.
- Applik8s's application model, commands, queries, UI model, or provider-neutral semantics.
- KRO controller behavior that can only be corrected upstream.
- Lossless serialization of unrestricted JavaScript or undeclared ambient effects.
- A guarantee that every current direct-only escape hatch becomes portable.
- Encoding Effect programs, services, layers, causes, fibers, or scopes in semantic or artifact DTOs.
- Replacing TypeKro's authoring language, proxy semantics, closure analysis, JS-to-CEL lowering, or
  integration APIs merely to adopt an Effect runtime.
- Using Effect Workflow or another TypeKro-owned durable workflow engine in place of Alchemy.
- Introducing a TypeKro operator merely to repeat direct-mode server-side apply continuously.
- Treating Alchemy, YAML, or an API-server apply mechanism as a third deployment target alongside
  direct and KRO.

## 4. Responsibility Model

### 4.1 TypeKro

TypeKro owns:

- TypeScript composition authoring and type inference.
- Schema analysis and the portable direct/KRO validation profile.
- Resource references, expression analysis, CEL generation, and direct evaluation.
- Logical Kubernetes identity and symbolic physical identity.
- Explicit aspects and declared planning inputs.
- Resource activation, readiness requirements, typed dependency edges, and lifecycle intent.
- Canonical desired Kubernetes manifests and serialization.
- Target-neutral `DesiredStatePlan` production for the supported planning subset.
- Direct Kubernetes and KRO representation compilers.
- Standalone Kubernetes execution and compensation for the current transition.
- Kubernetes-specific create, apply, readiness, and deletion operation implementations regardless
  of whether standalone TypeKro or Alchemy invokes them.
- KRO RGD, instance, prerequisite, singleton, and namespace-hoisting compilation.
- YAML/GitOps serialization and unsupported-capability diagnostics.
- Alchemy declaration generation from compiled artifact plans.
- Kubernetes ownership tagging, discovery, status hydration, and safe deletion.
- Kubernetes- and KRO-specific diagnostics and conformance tests.

### 4.2 Alchemy

Alchemy owns:

- Durable state, revisions, and applied-resource history.
- Desired/applied/live diff orchestration across providers.
- Durable scheduling and invocation of provider operations and provider registries.
- Durable outputs, secret persistence, receipts, and executor compatibility.
- Retry, timeout, concurrency, rate-limit, and scheduling policy.
- Cross-provider dependency orchestration.
- Interrupted-process recovery and transactional rollback or destroy behavior.
- Container builds when represented as Alchemy resources.
- Policy and permission enforcement spanning multiple providers.

TypeKro's direct and KRO Alchemy adapters emit declarations containing dependencies, lifecycle
intent, sensitivity metadata, and Kubernetes semantics. Alchemy schedules, invokes, and persists
those declarations; the TypeKro provider implementation remains authoritative for the
Kubernetes-specific operation. Alchemy must not reinterpret a direct artifact as KRO-managed,
independently reimplement TypeKro readiness or deletion semantics, or select a different apply
mechanism from the compiled artifact plan.

### 4.3 Application Platforms

Applik8s and similar platforms own their application model, provider-neutral product semantics, commands, queries, and user workflows. They translate application intent into TypeKro compositions and non-Kubernetes Alchemy resources. They must not need to inspect TypeKro private fields, replay composition functions, or parse emitted YAML to understand the Kubernetes subgraph.

### 4.4 KRO and Kubernetes

KRO owns reconciliation of ResourceGraphDefinitions and instances, server-side application and
ApplySet membership of graph children, controller finalizers, runtime CEL evaluation, and
supported root-status projection. Kubernetes owns API defaulting, normalization, admission, field
management, garbage collection, and resource finalizers.

TypeKro must model these behaviors accurately and diagnose known normalization or representation gaps. It cannot fix a controller comparison defect solely by changing its own plan model.

### 4.5 Effect v4 Runtime Boundary

TypeKro will incrementally use Effect v4 as its in-process operational substrate for compiler orchestration,
materialization, standalone Kubernetes execution, diagnostics, observability, cancellation, and
resource safety. Effect does not become TypeKro's semantic model or expand TypeKro's durability
responsibilities.

In this document, capitalized **Effect** names the Effect library and runtime. Lowercase “side
effect” describes an ordinary externally observable operation.

The following contracts remain immutable, runtime-neutral, canonically serializable data:

- `CapturedCompositionIR` projections exposed through public DTOs;
- `CompositionInspection` and `DesiredStatePlan`;
- `PlanValue`, `ExpressionIR`, and `SchemaIR`;
- direct and KRO artifact plans;
- lifecycle, apply, sensitivity, provenance, and diagnostic records; and
- Alchemy declarations and YAML bundles.

No serialized contract contains an `Effect`, `Layer`, service tag, `Cause`, `Fiber`, `Scope`, or
runtime closure. Effect services may supply operational capabilities, but any service input that
can change semantic intent or compiled artifacts must first be represented as a declared planning,
compiler, or materialization input and must participate in the appropriate digest. Dependency
injection is not an undeclared semantic-input channel.

Adoption is adapter-first. Existing Promise-based clients, analyzers, compilers, deployment
engines, readiness evaluators, rollback managers, and deletion workflows are initially lifted into
typed Effect programs without changing their algorithms. Fallible Promise adapters use
`Effect.tryPromise` with explicit domain-error mapping and forward Effect's `AbortSignal` into
underlying Kubernetes operations; `Effect.promise` is reserved for operations that cannot reject.
Native Effect implementations are then introduced selectively where scopes, interruption, bounded
concurrency, schedules, streams, deterministic clocks, or structured errors materially improve
behavior.

Runtime ownership differs by execution host:

- A standalone Promise facade provides one operation-scoped service layer and runs one top-level
  Effect program. Acquired clients, watches, and cleanup resources are released when that operation
  scope closes.
- An Alchemy provider returns or yields an Effect into Alchemy's existing runtime and must not call
  `Effect.runPromise`, create a nested managed runtime, or start a second orchestration loop.
- A reusable `ManagedRuntime` is permitted only for deliberately shared, long-lived services with
  explicit ownership and disposal. It is not the default facade implementation, especially for
  kubeconfig-dependent clients.

Promise compatibility includes failure shape. Public Promise facades reject with the existing
TypeKro domain error classes and messages, not an Effect `FiberFailure` or exposed `Cause`.
Top-level adapters interpret typed failures and defects explicitly before crossing back into the
Promise API. Effect cancellation is not considered implemented when a non-interruptible Promise is
merely wrapped; the cancellation signal must reach the underlying operation or the adapter must
diagnose that limitation.

The semantic frontend is a protected boundary. Effect adoption by itself must not change:

- ordinary TypeScript composition syntax or factory integration authoring;
- proxy and reference behavior;
- accepted closure syntax or closure signatures;
- source analysis, expression IR, direct evaluation, or emitted CEL;
- ArkType interpretation, `SchemaIR`, or generated validation schemas; or
- canonical manifests, YAML, diagnostics, readiness, status, or lifecycle semantics.

Changes to those systems require a separate semantic proposal and conformance evidence. Effect
syntax is not part of the portable TypeScript expression subset, and integration authors are not
required to import Effect. TypeKro's existing Promise facades remain the default public API and run
each operation through one operation-scoped Effect program at the outer boundary. No stable
`typekro/effect` export is
part of the initial migration. If concrete downstream demand appears after the internal service
model stabilizes, an Effect-native facade begins under an experimental subpath and must execute the
same programs as the Promise facade.

Effect remains an in-process runtime. Alchemy continues to own durable state, retries, scheduling,
provider execution, interrupted-process recovery, and cross-provider orchestration. TypeKro does
not use Effect Workflow to recreate those responsibilities.

While Effect v4 remains pre-stable, TypeKro pins and tests one coherent Effect dependency cohort,
including `effect`, `@effect/platform-*`, `@effect/vitest`, and Alchemy's supported peer range.
Exact-pinning only the root `effect` package is insufficient when transitive Effect packages resolve
to incompatible beta revisions. CI verifies the installed cohort and packed-package behavior.

### 4.6 Existing Provider-Like APIs

TypeKro v0.28.1 includes useful imperative workflows outside a pure Kubernetes desired-state graph. Harbor project and robot reconciliation is the clearest example. Those APIs remain supported compatibility resolvers, but they are not silently reclassified as portable plan nodes.

Each such workflow must choose one migration path:

1. remain a documented standalone, direct-only operation with no cross-process durability guarantee;
2. become an Alchemy-owned provider resource referenced by the Kubernetes plan through declared outputs; or
3. be deprecated after a replacement is available.

The current Harbor API chooses path 1 as its compatibility contract. Its injected client,
reconciliation functions, deletion confirmation, timeout, and `AbortSignal` behavior remain
supported. TypeKro may add an Alchemy resource adapter over the same implementation for callers
that need durable ownership, but that adapter does not make the standalone API deprecated and does
not move Harbor provider state into the Kubernetes semantic plan.

The plan may describe a declared external requirement and its output binding. TypeKro does not execute an arbitrary provider operation as part of pure planning or static YAML compilation.

## 5. Target Architecture

```text
Composition definition + explicit composition identity
                         |
                         v
              Captured Composition IR
                         |
              authoring transforms
              (ordered aspects)
                         |
             +-----------+------------+
             |                        |
             v                        v
  CompositionInspection       DesiredStatePlan(spec,
  (potential capabilities)     declared inputs, aspects)
                                      |
                         +------------+-------------+
                         |                          |
                         v                          v
              Direct Artifact Plan         KRO Artifact Plan
                         |                          |
              +----------+---------+       +--------+---------+
              |          |         |       |        |         |
          standalone  Alchemy    YAML   standalone Alchemy   YAML bundle
           executor    adapter serializer installer  adapter serializer
```

The two artifact-plan branches are deployment targets. Standalone and Alchemy are execution hosts
for either target. YAML is an output form rather than an execution host. Artifact apply mechanisms
are properties of executable Kubernetes artifact operations below these branches; they are not
additional branches in this diagram.

`CompositionInspection` and `DesiredStatePlan` are sibling projections of the same internal capture. `plan()` does not serialize or consume the public inspection DTO. The capture is also the destination for removing repeated composition execution and repeated source-analysis passes.

`DesiredStatePlan(spec, ...)` binds one instance's explicit inputs, but it must not destructively
specialize the composition template before target compilation. Resource desired values,
activation, readiness, and dependency expressions remain symbolic `PlanValue`/`ExpressionIR`
records that may reference the bound root spec. The direct compiler materializes those records for
the concrete instance. The KRO compiler emits the same symbolic records into a shared RGD and emits
the concrete spec only in the instance artifact. Consequently, two plans for different specs may
have different instance/input digests while compiling to byte-equivalent RGD graph content when
the composition structure is unchanged. A planner that derives semantic nodes only from an already
resolved direct deployment graph does not satisfy this invariant, even if direct execution happens
to be correct.

Aspects are ordered authoring transforms and therefore part of planning inputs and digests. They must run before the target-neutral desired plan is finalized. The existing `aspect.on(...)` DSL remains authoritative. Its manifest derives stable identity from registered target identity and surface semantics, records canonical selector, operation configuration, and order, and uses the aspect IR revision rather than requiring a parallel author registration API. Function source text is never authoritative aspect identity. A target-specific aspect rule that cannot be expressed portably must declare the capability it requires and fail for unsupported targets.

Representation compilers may introduce artifacts that are not application intent, including RGDs, KRO instances, hoisted Namespaces, and prerequisite ordering. The captured IR and plan expose any factory-specific representation requirements as versioned compiler inputs; compilers may not recover them from hidden factory behavior. Execution adapters may add runtime wrappers such as Alchemy declarations. Neither layer may reconstruct composition semantics independently. Selecting an execution host must not change the compiled Kubernetes representation or its effective apply policy.

Effect v4 begins at the operational boundary after target-neutral planning. `inspect()` and
`plan()` remain synchronous, deterministic, and runtime-free. Given complete explicit inputs,
`DesiredStatePlan -> ArtifactPlan` lowering is also an ordinary pure function. Effect may
orchestrate compilation only where materialization, discovery, filesystem access, tracing, or
another declared operational service is actually required; it is not mandatory ceremony around
pure AST transforms. Materialization and standalone execution may use Effect. Effect services provide operational dependencies
such as Kubernetes access, clocks, logging, tracing, artifact resolution, and
environment-dependent canonicalization. They consume and produce the runtime-neutral contracts
shown above; they do not become nodes in the semantic graph. Alchemy adapters emit declarations
from artifact plans and then yield ownership of durable execution to Alchemy rather than running a
second TypeKro orchestration loop inside the provider.

## 6. Public Contracts

The intended high-level API is:

```ts
const inspection = composition.inspect();
const planOptions = {
  aspects,
  inputs,
  strict: true,
} satisfies PlanOptions;

const plan = composition.plan(spec, planOptions);

const direct = composition.factory('direct', {
  plan: planOptions,
  compiler: directCompilerOptions,
  execution: directExecutionOptions,
});
await direct.deploy(spec);

const kro = composition.factory('kro', {
  plan: planOptions,
  compiler: kroCompilerOptions,
  execution: kroExecutionOptions,
});
const yaml = kro.toYaml(spec);
```

Conceptually, the normalized internal selection is two-dimensional even though the existing
facades already express it without introducing a new public host option:

```ts
type DeploymentTarget = 'direct' | 'kro';
type ExecutionHost = 'standalone' | 'alchemy';
```

`factory('direct' | 'kro')` selects the deployment target. Calling `deploy()` uses standalone
execution, while `toAlchemyResources()` adapts the already-selected target for Alchemy. The
existing `DeploymentOptions.mode: 'alchemy'` value is a compatibility execution-context marker,
not a third target, and should be internalized or deprecated after state and API migration
coverage exists. No `factory('alchemy')` API is introduced.

Every facade must accept or bind the same `PlanOptions` used by explicit `plan()`. Compatibility overloads may continue accepting top-level `aspects`, but they must normalize into `PlanOptions`; they may not maintain a parallel planning-input path. Compiler, materialization, and execution options remain separate namespaces. Existing facades must eventually delegate to the same planning and compilation pipeline. An explicit lower-level API is also required for integrations:

The nested `compiler` and `execution` objects above describe an eventual normalized option layout,
not a replacement signature required in the first release. Existing `PublicFactoryOptions`,
top-level execution fields, and `factory('direct' | 'kro', options)` remain source-compatible while
the implementation introduces internal normalization. Unsupported future option namespaces are
not advertised until their compilers exist.

```ts
const plan = composition.plan(spec, planOptions);
const artifact = composition.compile(plan, { target: 'kro', ...compilerOptions });
const bundle = artifact.toYamlBundle(materializationBindings);
```

Promise-returning facades remain the ordinary API. A standalone facade runs one top-level Effect
program with an operation-scoped layer at the outer API boundary. An Alchemy adapter yields the
same underlying program to Alchemy's runtime instead of running it itself. Neither path creates a
nested runtime per node or resource. A public Effect-native facade is deliberately deferred. If one
is later introduced experimentally, its compatibility requirement is to expose the same plan,
artifact compiler, and executor programs rather than a second implementation.

Illustrative contracts:

```ts
type CompositionIdentity =
  | {
      name: string;
      apiVersion: string;
      kind: string;
      stability: 'stable';
      revision:
        | { kind: 'version'; value: string }
        | { kind: 'bundle-digest'; value: string };
      diagnosticSourceDigest?: string;
    }
  | {
      name: string;
      apiVersion: string;
      kind: string;
      stability: 'preview-unstable';
      diagnosticSourceDigest: string;
    };

interface AspectManifestEntry {
  id: string;
  revision: string;
  configuration: PlanValue;
  order: number;
}

type DeclaredInputManifestEntry =
  | { name: string; kind: 'ordinary'; value: PlanValue }
  | { name: string; kind: 'sensitive'; binding: string; version?: string }
  | { name: string; kind: 'artifact'; requirement: ArtifactRequirement };

interface RepresentationRequirement {
  target: 'direct' | 'kro';
  kind: string;
  extension: string;
  version: number;
  inputs: PlanValue;
}

interface CanonicalizerManifestEntry {
  id: string;
  revision: string;
  stage: 'desired';
}

interface StatusContract {
  persistedSchema: SchemaIR;
  hydratedSchema: SchemaIR;
  projections: readonly StatusProjection[];
}

interface PlanOptions {
  aspects?: readonly AnyAspectDefinition[];
  inputs?: Readonly<Record<string, DeclaredInputBinding>>;
  strict?: boolean;
}

interface CompositionInspection {
  version: 1;
  composition: CompositionIdentity;
  specSchema: SchemaIR;
  status: StatusContract;
  potentialCapabilities: readonly CapabilityRequirement[];
  diagnostics: readonly PlanDiagnostic[];
}

interface DesiredStatePlan {
  version: 1;
  composition: CompositionIdentity;
  schemas: {
    irVersion: 1;
    spec: SchemaIR;
    specDigest: string;
    persistedStatusDigest: string;
    hydratedStatusDigest: string;
  };
  status: StatusContract;
  instance: LogicalInstanceIdentity;
  spec: PlanValue;
  nodes: readonly PlanNode[];
  edges: readonly PlanEdge[];
  outputs: Readonly<Record<string, PlanValue>>;
  inputs: readonly DeclaredInputManifestEntry[];
  aspects: readonly AspectManifestEntry[];
  representationRequirements: readonly RepresentationRequirement[];
  provenance: {
    canonicalizers: readonly CanonicalizerManifestEntry[];
  };
  requiredCapabilities: readonly CapabilityRequirement[];
  durability: {
    cacheEligible: boolean;
    provenanceEligible: boolean;
    reasons: readonly PlanDiagnostic[];
  };
  inputDigest: string;
  aspectDigest: string;
  semanticContentDigest: string;
  planIdentityDigest: string;
  diagnostics: readonly PlanDiagnostic[];
}

interface DirectKubernetesArtifactPlan {
  version: 1;
  planIdentityDigest: string;
  compiledArtifactDigest: string;
  resources: readonly DirectKubernetesArtifactResource[];
  diagnostics: readonly PlanDiagnostic[];
}

interface KroArtifactPlan {
  version: 1;
  planIdentityDigest: string;
  compiledArtifactDigest: string;
  resources: readonly KroArtifactResource[];
  diagnostics: readonly PlanDiagnostic[];
}
```

The composition identity carries the root API version and kind, the normalized instance `spec` is
explicit plan data, and the complete spec `SchemaIR` is carried in the plan. The KRO compiler needs
all three to generate the root CRD and instance without consulting captured executable state. The
schema digest remains adjacent for identity checks and efficient comparison. Persisted and
hydrated status schema bodies live in the `StatusContract` and their digests remain in `schemas`
for the same reason.

Artifact resources contain explicit role, scope, readiness, binding, lifecycle, and operation
records. Direct application resources carry an artifact apply policy. In a KRO artifact plan, only
resources TypeKro applies directly, such as prerequisites, hoisted Namespaces, singleton owner
artifacts, the RGD, and the instance CR, carry that policy. Templates reconciled as KRO graph
children do not: KRO's controller owns their apply mechanism and field management.

Inspection reports capabilities the composition may require. Planning reports capabilities actually required by the supplied spec, aspects, declared inputs, and representation requirements. Compilers and adapters negotiate against the realized requirements.

A `preview-unstable` identity is permitted only for local experimentation when no explicit
composition revision is available. The resulting plan is ineligible for durable caches,
provenance claims, or durable adapters. Those consumers must reject it with a structured
diagnostic. `diagnosticSourceDigest` can help compare local previews but never becomes the
revision. A future compiler-produced bundle digest may become stable only after the separately
gated build-boundary work is complete.

## 7. Determinism and the Supported Planning Subset

Planning must be free of undeclared external influence:

> Given the same stable captured composition identity, explicit spec, ordered aspect manifest, and declared input manifest, planning produces the same canonical semantic content.

Planning may evaluate supported composition code and defaults. It must not contact Kubernetes, build containers, invoke providers, read undeclared environment variables or files, or depend on time, randomness, import-time mutation, or other ambient state.

An explicit composition version is the preferred stable identity. A compiler-produced module or bundle digest is an acceptable automatic identity when TypeKro controls the build boundary and inputs. A digest derived from `Function.prototype.toString()` is diagnostic only: transpilers, minifiers, closures, and runtime differences make it unsuitable as a durable cache or provenance key. The same prohibition applies to aspect function text.

For the initial planning release, the optional composition-definition `revision` is the only
stable identity accepted for durable use. `bundle-digest` remains a reserved identity kind until a
separate build integration proves that TypeKro controls all relevant source, configuration, and
transformation inputs. The planning project does not introduce a mandatory TypeKro build command.

TypeKro must publish the supported planning subset and produce source-located diagnostics for rejected syntax or effects. That subset begins with the behavior already protected by the natural-TypeScript, proxy, closure-analysis, source-map, direct-evaluation, and emitted-CEL corpus; planning must not redefine it as a smaller greenfield grammar. The existing `fn.toString()` plus Acorn pipeline and its runtime self-test remain the compatibility frontend. Compiler-assisted source capture may augment that pipeline later, but is not a prerequisite for planning. Strict and development modes may plan twice and compare semantic content digests, but double evaluation is a detector, not a proof of purity.

## 8. Plan Model

### 8.1 Values and Expressions

`PlanValue` canonically represents:

- JSON primitives, arrays, objects, and intentional omission;
- spec references and resource field or status references;
- portable `ExpressionIR`;
- activation guards;
- sensitive bindings and tainted derived values;
- declared external inputs and unresolved artifact outputs.

Explicit CEL and natural TypeScript expressions lower into shared expression IR when portable. Raw CEL remains a KRO-constrained escape hatch. A plan using raw CEL declares that target capability; direct compilation must reject it unless a proven direct evaluator exists.

### 8.2 Sensitive Values

Serializable plans contain references, never plaintext secret material:

```ts
interface SensitiveValueRef {
  kind: 'sensitive-binding';
  binding: string;
  version?: string;
}
```

Canonical JSON redacts sensitive values. Digests include stable binding identity and optional version, never secret bytes. In-memory execution may hold opaque resolver handles outside the serializable DTO, but `JSON.stringify(plan)` must not expose plaintext.

The authoring API builds on the experimental `sensitiveValue(binding, version)` value and
sensitive entries in `PlanOptions.inputs`; it does not introduce another binding syntax. An
operational resolver receives the opaque binding identity and returns materialization data outside
the plan. Synchronous `toYaml()` never performs network, environment, or secret-store lookup. It
either serializes an explicitly supplied immutable/secret materialization or fails with the exact
unresolved binding names. Async materialization may resolve bindings before serialization.

Existing inline Kubernetes `Secret` literals require an explicit policy:

- local in-memory execution may accept them as ephemeral materialization values;
- serializable plans and GitOps output require named sensitive bindings; and
- static YAML secret materialization is an explicit opt-in operation with a prominent diagnostic.

The same rule applies to cluster credentials persisted by durable adapters. The Alchemy adapter now
defaults to re-reading the host's default kubeconfig, supports explicit default/file source
identities through `alchemyKubeConfig`, and represents detected static tokens, certificates, keys,
nested auth-provider credentials, and secret-bearing exec fields only as JSON-pointer-to-environment
bindings. Declaration construction fails before state creation when detected credential bytes are
unbound. The provider resolves bindings inside the operation host and rejects both unresolved
bindings and manually supplied inline durable credentials. Re-derived `exec` or auth-provider
configuration remains serializable only when it contains no detected secret bytes. This is a
Kubernetes connection-materialization policy; Alchemy still owns durable state and provider
operation hosting.

Taint propagates through expressions and outputs. Tainted data may not be projected into Kubernetes status.

### 8.3 Identity

Every node has a stable logical ID. Kubernetes physical identity remains symbolic until materialization:

```ts
interface KubernetesIdentity {
  apiVersion: string;
  kind: string;
  name: PlanValue;
  namespace?: PlanValue;
  scope: 'cluster' | 'namespaced';
}
```

Execution results preserve resolved physical identity for status, deletion, diagnostics, and durable adapters.

### 8.4 Typed Edges

Dependencies remain semantically distinct:

```ts
type PlanEdge =
  | { kind: 'output'; producer: NodeId; consumer: NodeId; output: string }
  | { kind: 'existence' | 'ready'; prerequisite: NodeId; dependent: NodeId }
  | { kind: 'ownership'; owner: NodeId; child: NodeId }
  | { kind: 'delete-after'; resource: NodeId; blocker: NodeId };
```

Data flow, creation ordering, readiness, ownership, and deletion ordering must not collapse into one ambiguous `dependsOn` edge.

### 8.5 Lifecycle Policy

Lifecycle policy uses orthogonal dimensions:

```ts
interface LifecyclePolicy {
  creation: 'create' | 'adopt' | 'require-existing';
  management: 'authoritative' | 'cooperative' | 'reference-only';
  deletion: 'delete' | 'retain' | 'delete-when-unused';
  instancing:
    | { kind: 'per-instance' }
    | { kind: 'per-scope'; key: PlanValue }
    | { kind: 'per-cluster' };
  sharing: 'exclusive' | 'shareable';
  unusedEvidence?: UnusedEvidence;
}
```

`delete-when-unused` must name an authoritative evidence source. TypeKro standalone fails closed when it cannot prove absence. Alchemy may use its state only when it owns execution.

The initial migration mapping is normative:

| Current concept | Plan representation |
|---|---|
| `externalRef` | `require-existing` + `reference-only` + `retain` |
| resource scopes | `per-scope` instancing plus explicit deletion policy |
| singleton | `per-scope` or `per-cluster` + `shareable` + declared unused evidence |
| owned Namespace | ordinary application node; KRO hoisting is compiler-only |
| `kroPrerequisites.resources` | versioned KRO `RepresentationRequirement`; compiler emits the artifact |
| runtime closure | standalone compatibility requirement with explicit host/output capability diagnostics |
| current conflict modes | preserve as existing-resource behavior within artifact-level `create-or-patch` during compatibility migration |

Mappings must be confirmed against fixtures before legacy metadata is removed. No mapping may infer ownership or deletion merely from creation order.

### 8.6 Semantic Management and Artifact Apply Policy

The target-neutral lifecycle `management` field records semantic ownership intent. It does not
select an API-server write primitive. Apply behavior belongs to compiled Kubernetes artifact
operations because it depends on the deployment target, artifact role, and effective compiler or
factory options.

```ts
type ArtifactApplyPolicy =
  | {
      strategy: 'create-or-patch';
      patchType?: 'merge' | 'strategic';
      existingResource: 'warn' | 'fail' | 'patch' | 'replace';
      immutableFieldPolicy: 'fail' | 'recreate';
    }
  | {
      strategy: 'server-side-apply';
      fieldManager: string;
      fieldConflictPolicy: 'fail' | 'force-owned-fields';
      immutableFieldPolicy: 'fail' | 'recreate';
    }
  | {
      strategy: 'create-only';
    }
  | {
      strategy: 'replace';
    };
```

Existing-resource behavior, SSA field-ownership conflicts, and immutable-field handling are
separate decisions. Current `conflictStrategy` compatibility options normalize into the
`create-or-patch` branch; they are not silently reinterpreted as SSA ownership policy.

The first plan-backed direct executor preserves TypeKro's current read, create, and patch behavior
and its existing conflict strategies. Server-side apply evolves the same direct executor through
an artifact-applier seam and remains explicit and opt-in until field-manager ownership, migration,
CRD handling, list/map topology, admission/defaulting behavior, and live integration fixtures are
validated. The implementation must consolidate or reuse the existing `yamlFile` server-side-apply
machinery rather than creating a competing SSA path. Replacement remains available only where the
current API explicitly requests it or a factory declares recreation safe.

KRO graph children never receive this TypeKro policy. KRO already server-side-applies those
children through its own controller and ApplySet ownership. A TypeKro policy on the RGD, instance,
prerequisite, singleton, or hoisted Namespace controls only how that outer artifact reaches the
API server.

The public option may remain in its current factory/execution namespace during compatibility
migration. Regardless of surface placement, normalization records the effective policy in the
artifact plan before either standalone or Alchemy-hosted execution begins.

The architecture does not add an SSA deployment target or a TypeKro reconciliation operator.

### 8.7 Capabilities

Capabilities are versioned and structured. Examples include raw KRO CEL, runtime closures, unresolved external outputs, sensitive materialization, status relay, rollback, and delete-when-unused evidence providers.

A compiler or adapter must either satisfy every realized capability or fail with a structured diagnostic naming the node, feature, target, and remediation. Accepting a TypeScript type never implies target portability.

Each compiler and adapter publishes a static map of capability IDs to supported major versions.
Only realized plan requirements are negotiated; potential capabilities reported by inspection do
not fail compilation. There is no implicit downgrade or ambient plugin lookup. Unused-evidence
interpreters are similarly explicit and typed, beginning with TypeKro's existing singleton
consumer evidence and Alchemy-owned state where Alchemy owns execution. This mechanism is not a
general provider-operation registry.

### 8.8 Representation Requirements

Target-specific compiler inputs are explicit, versioned plan data even when they are not application resources:

```ts
const requirement: RepresentationRequirement = {
  target: 'kro',
  kind: 'prerequisite',
  extension: 'typekro.helm-repository',
  version: 1,
  inputs: repositoryInputs,
};
```

This is the migration destination for `kroPrerequisites`, singleton-owner construction, and factory-specific lowering. Extension identity, version, and canonical inputs are mandatory. Requirements are produced by TypeKro capture and the decentralized factories actually used by a composition; they are not an ordinary author-supplied `PlanOptions` escape hatch. A compiler consumes these declarations and emits typed artifact roles; it may not consult private composition metadata or invoke hidden factory hooks to recover them.

Representation requirements are semantic compiler inputs and contribute to the semantic content digest. This deliberately makes plan identity sensitive to any declaration that can change compilation, while typed artifact nodes themselves remain exclusive to the compiled-artifact digest.

### 8.9 Container and External Requirements

Durable or deferred container builds are declared requirements, not hidden planning effects:

```ts
interface ContainerArtifactRequirement {
  kind: 'container-image';
  id: string;
  source: ContainerSourceDescriptor;
  platforms: readonly string[];
  output: ExternalOutputRef<string>;
}
```

The existing eager `await container({ context, ... })` API remains supported and continues to
resolve its context from the process working directory, compute the current content hash, build,
and return literal image coordinates before composition. A plan that receives those coordinates as
ordinary declared input does not retroactively own the build.

New deferred container source descriptors use normalized project-relative logical paths. They may
declare an explicit project root for durable identity. During compatibility migration, an implicit
working-directory root is permitted only for preview-unstable plans. Planning records the
descriptor and build configuration without reading or hashing ambient filesystem content.
Materialization computes source-content digests and immutable image bindings using the existing
builder wherever possible.

Standalone TypeKro may resolve a container requirement using its current builder. Alchemy may compile it to an Alchemy resource. Static YAML requires an explicit immutable binding and never invokes a hidden callback.

The same requirement/binding pattern applies to provider-owned outputs. The provider operation itself remains outside the target-neutral Kubernetes plan.

### 8.10 Input, Aspect, and Plan Digests

Input and aspect digest contents are normative:

- ordinary declared inputs contribute their canonical values, not only binding names;
- sensitive inputs contribute stable binding identity and optional version, never plaintext;
- artifact inputs contribute their canonical requirement descriptors;
- aspects contribute stable identity, revision, canonical configuration, and order;
- representation requirements contribute target, kind, extension identity, version, and canonical inputs;
- applied desired canonicalizers contribute identity and revision; and
- function source text is never authoritative composition or aspect identity.

The plan exposes input and aspect manifests as well as their digests so integrations can explain why two plans differ.

TypeKro defines three distinct digests:

- **Semantic content digest:** canonical accepted Kubernetes intent, schema identities, normative input and aspect manifests, lifecycle, edges, expressions, artifact requirement descriptors, versioned representation requirements, applied desired-canonicalizer identities, and normalized build configuration. It excludes timestamps, diagnostics, live state, receipts, plaintext secrets, and compiler-generated artifact nodes.
- **Plan identity digest:** composition identity, including its stable revision when present, plus the semantic content digest. It identifies who declared the semantics as well as what was declared. A preview-unstable plan may compute this digest for local comparison but is not durable-cache or provenance eligible.
- **Compiled artifact digest:** plan identity plus compiler target/version, compiler options,
  representation artifacts, effective artifact apply policies, materialized immutable bindings,
  and source-content digests.

Execution host does not contribute to semantic content or compiled Kubernetes artifact identity.
Standalone and Alchemy-hosted execution of the same artifact plan must preserve its meaning.
Alchemy declarations may have a separate adapter/state identity, but that identity cannot replace
or mutate the plan or artifact digest.

These digests serve different purposes and must not be collapsed. Semantic equivalence, provenance identity, and deployable artifact identity are not interchangeable.

Version 1 retains TypeKro's prototype encoding: recursively sorted JSON-compatible objects,
finite JSON numbers with negative zero normalized to zero, UTF-8 bytes, and SHA-256 hex digests.
Each digest layer hashes a versioned, typed envelope so the same payload cannot be confused across
schema, semantic-content, plan-identity, and artifact domains. Unsupported values fail
canonicalization instead of receiving implementation-dependent encodings.

### 8.11 Persisted and Hydrated Status

Persisted cluster status and client-hydrated status have separate schemas. Generated CRDs validate only `persistedSchema`; TypeKro client APIs return `hydratedSchema`. Hydrated status may add client-only fields, but it cannot weaken or contradict the persisted shape. Each field's projection records its source, persisted path when applicable, and mode.

Status projections are classified as live-resource, desired-spec, static, derived, or client-only. Projection mode is explicit:

```ts
type StatusProjectionMode = 'auto' | 'native' | 'relay' | 'client-only';
```

- `auto` uses native projection when representable; otherwise client hydration plus a diagnostic. It never creates a relay.
- `native` fails when the target cannot persist the projection.
- `relay` is reserved for an explicit visible compiler-generated resource with lifecycle and
  security diagnostics; initial compilers reject it until that design is approved.
- `client-only` never persists the field into cluster status.

KRO-owned root status fields, including `conditions`, `state`, and `observedGeneration`, are reserved by a versioned KRO target policy. This is a KRO compilation rule, not a target-neutral inspection or direct-planning error. The KRO compiler rejects a collision with a structured migration diagnostic; it does not silently rewrite the public typed status shape. Direct mode may continue to use the same field names where no controller owns them.

The initial compiler implements native KRO projection and current client hydration. Status relay is
deferred: `auto` never creates one, and an explicit `relay` request fails as unsupported until a
separate proposal defines its resource, RBAC, lifecycle, retention, and data model.

### 8.12 Canonicalization Boundary

A desired-manifest canonicalizer changes semantic content and therefore must be deterministic, cluster-independent, identified, and versioned. It runs before semantic digesting. Every applied desired canonicalizer appears in plan provenance, and its identity and version contribute to the semantic content digest.

Desired canonicalizers extend the existing decentralized `registerFactory()` mechanism; TypeKro
does not add a second public registry. Lookup uses full `apiVersion` plus `kind`, not kind alone.
Repeated identical registration is idempotent for module reloads and aliases. Conflicting
canonicalizer identities or revisions for the same GVK fail loudly so semantic output cannot vary
with unrelated import order. Factory-specific representation producers must retain provenance to
the factory/resource actually used rather than running every registration that happens to share a
kind.

Canonicalization that depends on Kubernetes version, API discovery, admission, defaulting, or live state is not desired-state canonicalization. It runs during compilation or materialization, records the relevant environment identity, and contributes to the compiled-artifact digest. Live canonicalizers used only for comparison are likewise outside semantic planning.

## 9. Artifact Plans and Serialization

An artifact plan is the complete deployable representation for one planned instance, not merely the most prominent manifest.

A KRO artifact bundle classifies resources by role:

- prerequisites and singleton owners required by this deployment;
- hoisted application resources such as Namespaces;
- ResourceGraphDefinition;
- composition instance;
- future relay artifacts only after a separate relay proposal is approved.

The bundle records ordering and lifecycle relationships. The compiler must distinguish a prerequisite representation artifact from a true application resource.

A direct artifact plan similarly contains all resolved Kubernetes resources, apply policies, ordering, activation, readiness, and reference materialization requirements.

Artifact plans must survive canonical JSON round trips without reconstructing semantics from
flattened manifests. They explicitly serialize binding and reference IR, resource scope, readiness
strategy identity, artifact role, deletion contract, and logical and symbolic physical identity.
Alchemy adaptation must not depend on scanning `${...}` strings, recovering WeakMap brands, or
guessing readiness behavior after state rehydration.

Existing `toYaml()` overloads remain compatibility facades with their current behavior. Direct
`toYaml(spec)` emits the resolved direct manifests or rejects unresolved runtime references. KRO
`toYaml()` emits prerequisites, singleton-owner definitions, and the RGD side; KRO `toYaml(spec)`
emits hoisted Namespaces, singleton-owner instances, and the composition instance side. These
overloads are not repurposed. A lower-level artifact serializer may add an unambiguous
`toYamlBundle(...)` operation that combines both KRO sides in dependency order. Static serialization fails
on unresolved outputs or sensitive values unless the caller supplies explicit immutable or
sensitive materialization bindings.

## 10. Workstreams

### Workstream 0: Re-baseline v0.28.1 and Establish Conformance

TypeKro v0.28.1 already adds bounded Kubernetes reads, strict overall readiness deadlines, final-read behavior, cancellation scoping, and focused tests. Preserve that behavior and extract reusable pure readiness predicates only where current call sites still duplicate semantics.

Additional work:

- verify and repair the `typekro/advanced` Node 22 packed-package import if still reproducible;
- make root and subpath imports quiet and side-effect-free;
- move original composition and schema capture out of enumerable/private status fields into internal capture metadata;
- inventory existing duplicate-delete 404 coverage and add only missing regression cases;
- audit vulnerable or deprecated dependency chains;
- create a machine-readable conformance registry and the parity fixtures listed below.

Acceptance: packed imports pass on supported Node versions and Bun; imports emit no logs; the v0.28.1 timeout guarantees remain covered; initial conformance fixtures run against legacy behavior.

### Workstream 1: Canonical PlanValue and Expression IR

- Introduce versioned `PlanValue` and `ExpressionIR`.
- Lower explicit CEL, computed expressions, aliases, and supported natural TypeScript into shared IR.
- Preserve arrays, omissions, references, and Kubernetes object shape exactly.
- Implement canonical encoding, decoding, and sensitivity propagation.
- Make direct evaluation and KRO CEL emission consume the same IR.
- Feed the existing analyzer output into the IR and preserve its current accepted expression corpus;
  do not introduce a smaller parallel expression language.
- Publish unsupported syntax and side-effect diagnostics while retaining the current source
  analysis and source-map pipeline as the compatibility frontend.
- Add strict double-planning diagnostics.

Acceptance: canonical round trips are structurally equivalent, secrets cannot leak through the DTO, and direct/KRO expression corpora agree for portable expressions.

### Workstream 2: Schema IR and Portable Validation

- Introduce versioned `SchemaIR` with canonical digests.
- Model persisted and hydrated status schemas separately and validate generated CRDs against only the persisted schema.
- Define a conservative portable ArkType subset before claiming direct/KRO parity.
- Preserve defaults, optionality, unions, arrays, patterns, lengths, and numeric bounds where supported.
- Fail unsupported schema semantics with source-located diagnostics.
- Keep target-specific validation extensions explicit.

Acceptance: every accepted portable schema has equivalent direct and KRO fixtures; rejected constructs fail before execution.

### Workstream 3: Captured Composition IR, Inspection, and Planning Prototype

- Capture composition semantics once for inspection and planning.
- Add `inspect()` and `plan(spec, options)` experimentally.
- Make aspects and declared external inputs explicit planning inputs with canonical manifests and normative digest rules.
- Require an explicit composition revision for durable v1 plans; keep automatic bundle identity
  reserved until TypeKro owns a build boundary.
- Derive aspect manifest identity from the existing registered target/surface DSL, canonical
  configuration, and order; do not add a parallel aspect-definition API.
- Project WeakMap metadata into versioned public DTOs.
- Assign stable logical and symbolic physical identities.
- Translate references, activation, readiness, ownership, deletion, and guarded access into typed edges and policies.
- Classify readiness along two independent axes: canonical `readyWhen` expressions describe the
  portable readiness predicate, while a versioned strategy identity describes any richer polling
  behavior such as generation freshness, terminal-failure detection, or diagnostic details.
  Deterministic evaluators over the live object plus serializable configuration become registered
  strategies. Evaluators requiring a process clock, ambient state, or opaque code remain explicit
  runtime requirements. Never infer durable readiness identity from resource kind, function source,
  or a process-local registry side effect.
- Capture versioned representation requirements internally for prerequisites, singleton-owner construction, and factory-specific lowering rather than exposing them as ordinary author inputs.
- Add pure, deterministic, cluster-independent, identified, and versioned desired-manifest hooks to decentralized factory registration.
- Represent container/provider requirements without executing them.
- Model persisted and hydrated status separately; defer KRO-owned root-field collision checks to
  KRO compilation and reject them without silently rewriting the typed status API.
- Implement the three digest layers.

Acceptance: integrations can understand all prototype fixtures without private reflection, composition replay, or YAML parsing. This workstream is a design gate: public DTOs do not freeze until the fixture set is representable.

### Cross-Cutting Constraint: Effect v4 Runtime Adoption

- Preserve the existing authoring and semantic frontend while introducing Effect below its output
  boundary.
- Begin with a small service boundary for deployment-scoped Kubernetes clients, logging/tracing,
  and materialization resolvers. Adapt the existing deployment, readiness, watch, rollback, and
  deletion classes through those services rather than creating one Effect service per class.
- Lift current Promise-based implementations into Effect adapters before selectively rewriting
  operational hotspots. Use `Effect.tryPromise` for fallible operations, map failures into typed
  TypeKro errors, and forward cancellation signals to the underlying APIs.
- Use typed error channels for failures that prevent a result, while preserving accumulated,
  serializable plan and compilation diagnostics as data.
- Use scopes, interruption, schedules, streams, and deterministic clocks first for Kubernetes
  watches, readiness, retries, bounded deployment concurrency, compensation, and finalizer-aware
  deletion.
- Run one operation-scoped top-level program for standalone Promise facades. Alchemy adapters yield
  programs into Alchemy's runtime and never create nested runtimes. Long-lived managed runtimes
  require explicit ownership and disposal; do not hide semantic inputs in service layers.
- Keep Promise facades behaviorally compatible; if an Effect-native public API is later justified,
  introduce it only as an optional experimental subpath.
- Pin a coherent Effect v4 package cohort during its pre-stable period, enforce that cohort in CI,
  and isolate direct library coupling behind a small TypeKro runtime/service module.
- Keep Effect Workflow and durable provider orchestration outside TypeKro.

Acceptance: introducing the Effect shell produces no semantic diff in captured IR, plans, emitted
CEL, generated schemas, artifact manifests, YAML, diagnostics, readiness, status, or lifecycle
behavior. Tests can substitute operational services and deterministic clocks without changing
composition or integration code. Promise facades preserve existing TypeKro rejection types and
messages, cancellation reaches underlying operations, Alchemy providers contain no nested runtime,
and the installed Effect dependency cohort is coherent. Any later semantic-frontend change is
reviewed and gated independently.

### Workstream 4: Representation Compilers

- Compile `DesiredStatePlan` into independently versioned direct and KRO artifact plans.
- Keep complete-input `DesiredStatePlan -> ArtifactPlan` transforms pure. Use Effect only to
  orchestrate explicitly effectful compiler or materialization services.
- Add capability negotiation and structured unsupported diagnostics.
- Compile registered readiness strategies and canonical `readyWhen` expressions independently so a
  target can preserve the predicate without pretending it can reconstruct richer runtime behavior.
  A host/output adapter must reject an unsatisfied runtime strategy with the resource identity,
  strategy reason, and supported alternatives.
- Consume only explicit, versioned representation requirements for target-specific lowering.
- Introduce KRO prerequisites, RGDs, instances, and namespace hoisting only in the KRO compiler;
  add relay artifacts only after the separate relay design is approved.
- Keep application resources distinguishable from representation artifacts.
- Attach effective apply policies only to Kubernetes artifacts TypeKro writes; leave KRO-managed
  graph-child apply behavior to KRO.
- Produce host-independent artifact plans: standalone and Alchemy adaptation cannot change target,
  artifact roles, bindings, lifecycle, or apply policy.
- Preserve existing APIs as facades during migration.

Acceptance: both compilers consume the same plan and no compiler consults private composition metadata outside the captured IR.

### Workstream 5: Direct Kubernetes Executor

- Adapt the current direct engine to artifact-plan nodes and typed edges.
- Introduce an artifact-applier interface beneath the existing engine rather than a second direct
  executor or deployment mode.
- First wrap the current engine behind Effect services; migrate watches, retries, cancellation,
  bounded concurrency, compensation, and cleanup incrementally rather than rewriting the engine.
- Resolve physical identities, references, and declared bindings during execution.
- Preserve the current read/create/patch and conflict-strategy behavior as `create-or-patch`, plus
  `create-only` where an existing path deliberately creates without later mutation.
- Keep `require-existing` resources reference-only and out of the apply set.
- Consolidate the existing `yamlFile` server-side-apply implementation and CRD handling behind the
  artifact-applier interface, then expose SSA as an explicit opt-in strategy with field-manager
  migration and live conformance evidence.
- Keep current existing-resource conflict behavior distinct from SSA field-ownership conflict and
  force behavior.
- Enable replacement only where the existing API requests it or a factory declares recreation
  safe.
- Preserve current-transition compensation.
- Expose serializable discovered-instance and status summaries after restart.
- Retain Kubernetes ownership metadata as standalone TypeKro's state source.

Acceptance: current direct integrations run through the plan without semantic regression;
standalone and Alchemy-hosted execution honor the same artifact operations; opt-in SSA has live
create, repeat-apply, field-coexistence, conflict, force, omission, defaulting/admission, CRD,
immutable-field, and migration fixtures. Direct mode does not become a revision database, generic
provider engine, or continuously reconciling operator.

### Workstream 6: KRO Compiler and Executor

- Generate complete KRO artifact bundles solely from the plan and compiler options.
- Treat TypeKro's KRO executor as an installer and lifecycle client for outer artifacts; KRO's
  controller remains the reconciler and SSA field manager for graph children.
- Reuse the same Effect runtime services for standalone KRO apply, readiness, status hydration, and
  deletion without making Effect part of the generated bundle.
- Compile activation and readiness edges into safe CEL.
- Exclude inactive resources from aggregate readiness.
- Distinguish native KRO status from client-hydrated status.
- Implement `auto`, `native`, and `client-only` using current native projection and hydration.
- Reserve `relay` in the status model but reject it until a separate resource, RBAC, lifecycle,
  retention, and data-shape proposal is approved.
- Reject collisions with versioned KRO-owned root status fields; do not automatically namespace or
  alter the public typed status shape.
- Permit artifact apply policies on prerequisites, hoisted Namespaces, singleton artifacts, RGDs,
  and instance CRs, but never imply that those policies configure KRO child reconciliation.
- Gate instance admission on the RGD's current top-level `status.observedGeneration`, while
  retaining condition-level generation compatibility for older KRO status shapes.
- Compare every admitted instance spec with the desired spec immediately after apply and fail with
  exact missing paths when API-server structural-schema pruning drops a field.

Acceptance: KRO output has parity with portable direct semantics and cannot silently omit accepted
configuration. Tests prove that TypeKro apply-policy changes affect only outer artifacts and that
the KRO controller retains exclusive ownership of graph-child reconciliation.

### Workstream 7: Alchemy Adapters

- Compile direct and KRO artifact plans into separate Alchemy declaration sets.
- Preserve the current direct fan-out baseline: one state entry per artifact node, typed artifact
  edges lowered to Alchemy `Output` dependencies, and resolved dependency outputs supplied to
  TypeKro's direct binding resolver.
- Preserve the current KRO baseline: prerequisites, hoisted Namespaces, singleton owners, RGD, and
  instance CR emitted as explicit role-tagged declarations in dependency order.
- Preserve representation choice, sensitivity, lifecycle, logical identity, and physical identity.
- Invoke the same TypeKro Kubernetes artifact operations used by standalone execution instead of
  implementing Alchemy-specific apply, readiness, or deletion behavior.
- Map sensitive values to Alchemy's native mechanisms.
- Persist kubeconfig source identities or named operation-host bindings rather than plaintext
  credentials, preserve safe re-derived authentication, and fail closed with migration guidance
  when legacy state contains inline credentials.
- Let Alchemy own durable outputs, revisions, retries, provider-operation scheduling, and recovery;
  keep Kubernetes operation semantics in the TypeKro provider implementation.
- Yield TypeKro operation programs directly into Alchemy's Effect runtime; do not call
  `Effect.runPromise` or nest a competing TypeKro managed runtime, durable retry policy, or workflow
  inside Alchemy execution.
- Adapt provider and container requirements to Alchemy resources when implementations exist.
- Validate every `artifactOutput(requirementId, output)` against a declared requirement and output,
  retain requirements and sensitivity-tainted output uses in direct and KRO declarations, and let
  `materializeAlchemyResources()` bind external Alchemy resource handles. Those handles become
  dependency edges; resolved values enter provider materialization only after Alchemy resolves the
  producer, and sensitive outputs remain host-native redacted inputs through durable rehydration.
- Keep the versioned planning and artifact DTOs experimental until the parity release. Downstream
  platforms may consume them through pinned internal adapters for diagnostics and evidence, but
  must not copy, persist, or expose them as a public application contract.
- Require one Alchemy stack/scope per installation identity. TypeKro documents the namespace-agnostic
  KRO instance id and detects collisions within one declaration set; application orchestration owns
  mapping its full installation identity to a distinct stack and enforcing that invariant across calls.
- Replace the architectural use of `mode: 'alchemy'` with explicit target plus host context. Retain
  compatibility normalization long enough to migrate persisted state and callers.
- Introduce accurately named aliases for the current generic `KroResource`/`kroProvider` surface,
  which also hosts direct resources, before considering deprecation of the existing names.

Acceptance: Alchemy integrations use stable factory/provider APIs and pinned internal adapters for
experimental plan/artifact contracts; canonical JSON state
round trips preserve references, scope, readiness strategy, artifact role, and deletion semantics
without CEL-string scanning or WeakMap reconstruction; external provider handles and their public or
redacted outputs survive direct and KRO rehydration; direct and KRO behavior is equivalent under
standalone and Alchemy hosts; and TypeKro does not duplicate Alchemy state, stack identity, or
provider lifecycles.

### Workstream 8: Compatibility Closures and External Side Effects

- Keep runtime closures as documented standalone compatibility requirements. A closure is not
  inherently a direct-target feature: current standalone direct and KRO workflows may sequence a
  closure when their executor already supports it. Its portability is constrained by execution
  host and output form rather than by target compilation alone.
- Preserve current closure signatures and invoke existing Promise or synchronous closures through
  adapters; Effect generator syntax and service access are not added to the portable closure
  language.
- Represent the required operational capability in the captured and artifact contracts instead of
  rejecting it prematurely in the target compiler. Standalone adapters may satisfy that capability
  in process. Alchemy may satisfy it only through an explicit durable declaration/provider adapter
  or a declared externally satisfied requirement. Static YAML must reject an unsatisfied closure
  requirement rather than silently omit it; immutable outputs or explicit external satisfaction
  may make the remaining bundle serializable.
- Mark serialization, restart, recovery, and durability limitations in structured diagnostics.
- Keep eager standalone container building unchanged as an explicit pre-composition compatibility
  resolver; add deferred artifact descriptors separately when durable planning needs them.
- Keep the current Harbor project/robot API as a supported standalone operation with in-process
  guarantees. An optional Alchemy adapter must reuse the same client and reconciliation logic
  rather than replacing or deprecating the direct API by default.
- Require static YAML to receive immutable bindings and forbid hidden materialization callbacks.
- Do not introduce a general TypeKro provider-operation registry.

Acceptance: every compatibility closure and external side effect has an honest target, host,
output-form, and durability classification; selecting KRO does not itself reject a closure that the
standalone KRO executor can sequence, and declarative outputs never silently omit one.

### Workstream 9: Live Canonicalization and Diagnostics

- Keep desired canonicalizers pure, cluster-independent, identified, and versioned as specified in planning.
- Use the existing decentralized factory registry for known desired-state normalization. The first
  production fixture is `NetworkPolicy`: empty ingress/egress rule arrays are omitted while
  explicit or safely inferred `policyTypes` preserve isolation semantics, and the canonicalizer's
  identity/revision is recorded in plan provenance and consumed by both direct and KRO artifacts.
- Add separate compilation/materialization canonicalizers for Kubernetes-version-, discovery-, admission-, or defaulting-dependent normalization.
- Extend decentralized factory registration with full-GVK live canonicalization hooks used only
  for comparison. Identical registrations are idempotent; conflicting implementations for the same
  canonicalization identity fail during registration or compilation.
- Compare canonical desired and live forms where TypeKro owns the comparison.
- In direct `create-or-patch`, decide whether to patch from the canonical desired/live comparison;
  preserve write-through behavior for Secrets whose desired `stringData` cannot be faithfully
  compared with live encoded `data`, and leave SSA field comparison to the API server.
- Add omitted-versus-empty and Kubernetes normalization fixtures.
- Report exact drifting paths and values where observable.
- Maintain minimal upstream KRO reproductions for controller defects.

Acceptance: known normalization loops are prevented or diagnosed precisely.

### Workstream 10: Lifecycle, Discovery, and Deletion

- Preserve safe KRO finalizer and child-deletion gates.
- Return structured complete, progressing, and blocked deletion results.
- Include remaining resources, owners, finalizers, and safe retry guidance.
- Classify Namespace occupants as known graph descendants, foreign resources, or ownership
  unknown. Poll known descendants within the operation budget, retain known foreign occupants
  promptly, and fail closed with exact evidence when ownership cannot be proven.
- Treat controller-owned grandchildren, including Helm-managed Pods and completed Job Pods, as
  lifecycle evidence even when the KRO owner CR and its direct child have reached 404.
- Add explicit generated-CRD retention and zero-instance policies.
- Initially support owner references, the TypeKro owner registry, and Alchemy state as unused evidence.
- Keep historical revision restoration and cross-provider rollback in Alchemy.

Acceptance: successful deletion means the promised graph is gone or explicitly retained; incomplete cleanup names every known blocker.

### Workstream 11: Packaging and TypeScript Experience

- Keep the root entry focused on authoring essentials.
- Put integrations, Alchemy, containers, and advanced APIs behind reliable subpath exports.
- Return planning diagnostics instead of logging speculative analyzer warnings.
- Add a typed unstructured-resource escape hatch.
- Narrow direct and KRO interfaces so unsupported operations do not compile.
- Track public type complexity using representative consumer projects and `tsc --extendedDiagnostics`.
- Keep Effect implementation imports lazy or subpath-scoped where possible, maintain packed-import
  and cold-import budgets, and prevent Effect types from leaking into ordinary authoring APIs.
- Defer a stable `typekro/effect` subpath. Any initial public experiment uses an explicitly
  experimental export and is justified by a real integration use case.
- Extend the existing packed-import script rather than creating a parallel harness. Establish
  numeric import-time, package-size, and type-check budgets from measured v0.28.1 baselines before
  enforcing them as release gates.

Acceptance: imports remain quiet and lightweight and ordinary downstream projects require no unsafe casts.

### Workstream 12: Permanent Conformance Program

- Require a machine-readable matrix for public compositions and semantic features.
- Run direct and KRO execution where both are supported.
- Run the target/host matrix: direct standalone, direct Alchemy, KRO standalone, and KRO Alchemy,
  plus direct and KRO static serialization where representable.
- Assert that changing execution host does not change semantic or compiled Kubernetes artifact
  digests and that adapters reject unsupported artifact-operation capabilities.
- Add canonical serialization property tests and packed-package Node/Bun tests.
- Cover updates, deletion, restart discovery, normalization, stale generations, and interrupted cleanup.
- Make missing declared coverage fail CI.
- Maintain semantic differential fixtures proving that Effect-wrapped and legacy paths produce the
  same CEL, schemas, plans, manifests, YAML, diagnostics, and observable lifecycle behavior.
- Test interruption, scoped cleanup, retry schedules, finalizer blockers, and fake Kubernetes
  services with deterministic clocks at the Effect runtime boundary.

Acceptance: parity remains an enforceable property after the migration.

## 11. Mandatory Design Fixtures

Before public DTOs freeze, the prototype must represent and round-trip at least:

1. ordered, identified, versioned aspects that change metadata, arrays, and nested workload configuration;
2. top-level and nested compositions with defaults;
3. `includeWhen`, `readyWhen`, guarded references, and inactive resources;
4. singletons, per-scope ownership, retain/delete policies, and drift checks;
5. `kroPrerequisites`, singleton-owner construction, and factory lowering represented as explicit versioned requirements;
6. namespace hoisting, RGDs, and KRO instances with explicit artifact roles;
7. stable composition identities and preview-unstable diagnostic identities with durable-adapter rejection;
8. ordinary, sensitive, and artifact input manifests with their normative digest behavior;
9. separate persisted and hydrated status schemas, projection modes, and KRO-owned root-field collisions;
10. pure desired canonicalizer version changes and environment-dependent materialization canonicalization;
11. external references and require-existing resources;
12. runtime closures across the capability matrix: standalone direct and KRO sequencing where
    supported, Alchemy adapter or externally-satisfied diagnostics, and static-YAML rejection of
    unsatisfied runtime effects;
13. portable expressions and raw CEL escape hatches;
14. inline secrets, named sensitive bindings, tainted derivations, and status rejection;
15. container requirements before and after materialization;
16. the Harbor API reconciliation workflow classified and tested as a supported standalone
    compatibility operation, plus an Alchemy adapter fixture if that optional adapter is added;
17. omitted-versus-empty Kubernetes normalization cases;
18. direct and KRO readiness across current and stale generations;
19. YAML bundle generation with unresolved and resolved inputs;
20. the existing natural-TypeScript and closure-analysis corpus, including aliases, nested access,
    conditionals, templates, unsupported syntax, source locations, direct evaluation, and emitted
    CEL, unchanged through the Effect runtime shell; and
21. representative third-party composition integrations compiling and executing through direct and
    KRO paths without importing Effect or changing their authoring APIs;
22. canonical artifact JSON round trips that preserve references, scope, readiness strategy,
    artifact roles, deletion contracts, and apply policies without private metadata recovery, plus
    a cross-spec fixture proving that two instance bindings compile to identical KRO RGD graph
    content whenever the symbolic composition structure is unchanged while retaining distinct
    instance artifacts; and
23. the direct/KRO by standalone/Alchemy target-host matrix, including direct opt-in SSA parity and
    proof that KRO graph children remain KRO-owned;
24. standalone Promise error and cancellation fixtures proving TypeKro error compatibility and
    `AbortSignal` propagation, plus an Alchemy fixture proving no nested runtime is created; and
25. an installed-dependency fixture proving the Effect v4 core, platform, test, and Alchemy peer
    packages belong to one tested compatible cohort.

These fixtures are design evidence, not cleanup deferred to the final conformance phase.

## 12. Migration Strategy

1. Land the conformance registry and capture legacy outputs for the mandatory fixtures.
2. Introduce internal value, expression, sensitivity, schema, and composition IR without changing executors.
3. Prototype inspection and planning over current resources and metadata.
4. Prove lifecycle mappings, input/aspect manifests, split status, secrets, representation requirements, canonicalizer boundaries, provider boundaries, and artifact roles against fixtures.
5. Review and version public experimental DTOs only after the prototype gate passes.
6. Introduce an Effect runtime/service shell around existing Promise-based operational machinery and
   prove that it causes no semantic or observable lifecycle diff.
7. Move direct representation compilation onto the plan as the first semantic reference.
8. Move KRO representation compilation and readiness onto the plan.
9. Adapt standalone execution, Alchemy declarations, and YAML serialization to artifact plans.
   Preserve the existing direct per-resource fan-out and KRO prerequisite/singleton/RGD/instance
   declaration behavior while removing semantic reconstruction from serialized manifests.
10. Convert operational hotspots to native Effect incrementally, beginning with watches,
    cancellation, retries, deterministic clocks, compensation, and deletion cleanup.
11. Compare legacy, Effect-wrapped, and plan-generated semantics in snapshot and live tests
    throughout migration.
12. Keep private reflection surfaces for at least one parity-to-default release window with
    migration diagnostics.
13. Introduce the artifact-applier seam beneath the current direct engine. Preserve
    create-or-patch as the default and consolidate existing SSA machinery as an opt-in artifact
    policy rather than adding a deployment mode.
14. Normalize legacy `mode: 'alchemy'` handling into direct/KRO target plus Alchemy host context,
    with persisted-state and source compatibility coverage.
15. Preserve the current source-analysis frontend and augment it incrementally with optional
    compiler-assisted source capture where bundling or source locations require it. Explicit IR
    becomes semantic authority only after it reproduces the existing corpus; do not combine this
    semantic change with Effect runtime adoption.

Experimental formats carry no compatibility guarantee. At the parity release, major-version semantics freeze and documented additive minor evolution may begin. Decoders reject unsupported major versions with migration guidance.

## 13. Gated Sequence and Indicative Effort

### 13.1 Current implementation baseline

The estimate distinguishes three states that must not be conflated:

1. **Existing operational machinery** means TypeKro already performs the behavior in at least one
   production path and the work is to preserve it behind an explicit contract.
2. **Prototype contract** means a serializable IR or compiler exists with focused tests, but the
   public execution and serialization paths do not yet treat it as authoritative.
3. **Migrated capability** means direct, KRO, standalone, Alchemy, and YAML paths consume the same
   artifact semantics and pass the required differential and live-cluster fixtures.

The current branch contains substantially more than the v0.28.1 baseline:

- canonical `PlanValue`, `SchemaIR`, `ExpressionIR`, typed template/reference, source-location,
  sensitivity, diagnostic, and digest machinery;
- strict canonical encoders and decoders for `PlanValue`, `DesiredStatePlan`, and direct/KRO
  artifact plans, including version checks, structural validation, and digest revalidation;
- target-neutral composition inspection and `DesiredStatePlan` production with full root API
  identity, root spec schema, normalized spec values, lifecycle intent, dependencies, aspects,
  inputs, split status projections, and representation requirements captured internally;
- exact used-factory provenance, full-GVK desired canonicalizer lookup, deterministic registration
  conflict detection, and decentralized factory-owned representation-requirement producers. The
  first production desired canonicalizer now normalizes `NetworkPolicy` empty rule arrays without
  changing ingress/egress isolation, records its version in semantic provenance, and produces the
  same stable shape through direct YAML and KRO RGD compilation;
- a separate decentralized live-comparison canonicalizer contract on the same factory registry,
  with full-GVK provenance resolution, deterministic/idempotent execution checks, directional
  desired-field comparison, bounded exact JSON-path evidence, API-server metadata suppression,
  and fail-closed Secret redaction. `NetworkPolicy` supplies the first factory-owned live hook,
  standalone plus Alchemy singleton drift decisions share one exact-path verdict, and direct
  `create-or-patch` now skips API writes only after that same canonical comparison proves equality;
- analyzer-produced CEL reference/source metadata with a CST parser fallback rather than regex as
  the primary fallback, plus a shared expression-frontend lowering module for callback readiness;
- direct and KRO artifact-plan contracts and pure compilers, including artifact-local apply policy,
  KRO-owned child apply semantics, outer RGD/instance artifacts, diagnostics, and
  compiled-artifact digests;
- a plan-value materializer and direct artifact runtime adapter that preserve typed references,
  require explicit sensitive bindings, and keep external-reference artifacts outside the
  apply/rollback ownership set;
- recursive sensitive-value validation that rejects plaintext hidden beneath arrays, objects, or
  nested sensitive wrappers; inspection-time Secret-derived spec taint; and strict diagnostics for
  sensitive values used in Kubernetes identity, activation, readiness, or iteration. Control-flow
  rejection is deliberately narrower than payload materialization: sensitive values may still
  populate ordinary desired fields through explicit bindings, but may not reveal themselves via
  resource existence, readiness state/timing, or cardinality. The direct execution-record path now separates a
  durable, plaintext-free record from ephemeral materialization bindings, and the direct Alchemy
  adapter maps those bindings to Effect `Redacted` values at the host boundary rather than placing
  secret bytes in canonical plan or execution-record state;
- symbolic resource-planning contracts for captured composition templates, including spec and
  resource references, mixed expression templates, activation, readiness, explicit target-neutral
  iteration dimensions, and
  template overrides, with nested-composition status origins retained explicitly through lowering
  and enforced by the canonical value, plan, and artifact decoders. The broad checked-in
  integration corpus now passes this lowering, including sensitive values, mixed templates,
  conditionals, and the established identity forms. Direct
  materialization now expands ordinary sequential iteration dimensions deterministically, pairs
  iterated dependency edges by coordinate, and preserves compound activation through both target
  compilers. Collection aggregates and orphaned item sentinels now lower through the same explicit
  iteration model, including array spreads, nested fields, mixed literals, and representative
  integration shapes; their dedicated and corpus-wide direct/KRO fixtures pass.
  Schema-authoritative optional-reference
  metadata now survives proxy lowering and canonical round trips, absent optional values omit
  cleanly without weakening required-path failures, and direct artifacts with spec-resolvable
  activation are filtered before Kubernetes identity materialization. Those semantics have
  focused and corpus-wide regression coverage and still require live target/host validation;
- serializable readiness-strategy identities with explicit runtime bindings or registered portable
  strategies, including registered reconstruction for the generic evaluator families, built-in
  Kubernetes resources, KRO lifecycle resources, and deterministic third-party integrations.
  Evaluators that intentionally depend on a process clock or ambient state carry an explicit
  runtime-only classification, while strict planning rejects any evaluator that declares neither
  contract. The direct adapter rejects unresolved identities rather than recovering an evaluator
  by kind or private metadata. `readyWhen` conditions already lower into canonical expression IR
  for direct and KRO artifacts, but they are not currently a complete substitute for runtime
  evaluators: direct polling still requires an evaluator, and specialized evaluators can carry
  generation checks, terminal-failure classification, and richer diagnostics that a boolean
  condition does not represent; and
- focused planning/compiler tests, cross-spec KRO graph-invariance coverage, and a registry naming
  all 25 mandatory conformance fixtures.

The direct target has crossed an important architectural migration boundary. Direct factory
materialization now builds its semantic plan from captured symbolic resource templates, compiles a
direct artifact plan, materializes that plan with the concrete instance spec, and adapts the result
into the established deployment graph. Direct deploy, dry-run, direct `toYaml(spec)`, and the
existing direct Alchemy fan-out therefore receive plan-compiled desired manifests and artifact
apply policies from the same symbolic source used by the KRO compiler. A differential fixture
verifies that distinct instance specs produce identical KRO graph content while retaining distinct
concrete instance documents. Direct external-reference artifacts are pre-read into the runtime
resolution context and are never applied or rolled back.

This makes the plan-backed path authoritative by design for migrated compositions and
corpus-complete against the checked-in repository suite. The 2026-07-22 full repository rebaseline,
run through the actual `bun run test` script after the latest dependency, sensitivity, nested-status,
mixed-template, namespace, external-identity, lifecycle-result, Alchemy deletion, NetworkPolicy
canonicalization, live-comparison, apply-policy, replacement-lifecycle, watch, lifecycle, and
integration corrections, reports **5,022 passing tests, zero failures, 13 skips, and one todo
across 5,036 tests in 294 files, with 19,796 assertions**. This run deliberately used no active Kubernetes context:
offline declaration generation and lifecycle characterization therefore no longer receive accidental
coverage from an ambient cluster. The complete library,
example, and test TypeScript projects also pass `bun run typecheck`. This closes all 126 runtime
failures recorded at the first branch checkpoint without adding a parallel planner, executor, KRO
reconciler, or Alchemy state system. A green checked-in corpus is not live-cluster acceptance, but
it removes the known semantic-migration defect backlog from the critical path and changes the
remaining work from broad compatibility repair to portability classification, live proof, and
lifecycle hardening.

Repository evidence now
proves ordinary direct expansion, empty collections, nested resource creation, deterministic
cartesian expansion, coordinate-paired dependency edges, collection aggregates, orphaned-item
collapse, compound conditions, direct artifact round trips, KRO preservation, and invalid
iteration-path rejection. Inline Secret values are classified as literal bindings or tainted
symbolic values, concrete secret-bearing spec paths are redacted from canonical plans, recursive
decoder validation fails closed, inspection reports status taint, sensitive identity fails during
planning, and direct Alchemy materialization uses a host-native redacted envelope. Symbolic leaves
captured from composition construction are preserved while concrete direct manifests are zipped
into the plan, so cross-artifact taint, resource references, mixed templates, and status
conditionals no longer disappear during direct materialization. Known external resources satisfy
reference resolution without becoming apply or rollback dependencies. KRO outer-instance/bundle
materialization and explicit static-YAML secret policy use the same binding contract. Public local
development placeholders require explicit factory metadata and produce a warning rather than
weakening the default Secret classification. Sensitive activation, readiness, and iteration now
fail closed with path-specific planning diagnostics. Durable cluster credentials follow the same
fail-closed principle: ambient/file sources are re-read by the operation host, detected static
fields require named environment bindings, provider materialization rejects inline credentials,
and diagnostics contain paths and binding identities rather than credential bytes. Focused tests
cover top-level static tokens, nested auth-provider values, exec environment/argument values,
missing host bindings, manual inline-state injection, source-only persistence, declaration creation
with no active kube context, and explicit failure when neither a durable source nor a concrete
kubeconfig exists. Default and file source declarations serialize only the host-readable source
identity: they do not initialize a local Kubernetes client or pin the authoring machine's current
context. Snapshot and named-binding paths still require a concrete kubeconfig because they must
inspect selected cluster and user material.

The legacy concrete graph is still constructed as a compatibility side channel for explicitly
runtime-only readiness evaluator functions. It is no longer semantic authority for desired manifests, plan
identity, artifact policy, or Alchemy dependency discovery. Direct Alchemy fan-out now emits a
canonical, digested per-resource execution record containing the concretized artifact operation and
its incoming artifact edges. The provider decodes that record, verifies Alchemy dependency wiring,
and reconstructs structured references, scope, apply policy, activation, and registered readiness
without scanning flattened manifest strings or recovering WeakMap semantics. The old CEL-string
rehydrator remains only for persisted declarations that predate execution records. The direct path
is therefore an **authoritative representation and new-state host path**. Deterministic built-in
and integration-specific evaluators now use registered portable strategies, intentionally
process-local evaluators carry an explicit runtime classification, and strict planning rejects
unclassified functions before a declaration can be emitted.
For new direct Alchemy state, spec-resolvable sensitive values are represented by stable binding
identities in the execution record and Effect `Redacted` inputs in the declaration. The provider
unwraps them only while materializing the Kubernetes operation; JSON cloning and canonical record
encoding do not reveal the bytes. This is adapter-boundary use of Effect, not an Effect type in the
semantic DTO.

KRO has crossed the corresponding core-representation boundary for the focused conformance set.
Production RGD serialization now
captures a symbolic plan, compiles a KRO artifact plan, and materializes the graph-child artifacts
back into the established serializer. The same compiled graph therefore feeds raw RGD YAML,
standalone RGD installation, and the RGD declaration embedded in Alchemy. Focused parity fixtures
cover nested-composition status references, callback and reference-based readiness, mixed CEL
templates, instance-independent graph shape, and composition serialization options.

KRO has now crossed the corresponding **new-state host-execution boundary** as well as the
core-representation boundary. The branch defines a versioned, digested `KroArtifactBundle` whose
physical operations include ordered prerequisites, hoisted Namespaces, recursive singleton-owner
RGDs and instances, and the root RGD and instance. Bundle operations carry their executable
artifact, concrete manifest, source-plan provenance, physical identity, role, and incoming edges.
The bundle codec rejects incompatible roles, duplicate or dangling identities, dependency cycles,
semantic conflicts while merging shared physical operations, and digest corruption. The factory
compiles nested singleton members recursively, resolves consumer edges to the direct owner
instance, normalizes physical custom-resource GVKs, then crosses an encode/decode boundary before
host adaptation.

`toYaml()` and `toYaml(spec)` now select and topologically order their documents from this decoded
bundle, and new KRO Alchemy declarations are generated from the same ordered operations. Those
declarations persist the canonical bundle and operation identity so the provider can validate and
rehydrate the exact compiled operation rather than infer semantics from a serialized manifest.
Physical instance documents, prerequisites, Namespaces, singleton owners, and RGDs therefore no
longer require separate recursive factory assembly in these new host paths. Hoisted Namespace
artifacts retain their host-neutral desired state, direct SSA policy, create/adopt lifecycle, and
delete-when-unused evidence contract; operational hosts add the ownership stamp only while making
the create-first ownership decision, while static YAML remains adoption-neutral.

The Alchemy provider now decodes and digest-validates the persisted bundle, resolves the declared
operation by identity, verifies that Alchemy dependency outputs exactly match compiled incoming
edges, materializes the canonical manifest, and restores scope, apply policy, identity, and
portable readiness metadata. JSON-state round-trip and dependency-tampering fixtures prove that
the provider fails closed rather than reconstructing semantics heuristically. Imperative
standalone KRO deployment also compiles, crosses the bundle codec boundary, and executes the same
topologically ordered operations. It retains factory instances only as operational contexts for
hooks, clients, and status hydration; desired state and ordering remain bundle-authoritative.
Focused fixtures cover recursive singleton ordering, direct-owner dependency edges, prerequisite
and hook sequencing, hoisted Namespace ordering, YAML parity, Alchemy declaration parity, and
persisted-state rehydration.

The migration is not considered complete merely because new-state hosts execute the bundle and the
repository corpus is green; it also requires representative live target/host evidence without
host-specific fallbacks. That evidence now passes for direct and KRO standalone execution, direct
Alchemy fan-out, KRO Alchemy persisted-state upgrade, lifecycle convergence, normalization, and
apply ownership. The repository audit covers 107
`withReadinessEvaluator(...)` attachments across 84 factory/composition files. Generic, built-in,
KRO lifecycle, and deterministic integration evaluators now resolve through versioned portable
registrations; the intentionally clock-dependent Cilium policy evaluators are explicitly classified
as `ambient-clock`; and strict planning rejects an evaluator that declares neither contract.
Standalone may retain an explicit runtime binding because it owns the in-process function, while Alchemy now
rejects runtime-only KRO readiness with a capability diagnostic instead of emitting state it cannot
rehydrate. Legacy assembly remains only for factories that have not entered semantic capture and
for documented persisted-state compatibility. Representative integration-corpus round trips and
live target/host fixtures now protect further narrowing of those compatibility paths. Direct
Alchemy likewise retains its established public declaration envelope
for source and persisted-state compatibility, but new declarations do not rely on that envelope to
recover semantic meaning.

Sensitivity now demonstrates the intended host-parity boundary for the focused covered paths.
Direct execution records and KRO outer bundles carry durable binding identities plus separate
ephemeral value envelopes. Recursive
singleton members namespace generated binding identities so identical spec paths cannot collide.
Standalone execution resolves the envelope immediately before apply; Alchemy declarations map only
the bindings used by each operation to Effect `Redacted` inputs, and the provider unwraps them only
for the apply object while preserving redacted desired state. Canonical record/bundle encoding and
declaration JSON do not contain the bytes. Direct and KRO static YAML fail closed unless callers
explicitly set `allowSensitiveMaterialization: true`; explicit `sensitiveValue(binding)` inputs must
also be supplied by name. Focused fixtures cover plaintext exclusion, recursive singleton
isolation, standalone materialization, provider rejection of non-redacted inputs, cross-artifact
taint preservation while symbolic and concrete manifests are zipped, explicit public-placeholder
classification, YAML parity, path-specific rejection of sensitive activation, readiness, and
iteration, and durable kubeconfig source/binding materialization. Additional live Secret and
credential cases remain conformance expansion rather than a known plan, persistence,
materialization, or control-flow gap.

The current implementation also provides mature operational machinery that this proposal evolves
rather than rebuilds:

- mature direct and KRO factories, serializers, deployment engines, reference resolution,
  readiness, discovery, rollback, and deletion workflows;
- the existing imperative composition capture context, factory metadata, proxy and closure
  analyzers, status-analysis pipeline, schema lowering, and CEL serialization frontend that the
  semantic planner can adapt rather than replace;
- direct Alchemy per-resource fan-out with dependency outputs seeding live reference resolution;
- KRO Alchemy declarations for prerequisites, hoisted Namespaces, singleton owners, RGDs, and
  instances, plus finalizer-aware reverse-topological teardown;
- artifact-local `create-or-patch`, `create-only`, `replace`, and server-side-apply dispatch in the
  direct `ResourceApplier`. The YAML file and directory factories now translate their compatibility
  strategies into that same artifact policy and delegate to the same applier; the previous
  CRD-specific SSA path and duplicate conflict handler have been removed. Server-side-apply field ownership conflicts
  now remain typed conflicts rather than degrading into legacy 409 success, SSA create fallback
  preserves the selected field manager, and every replace/recreate path waits abortably for a
  confirmed 404 with a typed timeout instead of sleeping for a fixed interval;
- operation-level abort signals, bounded readiness, deletion polling, finalizer diagnostics, and
  Kubernetes client seams now lifted behind a lazy standalone Effect operation boundary for direct
  and KRO deploy/delete, KRO instance/RGD/status reads, direct health/status reads, bulk rollback,
  and server dry-run. Composite reads and singleton drift checks join their parent operation rather
  than starting nested runtimes. Existing domain-error and abort-reason identity is preserved, and
  cancellation propagates through deployment, readiness, prerequisite, finalizer, and
  namespace-teardown waits. Individual generated-client HTTP reads remain bounded by configured
  HTTP timeouts where that client exposes no per-request AbortSignal; and
- working direct/KRO `toAlchemyResources()` declaration generation and provider execution that
  consume artifact records for new state while preserving the established declaration envelope.

Deletion has now crossed its first contract boundary rather than remaining success-shaped
operational behavior. `ResourceFactory.deleteInstance()` returns one serializable
`ResourceDeletionResult` for both direct and KRO targets, with `complete`, `progressing`, and
`blocked` states; exact deleted, retained, and remaining identities; owners, finalizers, and
deletion timestamps where observable; explicit shared-instance, scope-filter, adopted-resource,
occupied-Namespace, and generated-CRD retention policies; and safe retry guidance. Direct rollback
reports the exact resources confirmed gone and those retained by scope. KRO teardown now converts
its previous fail-closed early returns into blocked evidence when discovery or ownership cannot be
proven, preserves its child/finalizer and Namespace gates, and reports accepted-but-still-draining
deletions as progressing. Focused direct and KRO lifecycle fixtures and the complete TypeScript
projects pass. This is substantial Workstream 10 implementation credit:
the Alchemy KRO adapter now converts a non-complete result into a typed host failure carrying the
full DTO, which lets Alchemy retain durable retry ownership without reimplementing Kubernetes
diagnostics. Live KRO teardown now proves occupied-Namespace behavior, Helm descendants, exact
completed Job/Pod ownership cleanup, and generated-CRD retention. Additional finalizer topologies
remain permanent conformance cases rather than an absent completion contract.

A bounded 2026-07-22 OrbStack run proves the standalone KRO core path against Kubernetes 1.33.5
and an established KRO installation: RGD admission, generated-CRD availability, instance creation,
projected readiness/status, factory cleanup, and final Namespace absence all completed. That run
found and closed two defects that the checked-in corpus had not exposed: the legacy single-resource
deployment path now resolves registered readiness before applying, and RGD child templates remove
enumerable TypeKro transport fields such as `id` and `scope` before KRO schema validation.

A subsequent isolated run used a fresh kind v0.32.0 cluster on OrbStack, Kubernetes 1.36.1, KRO
0.9.2, Flux, cert-manager, CNPG, and Cilium. It passed bootstrap and a broad direct/KRO standalone
matrix including TLS deployment, Helm deployment, conditional resources, modern KRO
`includeWhen`/`readyWhen`/`forEach`/`externalRef` behavior, declarative status, complete status
hydration, cross-resource references, nested compositions, imperative parity, namespace retention,
and retry-safe teardown. Its three bounded residuals are now closed:

1. the legacy inline-Secret fixture now uses an instance-bound declared value, preserving the
   shared-graph sensitivity boundary;
2. a Namespace positively occupied by a foreign resource returns promptly with explicit
   `occupied-namespace` retention evidence rather than consuming the descendant-drain timeout; and
3. the Helm integration no longer waits for an incorrect generated Deployment name.

The corrected clean-cluster run added useful evidence rather than merely replaying those fixes.
It proved prompt empty, occupied, adopted, shared, and retry-safe Namespace policies; direct Helm
readiness; direct singleton-backed ClickHouse bootstrap plus its ClickHouseInstallation; KRO
ClickHouse status projection; static Valkey document ordering; and a substantial direct web
application graph using the cluster-discovered `standard` StorageClass. During that run TypeKro
found and closed five additional implementation defects:

- direct singleton consumers did not seed external-reference resolution from the already-ready
  singleton owner. Direct deployment now carries the owner's logical status as a non-applied,
  non-rollback resolution seed, and the ClickHouse path proves it live;
- static direct YAML used capture order rather than the compiled dependency graph. It now uses the
  artifact graph's topological order, and Valkey explicitly records its HelmRelease-to-repository
  dependency; and
- runtime whole-object Helm values could infer as `map(dyn, dyn)` after JSON normalization and fail
  assignment to Flux's structured `spec.values`. The shared CEL serializer now type-erases only the
  final merge result with `dyn(...)`, preserving merge semantics. KRO 0.9.2 accepts the corrected
  Valkey RGD in the live cluster; and
- strict artifact compilation previously ignored `PLAN_VALUE_UNSUPPORTED` and circular-value
  diagnostics, allowing runtime-only leaves to become silent omissions before the compatibility
  serializer could reject them. Target compilation now retains those path-specific failures while
  leaving not-yet-strict schema-inspection diagnostics advisory. Internal nested-composition `__*`
  metadata is excluded from user status outputs at the same boundary as the established schema
  serializer; and
- the Dagster fixture could build a local validation image but did not make that image visible to a
  harness-created kind node. It now detects the active kind context and loads an available local
  image before deployment, while leaving pullable remote-image and non-kind cluster paths alone.

The subsequent clean rerun closed both chart-level uncertainties. Direct ClickStack converged from
a cold cluster, hydrated its endpoint contract, and its equivalent KRO instance projected the live
UI, application, and OTLP endpoint status. The ClickStack KRO teardown then drained its
Helm-managed Pods during the bounded descendant grace period and confirmed removal of the instance,
RGD, and generated CRD. Dagster likewise reconciled through KRO and removed its application
Namespace. These runs validate the conservative descendant-producing-controller classification for
the representative Helm graphs while the prompt occupied-Namespace fixture continues to preserve
foreign occupants. Broader finalizer, completed-Job/Pod, and generated-CRD cases remain permanent
conformance obligations, but they are no longer unimplemented lifecycle architecture.

The run also surfaced non-blocking diagnostic false positives. A mixed
`${schema.spec...}` template was sent to the legacy Angular-expression analyzer before the
dedicated template path recovered it. The shared schema-only evaluator now parses and safely
evaluates balanced template segments, preserves escaped literal interpolation text, and retains
scalar result types for non-template expressions. Literal CEL strings such as URLs are now masked
before resource-reference detection, eliminating the observed false warning without changing
evaluation semantics. Intermediate nested-composition/status analysis can still use a speculative
Phase A result before the serializer performs its authoritative Phase B source analysis. The
implementation now keeps that speculative failure silent and emits a structured warning only when
final analysis actually degrades. Focused regressions prove that valid recovered Caddy, Ory, and
cert-manager status CEL no longer produces a false fallback warning. Newly discovered unsupported
control flow remains a source-location and diagnostic-quality obligation, not a reason to replace
the frontend.

The final 2026-07-22 verification used the repository's real test scripts and a newly created
disposable kind cluster on OrbStack. The non-Cilium phase completed 274 tests in 52 files with
**250 passes, 22 intentional skips, and two failures**. Those failures were classified rather than
silently retried:

- ClickStack direct mode hit a cold-start upstream collector CrashLoopBackOff while MongoDB was not
  yet reachable, and Flux exhausted the chart's ten-minute install timeout. The equivalent KRO
  case in the same run projected the expected live status, and a prior clean cold-cluster direct
  rerun had converged. The remaining TypeKro issue is diagnostic quality: the operation surfaced a
  generic `AbortError: Delay aborted` instead of preserving the resource, action, and bounded
  timeout evidence; and
- Dagster direct mode exposed a real TypeKro status-hydration defect. The deployment correctly
  consumed its ready direct singleton owner, but post-deployment status re-execution discarded that
  external-reference seed and queried the synthetic KRO owner kind. Direct hydration now retains a
  non-applied, non-rollback external seed view and indexes live status by captured resource identity
  before symbolic-name fallback. A focused clean-cluster rerun passed all five Dagster tests in
  direct and KRO modes.

The same correction pass made generated-custom-resource hydration resilient to stale aggregated
API discovery by falling back to the authoritative CRD plural and scope. Focused repository tests
cover that discovery path and the direct singleton/status identity behavior. On the same clean
cluster, the dedicated Cilium-last invocation passed **16 tests, skipped one intentionally, and
failed none** across four files. A focused cert-manager direct readiness/status test also passed
after Cilium was restored; running it after the terminal Cilium phase first reproduced the expected
missing-agent-socket failure, confirming that the two-invocation harness ordering is necessary.
The cluster was deleted after verification.

This evidence retires generated-CRD discovery freshness, direct status-alias identity, and direct
singleton status hydration as estimated implementation work. It also proves the existing Alchemy
direct fan-out path live: per-resource declarations applied in dependency order, resolved a live
cross-resource reference, and tore down successfully.

A final focused acceptance pass used a new disposable kind v0.32.0 cluster on OrbStack with
Kubernetes 1.36.1, KRO 0.9.2, Flux, cert-manager, CNPG, and Cilium. Four live semantic-planning
fixtures passed with **zero failures and 13 assertions**:

1. the Bun watch transport applied the active `KubeConfig` authentication and TLS options and
   received a streamed Kubernetes Event; a local HTTP fixture separately proves that non-success
   watch responses retain their status and body;
2. a KRO `NetworkPolicy` authored with `ingress: []` and `egress: []` reconciled to the API-server
   normalized form, reached ready, and retained a stable generation instead of looping on
   omitted-versus-empty drift;
3. deletion of a completed KRO Job captured the exact controller UID, removed its orphaned
   completed Pod after KRO 0.9.2 removed the Job, reported complete teardown, and retained the
   generated CRD in the `Established=True` state rather than leaving it terminating; and
4. direct opt-in SSA surfaced a competing manager as the typed ownership-conflict cause, forced
   migration acquired only the requested field while preserving the other manager's disjoint
   field, and `yamlFile` recorded its requested field manager through the same canonical applier.

The same disposable cluster also passed a real Alchemy v2 persisted-state upgrade fixture. A KRO
stack was first deployed through the provider host from legacy JSON-only declarations with no
canonical bundle fields, then planned and reconciled as two updates from modern declarations. The
persisted provider state acquired `kroArtifactBundle` and `kroArtifactOperationId`, the live child
remained correct, and Alchemy destroyed both operations cleanly. This proves the upgrade through
the actual host and state boundary rather than by calling the codec directly.

Standalone and Alchemy-hosted live schema-upgrade fixtures additionally applied revision 1 of an
RGD, added a new nested spec field in revision 2, and immediately updated the same custom resource.
Both paths waited for the RGD's current generation, preserved the nested field in the admitted
custom resource, projected it into the child ConfigMap, and completed narrowly bounded CRD and
Namespace cleanup on OrbStack. Unit coverage also proves that a post-apply omission raises
`KRO_INSTANCE_SPEC_PRUNED` with paths but no values.

These runs close the previously identified watch, normalization, completed-child, generated-CRD,
SSA ownership, KRO/Alchemy persisted-upgrade, and stale-CRD admission gaps. Broader API-kind,
admission, immutable-field, and finalizer combinations remain permanent conformance expansion and
soak work, but no longer represent missing architecture or an unimplemented primary lifecycle
path. Bun's lack of command-line file ordering under `--max-concurrency 1` is handled by separate
non-Cilium and Cilium-last invocations.

The estimate treats that machinery according to the following implementation inventory. This is
the practical boundary between adaptation work and genuinely new work:

| Concern | Machinery that already exists | Remaining RFP work |
|---|---|---|
| TypeScript semantics | Callable compositions, proxies, closure and status analyzers, schema lowering, JS-to-CEL emission, aspects, metadata, a green characterization corpus, registered portable readiness identities for deterministic factory evaluators, explicit runtime classification for clock-dependent evaluators, strict path-specific rejection of unclassified evaluators, and strict preservation of unsupported/circular value diagnostics through target compilation | Preserve the accepted corpus through canonical IR and improve source-located diagnostics as new unsupported control-flow cases are discovered |
| Direct target | Dependency resolution, reference materialization, readiness, create/patch/replace/SSA dispatch, rollback, discovery, deletion, and deployment closures | Make artifact records authoritative for every accepted identity, edge, sensitivity, and readiness form; do not build a second executor |
| KRO target | RGD/instance generation, prerequisites, singleton owners, namespace hoisting, readiness/status hydration, current-generation RGD admission gating, exact-path post-admission pruning detection, finalizer-aware deletion, KRO-owned child reconciliation, decoded outer-bundle execution in standalone and Alchemy, safe rejection of shared-graph secret bytes, instance-bound Secret fixtures, live-accepted runtime Helm-value map lowering, a real Alchemy legacy-to-canonical persisted-state upgrade, and standalone plus Alchemy live schema-upgrade fixtures | Retain upgrade fixtures and extend representative integrations without building another reconciler or weakening the sensitivity boundary |
| Runtime closures | Existing standalone direct and KRO sequencing with Promise/synchronous closure signatures | Record and negotiate the runtime requirement across host and output boundaries; reject unsatisfied static or durable forms explicitly |
| Alchemy | Direct fan-out, KRO declaration sets, dependency outputs, persisted state, provider hosting, retries, revisions, cross-provider scheduling, canonical artifact operations, host-native redaction, durable kubeconfig source/binding materialization, and live direct plus KRO persisted-upgrade evidence. Default/file-backed declarations are host-neutral and the complete offline corpus passes without an active kube context. | Preserve the host boundary and broaden upgrade matrices only as stored formats evolve; do not duplicate Alchemy orchestration |
| Lifecycle | Bounded polling, top-level and condition-level generation-aware RGD readiness, post-admission instance-spec preservation checks, rollback, finalizer checks, namespace teardown, discovery, generated-CRD retention, structured direct/KRO complete/progressing/blocked results with exact retention and blocker evidence, prompt permanent-occupant retention, a bounded grace period for graphs with descendant-producing controllers, exact controller-UID capture for completed Job descendants, typed Alchemy retry adaptation, factory-owned desired/live normalization, exact-path drift evidence, canonical direct `create-or-patch` no-op decisions, confirmed-deletion replacement waits, and live normalized-NetworkPolicy, completed-Job/Pod, and KRO schema-upgrade convergence | Retain the live fixtures and expand unusual controller/finalizer combinations when integrations expose them; refine ownership evidence only if exact UID capture or the conservative controller-kind signal proves insufficient |
| Effect v4 | One standalone operation boundary across stable cluster-facing Promise facades, operation joining for composite/internal calls, Alchemy-hosted provider effects, abort propagation, typed error preservation, `Redacted` at sensitive host boundaries, authenticated Bun watches, and contextual timeout propagation | Retain host/cancellation conformance and explicit bounded diagnostics for generated-client calls that cannot accept a per-request AbortSignal; do not rewrite analyzers or integrations |
| Server-side apply | Canonical artifact-local dispatch in `ResourceApplier` shared by direct execution and YAML factories; typed ownership conflicts; live fail/force/coexistence/migration and YAML-manager evidence; KRO-owned SSA for graph children | Expand API-kind/admission/immutable-field fixtures as conformance work; do not introduce an SSA deployment mode |

Consequently, the remaining estimate funds convergence, diagnostics, and proof. It does not fund
reimplementation of closures, direct deployment, KRO reconciliation, Alchemy state management,
readiness polling, rollback, deletion, or the JS-to-CEL frontend.

### 13.2 Revised estimate

| Gate | Outcome | Total from v0.28.1 | Remaining from current branch |
|---|---|---:|---:|
| A | Re-baseline, packaging fixes, conformance registry and measured fixtures | 1.25-2 weeks | Complete |
| B | Value, expression, sensitivity, schema IR, and canonical codecs | 2.75-4 weeks | Complete for the mandatory architecture and representative live matrix |
| C | Captured composition IR, planning contracts, provenance, lifecycle, and digest validation | 3-4.5 weeks | Complete; retain conformance coverage |
| D | Effect shell, artifact-plan migration, and standalone/Alchemy/YAML adaptation | 3.5-5.5 weeks | Complete for mandatory acceptance; retain compatibility coverage |
| E | Live canonicalization, lifecycle completion, apply-policy hardening, packaging, and stabilization | 3.5-6 weeks | 0.05-0.15 week of review and downstream soak |

The revised production-grade migration is approximately **14-22 engineer-weeks** from v0.28.1.
That number is retained as the historical whole-program estimate, not as work still outstanding.
Against the current experimental branch, the remaining work is approximately **0.05-0.15
engineer-week**, or roughly **0.2-0.5 calendar week** with review and downstream soak.
The remaining implementation allowance is only **0.01-0.03 engineer-week** for defects exposed by
review or prerelease consumers; the final repository and packaging gates are green. Recoverable
analyzer warnings now wait for final analysis, contextual timeout
errors preserve the operation and resource evidence, authenticated Bun watches are implemented,
completed Job descendants are handled by exact controller UID, and live direct/YAML SSA plus
KRO/Alchemy persisted-upgrade fixtures pass. The balance is the complete repository and packaging
gates, review, documentation reconciliation, and a small release margin. Specialized-readiness
classification, strict rejection of unclassified evaluators, instance-bound Secret handling,
prompt permanent-occupant retention, correct Helm fixture naming, direct singleton resolution,
static artifact ordering, and KRO-accepted runtime Helm-value lowering remain implemented.

The implementation-only lower bound is reduced from the earlier rewrite-oriented estimate because
the clean runs exercised the actual integration corpus and every newly found compiler or host
defect was localized and closed without changing the plan, artifact, executor, or responsibility
model. The real Alchemy persisted-state upgrade and live normalization, lifecycle, watch, and SSA
fixtures now provide the proof that previously justified the larger range. The delivery forecast
still includes review and release stabilization rather than collapsing to zero remaining effort.
The stable cluster-facing Promise operations and YAML policy paths share their intended runtime
contracts, while Gate A has
enforced numeric tarball, unpacked-package, declaration, file-count, and Node/Bun cold import
budgets across every published export, and the readiness audit confirms a bounded classification
exercise over existing evaluator families rather than a missing readiness architecture. Durable
kubeconfig persistence is also implemented as
an operation-host source/binding policy with fail-closed declaration and provider diagnostics, and
schema-authoritative optionality,
pre-materialization direct activation, explicit target-neutral
iteration, deterministic direct expansion, paired iterated dependencies, and compound activation
now have working shared implementations and canonical round-trip coverage. Initial sensitivity
classification, canonical spec redaction, recursive fail-closed validation, inspection-time status
taint, sensitive-identity and sensitive-control-flow diagnostics, direct materialization, and
direct Alchemy-native redaction are also implemented. Collection aggregates and orphaned item sentinels now lower through the
explicit iteration model, and recursive singleton bundles now derive physical operation identities
without concretizing symbolic forwarded owner specs. KRO outer bundles, recursive singleton
assemblies, standalone apply, Alchemy state, and static YAML now share the same sensitive
materialization envelope. Captured symbolic leaves survive direct concrete materialization,
external observed resources participate in resolution without becoming owned apply dependencies,
managed public placeholders require explicit metadata, and KRO-owned root-status collisions are
enforced in the KRO compiler. The final offline full-suite checkpoint is 5,022 passing tests with
zero failures across 5,036 tests in 294 files, with 19,796 assertions; all three TypeScript projects
typecheck. Direct and standalone KRO
deletion now return the same structured completion contract; fail-closed discovery and ownership
paths are observable blockers rather than silent retention, and generated CRD, shared-definition,
adopted-resource, occupied-Namespace, and scope-filter survivors are explicit policy results.
Alchemy now receives non-complete deletion evidence as a typed retry failure without moving retry
ownership into TypeKro. The first identified normalization defect now has decentralized,
versioned `NetworkPolicy` desired and live canonicalizers with direct/KRO emission parity. The
shared comparison machinery resolves exact factory provenance, rejects nondeterministic hooks,
ignores API-server metadata and unowned additional live fields, reports bounded exact paths, and
redacts Secret material. Singleton drift uses the same exact-path vocabulary in standalone and
Alchemy hosts, and the direct `create-or-patch` path now uses that comparison to avoid semantically
empty writes while keeping Secrets write-through and SSA API-server-owned. This removes the known
omitted-versus-empty template defect, comparison-contract design, and primary direct comparison
call site from implementation risk. The live KRO reproduction proves the operator clears its
reconciliation barrier, and the completed-Job fixture proves TypeKro's bounded descendant recovery
around KRO 0.9.2. The residual upper bound covers broader API-kind/defaulting/finalizer combinations
and release regression risk rather than an unproven primary path. The range remains substantially
below a greenfield rewrite because direct
Alchemy declarations and provider reconciliation now use canonical per-resource execution records
and artifact edges rather than serialized-manifest scanning or best-effort dependency recovery.
The complete KRO outer operation set now has a canonical, digested bundle contract: recursive
singleton-owner RGDs and instances join physical consumer instances, prerequisites, hoisted
Namespaces, and the root RGD. YAML and new Alchemy declaration generation consume its topological
ordering rather than independently recursing through factory state. Namespace desired state, SSA
policy, create/adopt lifecycle, unused-evidence requirements, and owner-to-consumer ordering are
explicit rather than being recovered separately in each host. Alchemy declarations persist bundle
and operation identities; provider rehydration and standalone execution now consume and validate
those identities. Prerequisite sequencing is represented by explicit artifact edges. Generic and
specialized factory readiness now carry stable registered identities, including parameterized
desired-state inputs for replica, service, Job, CronJob, and KRO custom-resource families.
Deterministic integration evaluators likewise reconstruct after canonical artifact JSON round
trips. The Cilium policy evaluators that intentionally consult wall-clock age are explicitly
classified `ambient-clock`; nonportable custom readiness remains an explicit runtime binding rather
than hidden metadata. Strict planning rejects an evaluator that declares neither contract, and
Alchemy rejects unsupported runtime-only KRO readiness instead of persisting an unrecoverable
function. It remains lower than the
earlier 7.5-14.5 estimate
because the production KRO RGD path consumes the compiled artifact graph, nested-composition
provenance and callback readiness survive the artifact boundary, callback lowering is shared by
the expression frontend and serializer, and the dead parallel graph serializer has been removed.
The planner is already the intended semantic authority on the migrated paths for direct desired
manifests, KRO graph children, physical and singleton-owner instances, prerequisites, and hoisted
Namespaces. Focused fixtures prove mixed-template preservation, graph invariance, and compatibility
behavior across that boundary; the repository suite establishes compiler parity and the
representative live target/host matrix supplies acceptance evidence. Exact provenance,
decentralized requirement production, codecs, direct external references, readiness binding
contracts, and live host upgrades remain credited.

The full-program estimate is also lower than the earlier 19-28 and 20-30 week ranges. Implementing
the bundle paths demonstrated that standalone and Alchemy hosts can adapt the existing deployment engines
rather than requiring separate executors, and the lifecycle/apply work can extend current
discovery, rollback, deletion, finalizer, CRD, and `ResourceApplier` machinery. The estimate still
reserves most of Gate E because stronger completion and drift contracts require new live behavior
and diagnostics even when their lower-level Kubernetes operations already exist.

The estimate now gives explicit implementation credit to the current ownership model. Deployment
closures remain supported authoring and in-process resolution machinery; the migration only asks
portable closure results to cross the planning boundary as deterministic values, requirements, or
bindings. Direct mode evolves the existing deployment engine and `ResourceApplier`; it does not
gain a replacement executor. KRO compilation evolves the existing RGD, instance, singleton,
prerequisite, and teardown paths; it does not add another reconciler. Alchemy continues to host and
persist TypeKro's direct or KRO operations; TypeKro does not rebuild Alchemy's scheduling, state,
retry, or cross-provider dependency system. Server-side apply remains an artifact apply policy in
the existing direct/YAML machinery rather than a third deployment target. These are exclusions
from the estimate, not deferred work.

The revised accounting applies four rules:

1. Existing closure analysis, proxy traversal, schema/status lowering, and JS-to-CEL behavior count
   as the semantic frontend. The RFP funds metadata extraction, canonical contracts, diagnostics,
   and parity around them, not a replacement language implementation.
2. Existing direct and KRO operations count as execution machinery. The RFP funds artifact-driven
   invocation and lifecycle guarantees, not replacement deployment engines or a TypeKro operator.
3. Alchemy counts as a host that schedules, persists, retries, and links TypeKro operations. The
   RFP funds declaration/provider adapters and host-native secret/dependency mapping, not duplicate
   durable orchestration inside TypeKro.
4. Effect counts as the in-process operational shell and adapter vocabulary. The RFP funds typed
   errors, cancellation, scopes, services, and redaction at runtime boundaries, not Effect-shaped
   semantic DTOs or rewrites of integrations and analyzers.

The estimate is organized around concrete residual work rather than hypothetical replacement
systems:

| Remaining package | Included work | Estimate |
|---|---|---:|
| Semantic migration and conformance closure | Preserve the classified readiness corpus and refine source locations only for newly discovered unsupported control flow. Final-analysis warning suppression, literal-URL masking, mixed schema-template evaluation, captured-resource status identity, and singleton-backed direct status hydration are implemented with focused and live coverage. `readyWhen`, registered strategies, runtime classifications, sensitive values, durable cluster credentials, packaging budgets, and registry evidence are implemented. | 0.005-0.015 week |
| KRO bundle closure and live host parity | Retain the real Alchemy v2 legacy-to-canonical persisted-state upgrade and the standalone plus Alchemy live RGD schema-upgrade fixtures; broaden them only when bundle versions, declaration envelopes, or KRO status generation shapes change. Recursive bundles, binding envelopes, standalone materialization, Alchemy `Redacted` inputs, edge validation, singleton lowering, closure sequencing, public placeholders, readiness identities, runtime Helm-value maps, host-neutral kubeconfig binding, direct fan-out, current-generation admission gating, post-admission pruning diagnostics, and live KRO host upgrade/teardown evidence are implemented. | 0.005-0.015 week |
| Effect operational boundary | Stable Promise facades enter one lazy standalone operation scope; composite calls join it; Alchemy hosts the same provider effects; Bun watches authenticate; contextual timeout evidence and abort identity are preserved. Remaining work is regression coverage for newly encountered generated clients that expose neither a request signal nor adequate timeout context. | 0.005-0.015 week |
| Canonicalization and lifecycle completion | Desired/live canonicalizers, exact redacted drift paths, direct/KRO parity, canonical no-op decisions, structured completion, generated-CRD retention, occupied-resource policy, controller-descendant drain, exact completed-Job controller-UID capture, blocker diagnostics, typed Alchemy retry adaptation, confirmed replacement, and authoritative CRD fallback are implemented. Live `NetworkPolicy`, completed Job/Pod, generated-CRD, ClickStack, and namespace-policy fixtures prove the representative paths. Remaining work is conformance expansion for unusual API normalization and finalizer combinations. | 0.01-0.03 week |
| Apply-policy and release hardening | Retain live direct/YAML fail/force/coexistence/ownership-migration evidence, typed SSA conflicts, field-manager-preserving create fallback, fail-closed CRD admission, immutable-field and replacement regressions, packed-consumer budgets, full-suite gates, and release documentation. Expand the live API-kind matrix when a supported integration exposes a new ownership topology. | 0.025-0.065 week |

These packages sum to **0.05-0.14 engineer-week** and are rounded to the **0.05-0.15
engineer-week** forecast above to include review and downstream-soak margin.
The representative repository round-trip and live target/host matrices are green. The primary RFP
architecture has therefore earned acceptance through implementation plus live evidence, not merely
through DTOs or pure compilers. The repository, packaging, documentation, and packed-consumer
gates are green; the remaining release work is human review and ordinary downstream soak.

The residual range is broad relative to its small size because Kubernetes admission/defaulting and
third-party finalizers can still expose a new kind-specific conformance case. The recursive
singleton-owner bundle is compiled, structurally validated, provider-rehydrated, and executed by
both hosts, including a representative legacy persisted-state upgrade. Nested compositions,
prerequisites, readiness, normalization, lifecycle, and SSA ownership have repository and live
evidence. A new fixture may still require a decentralized canonicalizer or ownership diagnostic,
but no remaining evidence suggests that it requires extending the core IR or inventing another
executor.

This forecast also reflects the deeper audit finding that several apparently new systems are
contract extractions over working machinery:

- direct SSA is an apply policy beneath the existing direct target, not a new deployment mode or
  reconciler;
- Alchemy is an execution host for existing direct/KRO semantics, not a third compiler or a state
  system TypeKro must duplicate;
- deployment closures, eager containers, prerequisite ordering, singleton ownership, readiness,
  discovery, rollback, and deletion already have implementations whose accepted semantics can be
  captured explicitly;
- the existing proxy, closure, status, schema, and JS-to-CEL analyzers remain the semantic frontend
  and now feed richer planning metadata rather than being rewritten; and
- Effect is an operational shell around current clients and engines, not a rewrite of analyzers,
  compilers, integrations, or DTOs.

Consequently, these estimates do **not** budget for rebuilding direct deployment, KRO installation,
Alchemy orchestration, deployment closures, readiness polling, rollback, deletion, singleton
ownership, prerequisite sequencing, YAML emission, or the JS-to-CEL frontend. They budget for
making their accepted semantics explicit in plans and artifacts, routing every host through those
artifacts, and proving parity. New implementation is required only where the existing behavior is
not serializable, differs by path, or lacks the diagnostics and lifecycle guarantees required by
this RFP.

The estimate credits the planning/compiler implementation and focused tests on the current branch,
but it does not convert line count into completion percentage. A prototype component counts as
complete only after its decoder, capability diagnostics, differential fixtures, and relevant
live-cluster paths pass. Direct plan compilation receives migration credit because it is now on the
production call path. Gate D's mandatory operation coverage, persisted-state upgrade, and live
host-matrix evidence now pass; its residual estimate is review and compatibility stabilization.
The compatibility-shaped Alchemy declaration envelope is not itself missing semantic work for new
direct state.

Gate A is complete. The registry names all 25 mandatory fixtures, the repository suite and all
TypeScript projects are green, and checked-in evidence covers the compiler corpus. The packed
artifact gate validates all 29 exports under fresh Node and Bun processes, requires quiet imports,
and enforces numeric tarball, unpacked-package, declaration, file-count, and cold-import ceilings
from a machine-readable budget. The final 2026-07-22 packed check produced a 2,056,616-byte tarball,
10,018,989 unpacked bytes, 1,846,259 declaration bytes, 2,132 files, a 1,568 ms cold Node import, and
a 1,205 ms cold Bun import, all below their checked-in limits. The Effect core/platform/test packages are pinned and
lockfile-checked as one tested beta.75 cohort. Some conformance entries still require the Gate E
live target/host matrix; that is live semantic acceptance rather than unfinished Gate A inventory or
packaging evidence.

Gates B and C are implemented architectural foundations with a narrow diagnostics and conformance
tail. Exact used-factory provenance, decentralized
representation-requirement production, canonical plan and
artifact decoding, typed template/reference and mixed-expression-template lowering, symbolic
resource planning, cross-spec graph invariance, and digest validation are implemented.
Recursive singleton-owner requirements, physical identities, and direct-owner dependency edges are
covered by the canonical KRO bundle and its codecs. Representative live losslessness across the
target/host matrix now passes; residual Gate B/C work is diagnostic quality as new unsupported
JavaScript forms are discovered. Specialized integration
readiness classification is implemented and protected by strict unclassified-evaluator diagnostics.
Established identity and dependency forms, template overrides, status conditionals, compiler
shapes, and the checked-in analyzer and third-party integration corpus now pass. Optional-reference omission, pre-identity
activation filtering, ordinary iteration expansion, collection aggregates, orphaned-item collapse,
coordinate-paired iterated dependencies, compound activation, and symbolic singleton-owner
identity lowering are implemented shared semantics and the representative live target/host matrix
now supplies migration acceptance evidence.

Gate D is now a late-stage boundary migration rather than the largest remaining block. Both target
cores and all new-state host adapters are in production paths. A host-independent direct artifact
plan drives direct desired manifests, direct YAML, and canonical
per-resource Alchemy execution records. External-reference reads use explicit artifacts and stay
outside ownership; new Alchemy state decodes structured references and verifies typed artifact
edges rather than scanning manifest strings. Direct sensitive inputs are now separated into a
plaintext-free execution record and host-native redacted bindings that are unwrapped only for
materialization. The shared explicit static-YAML boundary is implemented for direct and KRO.
Runtime requirements are now negotiated independently across target, host, and output form:
standalone direct and KRO preserve supported closure sequencing, while static YAML and unsupported
Alchemy paths fail with structured capability diagnostics. The legacy-state string rehydrator may
remain for its documented compatibility window, but no new state may depend on it. Generic and
deterministic specialized factory evaluators are portable; genuinely clock-dependent behavior is
explicitly runtime-classified. The KRO
artifact plan now drives production graph children and RGD serialization used by standalone, YAML,
and Alchemy paths. The KRO outer bundle now compiles recursive singleton owners and drives complete
YAML ordering, new Alchemy declaration/provider behavior, and imperative standalone operations from
decoded artifact records. KRO now carries the corresponding sensitive-binding envelope across
concrete instances and recursive singleton assemblies, resolves it at standalone apply, and maps it
to operation-specific Alchemy `Redacted` inputs. The real Alchemy legacy-state upgrade proves
representative persisted-state and live-provider parity. The Effect work is now a maintenance
boundary: stable cluster-facing Promise facades enter one lazy standalone operation scope,
preserve TypeKro error identity, and propagate interruption through the existing engines and
bounded waits. Composite status and singleton operations join that scope; the Bun watch uses the
active KubeConfig credentials and TLS material. Generated-client calls that cannot accept
per-request cancellation remain explicitly timeout-bounded and receive contextual errors rather
than another nested runtime.

Gate E builds on current deletion, rollback, readiness, finalizer, CRD, discovery, and YAML SSA
machinery. Artifact-local create-or-patch, create-only, replace, and SSA dispatch already execute
through the existing resource applier. SSA conflicts preserve field-ownership semantics, create
fallback preserves the field manager, and replace/recreate waits are bounded, abortable, and
confirmed by absence. Desired/live canonicalizers and exact redacted drift diagnostics now have a
decentralized factory contract, and canonical equality now suppresses unnecessary direct
create-or-patch writes. YAML file and directory resources now use this same applier and policy
translation, including fail-closed CRD admission. The live policy fixture proves conflict, force,
coexistence, ownership migration, and YAML field-manager parity; lifecycle and target/host fixtures
likewise pass. Release hardening and expansion to newly encountered API ownership topologies remain.
Create-or-patch stays the default, opt-in SSA stays an artifact policy, and unsupported requests
must continue to fail rather than silently degrading.

These are **engineer-effort estimates, not elapsed-calendar estimates**. The forecast assumes one
experienced TypeKro engineer working sequentially, prompt review of experimental contracts, and
access to repeatable KRO/Alchemy integration clusters. It includes implementation, focused
regression tests, representative live-cluster evidence, and review fixes. On those assumptions,
0.05-0.15 engineer-week is approximately 0.2-0.5 calendar week including review latency and
ordinary downstream soak. Add 20-30% calendar contingency only if review or a prerelease consumer
reveals a new KRO normalization or finalizer behavior that requires upstream operator work rather
than TypeKro-side canonicalization and diagnostics. Extended soak and integrations outside the
representative acceptance corpus are tracked separately rather than hidden in the implementation
estimate.

Confidence is not uniform across that range. The semantic/compiler estimate is grounded in a green
shared-frontend corpus and two already-wired artifact compilers, so it is unlikely to expand into a
new subsystem unless live target/host evidence disproves an IR invariant. The lifecycle range is
less certain because API-server normalization, KRO finalizers, generated-CRD retention, and
completed-child cleanup can reveal operator behavior that TypeKro can diagnose and orchestrate
around but cannot always correct locally. The representative live normalization, completed-child
teardown, generated-CRD retention, SSA ownership, direct-Alchemy, and KRO persisted-state upgrade
runs now provide that checkpoint. The full-suite and packed-consumer gates also pass. The next
checkpoint is ordinary downstream soak rather than another architectural implementation phase.

The estimate deliberately excludes optional work that is not required for parity: a public
Effect-native facade, Effect Workflow, a TypeKro operator, a third deployment target, a general
provider registry, and automatic lossless conversion of unrestricted JavaScript. Adding any of
those would require a separate estimate and responsibility review.

This is an architectural estimate, not a delivery commitment. Future bundle-version migrations or
new Kubernetes ownership topologies may still refine the contracts before public formats freeze,
but the representative outer-artifact migration no longer remains hypothetical.

The total and remaining estimates serve different purposes. The first describes the architectural
program from the released baseline; the second is a provisional implementation forecast from the
current branch. Re-baseline again only if review or downstream soak exposes a semantic regression,
or when an experimental DTO is proposed for public stability. Do not infer public API stability
merely from implementation completeness.

## 14. Release Strategy

- **Internal prototype:** IR and mandatory fixtures; no public compatibility promise.
- **Preview:** versioned `inspect()` and `plan()` behind an experimental export.
- **Compiler preview:** direct and KRO compilers consume the plan through the Effect runtime shell
  while compatibility side channels remain available for unmigrated capabilities and Promise
  facades remain compatible.
- **Parity release:** plan and legacy behavior pass the complete equivalence matrix; major DTO semantics freeze.
- **Default release:** public facades route through planning and artifact compilers; private reflection surfaces are deprecated.
- **Stability release:** formats receive documented compatibility guarantees and public integrations satisfy the conformance matrix.

No phase may claim portability merely because a value type is accepted. Unsupported target capabilities fail during planning, compilation, or adaptation with structured diagnostics.

## 15. Success Criteria

TypeKro reaches the intended state when:

1. Downstream integrations obtain the Kubernetes graph through public APIs only.
2. Direct and KRO compilers share one semantic source.
3. Standalone and Alchemy hosts execute the same direct or KRO artifact semantics, while YAML
   serializers consume those artifact plans without reinterpreting intent.
4. Ordered aspects and declared inputs participate explicitly in planning and digests.
5. Durable caches and adapters reject preview-unstable composition identities.
6. Representation compilers consume explicit versioned requirements rather than hidden factory behavior.
7. Persisted status, hydrated status, and KRO-owned fields have non-conflicting schemas.
8. No accepted portable field is silently ignored in either mode.
9. References, expressions, omissions, and sensitive references survive canonical serialization.
10. Plaintext secrets cannot leak into serializable plans, artifact plans, execution records,
    durable host state, or their digests.
11. Schema rules work portably or fail before execution.
12. Conditional resources, readiness, and status behave predictably across modes.
13. Kubernetes deletion and recovery are safe and diagnostically complete.
14. Provider effects have explicit portability and durability ownership.
15. Alchemy owns durable scheduling, provider-operation invocation, and state while TypeKro remains
    authoritative for Kubernetes operation semantics.
16. Importing TypeKro is quiet, lightweight, and reliable across supported runtimes.
17. Every public composition is protected by its declared conformance matrix.
18. Semantic equivalence, plan provenance, and compiled artifact identity use separate digests.
19. Plans, artifact plans, YAML, Alchemy declarations, and persisted diagnostics contain no Effect
    runtime values or undeclared service inputs.
20. Effect-wrapped execution preserves the semantic frontend and existing integration authoring
    APIs. If an experimental Effect-native facade is later introduced, it executes the same
    underlying program as the Promise facade.
21. Standalone Effect execution remains in-process and does not duplicate Alchemy's durable state,
    retry, provider, or workflow responsibilities.
22. Existing JS-to-CEL, closure-analysis, proxy, schema, and representative integration fixtures
    remain semantically equivalent through the Effect migration, and ordinary integration authors
    do not need to import Effect.
23. Direct and KRO remain the only deployment targets; Alchemy is an execution host, YAML is an
    output form, and apply mechanisms are artifact-operation policies.
24. Canonical artifact state survives JSON round trips without CEL-string scanning, WeakMap
    recovery, or host-specific reinterpretation.
25. Runtime requirements are negotiated independently across target, execution host, and output
    form. A closure supported by standalone KRO is not rejected merely because the target is KRO,
    and YAML or Alchemy never silently omit an unsatisfied runtime effect.

## 16. Adopted Design Decisions

1. `plan(spec, options)` is a direct composition method; inspection and planning are sibling projections of internal capture.
2. Ordered aspects and external bindings are explicit plan inputs with canonical manifests and normative digest contents.
3. Inspection reports potential capabilities; a plan reports realized required capabilities.
4. An explicit composition `revision` is the only stable v1 composition identity. Bundle identity is reserved until TypeKro controls a supported build boundary. Runtime function text is diagnostic only, and source-only plans are preview-unstable.
5. The portable TypeScript subset begins with the existing analyzer and conformance corpus rather than a smaller replacement grammar. The portable ArkType subset is conservative and explicitly documented.
6. Serializable plans never contain plaintext secrets.
7. Persisted and hydrated status have separate schemas; generated CRDs validate only persisted status.
8. Status modes are `auto`, `native`, `relay`, and `client-only`; `auto` never creates a relay, and explicit relay compilation remains unsupported until a separate relay proposal is approved.
9. KRO-owned root status fields are reserved by a versioned KRO compiler policy. Target-neutral inspection and direct planning do not reject them, and TypeKro does not silently namespace them.
10. The initial plan-backed executor preserves current create-or-patch and existing-resource
    conflict behavior. Server-side apply evolves the same direct artifact executor as an opt-in
    strategy requiring field-manager migration and live evidence; it is not a deployment target.
    Replacement requires current explicit configuration or declared recreation safety.
11. KRO artifact plans describe complete instance bundles with typed artifact roles.
12. Representation requirements are explicit, versioned compiler inputs produced by capture and decentralized factories actually used by the composition. They participate in semantic identity and are not an ordinary author `PlanOptions` escape hatch.
13. Desired canonicalizers are pure, cluster-independent, identified, versioned, and executed before semantic digesting.
14. Environment-dependent canonicalization belongs to compilation or materialization and affects artifact identity.
15. Semantic content, plan identity, and compiled artifact digests are separate.
16. Deferred container and provider operations are requirements/resolvers, not hidden planning effects. Existing eager `container()` and standalone provider APIs remain explicit compatibility operations whose literal outputs may be declared as plan inputs.
17. TypeKro does not create a general provider-operation registry; durable provider effects belong in Alchemy.
18. Existing provider-like TypeKro APIs receive explicit compatibility, migration, or deprecation decisions. Harbor remains a supported standalone API with an optional future Alchemy adapter over the same implementation.
19. All public facades normalize the same `PlanOptions`; compiler and execution options remain separate.
20. Private reflection surfaces remain for at least one parity-to-default release window.
21. The current source analyzer remains the compatibility frontend. Compiler-assisted source capture may augment it; explicit IR becomes semantic authority only after reproducing the existing corpus.
22. Effect v4 is TypeKro's in-process operational substrate, not its semantic or serialization
    model.
23. Semantic and artifact DTOs remain immutable, runtime-neutral, and free of Effect runtime
    values.
24. Existing Promise facades remain the default API and run each operation through one
    operation-scoped outer Effect program. Alchemy supplies the host runtime for provider
    operations. A public Effect-native facade is deferred and, if later introduced experimentally,
    must expose those same programs.
25. Effect adoption is adapter-first and cannot change authoring syntax, proxies, closure
    signatures, JS-to-CEL lowering, schema lowering, integrations, or generated output without an
    independently reviewed semantic change.
26. Operational service inputs that affect intent or artifacts must be promoted to declared inputs
    and included in the appropriate digest.
27. TypeKro does not use Effect Workflow to duplicate Alchemy's durable orchestration ownership.
28. Existing direct and KRO `toYaml()` overloads retain their current split semantics. A new lower-level `toYamlBundle(...)` operation may provide a complete KRO bundle without repurposing them.
29. The existing `aspect.on(...)` DSL remains the aspect authoring API; stable manifest identity is derived from registered target/surface semantics, canonical configuration, IR revision, and order.
30. Desired canonicalizers extend decentralized factory registration and are resolved by full GVK with idempotent identical registration and loud conflict rejection.
31. Direct and KRO are deployment targets; standalone and Alchemy are execution hosts; YAML is an
    output form; and create-or-patch, create-only, SSA, and replace are artifact apply mechanisms.
32. KRO retains exclusive apply and reconciliation ownership for graph children. TypeKro apply
    policy in KRO mode governs only outer artifacts TypeKro itself writes.
33. Alchemy adapters preserve target and compiled artifact semantics. Alchemy owns durable
    scheduling and state, while TypeKro's provider implementation owns Kubernetes operation
    semantics.
34. Standalone Promise facades run one operation-scoped top-level Effect program and preserve
    TypeKro error identities. Alchemy adapters yield programs into Alchemy's runtime and create no
    nested runtime.
35. Fallible Promise adapters use `Effect.tryPromise` with typed error mapping and real
    cancellation propagation. `Effect.promise` is reserved for non-rejecting operations.
36. Effect v4 pre-stable dependencies are pinned and tested as one compatible package cohort, not
    as independently floating beta packages.
37. Runtime closures are standalone compatibility requirements, not direct-target semantics.
    Standalone direct and KRO adapters may sequence existing supported closures; Alchemy requires a
    durable adapter or explicit external satisfaction, and static YAML rejects any unsatisfied
    runtime effect.

## 17. Current-State Resolutions

The implementation review resolves the previous open architectural directions as follows. Exact
signatures remain experimental until the mandatory fixtures pass.

1. Canonical encoding v1 uses recursively sorted JSON-compatible data, UTF-8, SHA-256, and typed versioned digest envelopes.
2. Explicit composition `revision` is the only stable v1 identity. Automatic bundle identity is deferred rather than creating a mandatory build boundary.
3. Aspect manifests derive identity from the existing `aspect.on(...)` target and surface model, canonical configuration, IR revision, and order. No parallel aspect registry is introduced.
4. Sensitive materialization builds on `sensitiveValue()` and sensitive declared inputs. Synchronous YAML performs no ambient resolution and fails with unresolved binding names.
5. The portable TypeScript profile is the existing proven analyzer corpus. Current source maps and the `fn.toString()` runtime self-test remain; compiler-assisted capture is optional future hardening.
6. Initial direct apply behavior is `create-or-patch` with existing-resource conflict strategies.
   SSA is an opt-in artifact policy implemented by evolving the existing direct executor and YAML
   SSA machinery. KRO child SSA remains entirely KRO-owned.
7. KRO root-status collision policy is versioned and enforced only by the KRO compiler. Collisions fail; TypeKro does not automatically change the typed status namespace.
8. Status relay is deferred. The model may reserve the mode, but compilers reject it until its operational design is separately approved.
9. Existing `toYaml()` overloads keep their current semantics. A separate lower-level `toYamlBundle(...)` operation may provide a complete bundle.
10. Existing eager `container()` keeps working-directory-relative context behavior. Deferred durable descriptors may declare a project root; an implicit root makes the plan preview-unstable during migration.
11. Canonicalizers reuse decentralized factory registration, key compatibility by full GVK, permit identical re-registration, and reject conflicts. Representation handlers are explicit compiler capabilities and operate only on requirements emitted by used factories/resources.
12. Compilers and adapters negotiate realized capabilities against static supported-major-version maps. Unused-evidence interpreters are explicit and typed, not provider plugins.
13. Harbor remains a supported standalone API. A durable Alchemy adapter is optional and must reuse the same client and reconciliation implementation.
14. Effect adoption starts with a small boundary around deployment-scoped Kubernetes clients, logging/tracing, and materialization resolvers. Existing operational classes are adapted; pure analyzers and compilers are not converted into services.
15. No stable `typekro/effect` subpath is planned initially. Any first public facade is experimental, demand-driven, and delegates to the same programs as Promise APIs.
16. Packaging budgets are established from measured baselines. Packed-package tests cover quiet
    Node/Bun imports for every published subpath, cold-import regression, declaration volume,
    tarball and unpacked size, and file count. Numeric thresholds are now CI release gates rather
    than a future measurement task.
17. Existing direct and KRO `toAlchemyResources()` behavior is the Alchemy migration baseline.
    `mode: 'alchemy'` is a compatibility context marker to normalize away, not a third deployment
    target.
18. Standalone uses an operation-scoped Effect program; Alchemy supplies the host runtime. Promise
    boundary adapters preserve existing errors and forward interruption. The entire Effect package
    family is pinned to a tested compatible cohort while v4 remains pre-stable.
19. Runtime-closure capability is negotiated at the host/output adapter boundary. The prototype
    now models target, host, and output requirements independently: standalone KRO sequences its
    supported closures, while static YAML and unsupported Alchemy paths reject unsatisfied runtime
    effects with structured diagnostics. No new closure language or executor is required.
20. Readiness has a dual portable contract rather than one overloaded callback. Canonical
    `readyWhen` expression IR captures target-portable predicates. Registered strategy identities
    capture reconstructible polling behavior and diagnostics. Deterministic factory evaluators are
    registered, clock-dependent evaluators are explicitly runtime-classified, and strict planning
    rejects an unclassified callback at its resource path. Opaque evaluators remain explicit
    runtime bindings with capability diagnostics; TypeKro does not serialize function source or
    use the kind-only readiness registry as durable semantic authority.

The prototype now preserves optional schema references through materialization, excludes
spec-resolvably inactive artifacts before identity resolution, and represents ordinary iteration
dimensions, collection aggregates, and orphaned-item collapse explicitly through direct expansion
and KRO compilation. It rejects sensitive activation, readiness, and iteration before compilation.
Specialized integration readiness evaluators are now registered or explicitly runtime-classified.
It still must define the exact KRO target-policy
version table, settle the public placement and return type of any `toYamlBundle(...)` API, prove
decoded-bundle parity across live hosts and persisted-state upgrades. Recursive sensitive-value
validation, inline Secret
classification, canonical spec redaction, inspection-time status taint, sensitive-identity
rejection, cross-artifact taint preservation, direct/KRO materialization, established dependency and
external-identity lowering, operation-scoped Alchemy host redaction, recursive singleton binding
isolation, explicit public-placeholder classification, and explicit static-YAML materialization are
implemented. Generic always-ready, condition-based, phase-based, and CRD evaluators are registered
portable strategies and no longer an open item. Numeric packed-artifact budgets and every-export
Node/Bun import checks are enforced in
CI. Prerequisite and namespace-hoisting requirements, symbolic-template planning, the
decentralized factory requirement-producer interface, the direct plan materializer, and
target/host/output capability negotiation are now implemented; they are no longer open
architectural questions. The remaining items are bounded
semantic migration, API, live-behavior, and measurement work, not unresolved responsibility or
authoring-model decisions.

### 17.1 Prototype correction status

The implementation review originally identified nine immediate corrections. Their current status
is recorded here so that completed prototype work is not repeatedly estimated while partial work is
not mistaken for production migration:

| # | Correction | Current status |
|---:|---|---|
| 1 | Move `PLAN_KRO_STATUS_FIELD_RESERVED` from target-neutral planning into KRO compilation. | Implemented in the prototype with direct/KRO differential coverage. |
| 2 | Remove plan-level `ApplyPolicy`; attach effective apply policy only to compiled artifacts. | Implemented in the prototype, including digest coverage for apply-policy changes. |
| 3 | Remove `representationRequirements` from public `PlanOptions`; derive requirements from capture and used factories. | Implemented. Used factories may emit pure, versioned requirements that participate in semantic identity. KRO prerequisites, namespace hoisting, and recursive singleton-owner outer bundles compile through the mechanism; the checked-in and representative live conformance corpus passes. |
| 4 | Feed analyzer references and source locations into `ExpressionIR`; stop treating regex extraction as semantic authority. | Implemented for the accepted analyzer corpus. Analyzer metadata and source locations are wired for status expressions and the fallback is CST-based. Remaining work is diagnostic quality and explicit rejection coverage, not parity repair. |
| 5 | Resolve desired canonicalizers by full GVK and exact used-factory provenance. | Implemented, including exact provenance validation, single-registration inference, ambiguous-provenance diagnostics, deterministic conflict detection, and checked-in same-GVK coverage. |
| 6 | Replace architectural `mode: 'alchemy'` branching with direct/KRO target plus Alchemy host context. | Provider execution now passes the declaration's direct/KRO strategy. The legacy union value remains only for source/state compatibility and still needs a deprecation migration. |
| 7 | Replace Alchemy CEL scanning and WeakMap/readiness reconstruction with explicit serializable artifact records. | Implemented for new direct and KRO Alchemy state. Direct declarations carry digested per-resource execution records; KRO declarations carry a canonical recursive bundle plus operation identity. Provider reconciliation decodes them, validates identity and dependency wiring against artifact edges, and restores portable metadata. JSON-state, tampering, live host, and legacy-to-canonical persisted-upgrade fixtures pass. A scanner remains only for the documented pre-record compatibility window. |
| 8 | Use typed, interruptible Effect adapters with one standalone outer runtime and no nested Alchemy runtime. | Implemented across stable cluster-facing Promise operations. Alchemy provider operations use `Effect.tryPromise` without a nested runtime. Standalone direct and KRO deploy/delete, instance/RGD/status reads, direct health/status reads, rollback, server dry-run, and authenticated event watch enter or join the operation boundary as appropriate. Exact TypeKro errors and abort reasons survive the Promise boundary, and interruption propagates through deployment, readiness, prerequisites, rollback, finalizer, and namespace-teardown waits. Generated-client calls with no per-request signal retain the documented bounded-timeout limitation. |
| 9 | Enforce one supported Effect v4 dependency cohort in package and lockfile tests. | Implemented for beta.75 across core, Bun platform, node-shared platform, and test packages, with Alchemy runtime coverage and a lockfile assertion. |

In addition, canonical plan/artifact codecs, typed reference/template lowering, plan-value
materialization, and direct artifact-to-runtime adaptation now exist. The production direct factory
uses a symbolic plan and that path for deploy, dry-run, direct YAML, and the graph supplied to direct
Alchemy. The production KRO RGD serializer likewise consumes compiled graph-child artifacts, and
focused tests prove cross-spec graph invariance plus nested-status and readiness parity. Nested
origin is an explicit canonical field and invalid forms are rejected during value, plan, and
artifact decoding. Generic readiness factories now also reconstruct from registered canonical
strategies. Recursive singleton-owner RGD compilation is now part of the canonical bundle;
KRO provider rehydration and standalone bundle execution now consume that decoded bundle.
Live invariance and persisted-state upgrade evidence now support Gates C and D production
acceptance. Effect operation coverage is implemented; generated-client reads that cannot receive a
per-request signal remain bounded by timeout rather than motivating another operation facade.
KRO/static-YAML sensitivity, identity,
mixed-template/conditional lowering, strict compilation, and the checked-in integration corpus are
green and are no longer known migration defects.
The legacy `mode: 'alchemy'` compatibility migration in correction 6 remains separate cleanup;
correction 7 is complete for new state.

## 18. Recommendation

Approve the responsibility boundary and move the measured migration into release stabilization.
The prototype has now demonstrated canonical planning, exact factory
provenance, decentralized representation requirements, target compilation, strict decoding, and a
production direct-path bridge with explicit external-reference materialization and readiness
identity, plus an authoritative production KRO graph-child/RGD path. The representative live
lifecycle, ownership, and target/host fixtures now pass, as do the final repository and packaging
gates; keep the DTOs experimental until the formats receive an explicit stability decision.
Specialized readiness behavior is now portable or explicitly constrained. Optionality, iteration,
activation, sensitivity, identity,
and established compiler shapes now survive the mandatory checked-in analyzer and integration
corpus. KRO outer-bundle
execution is now authoritative for new semantic-capture state in every host. The remaining reasons
to keep it experimental are final release evidence, downstream soak, and format stabilization, not
a missing host adapter, missing primary lifecycle path, or unresolved responsibility boundary.

Migrate KRO and declarative adapters incrementally through artifact plans, preserving the existing
engines behind compatibility adapters until differential and live evidence is complete. Do not
create a second executor or orchestration system. The right destination remains a stronger
Kubernetes semantic compiler and lifecycle library, with Alchemy remaining the durable execution
and provider system.

Continue introducing Effect through an adapter-first runtime shell around the migrated compiler
and existing operational engines. Treat current JS-to-CEL conversion, proxy behavior, closure
analysis, schema lowering, third-party composition integrations, and emitted artifacts as protected
compatibility surfaces. Effect should make compilation and execution safer and more testable; it
must not require the semantic frontend to understand Effect programs or force integration authors
to adopt Effect.
