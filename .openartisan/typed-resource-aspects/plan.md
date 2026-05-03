# Plan: Typed Resource Aspects and Kro-Safe Overrides

## Goal

Implement a first-class v1 aspect system for TypeKro that lets callers customize flattened resources without composition-specific plumbing, while preserving direct/Kro parity and failing loudly for Kro-unsafe operations.

Primary reference: GitHub issue #62, "Typed resource aspects and Kro-safe overrides".

## Scope

In scope for v1:

- `aspect.on(factoryOrGroup, override(...))`
- `aspect.on([factoryA, factoryB], override(...))` for targets with a common writable `spec` schema
- `aspect.on(allResources, metadata(...))`
- `aspect.on(resources, override(...))` for broad schema-capable resource targeting with advertised schema refinement where available
- `aspect.on(workloads, override(...))` for workload-focused compatibility targeting
- `override(...)`, `metadata(...)`, `replace(...)`, `merge(...)`, `append(...)`
- object-form `.where({...})`
- no-selector unconditional application
- `.optional()` and `.expectOne()` cardinality controls
- `slot(name, resource)` metadata helper
- factory/render-time aspect attachment through `graph.factory(..., { aspects })` and `graph.toYaml({ aspects })`
- `simple.Deployment` support
- `simple.StatefulSet` support through the same emitted-resource workload adapter as Deployment
- `resources` target group covering schema-capable resources, with runtime validation from advertised schemas or conservative current-spec inference
- `workloads` target group retained for workload-focused Deployment/StatefulSet compatibility
- Kro safety checks for reference-backed composite values

Out of scope for v1:

- shorthand plain-object operators
- builder-form selectors
- hand-maintained common workload override schemas separate from resource `spec`
- deploy-time `factory.deploy(spec, { aspects })`
- pod-template metadata surface
- arbitrary raw patches or YAML rewriting
- general deep merge
- raw full-resource schema auto-lifting without curated writable-field filtering
- full ecosystem factory support

## Requirement Coverage

- Requirement 1, typed factory-targeted aspects: stable factory targets, `aspect.on(...)`, Deployment and StatefulSet writable `spec` schemas, multi-target support, and matching after nested flattening.
- Requirement 2, queryable selectors: object-form `.where(...)`, AND semantics, label matching, no-selector unconditional matching, `.optional()`, `.expectOne()`, and no/multiple-match diagnostics.
- Requirement 3, Kro-safe operations: operator legality rules, reference-backed composite detection, direct/Kro parity tests, and fail-before-YAML behavior.
- Requirement 4, semantic slots: `slot(name, resource)` metadata stored on resources and preserved through nested flattening.
- Requirement 5, structured pipeline fit: aspect application before YAML/deployment, no raw YAML rewriting, advertised-schema validation, and conservative current-spec fallback only for schema-capable generic resources.
- Requirement 6, stack-wide metadata: `allResources` target and labels/annotations metadata adapter.
- Requirement 7, factory/render-time attachment: `graph.factory(..., { aspects })`, `graph.toYaml({ aspects })`, deterministic ordering, and unchanged no-aspect behavior.

Expected examples to support in tests and public JSDoc:

- hot-reload command/working directory/env/volume customization under a selected app workload's `spec.template.spec`
- stack-wide labels/annotations
- multi-workload target for all matching Deployments and StatefulSets, such as `aspect.on([simple.Deployment, simple.StatefulSet], override({ spec: ... })).where({ labels: { tier: 'app' } })`
- selector narrowing by `slot`, id/name/kind/namespace, and labels
- Kro-safety failure for reference-backed append/merge

Omitted capabilities are listed in the out-of-scope section. Each omission avoids expanding v1 into new selector-language design, deploy-time ordering semantics, non-curated patch behavior, or broad ecosystem support before the core model is proven.

Strategic revision: initial planning scoped broad overrides to `workloads`, but implementation review and user feedback broadened the public target to `resources` for any schema-capable resource. The tradeoff is intentional: concrete factory targets provide the strongest static narrowing; `resources` provides generic schema-capable targeting with runtime validation; `allResources` remains metadata-only to avoid unsafe arbitrary spec mutation.

## Design Approach

### 1. Add Public Aspect API

Add a small public API that mirrors the RFP:

```ts
aspect.on(simple.Deployment, override({
  spec: {
    template: {
      spec: {
        containers: append([{ name: 'app', command: ['bun', 'run', 'dev'] }]),
      },
    },
  },
})).where({ slot: 'app' }).expectOne();

aspect.on(allResources, metadata({
  labels: merge({ env: 'dev' }),
}));

aspect.on([simple.Deployment, simple.StatefulSet], override({
  spec: {
    template: {
      spec: {
        containers: append([{ name: 'app', env: [{ name: 'LOG_LEVEL', value: 'debug' }] }]),
      },
    },
  },
})).where({ labels: { tier: 'app' } });
```

The public API should create structured aspect definitions. It should not mutate resources at creation time and should not rely on global mutable aspect state.

Explicit v1 decisions:

- Include `resources` as the broad schema-capable override group so Service and future structured-spec resources can receive typed overrides without one group per kind.
- Retain `workloads` as a workload-focused compatibility group for Deployment and StatefulSet.
- Include `simple.StatefulSet` by mutating the emitted Kubernetes StatefulSet resource, not by first expanding `StatefulSetConfig`.
- Do not add `podTemplateMetadata(...)`; resource metadata remains separate from pod-template metadata in v1.
- Do not add deploy-call aspects; only factory/render-time aspects are supported.
- Export from the existing main entry point only. No new package subpath is required for v1.

### 2. Store Matching Metadata on Resources

Extend `ResourceMetadata` with aspect matching fields such as:

- factory identity or target ids
- supported aspect surfaces
- optional semantic slot
- original resource id/name/kind/namespace/labels snapshot where useful for selectors

Use WeakMap metadata only. Do not serialize aspect metadata into YAML.

Stamp metadata in simple workload factories and preserve it through nested composition flattening via existing metadata copy paths.

### 3. Implement Target Groups and Selectors

Represent targets as stable internal descriptors:

- simple factory target identities for `simple.Deployment` and `simple.StatefulSet`
- `allResources`
- `resources`, defined as the broad schema-capable override group for resources that advertise writable schemas or have structured `spec` objects
- `workloads`, retained as the workload-focused group for v1 Deployment and StatefulSet resources

`aspect.on([simple.Deployment, simple.StatefulSet], override({ spec: ... })).where({...})` applies one aspect to every flattened Deployment or StatefulSet that matches the selector. This supports examples such as "all app-tier workloads" without requiring callers to write one aspect per resource type.

Implement selectors with AND semantics:

- `slot`
- `id`
- `name`
- `namespace`
- `kind`
- `labels`

Cardinality rules:

- no selector: apply to all matching target resources
- no match: error by default
- `.optional()`: allow zero matches
- `.expectOne()`: require exactly one match
- multiple matches without `.expectOne()`: allowed

### 4. Add Curated Spec-Derived Surface Adapters

Add metadata adapter:

- `labels`: `merge` or `replace`
- `annotations`: `merge` or `replace`

Add spec-derived override adapter:

- Each aspect-capable factory advertises a curated writable schema rooted at `{ spec: ... }`.
- For `simple.Deployment`, the advertised schema is the safe writable subset of the emitted Kubernetes Deployment `spec`.
- For `simple.StatefulSet`, the advertised schema is the safe writable subset of the emitted Kubernetes StatefulSet `spec`.
- For `aspect.on([simple.Deployment, simple.StatefulSet], override(...))`, TypeScript and runtime validation use the recursively common writable subset under `spec`.
- `status`, identity metadata, generated fields, and Kro-sensitive fields are excluded from advertised writable schemas.
- The implementation must not model multi-target overrides as `Partial<Deployment & StatefulSet>` because TypeScript intersections do not mean common keys only and can admit target-specific fields.
- Operator behavior is schema-derived and uniform: `replace(...)` may target any advertised writable field; `merge(...)` may target advertised concrete object fields; `append(...)` may target advertised concrete array fields. Field-specific semantics come from the factory-advertised schema, not from a central workload-specific operator table.

Schema ownership decisions:

- The aspect interface layer defines the generic contract for factory-advertised `{ spec: ... }` schemas and common-schema derivation.
- Concrete Deployment and StatefulSet advertised schemas belong to their factory integration, not to a centrally maintained common workload schema in the aspect interface contract.
- Implementation may derive those concrete schemas from the factory output/resource types or define factory-local aliases, but it should not introduce a hand-maintained cross-workload schema owned by `src/core/aspects/types.ts`.
- Tests should prove behavior through public typing: Deployment accepts valid curated spec paths, a Deployment/StatefulSet target array rejects target-specific spec paths, `resources` accepts schema-capable resource overrides without unsafe casts, and `allResources` remains metadata-only.

Adapters should mutate structured Kubernetes resource objects before YAML/deploy processing. They must not rewrite YAML strings.

### 5. Enforce Kro Safety

Classify operations by target field state and mode:

- `replace(...)` is legal for literals, KubernetesRefs, and CelExpressions.
- `merge(...)` and `append(...)` are legal only when the current target is concrete object/array.
- `merge(...)` and `append(...)` against a KubernetesRef/CelExpression/reference-backed composite must fail in Kro mode.

Use existing helpers such as `isKubernetesRef`, `isCelExpression`, `containsKubernetesRefs`, and `containsCelExpressions`.

Errors should include target summary, surface, selector context, match count, resource id/name, mode, operation, and reason.

### 6. Attach Aspects to Factory and Render Paths

Add `aspects` to public factory/render options.

Required behavior:

- `graph.factory('direct', { aspects })` applies aspects before direct deployment/YAML resource use.
- `graph.factory('kro', { aspects })` applies aspects before RGD YAML/deployment use.
- `graph.toYaml({ aspects })` applies aspects before Kro RGD serialization.
- no aspects means behavior is unchanged.
- multiple aspects apply in array order.

Ordering is observable and intentional: later aspects see the resource mutations made by earlier aspects. For example, applying `metadata({ labels: merge({ tier: 'app' }) })` before `aspect.on(workloads, override({ spec: ... })).where({ labels: { tier: 'app' } })` allows the later workload aspect to match labels added by the earlier metadata aspect.

Implementation should avoid mutating shared base graph resources in a way that makes repeated `toYaml()` calls non-idempotent. Prefer per-render/per-factory resource cloning with metadata preservation or another explicit single-use strategy.

### 7. Integration Points

Internal integration points:

- `PublicFactoryOptions`: add `aspects` for factory-time attachment.
- `TypedResourceGraph.toYaml`: add an options overload for render-time aspects while preserving existing `toYaml()` and `toYaml(spec)` behavior.
- `toYaml` overload dispatch decision: an object is treated as render options only when it has an own `aspects` property whose value is an array. Other objects are treated as specs. If a spec itself has an `aspects` field, callers must use factory-time aspects or an explicit future overload; v1 does not support ambiguous spec/render-options objects.
- Avoid unrelated public API churn: do not change existing deployment `Error` fields, do not add broad aspect-specific `@throws` annotations to general deployment interfaces, and do not propagate generic internal option changes unless implementation proves they are required for the aspect feature.
- `createDirectResourceFactory`: receive/apply aspects before direct resource graph use.
- `createKroResourceFactory` and RGD rendering: receive/apply aspects before serializing Kro resources.
- `ResourceMetadata`: store aspect target/surface/slot metadata.
- simple workload factories: stamp aspect metadata on emitted resources.
- public API barrel: export aspect helpers and target groups from `src/index.ts`.

External integration points:

- No database, network service, credentials, DNS, HTTP route, or Kubernetes cluster setup changes are required.
- No new npm/Bun dependencies are required; this behavior depends on TypeKro's magic proxies, Kro safety model, metadata store, and serialization pipeline.
- No OpenCode/Hermes/Claude protocol methods are part of the TypeKro feature. Dogfooding adapter fixes are tracked separately.
- Package export impact is limited to the existing main entry point. A future `typekro/aspects` subpath is explicitly out of v1.

### 8. End-User Journey

Installation and onboarding:

- Users install TypeKro as they do today. No new package or controller installation is needed.
- Users import the new helpers from `typekro` alongside existing APIs.

Daily use:

- Composition authors continue writing `kubernetesComposition` or `toResourceGraph` without threading every customization field through nested specs.
- Callers attach environment-specific aspects at render/factory time.
- Callers use selectors when multiple target resources exist.

Operational modes:

- Direct mode applies legal aspects before direct resource graph deployment/YAML generation.
- Kro mode applies legal aspects before RGD YAML generation/deployment.
- The same legal aspect list should have equivalent structured effects in both modes.

Error recovery:

- If a selector matches zero resources, use `.optional()` for intentional absence or adjust selector metadata.
- If `.expectOne()` matches multiple resources, narrow with `where(...)` or remove `.expectOne()`.
- If Kro mode rejects `append`/`merge` on a reference-backed composite, use `replace(...)` or move the customization into the composition.

Documentation/workflow integration:

- Public JSDoc examples cover core examples. Full docs page updates are out of v1 unless a later documentation phase explicitly adds them.
- CI and local workflows remain unchanged: typecheck, lint, tests, and build.

Reference and competing solution comparison:

- CDK Aspects provide tree-wide construct traversal, but TypeKro v1 aspects intentionally avoid arbitrary traversal hooks. TypeKro aspects are narrower and safer: typed factory/group targets, curated mutation surfaces, selectors, and Kro-mode safety checks.
- Kustomize patches can mutate rendered YAML broadly, but TypeKro v1 explicitly avoids raw YAML patching so mutations remain structured, type-directed, and checked before direct/Kro serialization.
- Helm values are chart-specific configuration inputs, but TypeKro aspects operate after composition flattening so callers can customize nested resources without each composition author exposing pass-through values.
- Kubernetes strategic merge/json patches support broad resource mutation, but TypeKro v1 does not attempt parity with generic patch systems. The gap is intentional: v1 optimizes for safe curated `spec` and metadata customizations, not unrestricted patch power.
- Compared with these tools, expected omissions are raw arbitrary patching, service-specific surfaces, pod-template-specific shorthand helpers, and raw full-resource schema auto-lifting. These remain out of scope until the typed target, selector, and Kro-safety model is proven.

## Proposed Implementation Phases

### Phase A: Aspect Types and Metadata Foundations

- Add aspect operation and selector types.
- Add public constructors: `aspect`, `override`, `metadata`, `replace`, `merge`, `append`.
- Add target groups: `allResources` and `workloads`.
- Extend `ResourceMetadata` with aspect matching fields and slot support.
- Add `slot(name, resource)` helper.
- Stamp factory/surface metadata in `simple.Deployment` and `simple.StatefulSet`.
- Preserve metadata through nested composition flattening.

### Phase B: Matching, Cardinality, and Metadata Adapter

- Implement aspect matching over flattened resource maps.
- Implement selector filtering.
- Implement `.optional()` and `.expectOne()` validation.
- Implement ordered aspect application.
- Implement metadata surface adapter for labels/annotations.
- Add diagnostics for no match, multiple expectOne matches, and invalid target/surface combinations.

### Phase C: Spec-Derived Workload Adapter and Kro Safety

- Implement override adapter for curated writable `{ spec: ... }` schemas on Deployment-shaped resources.
- Add Kro-safety checks for merge/append target fields.
- Support recursive patch application under `spec`, including Kubernetes pod-template fields when those fields are present in the advertised writable schema.
- Support multi-target common schema checks so a StatefulSet-only `spec` field is rejected for `[simple.Deployment, simple.StatefulSet]`.
- Enable simple StatefulSet through the same emitted-resource adapter. Do not expand `StatefulSetConfig` unless tests reveal emitted resource mutation cannot represent the v1 surface.

### Phase D: Factory/Render Integration

- Add `aspects` to public options.
- Apply aspects in direct factory resource graph creation.
- Apply aspects in Kro factory RGD generation.
- Apply aspects in graph-level `toYaml({ aspects })`.
- Ensure no-aspect paths remain unchanged.
- Ensure repeated renders do not duplicate append/merge mutations.

### Phase E: Validation and Documentation Touches

- Add or update public exports.
- Add JSDoc for public aspect API.
- Add focused examples in public JSDoc and tests.
- Run targeted tests and typecheck.

## Testing Plan

Add targeted unit tests before implementation.

Core behavior tests:

- `aspect.on(simple.Deployment, override({ spec: ... }))` mutates a Deployment workload.
- `aspect.on(allResources, metadata(...))` labels all flattened resources.
- aspects apply after nested composition flattening.
- no selector applies to all target matches.
- selector no-match fails by default.
- `.optional()` allows no matches.
- `.expectOne()` fails on zero or multiple matches.
- multiple matches without `.expectOne()` apply to all matches.
- ordered aspects are deterministic and later operations observe earlier mutations.
- multi-type aspects apply to all matching Deployments and StatefulSets under a shared selector.

Direct/Kro tests:

- direct factory resource graph includes aspect mutations.
- Kro `toYaml()` includes equivalent legal aspect mutations.
- no-aspect factory/YAML output is unchanged.
- repeated `toYaml({ aspects })` does not duplicate appended arrays.

Kro-safety tests:

- `replace(...)` accepts literals, KubernetesRefs, and CelExpressions.
- `append(...)`/`merge(...)` into concrete fields succeeds in Kro mode.
- `append(...)`/`merge(...)` into reference-backed array/object fails with targeted diagnostics.

Type/API tests:

- Deployment target accepts curated writable `spec` override fields.
- multi-target Deployment/StatefulSet override accepts only recursively common writable `spec` fields.
- StatefulSet-only `spec` fields are rejected for a Deployment/StatefulSet target array.
- `allResources` accepts metadata override fields.
- invalid target/surface pairings fail at compile time where feasible.
- multi-target common surfaces are constrained where feasible.

## Proposed File Allowlist

Because this is INCREMENTAL mode, implementation should be limited to the smallest approved file set. Proposed allowlist:

- `src/index.ts`
- `src/core/types/deployment.ts`
- `src/core/types/resource-graph.ts`
- `src/core/metadata/resource-metadata.ts`
- `src/core/serialization/core.ts`
- `src/core/deployment/direct-factory.ts`
- `src/core/deployment/kro-factory.ts`
- `src/core/serialization/yaml.ts`
- `src/factories/simple/workloads/deployment.ts`
- `src/factories/simple/workloads/stateful-set.ts`
- `src/core/aspects/index.ts`
- `src/core/aspects/types.ts`
- `src/core/aspects/metadata.ts`
- `src/core/aspects/apply.ts`
- `src/core/aspects/adapters.ts`
- `test/unit/aspects.test.ts`
- `test/unit/aspects-types.test.ts`

Allowlist adequacy review:

- The allowlist covers all remaining phases: interface/type work, tests, implementation, public exports, and direct/Kro integration.
- New `src/core/aspects/*` files are justified because aspects are a new cohesive subsystem with public types, matching, adapters, and application logic. Placing all logic into existing serialization/deployment files would increase coupling and duplicate behavior.
- Existing dependencies do not provide this feature because the behavior is TypeKro-specific: typed factory identity, WeakMap resource metadata, magic proxy/CEL/KubernetesRef handling, Kro legality checks, and ordered application before TypeKro serialization.
- The allowlist excludes generated files, docs build outputs, package manager config, and unrelated ecosystem factories.
- `simple.StatefulSet` remains in the allowlist because v1 explicitly supports it through emitted-resource metadata and adapter behavior.

## Risks and Mitigations

- Risk: repeated renders duplicate append/merge changes.
  - Mitigation: apply aspects to per-render/per-factory resource copies with metadata preservation.

- Risk: metadata lost across nested composition flattening.
  - Mitigation: extend and test existing metadata copy paths.

- Risk: direct/Kro behavior diverges.
  - Mitigation: centralize aspect application and call it from both direct and Kro paths.

- Risk: generic patch behavior leaks into API.
  - Mitigation: implement only curated adapters and explicit operators.

- Risk: reference-backed composites produce invalid Kro YAML.
  - Mitigation: fail during aspect application before serialization/deployment.

- Risk: StatefulSet support expands scope.
  - Mitigation: support it only through emitted-resource adapter behavior and avoid expanding the simple factory config unless required by tests.

## Verification

During implementation tasks, run targeted tests first:

- `bun test test/unit/aspects.test.ts --timeout 10000`
- `bun test test/unit/aspects-types.test.ts --timeout 10000` if type-level test file exists

Then broaden:

- `bun run typecheck:lib`
- `bun run test`
- `bun run build` near completion if time allows

## Deployment, Rollout, and Operations

No infrastructure deployment is required for this library feature.

Production reach:

- The feature reaches users through the normal TypeKro package release process after merge.
- No Kubernetes manifests, CRDs, webhooks, DNS, credentials, databases, or long-running services are introduced.
- Existing CI/build/test gates are sufficient for rollout validation.

Rollback:

- Rollback is normal source/package rollback: revert the change or release a patch version.
- No data migration or persistent state migration is required.

Logging and monitoring:

- No runtime monitoring or alerting is required because aspect application is synchronous library logic.
- Errors must be structured and actionable at render/deploy time.
- Diagnostic policy: aspect failures should throw structured TypeKro errors with target, selector, operation, mode, and reason; successful aspect application should remain quiet by default.
- Existing debug logging conventions can be used for optional local diagnostics if the project already exposes a debug channel, but v1 must not introduce new always-on logs or new log streams.

Incident response:

- Production incidents are expected to present as library render/deploy failures or incorrect generated manifests, not as service outages owned by this feature.
- Triage starts from the thrown aspect diagnostic, the aspect list supplied by the caller, the selected mode (`direct` or `kro`), and generated YAML/resource output.
- If a released aspect behavior is unsafe, mitigation is to remove or narrow the caller's aspect list, switch from `append`/`merge` to `replace` where appropriate, or roll back/release a patch version of TypeKro.
- No runtime kill switch, pager, or new operational runbook is required for v1 beyond documenting the diagnostic fields and rollback path.

Security and least privilege:

- No new auth flow or privilege boundary is introduced.
- Aspect inputs are local TypeScript values supplied by the caller.
- Validation prevents unsafe Kro representations from being emitted.
- Secret material must not be logged or serialized beyond caller-provided Kubernetes Secret references/values already represented in resources.

## Dogfooding Observations To Track Separately

The TypeKro implementation should not be blocked by these, but they are Open Artisan improvement candidates found during this run:

- `request_review` with relative `artifact_files` caused invalid persisted state; fixed in Open Artisan by normalizing to absolute paths.
- Discovery approval checkpoint failed with `spawnSync git ENOBUFS`; investigate Open Artisan git checkpoint output buffering for dirty/large worktrees.
