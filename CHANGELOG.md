# Changelog

All notable changes to TypeKro will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.20.1] - 2026-06-30

### Fixed

- Fixed KRO-invalid CEL emitted for **optional scalar** spec fields in the runtime values-merge.
  When a `values` block contained a CEL/ref (forcing the runtime map-merge), each optional overlay
  field was emitted as `.merge({ "X": has(spec.X) ? spec.X : omit() })`. KRO types `omit()` as
  `map(string, dyn)`, so for a scalar field the ternary `bool ? <scalar> : map(string, dyn)` failed
  to compile (`GraphAccepted=False` / `no matching overload for '_?_:_'`). Optional refs now emit a
  type-safe conditional single-key merge `.merge(has(spec.X) ? {"X": spec.X} : {})` (both branches
  maps), and the emitted value preserves the field's full expression (e.g. a `string(...)` conversion
  is not dropped to the bare path). Static maps and the field-level `has(x) ? x : omit()` form are
  unchanged.
- Fixed the alchemy KRO RGD deploy ignoring the factory's configured `timeout`: it hardcoded
  `DEFAULT_RGD_TIMEOUT` (60s) instead of honoring `factoryOptions.timeout` (the non-alchemy paths
  already did). A converge whose RGD legitimately takes >60s to reach ready (e.g. a Helm workload
  rollout) false-failed with `AbortError: Delay aborted`.

## [0.20.0] - 2026-06-30

### Changed

- **BREAKING (pre-1.0 minor):** Alchemy resource scope is now metadata-driven rather than inferred from a centralized Kubernetes kind list. Factory-created cluster-scoped resources serialize their `scope: 'cluster'` metadata into Alchemy state, and raw manifests must declare `scope: 'cluster'` explicitly when they are cluster-scoped. Legacy JSON-only Alchemy state without serialized scope is no longer reclassified by `apiVersion`/`kind`.
- KRO prerequisite resources now use the same per-resource scope metadata path across imperative deploys, GitOps YAML, and declarative Alchemy resources.

### Fixed

- ResourceGraphDefinition and other factory-created cluster-scoped resources no longer receive a deployment namespace when their scope metadata is present.
- Persisted Alchemy `scope` metadata is stripped before manifests are sent to Kubernetes.

## [0.19.0] - 2026-06-29

### Added

- Added Dagster daemon liveness probe support and related Alchemy/serializer hardening for external refs and conditional value rendering.

## [0.18.0] - 2026-06-26

### Added

- Added `kroPrerequisites` for KRO factories so prerequisite resources can be applied or emitted before
  the ResourceGraphDefinition. Resource prerequisites work across imperative deploys, GitOps YAML, and
  declarative Alchemy resources; live `beforeResourceGraphDefinition` hooks remain deploy-only.
- Added prerequisite handling for cluster-scoped resources, CRD readiness, and ordered Alchemy
  declarations so dependent prerequisites reconcile predictably before the RGD.

## [0.17.0] - 2026-06-15

### Added

- Caddy ingress: a build-time `makeCaddyIngress({ ephemeral?: boolean })` option. With `ephemeral: true`
  the `/data` volume is an `emptyDir` instead of the default PVC — Caddy's `tls internal` CA regenerates
  per pod, but the plane no longer depends on a single-AZ ReadWriteOnce volume that strands the pod
  (`Pending`, PV node-affinity mismatch) when a node/AZ changes under it. The choice is resolved when the
  composition is constructed (a real value, not a KRO spec field), so it selects the resource set
  statically and never needs an unsafe runtime conditional. The default `caddyIngress` is unchanged
  (PVC-backed). Ephemeral mode validates against a dedicated schema (`CaddyIngressEphemeralConfigSchema`)
  with no `persistence` field, so passing `persistence` config in ephemeral mode is rejected loudly
  rather than silently ignored.

## [0.16.0] - 2026-06-14

### Added

- Added a typed Caddy integration for config-driven reverse proxy deployments.

### Changed

- Caddy bootstrap is intentionally single-replica with `Recreate` rollout semantics because it owns a
  single ReadWriteOnce data volume.
- Direct-mode re-execution now hydrates `.spec` references from live Kubernetes resources, improving
  parity with KRO CEL status evaluation.

## [0.15.3] - 2026-06-12

### Fixed

- Fixed declarative Alchemy KRO custom-resource deploys so rehydrated CR instances regain the
  KRO readiness evaluator before waiting for readiness.

## [0.15.2] - 2026-06-12

### Fixed

- Fixed declarative Alchemy KRO resources so CR instance declarations honor the factory
  `waitForReady` option and default to end-to-end readiness, matching the imperative deploy path.

## [0.15.1] - 2026-06-12

### Fixed

- Fixed KRO status serialization so schema-only status fields are hydrated by TypeKro instead of
  being emitted into the ResourceGraphDefinition status schema.
- Fixed nested status expression handling so embedded template expressions remain valid CEL and
  resource-backed status fields continue to be emitted for KRO reconciliation.
- Fixed integration test typecheck regressions in the status hydration and Cilium test suites.

## [0.15.0]

### Changed

- **Alchemy integration migrated v1 → v2 (BREAKING).** TypeKro's alchemy integration now targets
  alchemy `2.0.0-beta` (Effect-based) instead of `0.62`. The dependency was bumped (`alchemy`
  `^0.62.3` → `2.0.0-beta.51`) and `effect` (`4.0.0-beta.75`) is now a direct dependency.

### Added

- **Declarative alchemy v2 resources.** `typekro/alchemy` now exports `KroResource` (an alchemy v2
  `Resource`), `kroProvider` (its provider `Layer`), `materializeAlchemyResources(KroResource, decls)`,
  and the `AlchemyResourceDeclaration` type.
- **`factory.toAlchemyResources(spec, opts?)`** on both direct and Kro factories — emits a typekro
  deployment as per-resource alchemy v2 declarations (KRO: any shared singleton owners + the RGD +
  one CR instance; direct: one per resolved resource, topologically ordered with `dependsOn`). Feed them to
  `materializeAlchemyResources` inside an alchemy Stack (with `kroProvider` merged into the runtime)
  to deploy them as unified-state, reverse-topo-torn-down resources. The v2 analog of the removed
  imperative path; see `docs/advanced/alchemy-integration.md`.

### Removed

- **The imperative alchemy v1 API.** Removed `ResourceGraph.deployWithAlchemy(scope)`, the
  `alchemyScope` factory option, `isAlchemyManaged` (on factories + `FactoryStatus`), the
  `AlchemyDeploymentStrategy`, dynamic per-kind provider registration, and the `Scope` re-export.
  Migration: replace `factory('…', { alchemyScope }).deploy(spec)` with
  `materializeAlchemyResources(KroResource, await factory.toAlchemyResources(spec))` inside your
  alchemy v2 Stack.

### Security

- `toAlchemyResources` persists the factory's `kubeConfigOptions` into alchemy state so a state-driven
  delete can reconnect. If the kubeconfig uses static credentials (`token`/`certData`/`keyData`) those
  are written to the state store. Prefer re-derived auth (`exec`, e.g. `aws eks get-token`, or
  `authProvider`) and a secured state backend.

## [0.12.0] - 2026-06-08

### Added

- **Dagster integration**: typed Helm values mapper, Flux HelmRepository/HelmRelease factories, and `dagsterBootstrap` composition for Dagster OSS deployments.
- **Dagster package export and documentation**: new `typekro/dagster` entry point with API docs and live direct/KRO validation coverage.

### Fixed

- Dagster graph-mode Helm values now preserve nested runtime references and CEL expressions, including global and subchart overrides.
- Dagster RabbitMQ credential conveniences now map to the official chart paths under `rabbitmq.rabbitmq.*`.
- KRO factory YAML generation now validates specs consistently with direct `deploy()` execution.

## [0.11.0] - 2026-06-07

### Added

- **Ory integration**: typed Ory Identity and Platform stack compositions with Hydra, Kratos, Keto, Oathkeeper, Maester resources, chart value contracts, upstream coverage, and API documentation.
- **Ory Helm utilities**: typed chart values mappers and resource factories for Ory Helm releases, OAuth2 clients, and Oathkeeper rules.
- **Helm runtime values coverage**: regression tests for graph-mode Helm values merging and runtime passthrough behavior.

### Changed

- SearXNG bootstrap configs now require an explicit secret source for enabled instances: either `server.secret_key` for an auto-created Secret or `secretKeyRef` for an external Secret.
- SearXNG KRO mode now rejects `enabled: false` instances; direct mode still supports disabled instances by creating no resources. KRO users should omit disabled instances instead.
- TypeKro runtime bootstrap now defaults to KRO `0.9.2` and Flux `v2.7.5` in examples and docs.

### Fixed

- Graph-mode Helm values now preserve runtime values during graph merges, including Ory chart values.
- Composed CEL operands are grouped correctly to preserve intended expression precedence.
- SearXNG KRO bootstrap status and resource guards no longer reference omitted resources for missing secret sources.
- Nested resource serialization and schema proxy handling were tightened for external refs, `omit()` conversion, and status field generation.

## [0.10.1] - 2026-05-04

### Fixed

- Nested direct-mode re-execution now binds non-intercepted live-status `Map` methods to the underlying map, fixing brand-check failures for three-level nested compositions.

## [0.10.0] - 2026-05-04

### Added

- **Typed resource aspects**: reusable, type-checked resource mutations that can target resources by kind/capability, selectors, slots, and IDs.
- **Aspect convenience helpers**: `withLabels()`, `withAnnotations()`, `withMetadata()`, `withEnvVars()`, `withEnvFrom()`, `withResourceDefaults()`, `withImagePullPolicy()`, `withReplicas()`, `withServiceAccount()`, `withLocalWorkspace()`, and `withHotReload()`.
- **Dedicated aspect exports**: new `typekro/aspects` package export path alongside top-level exports for aspect primitives and helpers.
- **Hot reload aspects**: `hotReload()` and `withHotReload()` support local-development container, volume, label, and replica overrides.
- **Aspect documentation**: guide and API reference for target semantics, selectors, slots, KRO safety constraints, and advanced `override({ spec: ... })` usage.

### Fixed

- KRO-mode aspect validation now rejects unsafe reference-backed composite mutations while preserving safe no-op mutations.
- Aspect selector and render-option validation now fails closed for malformed selector input and avoids mistaking arbitrary specs for render options.

## [0.9.0] - 2026-04-28

### Added

- **SearXNG integration**: `searxngBootstrap` composition and `searxng()` factory for deploying the SearXNG metasearch engine. Supports auto-created Secret (from `server.secret_key`) or external `secretKeyRef` for Vault / external-secrets-operator workflows.
- **Public singleton helper**: `singleton()` is exported from the root `typekro` entry point for shared-owner boundaries used by nested compositions such as `webAppWithProcessing`.
- **JS-to-CEL: native `if`/`else` control flow**: Composition bodies can now use plain JavaScript `if (!spec.optional) { createResource(...) }` patterns to generate KRO `includeWhen` directives. The framework's differential execution captures resources from untaken branches (using a hybrid schema proxy that overrides tested optional fields with `undefined`) and field-level differences between proxy and hybrid runs are auto-converted to CEL `has(...) ? ... : ...` conditionals on the emitted resource fields.
- **JS-to-CEL: truthiness-aware `has()` wrapping**: Bare `if (spec.optionalField)` now compiles to `has(schema.spec.optionalField)` in the emitted RGD. Required boolean fields still compile to their value read (`schema.spec.enabled`) because `has()` on a required field is trivially true.
- **Framework: `Cel.has(ref)` and `Cel.not(ref|expr)`**: Public CEL helpers for explicit escape hatches where the auto-conversion can't reach (rare; AST analyzer covers most cases).
- **Framework: nested-object ternary detection**: `analyzeFactoryArgTernaries` now recurses into nested object literals, so ternaries deep inside structured factory arguments produce template overrides at the correct dotted path.
- **KRO 0.9 `omit()` emission**: Optional spec fields without defaults now emit `${has(schema.spec.X) ? schema.spec.X : omit()}` CEL conditionals inline during ref-to-CEL conversion (no post-hoc YAML rewriting). Mixed-template fields and sub-path refs are intentionally left unwrapped.
- **`simple.Secret` proxy-value guard**: The `simple.Secret` factory now throws a descriptive error if any `stringData` value is a `KubernetesRef` proxy or a string containing a `__KUBERNETES_REF__` marker. Previously these would silently base64-encode the marker token, producing a valid-but-wrong Secret in KRO mode. The error message points at the low-level `secret()` factory which passes stringData through untouched.
- **Phase 1/2 default precedence**: `applyNullishDefaults` now supports an `overwrite` mode so Phase 2 (authoritative re-execution) can correct Phase 1 (regex fast-path) misfires on the same field. Phase 1 misfires on edge cases like multi-line `??` expressions; Phase 2 always runs and takes precedence.
- **Required-field sentinel hardening**: `extractDefaultsByComparison` now filters out NaN values (from numeric-coercion propagation of the required-field sentinel) in addition to the existing substring match, preventing silent type-confusion when a required numeric field is compared.
- **Integration-skill rules #30–#34**: Composition side-effect constraints; `simple.Secret` proxy-value trap (#31); native-TypeScript composition preference (#32); "fix the framework, don't work around it" (#33); differential-capture override scoping and compound-condition limitations (#34).

### Changed

- **BREAKING**: Default KRO version bumped from `0.8.5` to `0.9.2`. TypeKro's serialization pipeline now emits the KRO 0.9+ mixed-template CEL format (`literal${string(ref)}literal`) and uses the `CELOmitFunction` feature gate for `omit()` support. Existing clusters must upgrade KRO to 0.9.2+ with `--set config.featureGates.CELOmitFunction=true` (the `typeKroRuntimeBootstrap` bootstrap sets this automatically). Running TypeKro 0.8+ against KRO 0.8.x will cause RGD validation failures at reconcile time.
- **BREAKING**: Mixed-template CEL format — references embedded in template literals now emit as `${string(ref)}` wrapped rather than CEL string concatenation (`"literal" + ref + "literal"`). This requires KRO 0.9+.
- `webAppWithProcessing` now defaults `database.database` to `app` when omitted instead of deriving the database name from the app name.

### Fixed

- `applyTernaryConditionalsToResources` now properly escapes `"`, `\`, `\n`, `\r`, and `\t` in ternary truthy-branch literal text when embedding into CEL string literals. Previous versions only escaped `\n`, which was a latent bug for compositions with quoted YAML values in conditional sections.
- `resolveDefaultsByReExecution` now matches proxy-run and defaults-run resources by RESOURCE ID instead of by insertion order. Compositions with conditional `createResource` patterns (e.g., `if (!spec.x) { createResource(...) }`) produce different resource counts between runs, and positional matching silently paired unrelated resources and corrupted default detection. The SearXNG KRO integration test regressed on this until it was fixed.
- Differential field capture now narrows the override set to only optional fields that appear in AST-detected condition tests — previously, over-eager override of all optional fields made `spec.server?.secret_key` evaluate to `undefined` in hybrid runs and leaked empty values into captured resources.
- `pickConditionField` fallback now emits a `logger.debug` entry so multi-field-override cases where the heuristic guesses the controlling field can be diagnosed from the composition output.

### Deprecated

- The SearXNG factory's plaintext `server.secret_key` env-var delivery path is retained for direct-mode callers that manage their own secret injection, but using the `searxngBootstrap` composition (which auto-creates a K8s Secret) or providing an explicit `secretKeyRef` is strongly preferred. The plaintext path exposes the secret in `kubectl get deploy -o yaml` and should not be used in production.

## [0.8.0] - 2026-04-05

## [0.5.0] - 2026-03-16

### Added

- **Kro v0.8.x**: `forEach` directive for iterating over arrays in resource definitions
- **Kro v0.8.x**: `includeWhen` directive for conditional resource inclusion based on `schema.spec` fields
- **Kro v0.8.x**: `readyWhen` directive for custom readiness CEL expressions
- **Kro v0.8.x**: `externalRef` for referencing pre-existing cluster resources without managing their lifecycle
- **Security**: Replace `new Function()` calls with `angular-expressions` for safe expression evaluation
- **Tests**: 37 compile-time type tests covering 13 type system areas
- **Tests**: 29 unit tests for serialization pipeline (schema, validation, yaml)
- **Tests**: 26 unit tests for safe expression evaluation
- **Tests**: 30 unit tests for CRD schema fix logic
- **Tests**: E2E integration tests for Kro v0.8.x features (forEach, includeWhen, readyWhen, externalRef)
- Configurable HTTP request timeouts for Kubernetes API operations
- APISIX chart upgraded to 2.13.0 with orphan cleanup support
- `customResource()` factory now provides a default readiness evaluator (overridable via `.withReadinessEvaluator()`)
- APISIX admin credentials now configurable via `gateway.adminCredentials` in bootstrap config
- New subpath entry points: `typekro/advanced` for internal/advanced APIs and `typekro/alchemy` for Alchemy integration
- `arktypeToKroSchema` and `createWebService` added to main public API
- `RbacMode` and `TypeKroRuntimeConfig` types added for TypeKro runtime compositions
- Runtime typo detection for status field names (Levenshtein distance, debug mode only)
- WeakMap-based resource metadata store replacing non-enumerable object properties
- Factory registry with self-registration pattern replacing hardcoded allowlists
- Shared deployment infrastructure: `ResourceApplier`, `ReadinessWaiter`, `ResourceRollbackManager` extracted from engine
- `analyzeAndConvertStatusMappings` pipeline decomposed into named stages with `StageResult` pattern

### Changed

- **BREAKING**: Kro upgraded from v0.3.0 to v0.8.5 (OCI registry moved to `registry.k8s.io/kro/charts`)
- **BREAKING**: All factories now require explicit readiness evaluators (no default provided by `createResource`)
- **BREAKING**: `ResourceGraph` interface renamed to `DeploymentResourceGraph`
- **BREAKING**: `FactoryOptions` split into `PublicFactoryOptions` (user-facing) and `InternalFactoryOptions` (internal)
- **BREAKING**: `ResourceDeploymentError`, `ResourceReadinessTimeoutError`, `ResourceConflictError`, and `UnsupportedMediaTypeError` now extend `TypeKroError` instead of `Error`
- **BREAKING**: `KroResourceTemplate.template` field is now optional (to support the new `externalRef` alternative)
- Lower-level APIs moved to dedicated subpath exports: `typekro/advanced` (logging, K8s client, errors, CEL internals) and `typekro/alchemy` (Alchemy deployers and utilities)
- Ingress readiness evaluator rewritten to require actual controller signals instead of accepting empty status
- `autoFix.fluxCRDs` patching logs upgraded to warn level
- CRD schema fix logic consolidated from 3 files into `src/core/utils/crd-schema-fix.ts`
- Status builder context migrated from `globalThis` flag to `AsyncLocalStorage`
- 41 generic `throw new Error()` calls migrated to typed error classes
- 38 `as any` casts eliminated across 4 core files
- Cert-manager upgraded to 1.19.3
- `MutatingAdmissionWebhook` kind corrected to `MutatingWebhookConfiguration`
- `ValidatingAdmissionWebhook` kind corrected to `ValidatingWebhookConfiguration`

### Fixed

- `deploy()` hang caused by unbounded status hydration polling
- Deployment deadlocks in cert-manager helm mapping
- Hardcoded sleeps/timeouts replaced with polling and configurable values
- `getTimeoutForRequest()` now uses configured timeouts instead of hardcoded values
- Bun async abort errors in event monitor cleanup
- `Promise.allSettled` used in test cleanup to prevent cascading failures
- `CelEvaluationError` now extends `TypeKroError` instead of `Error`
- Missing exports for `ConversionError` and `StatusHydrationError` from barrel
- Race condition in `ensureFluxCRDsPatched` with concurrent deployments
- Timer leak in CRD JSON patch `Promise.race` (timeout never cleared)
- Async `setTimeout` unhandled rejection in deployment timeout handlers
- Incorrect `successCount` in partial deployment error (counted all resources, not just successful ones)
- Shared timeout budget across sequential namespace deletions (each namespace now gets its own timeout)
- Cert-manager Helm values spread overwriting carefully-built nested defaults
- Integration test `unhandledRejection` handlers now properly cleaned up in `afterAll`

### Removed

- ~70 lines of dead code in HelmRelease readiness evaluator
- Unused `WebhookConfig` interface from cert-manager types
- `CompositionFactory` type removed from main `'typekro'` barrel (still accessible via `typekro/advanced`)
- `UnsupportedPatternDetector` class removed entirely

## [0.4.0] - 2026-01-01

### Added

- Cilium ecosystem support: networking policies, L7 policies, gateway API integration
- Cert-manager ecosystem with CEL expressions and nested composition improvements
- Major deployment engine improvements
- APISIX bootstrap fixes
- Comprehensive unit tests for marker conversion

### Fixed

- Regex pattern for `__KUBERNETES_REF__` marker conversion
- Kro HelmRelease namespace to match ClusterRoleBinding (kro-system)
- CEL expression cloning and OCI HelmRepository readiness issues
- Cilium bootstrap composition export and test issues

## [0.3.1] - 2025-09-07

### Added

- JavaScript-to-CEL template literal conversion

### Fixed

- HTTP 415 error in Kubernetes API operations

## [0.3.0] - 2025-09-04

### Added

- JavaScript to CEL expression conversion system
- Standard npm publish workflow based on `package.json` version changes

### Fixed

- Preserve static values in status builder analyzer for performance
- Preserve undefined values in status builder analyzer
- Edge case bug fixes in expression handling

## [0.2.2] - 2025-08-27

### Fixed

- Grant `contents: write` permission for GitHub releases
- Documentation link standardization

## [0.2.0] - 2025-08-27

### Added

- Kubernetes events progress monitoring
- Imperative composition pattern with enhanced error handling
- Comprehensive Alchemy test coverage
- Production-ready repository infrastructure (CI, coverage, Dependabot)

### Fixed

- Circular reference hanging in deployment engine
- Comprehensive linting fixes

## [0.1.0] - 2025-08-08

### Added

- Initial release
- Type-safe Kubernetes resource composition with `toResourceGraph()`
- Magic proxy system for cross-resource references
- CEL expression support for status builders (`Cel.expr()`, `Cel.template()`)
- Factory functions: Deployment, Service, ConfigMap, Secret, Ingress, PVC, RBAC resources
- HelmRelease and HelmRepository factories for Flux CD
- YAML file resource factory
- Kustomize factory functions
- Direct deployment mode with readiness checking
- Kro deployment mode with ResourceGraphDefinition serialization
- Schema proxy with type-safe spec/status access

[Unreleased]: https://github.com/yehudacohen/typekro/compare/v0.20.0...HEAD
[0.20.0]: https://github.com/yehudacohen/typekro/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/yehudacohen/typekro/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/yehudacohen/typekro/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/yehudacohen/typekro/compare/v0.16.1...v0.17.0
[0.16.0]: https://github.com/yehudacohen/typekro/compare/v0.15.4...v0.16.0
[0.15.3]: https://github.com/yehudacohen/typekro/compare/v0.15.2...v0.15.3
[0.15.2]: https://github.com/yehudacohen/typekro/compare/v0.15.1...v0.15.2
[0.15.1]: https://github.com/yehudacohen/typekro/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/yehudacohen/typekro/compare/v0.14.0...v0.15.0
[0.12.0]: https://github.com/yehudacohen/typekro/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/yehudacohen/typekro/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/yehudacohen/typekro/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/yehudacohen/typekro/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/yehudacohen/typekro/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/yehudacohen/typekro/compare/v0.7.0...v0.8.0
[0.5.0]: https://github.com/yehudacohen/typekro/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/yehudacohen/typekro/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/yehudacohen/typekro/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/yehudacohen/typekro/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/yehudacohen/typekro/compare/v0.2.0...v0.2.2
[0.2.0]: https://github.com/yehudacohen/typekro/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yehudacohen/typekro/releases/tag/v0.1.0
