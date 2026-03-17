# Changelog

All notable changes to TypeKro will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- `RbacMode`, `TypeKroRuntimeSpec`, `TypeKroRuntimeStatus` types added for TypeKro runtime compositions
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

[Unreleased]: https://github.com/yehudacohen/typekro/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/yehudacohen/typekro/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/yehudacohen/typekro/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/yehudacohen/typekro/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/yehudacohen/typekro/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/yehudacohen/typekro/compare/v0.2.0...v0.2.2
[0.2.0]: https://github.com/yehudacohen/typekro/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yehudacohen/typekro/releases/tag/v0.1.0
