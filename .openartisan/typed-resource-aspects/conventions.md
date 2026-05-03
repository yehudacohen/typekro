# Conventions: Typed Resource Aspects

## Scope

This document captures repository conventions and feature-specific constraints for implementing typed resource aspects and Kro-safe overrides for TypeKro issue #62.

Applicable reference material:

- GitHub issue #62: typed resource aspects and Kro-safe overrides RFP.
- `AGENTS.md`: TypeKro engineering and safety requirements.
- `.openartisan/typed-resource-aspects/discovery-report.md`: generated discovery scan.
- Existing implementation in `src/core`, `src/factories`, and `test/unit`.

## Naming Conventions

- Files use kebab-case: `resource-metadata.ts`, `direct-factory.ts`, `simple-deployment-features.test.ts`.
- Functions and variables use camelCase: `createResourceGraphForInstance`, `resourcesWithKeys`, `compositionAnalysis`.
- Types, interfaces, and classes use PascalCase: `PublicFactoryOptions`, `TypedResourceGraph`, `KubernetesRef`, `ValidationError`.
- Constants use UPPER_SNAKE_CASE when they are true constants or symbols: `CEL_EXPRESSION_BRAND`, `KUBERNETES_REF_BRAND`.
- Public aspect API names should match the RFP and existing user-facing style: `aspect`, `override`, `metadata`, `replace`, `merge`, `append`, `slot`, `allResources`, `workloads`.
- Resource factory names follow existing convention: lower-level Kubernetes factories are lowercase (`deployment`, `statefulSet`), while simple factories are PascalCase (`simple.Deployment`, `simple.StatefulSet`).
- New internal files should be named for their domain, not implementation mechanics. Prefer names like `aspects.ts`, `aspect-metadata.ts`, `aspect-selectors.ts`, or `workload-adapter.ts` over vague names like `patcher.ts`.

## Architecture Patterns

- Core framework behavior belongs under `src/core/`; user-facing simple factories belong under `src/factories/simple/`.
- Public APIs should be exported through existing barrels, especially `src/index.ts` and any relevant `src/core/types/index.ts` or category index files.
- Public barrels may import/re-export lower layers; lower layers must not import public barrels.
- `src/core/types` should remain the lowest-level type layer. Avoid runtime imports from higher-level modules there.
- `src/core/proxy`, `src/core/composition`, `src/core/serialization`, and `src/core/deployment` may depend on core utilities/types, but must not depend on concrete factory implementations.
- Factories may depend on core. If core needs factory identity or capability information, use metadata, registry, or injected providers instead of importing factories.
- Simple factories may depend on Kubernetes factories; Kubernetes factories must not depend on simple factories.
- Ecosystem compositions may depend on Kubernetes/simple/ecosystem resources; resource factories should avoid depending on compositions.
- Cross-cutting utilities such as `src/utils`, `src/shared/brands.ts`, and core constants should not import domain modules.
- Keep the aspect system structured and metadata-driven. Do not implement raw YAML string rewriting or generic Kubernetes patching.
- Use the existing WeakMap metadata store in `src/core/metadata/resource-metadata.ts` for aspect matching metadata so no implementation details leak into YAML or JSON.
- Preserve metadata across existing copy/spread paths by extending the existing metadata model rather than adding non-enumerable ad hoc properties.
- Apply aspects after nested composition flattening and before direct/Kro serialization or deployment execution.
- Share aspect application between direct and Kro paths so `factory('direct', { aspects })`, `factory('kro', { aspects })`, and render-time `toYaml({ aspects })` do not drift.
- Public factory/render options should extend `PublicFactoryOptions` and `TypedResourceGraph` overloads carefully. Do not add internal-only fields to public types unless they are intentionally user-facing.
- Adapter logic should operate on structured resources:
  - resource metadata labels/annotations via `resource.metadata`
  - workload container fields via `resource.spec.template.spec.containers[0]`
  - workload volumes via `resource.spec.template.spec.volumes`
- Kro-safety validation should use existing runtime guards: `isKubernetesRef`, `isCelExpression`, `containsKubernetesRefs`, and `containsCelExpressions`.
- `replace(...)` can accept literals, KubernetesRefs, and CelExpressions. `merge(...)` and `append(...)` must reject reference-backed composite target fields in Kro mode.
- Avoid mutating shared resource objects repeatedly across multiple `toYaml()` calls. Any in-place aspect application must be guarded, cloned safely with metadata preserved, or scoped to per-render/per-factory resource instances.

## Module Structure Guidance

Expected implementation areas should be refined in planning, but likely candidates are:

- `src/core/types/deployment.ts`: public factory option shape.
- `src/core/types/resource-graph.ts`: public graph render/factory overloads if render-time aspects are added.
- `src/core/metadata/resource-metadata.ts`: aspect matching metadata fields and helpers.
- `src/core/serialization/core.ts`: graph-level attachment/plumbing for `factory(...)` and `toYaml(...)`.
- `src/core/deployment/direct-factory.ts`: direct-mode resource graph creation/deploy/YAML aspect application.
- `src/core/deployment/kro-factory.ts`: Kro RGD render/deploy aspect application.
- `src/core/serialization/yaml.ts`: final Kro serialization should receive already-mutated resources rather than applying aspects as YAML rewrites.
- `src/factories/simple/workloads/deployment.ts`: simple Deployment should stamp factory identity/surface metadata.
- `src/factories/simple/workloads/stateful-set.ts`: simple StatefulSet support should be planned carefully because its config surface is currently narrower than Deployment.
- `src/index.ts`: public aspect API exports if accepted in planning.

## Import Conventions

- Import order is external libraries first, internal modules second, type-only imports last within the same logical block.
- Local TypeScript imports use explicit `.js` extensions.
- Relative imports are standard inside `src`; no project-wide path alias should be introduced for this feature.
- Public consumers should use package barrels/subpaths. Internal implementation should avoid importing from `src/index.ts`.
- Use `import type` and `export type` for type-only dependencies.
- New public API exports must be added through the correct barrel rather than requiring consumer deep imports.

## Error Handling Conventions

- Domain errors should extend `TypeKroError` directly or use an existing subclass such as `ValidationError` when appropriate.
- Structured errors should carry stable codes and context fields rather than only free-form messages.
- Aspect validation failures should include target summary, surface, selector context, matched count, resource id/name when available, mode, operation, and reason.
- Catch blocks should use `unknown` and normalize with `ensureError` before reading messages.
- Readiness evaluators return structured status objects instead of throwing for ordinary not-ready states.
- Kubernetes API catch blocks should inspect `error.statusCode ?? error.code ?? error.body?.code` when classifying API failures.
- Validation belongs in serialization/application boundaries, not in composition function signatures.

## Testing Conventions

- Use `bun test` and existing test layout. Targeted tests should live under `test/unit` unless they are true integration tests.
- Test files use the `*.test.ts` suffix and are kept under `test/`, not colocated with `src/`.
- Tests import from `bun:test`: `import { describe, expect, it } from 'bun:test';`.
- Top-level `describe('Feature Name', ...)` blocks with nested `describe(...)` for sub-features are standard.
- Individual test descriptions are descriptive and often use `should ...` phrasing.
- Assertions use Bun/Jest-style `expect`: `toBe`, `toEqual`, `toContain`, `toBeDefined`, `toThrow`, `toMatch`, `not.toContain`, and `toHaveLength`.
- Prefer typed helpers from `test/utils/mock-factories.ts` or focused inline helpers over ad hoc `as any` casts.
- Bun mocks use `mock` from `bun:test` when mocking is necessary.
- Integration tests use `beforeAll`/`afterAll`, cluster-availability guards, and shared helpers such as `test/integration/shared-kubeconfig.ts`.
- Add tests before implementation during the Open Artisan `TESTS` phase.
- Prefer end-to-end `kubernetesComposition(...).toYaml()` tests for Kro serialization behavior because many regressions only appear through the full pipeline.
- Use direct factory `createResourceGraphForInstance(...)` tests for direct-mode structured resource mutation.
- Include type-level API tests if the plan introduces inference-heavy public types. Existing test infrastructure includes TypeScript typecheck scripts; avoid `as any` in new type-safety tests.
- Cover both positive and negative cases:
  - factory-targeted Deployment aspect applies to flattened nested resources
  - `allResources` metadata applies to all flattened resources
  - selector no-match fails by default
  - `.optional()` allows zero matches
  - `.expectOne()` rejects zero or multiple matches
  - ordered aspects apply deterministically
  - Kro mode rejects `append` or `merge` against reference-backed arrays/objects
  - legal direct and Kro aspects produce equivalent structured effects where representable
- Regression tests must avoid changing expectations to match broken behavior. If a test exposes a real implementation gap, fix the implementation.

## Code Style Rules

- Use Bun commands only. Do not introduce npm/yarn/pnpm lockfiles or instructions.
- Format with existing Biome conventions: 2 spaces, single quotes, semicolons, 100-character line preference, trailing commas where configured.
- Use explicit `.js` extensions on local TypeScript imports.
- Use `import type` for type-only imports.
- Prefer `unknown` plus narrowing over `any`. Do not add `as any`; if a cast is unavoidable, it must be narrow, justified, and consistent with existing internal patterns.
- Respect `exactOptionalPropertyTypes`: omit optional fields instead of setting them to `undefined`.
- With `noUncheckedIndexedAccess`, guard array access (`containers[0]`) before mutation.
- Add JSDoc for public APIs, exported helpers, and complex types.
- Keep comments rare and explanatory. Use comments to explain non-obvious Kro/proxy constraints, not line-by-line mechanics.
- Do not create backup files or temporary files in the workspace root.

## Security And Secret Handling

- Never read, write, or commit `.env` files or credential material.
- Do not introduce package-lock or yarn lockfiles; use Bun-managed dependency state only where intentionally configured.
- Preserve existing secret-handling invariants. For example, Searxng `secret_key` must never be written into a ConfigMap.
- Do not leak plaintext secret values into Helm values, generated YAML, logs, or test snapshots.
- Prefer Kubernetes Secret references or existing low-level secret factories for reference-backed secret material.
- Validate user-supplied aspect selectors and override operations with targeted errors. Do not silently ignore unsafe operations.
- Kro-safety is a security and correctness boundary: reject reference-backed composite merge/append instead of emitting ambiguous manifests.

## Operational Conventions

- Logging uses the existing component logger and debug environment variables such as `TYPEKRO_LOG_LEVEL`, `TYPEKRO_DEBUG`, and `TYPEKRO_LOG_PRETTY`.
- Deployment behavior is split across direct and Kro factories; operational parity must be verified for both when aspect behavior is legal in both modes.
- Direct deployment readiness relies on structured readiness evaluators attached through `Enhanced` helpers.
- Kro output must remain valid RGD YAML and should use existing serialization conversion paths for references and CEL.
- CI expects build, typecheck, lint, circular dependency checks, coverage/unit tests, and YAML integration tests to remain healthy.
- Integration tests should clean up through TypeKro APIs such as `factory.deleteInstance()` rather than manually deleting RGDs, CRDs, or namespaces.
- Do not introduce hidden I/O, random generation, logging, metrics, or mutable side effects inside composition functions.
- Dynamic imports should stay limited to established bridge/integration areas; prefer dependency-inversion providers where core needs integration capabilities.

## No-Touch And Safety Constraints

- Do not edit generated build outputs such as `dist/`, `examples-dist/`, coverage artifacts, or docs build output.
- Do not create backup files (`*.backup`, `*.old`, `*.bak`) or duplicate implementation variants.
- Do not run destructive git commands or revert user work.
- Do not stage or commit unrelated work; stage files selectively if committing is requested later.
- Do not change tests to match broken implementation, skip failing tests, or disable functionality to make tests pass.
- Do not modify composition function signatures without explicit architectural justification.
- Do not change proxy brands, core reference semantics, or status builder semantics as a side effect of aspects.
- Do not add circular dependencies; use `bunx madge --circular --extensions ts src/` if dependency direction is uncertain.
- Do not modify build/config files unless they are explicitly part of an approved plan.

## Feature-Specific Constraints

- The v1 API must be small and composable. Avoid adding shorthand forms or general deep merge unless explicitly approved.
- Curated override surfaces are required. Do not derive override permissions from full Kubernetes object types.
- Matching must be based on stable factory/target metadata, not only kind/name heuristics.
- Re-exported simple factories must preserve stable target identity for `aspect.on(simple.Deployment, ...)`.
- `slot(...)` metadata must survive nested composition flattening.
- Selector diagnostics should report target, selector, mode, matched count, and resource id/name when available.
- No selector means unconditional application to all target matches.
- Zero matches should fail unless `.optional()` is used.
- `.expectOne()` should fail on zero or multiple matches.
- Multiple matches without `.expectOne()` are allowed.
- Later aspects observe earlier aspect mutations.
- Validation failure must stop before YAML output or deployment.

## Risks

- Mutating the original `resourcesWithKeys` object can make repeated `toYaml()` calls non-idempotent.
- Metadata can be lost if resource objects are cloned without using existing metadata copy helpers.
- Kro mode cannot represent “existing reference-backed composite plus appended/merged literals”; this must fail loudly.
- Direct and Kro factory implementations are separate; applying aspects in only one path will create parity bugs.
- `simple.StatefulSet` currently exposes fewer workload fields than the RFP's workload override surface. Planning must decide whether to mutate emitted resource shape only or first expand the simple factory config.
- Existing tests use some legacy casts in old files; new tests should not copy that style unless absolutely necessary.
- The magic proxy system is subtle. Do not change composition function signatures, proxy brands, or serialization reference behavior as a side effect of this feature.

## Verification Commands

- Targeted test: `bun test test/path/to/file.test.ts --timeout 10000`
- Unit tests: `bun run test`
- Typecheck: `bun run typecheck` or `bun run typecheck:lib`
- Lint: `bun run lint`
- Full build: `bun run build`

Use the narrowest meaningful command during implementation tasks, then broaden verification near completion.
