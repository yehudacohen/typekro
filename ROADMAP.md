# TypeKro Roadmap

> Last updated: 2026-03-11 · Current version: 0.4.0 (unreleased 0.5.0 in progress)
>
> **Completed**: Phase 0, Phase 1 (Tier 1 + Tier 2), Phase 2 (all items 2.1-2.12), Phase 3 Rank 5 (all: 3.4-3.9)
> **Next**: Phase 3 Rank 4 — 3.1 (YAML Kro mode), 3.2 (Cert-Manager/External-DNS), 3.3 (Cilium)

This roadmap is organized by **execution order**, not by category. The principle is
simple: build the safety net first, then make changes in order of impact.

The codebase review scored Code Excellence 3.5/5, Security 4/5, Architecture 3/5,
Developer Experience 4/5. The goal is to reach 4.5/5 across the board.

---

## Table of Contents

- [Why This Order](#why-this-order)
- [Phase 0: Infrastructure — Build and CI](#phase-0-infrastructure--build-and-ci)
- [Phase 1: Test Safety Net — Cover the Gaps](#phase-1-test-safety-net--cover-the-gaps)
- [Phase 2: High-Impact Changes](#phase-2-high-impact-changes)
- [Phase 3: Medium-Impact Changes](#phase-3-medium-impact-changes)
- [Phase 4: Lower-Impact and Ongoing](#phase-4-lower-impact-and-ongoing)
- [Appendix A: Metrics Baseline](#appendix-a-metrics-baseline)
- [Appendix B: Spec Tracker](#appendix-b-spec-tracker)
- [Decision Log](#decision-log)

---

## Why This Order

The codebase has 207 test files and 83k lines of test code. That sounds comprehensive.
But a structural analysis reveals that **~18,900 lines of core source code (26% of the
codebase) have zero or near-zero test coverage.** The untested files are exactly the ones
that need the most refactoring:

| File | Lines | Direct Tests |
|------|-------|-------------|
| `type-inference.ts` | 1,155 | **0** |
| `compile-time-validation.ts` | 937 | **0** |
| `resource-validation.ts` | 904 | **0** |
| `errors.ts` | 968 | **0** |
| `dependency-tracker.ts` | 773 | **0** |
| `type-safety.ts` | 680 | **0** |
| `expression-analyzer.ts` | 617 | **0** |
| `context-validator.ts` | 600 | **0** |
| `context-aware-generator.ts` | 574 | **0** |
| `imperative-analyzer.ts` | 556 | **0** |
| `create-resource.ts` | 445 | **0** |
| `kro-factory.ts` | 1,560 | **0 direct** |
| `status-builder-analyzer.ts` | 1,990 | 16 tests |
| `optionality-handler.ts` | 1,852 | 15 tests |
| `composition-analyzer.ts` | 1,508 | ~8 indirect |
| `path-resolver.ts` | 1,259 | 13 tests |
| `client-provider.ts` | 1,180 | 19 tests |

You cannot safely refactor `composition-analyzer.ts` (needed for the registry pattern)
when it has 8 indirect tests. You cannot safely decompose `kro-factory.ts` (needed for
shared deployment infrastructure) when it has zero direct unit tests.

**Tests first. Then changes ranked by impact.**

---

## Design Constraints

These are load-bearing design decisions. Each was investigated for improvement
opportunities. Where the investigation revealed a viable path, it's included in the
roadmap. Where it didn't, the reasoning is documented here.

1. **The MagicProxy catch-all `[key: string]: MagicAssignable<any>` cannot be tightened
   at the type level.** Cross-composition status references access user-defined fields
   not present in any known type. Branded error types, `unknown`, and `never` were tried
   and rejected — they force `as any` casts on valid runtime operations, making the
   experience worse. However, the underlying problem (typos compile silently) CAN be
   addressed at runtime — see item 2.12.

2. **`KubernetesResource` kind-specific fields are internal plumbing, not a user-facing
   problem.** Users never construct `KubernetesResource` directly — they call factory
   functions that accept K8s client-node types (like `V1ConfigMap`). The kind-specific
   fields exist so `createResource()` can accept the spread. Removing them would force
   `as any` casts inside factory implementations with zero user-facing benefit. The real
   problem (14 hardcoded proxy branches block extensibility) IS solvable by making the
   branches data-driven — see item 3.4.

3. **`cluster-admin` RBAC must remain the default for `typeKroRuntimeBootstrap`.** Flux
   controllers manage arbitrary Helm charts that create arbitrary CRDs. Scoped RBAC as
   the default would produce silent, confusing RBAC failures when deploying any chart with
   CRD resources. The security improvement path is additive — see item 2.8.

4. **`fn.toString()` is the engine behind JS-to-CEL conversion.** Any change that
   disrupts `Function.prototype.toString()` returning parseable source breaks the core
   value proposition. Minification, certain transpilers, and some bundlers break this.

5. **The `id` field cannot be conditionally required at compile time based on name
   dynamism.** The magic proxy makes `schema.spec.name` appear as type `string` at
   compile time (the proxy ensures all fields look like their declared types). TypeScript
   cannot distinguish `name: 'my-app'` (static literal) from `name: schema.spec.name`
   (runtime KubernetesRef that looks like `string`). A generic `TName extends string`
   conditional type was investigated and rejected — it would never trigger because the
   proxy erases the distinction. The `id` field is instead made discoverable through
   type signatures (`& { id?: string }` on all factory functions) and enforced at
   runtime by `generateDeterministicResourceId` which throws with actionable error
   messages when a dynamic name is detected.

---

## Phase 0: Infrastructure — Build and CI

**Goal:** Make the build green and establish CI that prevents regressions.
**Effort:** 2–3 days

### 0.1 Fix Build Errors

| Task | Effort | Details |
|------|--------|---------|
| Fix typecheck error | 10 min | `hello-world-complete.ts:154` — `.length` possibly undefined |
| Fix 3 Biome lint errors | 30 min | These block `bun run build` |
| Triage lint warnings | 1 day | 579 warnings → <100. Fix trivial ones. Add `// biome-ignore` with explanation for intentional `any` at type boundaries. |

### 0.2 Delete Dead Code

| File | Lines | Action |
|------|-------|--------|
| `src/core/expressions/cel-utils.ts` | 63 | Delete |
| `src/core/readiness/cluster-state.ts` | 174 | Delete |
| `src/core/deployment/event-streamer.ts` | 451 | Delete (only used by one test) |
| Duplicate `FactoryAnalysisConfig` | `factory-integration.ts:30,52` | Remove duplicate |

### 0.3 Add PR-Level CI

Create `.github/workflows/ci.yml`:
- `bun run typecheck`
- `bun run lint`
- `bun run test` (unit tests, no cluster)
- `bunx madge --circular --extensions ts src/`

### 0.4 Fix Coverage Pipeline

- Fix `bun test --coverage` producing only `.tmp` files
- Set baseline coverage floor, ratchet up over time
- Report coverage diff on PRs

**Done when:** `bun run build` passes. PR CI blocks merges on failure. Coverage reports.

---

## Phase 1: Test Safety Net — Cover the Gaps

**Goal:** Every core file over 500 lines has meaningful unit tests. No refactoring happens
until its target file has a safety net.

**Effort:** 2–3 weeks

### 1.1 Priority Tier 1 — Files We Need to Refactor Next (Phase 2 Prerequisites)

These files are directly in the path of the highest-impact changes. Test them first.

| File | Lines | Current Tests | Why Needed | Est. Tests to Write |
|------|-------|--------------|------------|-------------------|
| `kro-factory.ts` | 1,560 | 0 direct | Phase 2 shared infra extraction | ~40 unit tests |
| `composition-analyzer.ts` | 1,508 | ~8 indirect | Phase 2 registry pattern | ~35 unit tests |
| `create-resource.ts` | 445 | 0 | Phase 2 registry pattern | ~20 unit tests |
| `status-builder-analyzer.ts` | 1,990 | 16 | Phase 2 expression decomposition | ~30 additional |
| `optionality-handler.ts` | 1,852 | 15 | Phase 2 expression decomposition | ~30 additional |
| `path-resolver.ts` | 1,259 | 13 | Phase 2 security fix (DNS rebinding) | ~25 additional |

**Approach for each:**
1. Read the file. Identify public methods and internal branching logic.
2. Write characterization tests — tests that capture *current behavior*, not ideal behavior.
   These are the safety net for refactoring. They assert what happens today, even if it's
   suboptimal.
3. Cover: happy path, error paths, edge cases, boundary conditions.
4. Aim for 0.5× test-to-source line ratio minimum.

### 1.2 Priority Tier 2 — Completely Untested Files

These have zero test coverage and contain non-trivial logic.

| File | Lines | Est. Tests |
|------|-------|-----------|
| `type-inference.ts` | 1,155 | ~30 |
| `compile-time-validation.ts` | 937 | ~25 |
| `resource-validation.ts` | 904 | ~25 |
| `errors.ts` | 968 | ~20 |
| `dependency-tracker.ts` | 773 | ~20 |
| `type-safety.ts` | 680 | ~20 |
| `expression-analyzer.ts` | 617 | ~15 |
| `context-validator.ts` | 600 | ~15 |
| `context-aware-generator.ts` | 574 | ~15 |
| `imperative-analyzer.ts` | 556 | ~15 |

### 1.3 Priority Tier 3 — Undertested Files

These have some tests but the ratio is too low for their complexity.

| File | Lines | Current Tests | Target |
|------|-------|--------------|--------|
| `client-provider.ts` | 1,180 | 19 | +20 |
| `context-detector.ts` | 790 | ~8 | +15 |
| `serialization/yaml.ts` | 574 | minimal | +15 |

**Done when:** Every core file over 500 lines has at least 0.3× test-to-source ratio.
All Tier 1 files are at 0.5× or better. Total unit test count: ~2,600+ (up from 2,222).

---

## Phase 2: High-Impact Changes

Each change is ranked by `(user impact × blast radius) / effort`. Changes within the same
rank are independent and can be parallelized.

### Rank 1 — Quick Wins (high impact, low effort)

#### 2.1 Throw on `===`/`!==` in `Cel.expr()` ★

| | |
|---|---|
| **Impact** | Prevents guaranteed-broken CEL expressions at author time |
| **Effort** | ~5 lines of code, 1 hour |
| **Risk** | Breaking change, but previous behavior was already producing invalid CEL |
| **Review finding** | DX: "Cel.expr() validation logs warnings for ===/!==... should throw" |
| **Prerequisite tests** | None — existing tests cover this |

#### 2.2 Fix DNS Rebinding TOCTOU ★

| | |
|---|---|
| **Impact** | Closes the most concrete security vulnerability |
| **Effort** | ~20 lines — use resolved IP in URL, set `Host` header |
| **Risk** | Low — mechanical fix, path-resolver has 13 tests + we add more in Phase 1 |
| **Review finding** | Security: "DNS rebinding TOCTOU gap (path-resolver.ts:1186-1189)" |
| **File** | `src/core/yaml/path-resolver.ts` |

#### 2.3 Fix `cel-js` Evaluator Context ★

| | |
|---|---|
| **Impact** | Closes prototype-chain access in CEL evaluation |
| **Effort** | 1 line — `Object.create(null)` instead of `{}` |
| **Risk** | Near zero |
| **Review finding** | Security: "cel-js evaluator context uses normal {} object with prototype" |
| **File** | `src/core/references/cel-evaluator.ts` |

#### 2.4 Document Threat Model ★

| | |
|---|---|
| **Impact** | Makes the security boundary explicit for all contributors and users |
| **Effort** | ~30 min — add section to `SECURITY.md` |
| **Risk** | None |
| **Review finding** | Security: "implicit threat model not documented" |

### Rank 2 — Foundational Refactors (high impact, medium effort)

#### 2.5 Extract Shared Deployment Infrastructure ★★

| | |
|---|---|
| **Impact** | Eliminates deployment bug duplication between Kro and Direct factories |
| **Effort** | 2–3 days |
| **Risk** | Medium — touches two of the largest files. Mitigated by Phase 1.1 tests. |
| **Review finding** | Architecture: "dual factory implementations evolved in parallel without shared infrastructure" |
| **Files** | `kro-factory.ts` (1,560), `direct-factory.ts` (1,357) |

Extract shared modules:
- `ResourceValidator` — validation, normalization
- `NamespaceManager` — creation, cleanup
- `ReadinessPoller` — polling infrastructure
- `EventBridge` — event monitoring setup/teardown
- `ErrorAggregator` — error collection and reporting

Both factories delegate to shared infra, keeping only unique logic.

#### 2.6 Replace Non-Enumerable Property Pattern with WeakMap ★★

| | |
|---|---|
| **Impact** | Eliminates the entire class of "metadata silently dropped" bugs |
| **Effort** | 2–3 days |
| **Risk** | Medium — touches many pipeline boundaries. Mitigated by characterization tests. |
| **Review finding** | Code Excellence: "non-enumerable property pattern is the primary code quality liability" |

Create `WeakMap<Resource, ResourceMetadata>` + accessor functions. Migrate all 10+
non-enumerable properties: `__resourceId`, `__factoryName`, `__readinessEvaluator`,
`__namespace`, `__apiVersion`, `__kind`, `includeWhen`, `readyWhen`, `forEach`,
`__templateOverrides`, `__externalRef`, `readinessEvaluator`, `__originalCompositionFn`,
`__originalSchema`, `__needsPreAnalysis`.

#### 2.7 Replace Hardcoded Allowlists with Factory Registry ★★

| | |
|---|---|
| **Impact** | Makes custom factories first-class citizens without forking core |
| **Effort** | 2 days |
| **Risk** | Medium — changes AST analysis paths. Mitigated by Phase 1.1 tests on composition-analyzer. |
| **Review finding** | Architecture: "three hardcoded allowlists silently block extensibility" |

Replace:
1. `KNOWN_FACTORY_NAMES` (24 entries in `composition-analyzer.ts`)
2. Field checks in `createGenericProxyResource` (14 `if (prop === 'X')` branches)
3. `findResourceByKey` semantic patterns (`database → deployment/statefulset`)

With `FactoryRegistry` — factories self-register at import time.

#### 2.8 Make RBAC Configurable in `typeKroRuntimeBootstrap` ★★

| | |
|---|---|
| **Impact** | Lets security-conscious users scope down Flux controller privileges |
| **Effort** | 1–2 days |
| **Risk** | Low — additive option, default unchanged |
| **Review finding** | Security: "6 Flux controllers bound to cluster-admin" |
| **File** | `src/compositions/typekro-runtime/typekro-runtime.ts` |

Add an `rbac` option to `TypeKroRuntimeConfig`:
- `rbac: 'cluster-admin'` (default — current behavior, zero experience change)
- `rbac: 'scoped'` — per-controller minimal RBAC
- `rbac: 'custom'` with a `clusterRoleRef` for BYO ClusterRole

The default stays `cluster-admin`. Scoping down as default would produce silent RBAC
failures when deploying Helm charts with CRDs (cert-manager, external-dns, apisix —
all used in the hello-world demo). The failure mode is terrible: a generic Kubernetes
RBAC error on the HelmRelease status conditions, with no mention of TypeKro or what
to do about it. The `cluster-admin` default is the correct choice for a "just works"
bootstrap function. Security-conscious users opt in to scoped mode and accept the
responsibility of maintaining the role.

### Rank 3 — Decomposition (high impact, higher effort)

#### 2.9 Decompose `analyzeAndConvertStatusMappings` ★★★

| | |
|---|---|
| **Impact** | Makes the single hardest function in the codebase maintainable |
| **Effort** | 2–3 days |
| **Risk** | High — 9-step pipeline with 3 layers of swallowed fallbacks. Tests critical. |
| **Review finding** | Code Excellence: "analyzeAndConvertStatusMappings orchestrates 9 sub-steps with three layers of try/catch fallbacks" |
| **File** | `src/core/serialization/core.ts:721-863` |

Decompose into explicit pipeline stages with `StageResult<T>` carrying
success/failure/degraded state. Log degradation at warn level, not debug.

#### 2.10 Decompose Expression System (analyzer.ts, status-builder-analyzer.ts) ★★★ ✅ COMPLETE (2.10a + 2.10b)

| | |
|---|---|
| **Impact** | Reduces bus-factor risk in the largest subsystem (26k lines, 36.6% of codebase) |
| **Effort** | 3–5 days |
| **Risk** | Medium — incremental splits, not rewrite. Mitigated by existing thorough tests on analyzer.ts. |
| **Review finding** | Architecture: "expression system concentration" |

**2.10a — analyzer.ts decomposition** ✅ COMPLETE
Split `analyzer.ts` (2,736 → 4 files, all ≤800 lines):
- `expression-classifier.ts` (669 lines) — identify expression type
- `cel-emitter.ts` (639 lines) — emit CEL strings
- `scope-resolver.ts` (600 lines) — resolve scopes and references
- `analyzer.ts` (800 lines) — orchestration

**2.10b — status-builder-analyzer.ts decomposition** ✅ COMPLETE
Split `status-builder-analyzer.ts` (1,990 → 4 files, all ≤800 lines):
- `status-ast-utils.ts` (380 lines) — AST parsing, source extraction, pattern detection
- `status-cel-generation.ts` (423 lines) — CEL generation with status-specific transformations
- `status-field-analysis.ts` (617 lines) — per-field analysis (AST-based and runtime)
- `status-builder-analyzer.ts` (624 lines) — orchestration

**2.10c — Decompose remaining 6 files over 800 lines** ✅ COMPLETE
All 6 files decomposed, every file in `expressions/` now ≤800 lines:

1. `optionality-handler.ts` (1,851 → 5 files):
   - `optionality-analysis.ts` (319) — core optionality analysis
   - `optionality-cel-generation.ts` (284) — CEL generation, has() checks
   - `optionality-optional-chaining.ts` (311) — optional chaining patterns
   - `optionality-hydration.ts` (523) — hydration timing integration
   - `optionality-handler.ts` (527) — slim coordinator class

2. `composition-analyzer.ts` (1,474 → 5 files):
   - `composition-analyzer-types.ts` (171) — AST + domain types
   - `composition-analyzer-helpers.ts` (336) — utility functions
   - `composition-analyzer-ternary.ts` (451) — ternary + collection analysis
   - `composition-analyzer-traversal.ts` (523) — AST traversal
   - `composition-analyzer.ts` (187) — public API barrel

3. `type-inference.ts` (1,155 → 3 files):
   - `type-inference-types.ts` (186) — types + error classes
   - `kubernetes-field-types.ts` (268) — K8s field type knowledge
   - `type-inference.ts` (772) — inference engine

4. `compile-time-validation.ts` (937 → 4 files):
   - `compile-time-types.ts` (208) — type definitions
   - `compile-time-errors.ts` (120) — error/warning classes
   - `compile-time-checker.ts` (635) — checker class
   - `compile-time-validation.ts` (28) — barrel re-export

5. `resource-validation.ts` (904 → 3 files):
   - `resource-validation-types.ts` (237) — types + error classes
   - `resource-field-utils.ts` (325) — field knowledge utilities
   - `resource-validation.ts` (443) — validator class

6. `magic-proxy-analyzer.ts` (869 → 3 files):
   - `magic-proxy-types.ts` (44) — analysis interfaces
   - `magic-proxy-ast.ts` (228) — AST parsing functions
   - `magic-proxy-analyzer.ts` (629) — analyzer class

#### 2.11 Decompose `engine.ts` ★★★ ✅ COMPLETE

| | |
|---|---|
| **Impact** | Makes the deployment engine maintainable and testable |
| **Effort** | 2–3 days |
| **Risk** | Medium — well-tested (106 tests) but large surface area |
| **Review finding** | Architecture: "engine.ts god object (2,055 lines)" |

**Findings**: `CrdLifecycleManager` and `ReferenceResolver` were already extracted prior to this phase.

**Extractions performed**:
- `ResourceApplier` (501 lines) — K8s resource apply/patch/conflict/namespace/serialization
- `ReadinessWaiter` (311 lines) — readiness polling and one-shot readiness checks
- `RollbackManager` updated (467 lines) — engine's rollback/delete methods moved in, engine delegates

**Result**: `engine.ts` reduced from 2,029 → 1,251 lines (38% reduction). Remaining bulk is core orchestration (`deployWithClosures`, `deployLevel`, `validateAndPlanDeployment`) — tightly coupled methods that cannot be cleanly extracted without awkward callback injection patterns.

#### 2.12 Make Silent Failures Loud ★★★

| | |
|---|---|
| **Impact** | Fixes the primary DX liability — the core value proposition is type safety, and typos silently compile |
| **Effort** | 3–5 days |
| **Risk** | Low — runtime warnings only, zero behavior change, debug-mode gated |
| **Review finding** | DX: "MagicProxy catch-all index signature", "id field requirement not discoverable" |

Three fixes:

1. **Runtime typo detection in the proxy.** The type-level catch-all `[key: string]:
   MagicAssignable<any>` cannot be tightened (see Design Constraints). But the proxy's
   `get` trap at `create-resource.ts:165` has access to `target.kind` at runtime.

   **Approach:** Build a `KNOWN_STATUS_FIELDS` registry mapping standard K8s kinds to
   their known status field names (Deployment → `readyReplicas`, `availableReplicas`,
   `conditions`, etc.). In the status builder context, before returning the
   `KubernetesRef`, check if the accessed property is a close Levenshtein match to a
   known field. If so, emit a warning:

   ```
   Warning: 'reedyReplicas' accessed on Deployment status but not found in known
   fields. Did you mean 'readyReplicas'?
   ```

   **Why this works without false positives:**
   - Only fires for kinds in the registry (standard K8s types). CRDs and
     cross-composition references have unknown kinds → no warning.
   - Only fires when Levenshtein distance suggests a typo, not for every unknown field.
   - Gated behind `IS_DEBUG_MODE` — zero cost in production.
   - All infrastructure already exists: `levenshteinDistance` in `utils/string.ts`,
     `debugLogger`, the "did you mean?" pattern in `resource-validation.ts`.

2. **`Cel.expr()` throws on `===`/`!==`** — already covered in 2.1.

3. **`id` field discoverable in all factory type signatures** — the original plan was to
   make `id` conditionally required at the type level when `name` is dynamic. However,
   the magic proxy system makes `schema.spec.name` appear as `string` at compile time
   (not `KubernetesRef`), so TypeScript cannot distinguish static from dynamic names.
   A generic `TName` conditional type approach is fundamentally impossible with the
   current proxy architecture. Instead: (a) all 45 Kubernetes factory functions now
   accept `id?: string` in their type signatures (previously only 2/45 did), ensuring
   IDE autocomplete and documentation show the `id` option; (b) the runtime throw from
   `generateDeterministicResourceId` continues to catch dynamic names with clear error
   messages pointing users to add `id`. This is documented as a design constraint.

**Done when:** All Rank 1–3 changes complete. No file over 800 lines in `expressions/`
or `deployment/`. Factory registry replaces all 3 allowlists. Non-enumerable properties
migrated to WeakMap. All 4 security findings addressed. `id` discoverable in all factory
signatures. RBAC configurable in bootstrap.

**Status: COMPLETE** — All three items addressed. Runtime typo detection (KNOWN_STATUS_FIELDS)
implemented, `Cel.expr()` validates operators (2.1), `id` field visible in all factory
type signatures with documented design constraint for compile-time detection.

---

## Phase 3: Medium-Impact Changes

### Rank 4 — Ecosystem Completion

#### 3.1 Complete YAML File Resources — Kro Mode

| | |
|---|---|
| **Impact** | Unblocks users who define resources via YAML files in Kro mode |
| **Effort** | 1 week |
| **Spec** | `yaml-file-resources` (~75% complete, Kro mode is the critical blocker) |

Remaining: Kro mode serialization, Kustomize types fix, bootstrap compositions, error
handling, integration tests.

#### 3.2 Complete Cert-Manager / External-DNS Integration

| | |
|---|---|
| **Impact** | TLS certificates and DNS are table-stakes for production workloads |
| **Effort** | 1–2 weeks |
| **Spec** | `cert-manager-external-dns-integration` (~60% complete) |

Remaining: CRD factory completion (Certificate, Issuer, ClusterIssuer, Challenge, Order),
webapp integration example, forEach/includeWhen support, docs.

#### 3.3 Complete Cilium Ecosystem Support

| | |
|---|---|
| **Impact** | Cilium is the default CNI in many production clusters |
| **Effort** | 2–3 weeks |
| **Spec** | `cilium-ecosystem-support` (~30% complete) |

Remaining: Helm values mapping, bootstrap composition, CRD factories (networking, BGP,
load balancer, gateway, security), integration tests, docs.

### Rank 5 — Structural Improvements

#### 3.4 Make Proxy Field Handling Data-Driven

| | |
|---|---|
| **Impact** | Enables adding new resource kinds without modifying core proxy logic |
| **Effort** | 1–2 days |
| **Review finding** | Code Excellence: "KubernetesResource has accumulated 13 kind-specific fields" / "createGenericProxyResource has 14 hardcoded if branches" |

The `KubernetesResource` interface and its fields stay as-is — they're internal plumbing
that users never see directly (see Design Constraints). The actual problem is the 14
hardcoded `if (prop === 'data')` branches in the proxy that prevent extensibility.

**Approach:** Replace the if-chain with a `Map<string, ProxyFieldConfig>`:

```typescript
const PROXY_ROOT_FIELDS = new Map([
  ['data',       { proxyMode: 'property' }],
  ['stringData', { proxyMode: 'property' }],
  ['rules',      { proxyMode: 'property' }],
  ['roleRef',    { proxyMode: 'property' }],
  ['subjects',   { proxyMode: 'property' }],
  ['provisioner',{ proxyMode: 'value-or-ref' }],
  ['parameters', { proxyMode: 'property' }],
  ['subsets',    { proxyMode: 'property' }],
]);
```

The proxy get trap becomes: `if (PROXY_ROOT_FIELDS.has(prop) && prop in target)`.
Adding a new root-level field means one line in the map, not a new if-branch.
Behavior is identical for all existing fields.

**Status: COMPLETE** — 8 hardcoded if-branches replaced with `PROXY_ROOT_FIELDS` Map in
`create-resource.ts`. Two proxy modes: `property` (wraps value with `createPropertyProxy`)
and `value-or-ref` (returns raw value or falls back to `createRefFactory`). All 3194 tests
pass with identical results.

#### 3.5 Fix Dependency Inversion in `kro-factory.ts`

| | |
|---|---|
| **Impact** | Fixes core depending on factories/alchemy (wrong direction) |
| **Effort** | 1–2 days |
| **Review finding** | Architecture: "5 dynamic imports from higher layers, inverting dependency direction" |

Inject dependencies via constructor. `kro-factory.ts` accepts interfaces, registration
happens at the composition layer.

**Status: COMPLETE** — Three provider interfaces (`KroCustomResourceProvider`,
`ResourceGraphDefinitionProvider`, `AlchemyBridge`) added to `InternalFactoryOptions`.
`kro-factory.ts` uses injected providers with `??` fallback to dynamic `import()` for
backward compatibility. 5 wrong-direction dynamic imports are now bypassable. All 3194
tests pass with identical results. No new circular dependencies.

#### 3.6 Reduce `as unknown as` Casts

| | |
|---|---|
| **Impact** | Improves type safety at 47 boundary points |
| **Effort** | 2–3 days |
| **Review finding** | Code Excellence: "47 as unknown as casts across 22 files" |

Audit each cast. Create type guards for AST boundaries (`isExpression(node)`). Create
typed wrappers for `acorn`/`estraverse`. Target: <20 remaining, all with comments.

**Status: COMPLETE** (47 → 24 casts, 23 removed). Strategies applied:
- **Reflect.get/set** (8 casts): `create-resource.ts`, `yaml.ts`, `direct-factory.ts`,
  `crd-patcher.ts` — replaced `(x as unknown as Record)[key]` with `Reflect.get(x, key)`.
- **Symbol access via Reflect** (3 casts): `resolver.ts` — alchemy symbol property access.
- **ESTree type guard** (4 casts): Created `ast-type-guards.ts` with `getIdentifierName()`
  helper; used in `status-ast-utils.ts` and `composition-analyzer-helpers.ts`.
- **Type augmentation** (3 casts): Added `createFactoryContext()` to
  `EnhancedWithConditionals` type in `conditional-integration.ts`.
- **Reflect.set for metadata** (2 casts): `imperative.ts` — `__originalCompositionFn` /
  `__originalSchema` metadata attachment.
- **Reflect.get for Node internals** (2 casts): `bun-http-library.ts` — agent options and
  request signal access.
- **Design constraint**: Target was <20 remaining, achieved 24. The remaining 24 are
  genuine type boundaries: magic proxy system (2), K8s client generics (4), acorn→ESTree
  (7), Enhanced object construction (4), CelExpression branding (2), closure-as-Enhanced (1),
  KroCompatibleType recursion (2), CRDManifest (1), CallableComposition (1).
  All have inline comments explaining why the cast is necessary.

#### 3.7 Connection Management Cleanup ✅ COMPLETE

| | |
|---|---|
| **Impact** | Eliminates dangerous global state in K8s client |
| **Effort** | 1 week |
| **Spec** | `connection-management-cleanup-fix` (design complete) |

Remove dangerous globals, implement scoped cleanup (per-composition), improve error
handling for connection failures.

**Status: COMPLETE** — Two phases delivered:

**Phase 1** (completed in earlier session): Removed all dangerous global state —
`Bun.exit()`, `globalAgent` manipulation, `__BUN_FETCH_CACHE`, `Bun.gc()` calls.

**Phase 2** (completed this session): Singleton deprecation and DI path for remaining
consumer.

1. **`KroDeploymentStrategy` fixed**: The only src/ consumer of the singleton
   (`getCustomObjectsApi()` at `kro-strategy.ts:62`) now accepts `customObjectsApi`
   via constructor injection. Falls back to singleton for backward compatibility.

2. **Singleton pattern deprecated**: `getInstance()` and all 14 singleton convenience
   functions (`getKubernetesClientProvider`, `getKubernetesApi`, `getKubeConfig`,
   `getCoreV1Api`, `getAppsV1Api`, `getCustomObjectsApi`, `getBatchV1Api`,
   `getNetworkingV1Api`, `getRbacAuthorizationV1Api`, `getStorageV1Api`,
   `getApiExtensionsV1Api`, `isClusterAvailable`, `waitForClusterReady`, `withRetry`)
   now have `@deprecated` JSDoc tags pointing to `createKubernetesClientProvider()`.

3. **Module documentation updated**: `client-provider.ts` header now documents the
   recommended deployment-scoped pattern via `KubernetesClientManager` and explains
   why the singleton is deprecated.

4. **Zero blast radius confirmed**: Audit found exactly 1 singleton consumer in src/
   (kro-strategy.ts). Both factories (`DirectResourceFactoryImpl`, `KroResourceFactoryImpl`)
   already use `KubernetesClientManager` which creates non-singleton providers.
   The singleton convenience functions exist only for the public API surface — external
   consumers can migrate at their own pace.

**Remaining from spec** (intentionally deferred — Phase 3-4 of the connection-management
spec are lower priority and need real concurrent deployment testing infrastructure):
- TASK-2.1–2.3: Enhanced deployment-scoped cleanup (timer lifecycle, ECONNRESET handling)
- TASK-3.1–3.2: Cleanup failure recovery and verification
- TASK-4.1–4.2: Connection pool isolation, memory management enhancement

#### 3.8 API Guidance and Dual-API Confusion ✅ COMPLETE

| | |
|---|---|
| **Impact** | Removes the primary source of new-user confusion |
| **Effort** | 1–2 days |
| **Review finding** | DX: "two APIs coexist without clear guidance" |

Add "Which API should I use?" decision flowchart to getting-started guide. Document
migration paths. Reconcile AGENTS.md and the getting-started guide. If one is the
recommended default, say so explicitly.

**Status: COMPLETE** — Five changes made:

1. **AGENTS.md reconciled**: Added `kubernetesComposition` as the recommended default
   with full patterns section (imports, resources, status, string templates, conditionals,
   id parameter). Renamed existing `toResourceGraph` section as "Advanced". Fixed the
   `?.` inconsistency in the Quick Reference (was showing `resources.myResource?.status`
   alongside instructions not to use `?.`). Added "Which Composition API to Use" quick
   reference with rule of thumb.

2. **Mermaid decision flowchart**: Added to `docs/api/kubernetes-composition.md` replacing
   the text-based decision tree. Visual flowchart with green (recommended) and yellow
   (advanced) nodes.

3. **Migration paths**: Added "Between TypeKro APIs" section to `docs/advanced/migration.md`
   with side-by-side before/after code examples for `toResourceGraph` → `kubernetesComposition`
   migration, plus a reverse checklist for `kubernetesComposition` → `toResourceGraph`.

4. **Getting-started mention**: Added collapsible info box in `docs/guide/getting-started.md`
   mentioning `toResourceGraph` exists for advanced use cases, with link to comparison page.

5. **src/index.ts JSDoc**: Updated module documentation to list `kubernetesComposition`
   first as "Recommended", fixed misleading comparison table entries (both APIs use
   arktype for schema validation), added "Rule of thumb" guidance.

#### 3.9 Address `fn.toString()` Fragility ✅ COMPLETE

| | |
|---|---|
| **Impact** | Documents a fundamental constraint and mitigates breakage risk |
| **Effort** | 2–3 days for docs + self-test. 2+ weeks for TS compiler alternative (if pursued). |
| **Review finding** | Architecture: "dependence on fn.toString() producing parseable JS is a fundamental fragility" |

1. Document which build configs break it
2. Add startup self-test (parse known function, verify output)
3. Explore TS compiler API as opt-in alternative

**Status: COMPLETE** — All three deliverables addressed:

1. **Build config documentation**: Comprehensive table of safe vs. breaking build
   configurations documented in `fn-toString-self-test.ts` JSDoc (variable name mangling,
   dead code elimination, advanced minification, source-to-source transforms vs. safe
   configs like direct Bun/ts-node, esbuild --minify-whitespace only, Webpack/Vite dev).

2. **Startup self-test**: `runFnToStringSelfTest()` and `validateFnToStringEnvironment()`
   implemented in `src/core/expressions/analysis/fn-toString-self-test.ts`. Tests
   parseability, parameter name preservation, function body preservation, and arrow
   syntax preservation. Integrated into `parser.ts` via lazy one-time call on first
   `parseExpression()` or `parseScript()` invocation — logs warnings if environment is
   incompatible. 5 unit tests in `test/core/fn-toString-self-test.test.ts`.

3. **TS compiler API exploration**: Documented as a future opt-in alternative in the
   self-test module JSDoc. Covers how it would work (source location capture →
   `ts.createProgram()` → AST walk → cached results), advantages (bundler-independent,
   full type info), and challenges (source location capture, 45MB dependency, performance,
   monorepo support, runtime-only fallback, dual-path testing). Recommendation: keep
   fn.toString() as default with self-test safety net; TS compiler API should wait for
   concrete user demand from production deployments with aggressive minification.

**Audit**: 12 fn.toString() call sites across 8 files identified and documented in the
self-test module's call-site table.

**Done when:** YAML Kro mode works. Cert-manager and Cilium factories complete.
Proxy root-field handling is map-driven (not if-branches). `kro-factory.ts` has no
upward dependencies. `as unknown as` count <20.

---

## Phase 4: Lower-Impact and Ongoing

### 4.1 Factory JSDoc Coverage

~30 factory functions lack `@param`, `@returns`, `@example`. Audit all exported functions.
Priority: high-traffic first, then sweep. Consider CI check requiring JSDoc on exports.
**Effort:** 2–3 days.

### 4.2 Performance Profiling

No profiling has been done. Create `bench/` directory with representative compositions.
Profile with `bun --inspect`. Cache parsed ASTs, pool connections, batch API calls. Set
regression thresholds in CI. **Effort:** 1 week.

### 4.3 Bundle Size Optimization

9 runtime deps. Measure current bundle. Evaluate making `angular-expressions` (25kb) and
`pino` (45kb) optional. Verify subpath exports tree-shake. Track in CI. **Effort:** 2–3 days.

### 4.4 Documentation Launch

Spec at 97%. Remaining: copy buttons, search, mobile, CI/CD for docs, SEO, analytics.
**Effort:** 1 week.

### 4.5 Contributor Experience

ADRs for magic proxy, fn.toString, angular-expressions decisions. Update CONTRIBUTING.md
with expression system and proxy architecture internals. One-command dev setup
(`bun run setup` → kind cluster + Kro + Flux + cert-manager). Every new factory ships
with a runnable example. **Effort:** 1 week.

### 4.6 Observability for Compositions

OpenTelemetry spans for deployment events. Mermaid dependency graph visualization (already
a dep). Dry-run mode. **Effort:** 2 weeks.

### 4.7 Finish Kubernetes Client Upgrade

198 remaining test type errors. Error handling migration, Watch API, KubeConfig handling,
factory type centralization. **Effort:** 1 week.

### 4.8 Release 0.5.0

Finalize CHANGELOG `[Unreleased]`. Document all breaking changes (Kro v0.3→v0.8, explicit
readiness evaluators). Bump version, tag, publish. Migration guide on docs site.

### 4.9 Tech Debt Maintenance (Ongoing)

From `tech-debt-q1-2026` spec:
- Sprint 3: Memory optimization, type safety audit
- Sprint 4: Console logging cleanup, deprecated function removal, timeout standardization,
  TODO resolution (10 TODOs in production code)

Clean up 8 empty/abandoned specs: `alchemy-kubeconfig-refactor`, `test-compilation-fixes`,
`test-failure-fixes`, `test-suite-stabilization`, `test-timeout-configuration`,
`typescript-compilation-and-composition-fixes`, `alchemy-kubeconfig-fix`,
`javascript-to-cel-template-literals`.

---

## Appendix A: Metrics Baseline

| Metric | Current | Post Phase 0 | Post Phase 1 | Post Phase 2 | Post Phase 4 |
|--------|---------|-------------|-------------|-------------|-------------|
| Source files | 292 | 289 | 289 | ~285 | ~280 |
| Source lines | 72,061 | ~71,400 | ~71,400 | ~68,000 | ~68,000 |
| Test files | 207 | 207 | ~230 | ~240 | ~250 |
| Unit tests passing | 2,222 | 2,222 | ~2,700 | ~2,800 | ~3,000 |
| Core files >500 lines with 0 tests | 11 | 11 | 0 | 0 | 0 |
| Test-to-source ratio (core >500 line files) | 0.14–0.5× | same | >0.3× all, >0.5× Tier 1 | >0.5× all | >0.7× all |
| `as any` in src/ | 3 | 3 | 3 | 3 | 3 |
| `as unknown as` in src/ | 47 | 47 | 47 | <20 | <15 |
| Lint errors | 3 | 0 | 0 | 0 | 0 |
| Lint warnings | 579 | <100 | <100 | <50 | <25 |
| Circular dependencies | 0 | 0 | 0 | 0 | 0 |
| Dead code files | 3 | 0 | 0 | 0 | 0 |
| Max file size (lines) | 2,736 | 2,736 | 2,736 | <800 | <800 |
| PR CI | No | Yes | Yes | Yes | Yes |
| Coverage reporting | Broken | Working | Floor set | Tracked | Enforced |
| Hardcoded allowlists | 3 | 3 | 3 | 0 | 0 |
| Non-enumerable props | ~10 | ~10 | ~10 | 0 | 0 |
| Proxy field branches (hardcoded→map) | 14 if-branches | 14 | 14 | 14 | 0 (map-driven) |
| Security review findings open | 4 | 4 | 4 | 0 | 0 |
| Exported functions with JSDoc | ~40% | ~40% | ~40% | ~60% | 100% |
| Review: Code Excellence | 3.5 | 3.5 | 3.5 | 4.0 | 4.5 |
| Review: Security | 4.0 | 4.0 | 4.0 | 4.5 | 4.5 |
| Review: Architecture | 3.0 | 3.0 | 3.0 | 4.0 | 4.5 |
| Review: DX | 4.0 | 4.0 | 4.0 | 4.0 | 4.5 |

---

## Appendix B: Spec Tracker

### Done (17 specs)

alchemy-integration-completion, codebase-quality-improvements,
imperative-composition-pattern, javascript-to-cel-conversion, kro-factory-pattern,
kro-less-deployment, nested-compositions, simple-factory-namespace-refactor,
steering-documentation-consolidation, unify-acorn-parser, documentation-overhaul,
production-readiness (phases 0-2), kubernetes-events-progress-monitoring (phases 1-2),
typekro, integration-test-reliability-fix, documentation-roadmap-improvement,
upgrade-kubernetes-client (core)

### In Progress (10 specs) → Mapped to Roadmap

| Spec | Completion | Roadmap Section |
|------|-----------|----------------|
| yaml-file-resources | ~75% | 3.1 |
| cert-manager-external-dns-integration | ~60% | 3.2 |
| cilium-ecosystem-support | ~30% | 3.3 |
| connection-management-cleanup-fix | Design only | 3.7 |
| upgrade-kubernetes-client (remaining) | ~70% | 4.7 |
| codebase-cleanup-restructure | ~60% | Phase 0 + 2 |
| tech-debt-q1-2026 | ~40% | Phase 0 + 4.9 |
| production-readiness (polish) | ~80% | Phase 0 + 4 |
| kubernetes-events-progress-monitoring | ~50% | 4.6 |
| documentation-completeness | ~97% | 4.4 |

### To Close/Archive (8 empty or superseded specs)

alchemy-kubeconfig-refactor, alchemy-kubeconfig-fix, test-compilation-fixes,
test-failure-fixes, test-suite-stabilization, test-timeout-configuration,
typescript-compilation-and-composition-fixes, javascript-to-cel-template-literals

---

## Decision Log

1. **Tests before refactoring.** 26% of core source has zero tests. Refactoring without
   tests is flying blind. Phase 1 creates the safety net that makes Phase 2 safe.

2. **Impact ranking over categories.** The v1 roadmap grouped by category (architecture,
   security, DX). This version ranks by `(user impact × blast radius) / effort`. A 1-line
   security fix shouldn't wait for Phase 4 because it was categorized as "polish."

3. **Characterization tests, not ideal tests.** Phase 1 tests capture current behavior,
   even if suboptimal. The goal is regression detection during refactoring, not correctness
   validation (that comes after the refactors).

4. **Release 0.5.0 moved to Phase 4.** The v1 roadmap had release in Phase 1. But shipping
   a release before the safety net and high-impact fixes means shipping known architectural
   debt. Better to ship 0.5.0 after Phase 2 when the codebase is genuinely improved. If
   external pressure requires an earlier release, Phase 0 completion is the minimum bar.

5. **WeakMap over Symbol properties.** WeakMap is invisible to serialization by design
   (correct behavior), doesn't pollute the object shape, and allows garbage collection.

6. **Registry over plugin system.** Simple singleton registry, not full plugins. No
   third-party factory authors yet. Upgrade to plugins if demand materializes.

7. **Throw on `===`/`!==` in Cel.expr().** Breaking change classified as bug fix — the
   previous behavior produced invalid CEL.

8. **MagicProxy catch-all stays at the type level; typo detection moves to runtime.**
   The type-level catch-all `[key: string]: MagicAssignable<any>` cannot be tightened
   because the runtime proxy creates valid `KubernetesRef` objects for any property
   access — the type must reflect what the runtime does. Tightening to `unknown` or
   a branded error would force `as any` casts on valid operations, worsening the
   experience. But a runtime `KNOWN_STATUS_FIELDS` registry with Levenshtein-based
   typo detection in the proxy get trap (debug-mode only, zero behavior change) catches
   the most common mistakes without false positives on CRDs or cross-composition refs.

9. **`KubernetesResource` fields stay; proxy branches become data-driven.** The
   kind-specific fields are internal plumbing — users never construct
   `KubernetesResource` directly. The fields exist so `createResource()` can accept
   factory spreads without type errors. Removing them would force `as any` inside every
   factory with zero user benefit. The actual extensibility problem is the 14 hardcoded
   `if` branches in the proxy, which become a `Map<string, ProxyFieldConfig>` lookup.
