# Implementation Plan: Typed Resource Aspects

This revised DAG uses one integration task because the implementation reviewer runs the full expected test files and full unit regression checks for each task. The previous four-task DAG had correct engineering boundaries, but its early tasks intentionally left downstream aspect runtime tests red, which made per-task review impossible to satisfy. A single task aligns the scheduler with the actual review gate: all approved aspect tests become green together.

## DAG Strategy and Tradeoffs

- **Task shape:** Use one integration task that owns the full vertical slice from public API to metadata, adapters, and render/factory wiring.
- **Why not parallelize:** The work touches shared aspect contracts, metadata propagation, serialization/factory paths, and the same two test files. Splitting created useful conceptual phases but not independently reviewable green checkpoints under the current workflow.
- **Review alignment:** The task is complete only when `test/unit/aspects-types.test.ts`, `test/unit/aspects.test.ts`, `bun run typecheck:lib`, and final regression commands pass.
- **Scope control:** Keep the implementation to the approved v1 surfaces. Do not add deploy-time aspects, raw YAML patching, broad ecosystem factory support, network/auth/timeout behavior, new package subpaths, or unrelated deployment API churn.

## Task T1: Implement typed resource aspects end-to-end

**Dependencies:** none
**Category:** integration
**Files:**
- src/index.ts
- src/core/types/deployment.ts
- src/core/types/resource-graph.ts
- src/core/metadata/resource-metadata.ts
- src/core/serialization/core.ts
- src/core/deployment/direct-factory.ts
- src/core/deployment/kro-factory.ts
- src/core/serialization/yaml.ts
- src/factories/simple/workloads/deployment.ts
- src/factories/simple/workloads/stateful-set.ts
- src/core/aspects/index.ts
- src/core/aspects/types.ts
- src/core/aspects/metadata.ts
- src/core/aspects/apply.ts
- src/core/aspects/adapters.ts
**Expected tests:**
- test/unit/aspects-types.test.ts
- test/unit/aspects.test.ts
**Complexity:** large

Implement the full approved v1 typed resource aspects feature.

Acceptance details:

- Export public helpers from `src/index.ts`: `allResources`, `workloads`, `aspect`, `replace`, `merge`, `append`, `metadata`, `override`, `slot`, and aspect error/types.
- Keep public descriptors immutable; `.where`, `.optional`, and `.expectOne` must return refined definitions without mutating the previous definition.
- Validate definition-time invalid data: null object merges, undefined/non-array appends, unsupported metadata fields, invalid override roots, invalid operation placement, empty slot names, duplicate selectors, and conflicting cardinality methods.
- Preserve the approved TypeScript contracts: literal target groups, required `ToYamlOptions.aspects`, array/object/scalar operation constraints, public render/factory option visibility, target-array compatibility, and recursively common multi-target override surfaces.
- Store aspect metadata in WeakMap-backed resource metadata only; never serialize aspect metadata into Kubernetes manifests.
- Implement `slot(name, resource)` by attaching semantic slot metadata and preserving it through resource flattening/copy paths.
- Stamp `simple.Deployment` and `simple.StatefulSet` emitted resources with factory target identity, `workloads` target group membership, supported surfaces, id/name/namespace/kind/labels selector data, and curated writable `spec` support.
- Match aspect targets for `allResources`, `workloads`, concrete factory targets, and target arrays.
- Apply selector AND semantics for `slot`, `id`, `name`, `namespace`, `kind`, and `labels`.
- Enforce cardinality: default one-or-more, `.optional()` zero-or-more, and `.expectOne()` exactly-one.
- Apply aspects in array order so later selectors observe earlier mutations.
- Implement metadata `merge` and `replace` for labels and annotations.
- Implement override `replace`, `merge`, and `append` under curated `{ spec: ... }` paths for Deployment and StatefulSet emitted resources.
- Enforce Kro safety: `merge` and `append` must fail before YAML when the target value is reference-backed or expression-backed in Kro mode; `replace` remains legal.
- Avoid mutating shared base resources across repeated render calls; repeated `toYaml({ aspects })` with append operations must be idempotent.
- Throw structured `AspectApplicationError` diagnostics with aspect index, target, selector, match count, resource identity, mode, surface, operation, field path, and reason while redacting operation values and full manifests.
- Support `graph.toYaml({ aspects })` as render options only when the argument has an own `aspects` array; preserve existing `toYaml()` and `toYaml(spec)` behavior.
- Support `graph.factory('direct', { aspects })` and `graph.factory('kro', { aspects })` before direct resource graph use and Kro RGD serialization.
- Keep no-aspect rendering unchanged and ensure legal metadata aspects have equivalent structured effects in direct and Kro paths.

Expected green outcomes after T1:

- `bun test test/unit/aspects-types.test.ts --timeout 10000` passes.
- `bun test test/unit/aspects.test.ts --timeout 10000` passes.
- `bun run typecheck:lib` passes.
- Before final implementation review, `bun run typecheck` and `bun run test` pass or any unrelated pre-existing failures are explicitly identified with evidence.

Integration seams owned by T1:

- Public API barrel and compile-time type contracts.
- Resource metadata stamping and preservation through flattening.
- Shared aspect application engine and Deployment/StatefulSet adapters.
- Direct factory, Kro factory, and render-time YAML entry points.
- Serialization safety and diagnostic behavior.

## Verification Plan

Run during implementation:

- `bun test test/unit/aspects-types.test.ts --timeout 10000`
- `bun test test/unit/aspects.test.ts --timeout 10000`
- `bun run typecheck:lib`

Run before final implementation review:

- `bun run typecheck`
- `bun run test`

## Non-Goals Preserved

- No deploy-time `factory.deploy(spec, { aspects })` support.
- No generic YAML patching or arbitrary raw patches.
- No broad ecosystem factory support beyond v1 Deployment and StatefulSet workload adapters.
- No new network, auth, credentials, Kubernetes cluster, or timeout behavior.
