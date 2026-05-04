# Changelog

All notable changes to TypeKro will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- **BREAKING**: Default KRO version bumped from `0.8.5` to `0.9.1`. TypeKro's serialization pipeline now emits the KRO 0.9+ mixed-template CEL format (`literal${string(ref)}literal`) and uses the `CELOmitFunction` feature gate for `omit()` support. Existing clusters must upgrade KRO to 0.9.1+ with `--set config.featureGates.CELOmitFunction=true` (the `typeKroRuntimeBootstrap` bootstrap sets this automatically). Running TypeKro 0.8+ against KRO 0.8.x will cause RGD validation failures at reconcile time.
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

[Unreleased]: https://github.com/yehudacohen/typekro/compare/v0.10.1...HEAD
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
