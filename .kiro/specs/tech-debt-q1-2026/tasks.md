# Tech Debt Tasks

## Sprint 1: Deployment Safety (P0) - Week 1-2

### Task 1.1: Flux Bootstrap Strategy Fix
- [x] 1.1.1 Add CRD validation check before applying `replace` strategy
  - Added `needsCRDSchemaFix()` function to check if CRD needs fixes
  - Added `smartFixCRDSchemaForK8s133()` that only applies fixes when needed
- [x] 1.1.2 Implement server-side apply option for CRD updates
  - Added `serverSideApply` deployment strategy to yaml-file factory
  - Added `fieldManager` and `forceConflicts` options for SSA
- [x] 1.1.3 Add integration test for CRD update scenarios
  - Added comprehensive unit tests in `test/core/utils/crd-schema-fix.test.ts`
  - Tests cover: needsCRDSchemaFix, fixCRDSchemaForK8s133, smartFixCRDSchemaForK8s133
  - Tests cover: nested properties, additionalProperties, array items, real-world Flux CRD scenarios
- [x] 1.1.4 Update documentation for CRD handling
  - Updated `.kiro/steering/external-manifest-compatibility.md` with:
    - Server-side apply strategy documentation
    - Smart fix functions documentation
    - Helper functions documentation

### Task 1.2: Readiness Evaluator Improvements
- [x] 1.2.1 Verified existing registry-based readiness evaluator lookup
  - Factory functions already register evaluators via `.withReadinessEvaluator()`
  - `ReadinessEvaluatorRegistry` stores evaluators by kind
  - `ensureReadinessEvaluator()` in helpers.ts handles registry lookup
- [x] 1.2.2 Simplified `DirectTypeKroDeployer` to use registry lookup
  - Removed redundant `recreateReadinessEvaluator` duck-typing logic
  - Now uses `ensureReadinessEvaluator()` which:
    1. Returns resource if it already has evaluator attached
    2. Looks up evaluator in registry by kind
    3. Throws error if no evaluator found
- [x] 1.2.3 Updated unit tests for registry-based approach
  - Updated `test/unit/alchemy-deployers.test.ts` to test registry lookup
  - Removed obsolete `test/unit/alchemy-deployers-workload-types.test.ts`
  - Tests verify: factory registration, registry lookup, evaluator behavior

---

## Sprint 2: Runtime Stability (P1) - Week 3

### Task 2.1: Bun Client Token Refresh
- [x] 2.1.1 Audit `BunClient.execute()` for token refresh handling
  - Verified: KubeConfig is passed as auth method, applyToRequest() called per-request
- [x] 2.1.2 Ensure `KubeConfig.applyToRequest()` is called per-request
  - Confirmed: authMethods.default = kubeConfig ensures dynamic token refresh
- [x] 2.1.3 Add documentation for token refresh behavior
  - Added comprehensive JSDoc explaining token refresh mechanism
- [ ] 2.1.4 Add integration test for token expiration scenario (optional)
  - Mock token expiration after 1 hour

### Task 2.2: Event Monitor Reconnection
- [x] 2.2.1 Implement exponential backoff with jitter
  - Base delay: 1s, max delay: 30s
  - Jitter: ±20%
- [x] 2.2.2 Add max retry limit configuration
  - Default: 10 retries
  - Configurable via `maxReconnectAttempts` option
- [x] 2.2.3 Emit degraded monitoring events
  - Emits progress event when retries exhausted
- [x] 2.2.4 Add unit tests for reconnection logic
  - Added comprehensive tests in `test/unit/event-monitor-reconnection.test.ts`
  - Tests cover: exponential backoff calculation, jitter, max delay cap
  - Tests cover: reconnection options, degraded monitoring events
  - Tests cover: TimeoutError handling, AbortError handling during cleanup

---

## Sprint 3: Architecture (P2) - Week 4-5

### Task 3.0: Integration Test Conflict Handling (Quick Win)
- [x] 3.0.1 Add `createResourceWithConflictHandling()` utility to shared-kubeconfig.ts
  - Supports 'warn', 'fail', 'patch', 'replace' strategies
  - Default strategy is 'warn' - logs warning and returns existing resource
- [x] 3.0.2 Add `deleteResourceIfExists()` utility for graceful cleanup
  - Ignores 404 errors during cleanup
- [x] 3.0.3 Update cert-manager integration tests to use conflict handling
- [x] 3.0.4 Update external-dns integration tests to use conflict handling
- [x] 3.0.5 Document Kro CEL schema limitation with HelmRelease spec.values
  - Kro controller tries to extract CEL expressions from all fields
  - HelmRelease uses x-kubernetes-preserve-unknown-fields for values
  - Workaround: Use direct deployment for HelmRelease with complex values
  - Skipped Kro factory test in cilium/bootstrap-composition.test.ts
- [x] 3.0.6 Verified no apisix/pebble integration tests exist that need updating
  - Other integration tests use namespace creation with existing try/catch handling

### Task 3.1: Memory Optimization (Quick Win)
- [ ] 3.1.1 Create resource projection utility
  - Extract only: `status`, `metadata.uid`, `metadata.resourceVersion`, `metadata.name`
- [ ] 3.1.2 Update `resourceKeyMapping` to store projections
- [ ] 3.1.3 Add lazy loading for full resource data
  - Fetch full resource only when needed
- [ ] 3.1.4 Add memory usage tests/benchmarks

### Task 3.2: Type Safety Audit
- [ ] 3.2.1 Categorize all `as any` usages (70+ instances)
  - Create spreadsheet: file, line, category, action
- [ ] 3.2.2 Create type definitions for proxy patterns
  - `EnhancedProxy<T>`, `MagicProxy<T>`
- [ ] 3.2.3 Fix low-hanging fruit (simple type fixes)
  - Target: reduce by 30% in first pass
- [ ] 3.2.4 Add ESLint rule for `as any` justification
  - Require comment explaining why

### Task 3.3: Magic String Parsing (Deferred to Q2 if needed)
- [ ] 3.3.1 Document magic string format (`__KUBERNETES_REF_`)
- [ ] 3.3.2 Add validation for magic string format
- [ ] 3.3.3 Design AST-based CEL generation (spike)
- [ ] 3.3.4 Implement tokenizer for string interpolation

---

## Sprint 4: Code Quality (P3) - Week 6

### Task 4.1: Console Logging Cleanup
- [ ] 4.1.1 Create logging utility wrapper
  - Use pino logger with context
- [ ] 4.1.2 Replace console.* in `src/core/expressions/` (10 instances)
- [ ] 4.1.3 Replace console.* in `src/factories/kubernetes/yaml/` (6 instances)
- [ ] 4.1.4 Replace console.* in remaining files (9 instances)
- [ ] 4.1.5 Add ESLint rule to prevent console.* in src/

### Task 4.2: Deprecated Function Removal
- [ ] 4.2.1 Add runtime deprecation warnings
  - `console.warn` on first use of deprecated function
- [ ] 4.2.2 Update internal usages to new APIs
- [ ] 4.2.3 Document migration path in CHANGELOG
- [ ] 4.2.4 Schedule removal for next major version

### Task 4.3: Hardcoded Timeout Values
- [ ] 4.3.1 Create central configuration module
  - `src/core/config/defaults.ts`
- [ ] 4.3.2 Add environment variable overrides
  - `TYPEKRO_DEFAULT_TIMEOUT`
- [ ] 4.3.3 Update all hardcoded timeout references
- [ ] 4.3.4 Document timeout configuration

### Task 4.4: TODO Cleanup
- [ ] 4.4.1 Audit all TODO comments (30+)
- [ ] 4.4.2 Create GitHub issues for actionable items
- [ ] 4.4.3 Remove stale TODOs
- [ ] 4.4.4 Add lint rule for TODO format

### Task 4.5: Error Handling Audit
- [ ] 4.5.1 Audit catch blocks in src/
- [ ] 4.5.2 Add proper error handling or re-throw
- [ ] 4.5.3 Document intentional error swallowing

---

## Completed Tasks

### ✅ Task 0.1: Quick Wins (Completed 2025-12-21)
- [x] 0.1.1 Add logging to CRD schema transformation
- [x] 0.1.2 Pin Kubernetes client version to specific commit

---

## Backlog (Not Scheduled)

### Cilium Factory Placeholders (P3-13)
- [ ] Implement CiliumBGPClusterConfig factory
- [ ] Implement CiliumBGPPeeringPolicy factory
- [ ] Implement CiliumBGPAdvertisement factory
- [ ] Implement CiliumLoadBalancerIPPool factory
- [ ] Implement CiliumL2AnnouncementPolicy factory
- [ ] Implement CiliumEgressGatewayPolicy factory
- [ ] Implement CiliumLocalRedirectPolicy factory
- [ ] Implement CiliumCIDRGroup factory
- [ ] Implement CiliumGatewayClassConfig factory
- [ ] Implement CiliumEnvoyConfig factory

*Note: Implement on-demand as users request specific Cilium features*
