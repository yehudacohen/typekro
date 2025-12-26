# Tech Debt Backlog - Q1 2026

## Overview

This spec tracks technical debt items identified during code review and feedback analysis. Items are prioritized by impact and effort, organized into cohesive themes for efficient execution.

## Priority Levels

- **P0 (Critical)**: Data loss risk, security issues, or blocking bugs
- **P1 (High)**: Runtime stability, compatibility issues
- **P2 (Medium)**: Architecture improvements, performance optimizations
- **P3 (Low)**: Code quality, documentation, cleanup

## Themes

1. **Deployment Safety** (P0-1, P0-2): Ensuring safe, reliable deployments
2. **Runtime Stability** (P1-4, P1-5): Long-running process reliability
3. **Code Architecture** (P2-6, P2-7, P2-8): Maintainability and performance
4. **Code Quality** (P3-9 through P3-14): Cleanup and consistency

---

## P0: Critical Issues

### P0-1. Flux Bootstrap Strategy - Data Loss Risk

**Status**: Open
**Effort**: Medium (1-2 days)
**Theme**: Deployment Safety
**Risk**: Using `replace` strategy for Flux CRDs can overwrite manual patches on existing clusters

**Current Behavior**:
- `e2e-helm-integration.test.ts` uses `deploymentStrategy: 'replace'` with `manifestTransform: fixCRDSchemaForK8s133`
- This overwrites any manual customizations operators have applied to Flux CRDs

**Proposed Solution**:
1. Short-term: Add a check to only apply `replace` if the CRD schema actually violates the K8s 1.33 rule
2. Long-term: Use server-side apply with `--force-conflicts` which merges rather than replaces
3. Add warning logs when CRD transformations are applied (✅ DONE)

**Files Affected**:
- `test/integration/e2e-helm-integration.test.ts`
- `src/core/utils/crd-schema-fix.ts`
- `src/factories/kubernetes/yaml/yaml-file.ts`

---

### P0-2. Readiness Evaluator - Kind-Specific Hardcoding

**Status**: Open
**Effort**: Medium (1-2 days)
**Theme**: Deployment Safety
**Risk**: StatefulSets, DaemonSets, and other workloads bypass readiness logic

**Current Behavior**:
- `recreateReadinessEvaluator` in `DirectTypeKroDeployer` only handles `kind: Deployment`
- Defaults `expectedReplicas` to 1, breaking HPA scenarios

**Proposed Solution**:
1. Use duck typing: check if resource has `spec.replicas` and `status.readyReplicas` fields
2. Remove default to 1 - if replicas are undefined (HPA-managed), check `status.readyReplicas == status.replicas`
3. Add support for StatefulSet, DaemonSet, ReplicaSet patterns

**Files Affected**:
- `src/alchemy/deployers.ts`
- `src/core/deployment/readiness.ts`

---

## P1: Runtime Stability

### P1-3. Kubernetes Client Version Pinning

**Status**: ✅ DONE
**Effort**: Minimal (5 min)
**Theme**: Runtime Stability

**Solution Applied**:
- Pinned `@kubernetes/client-node` to specific commit `67d6aa4` instead of `main` branch
- Documented reason in `.kiro/specs/upgrade-kubernetes-client/requirements.md`

---

### P1-4. Bun Client Authentication Refresh

**Status**: Open
**Effort**: Medium (1 day)
**Theme**: Runtime Stability
**Risk**: Long-running processes (>1 hour) may fail due to token expiration

**Current Behavior**:
- Custom `BunClient` overrides `execute` method for TLS handling
- May bypass automatic token refresh logic (OIDC/GKE token rotation)

**Proposed Solution**:
1. Audit `src/core/kubernetes/bun-http-library.ts` to ensure `KubeConfig.applyToRequest()` is called dynamically
2. Add integration test that simulates token expiration
3. Consider adding token refresh callback

**Files Affected**:
- `src/core/kubernetes/bun-http-library.ts`
- `src/core/kubernetes/api.ts`

---

### P1-5. Event Monitor Reconnection Logic

**Status**: Open
**Effort**: Low (0.5 day)
**Theme**: Runtime Stability
**Risk**: Watch connections may not recover from network issues

**Current Behavior**:
- `src/core/deployment/event-monitor.ts` has TODO for exponential backoff retry logic
- Watch connection errors are logged but not properly recovered

**Proposed Solution**:
1. Implement exponential backoff with jitter for reconnection
2. Add max retry limit with graceful degradation
3. Emit events when monitoring is degraded

**Files Affected**:
- `src/core/deployment/event-monitor.ts`

---

## P2: Architecture Improvements

### P2-6. Magic String Parsing in CEL

**Status**: Open
**Effort**: High (3-5 days)
**Theme**: Code Architecture
**Risk**: Fragile string manipulation, hard to debug

**Current Behavior**:
- Uses `__KUBERNETES_REF_` markers inside strings to detect dependencies
- Regex-based string manipulation for CEL generation

**Proposed Solution**:
1. Short-term: Document the magic string format clearly, add validation
2. Long-term: Move towards structured AST for CEL generation
3. Consider using a proper tokenizer for string interpolation

**Files Affected**:
- `src/core/expressions/analyzer.ts`
- `src/core/expressions/imperative-analyzer.ts`
- `src/core/expressions/status-builder-analyzer.ts`
- `src/core/references/cel.ts`

---

### P2-7. Memory Optimization - resourceKeyMapping

**Status**: Open
**Effort**: Low (0.5 day)
**Theme**: Code Architecture
**Risk**: Memory pressure on large clusters

**Current Behavior**:
- `resourceKeyMapping` stores entire live Kubernetes objects (metadata, spec, status)
- For large clusters with many resources, this causes memory bloat

**Proposed Solution**:
1. Store only necessary projection: `status`, `metadata.uid`, `metadata.resourceVersion`
2. Add lazy loading for full resource when needed
3. Consider LRU cache with size limits

**Files Affected**:
- `src/core/deployment/engine.ts`

---

### P2-8. Type Safety - Reduce `as any` Usage

**Status**: Open
**Effort**: High (ongoing)
**Theme**: Code Architecture
**Risk**: Type errors at runtime, poor IDE experience

**Current Behavior**:
- 70+ instances of `as any` in source code (verified via grep)
- Many are in proxy/factory code where types are complex
- Concentrated in: `src/factories/shared.ts`, `src/alchemy/`, `src/core/expressions/`

**Proposed Solution**:
1. Audit each `as any` usage and categorize:
   - Necessary (proxy magic, external library types)
   - Fixable (missing type definitions)
   - Technical debt (lazy typing)
2. Create proper type definitions for common patterns
3. Add ESLint rule to prevent new `as any` without justification

**Files Affected**:
- `src/factories/shared.ts` (highest concentration)
- `src/alchemy/deployers.ts`
- `src/core/expressions/expression-proxy.ts`
- `src/core/expressions/lazy-analysis.ts`

---

## P3: Code Quality

### P3-9. Console Logging Cleanup

**Status**: Open
**Effort**: Medium (1 day)
**Theme**: Code Quality
**Risk**: Inconsistent logging, no log levels, hard to debug in production

**Current Behavior**:
- 25+ `console.log/warn/error` statements in source code
- Concentrated in: `src/core/expressions/`, `src/core/yaml/`, `src/factories/kubernetes/yaml/`
- No structured logging, no log levels, no correlation IDs

**Proposed Solution**:
1. Replace all `console.*` calls with pino logger (already in project)
2. Add appropriate log levels (debug, info, warn, error)
3. Add context/correlation IDs for tracing
4. Add ESLint rule to prevent `console.*` in src/

**Files Affected**:
- `src/core/expressions/composition-integration.ts` (6 instances)
- `src/core/expressions/status-builder-analyzer.ts` (1 instance)
- `src/core/expressions/lazy-analysis.ts` (2 instances)
- `src/core/expressions/magic-proxy-analyzer.ts` (1 instance)
- `src/core/yaml/path-resolver.ts` (2 instances)
- `src/factories/kubernetes/yaml/yaml-file.ts` (3 instances)
- `src/factories/kubernetes/yaml/yaml-directory.ts` (3 instances)
- `src/core/deployment/engine.ts` (1 instance)
- `src/core/composition/imperative.ts` (1 instance)

---

### P3-10. Deprecated Function Removal

**Status**: Open
**Effort**: Low (0.5 day)
**Theme**: Code Quality
**Risk**: Confusion for new developers, maintenance burden

**Current Behavior**:
- `simpleHelmChart()` deprecated in favor of `simple.HelmChart()`
- `simpleYamlFile()` deprecated in favor of `simple.YamlFile()`
- `src/core/factory.ts` entirely deprecated

**Proposed Solution**:
1. Add deprecation warnings at runtime (console.warn on first use)
2. Update all internal usages to new APIs
3. Document migration path in CHANGELOG
4. Remove in next major version

**Files Affected**:
- `src/factories/helm/helm-release.ts`
- `src/factories/kubernetes/yaml/yaml-file.ts`
- `src/core/factory.ts`

---

### P3-11. TODO Comments Cleanup

**Status**: Open
**Effort**: Medium (1-2 days)
**Theme**: Code Quality

**Current State**:
- 30+ TODO/FIXME comments in source code (verified via grep)
- Many are for features that may never be implemented
- Some are stale (referring to completed work)
- Notable patterns:
  - CEL analyzer placeholders: `/* TODO: convert find predicate */`
  - Cilium factory placeholders: `// TODO: Implement in task X.X`
  - Integration TODOs: `// TODO: Implement proper alchemy integration`

**Proposed Solution**:
1. Audit all TODO comments
2. Convert actionable items to GitHub issues
3. Remove stale TODOs
4. Add lint rule requiring issue reference for new TODOs

---

### P3-12. Empty Catch Block Audit

**Status**: Open
**Effort**: Low (0.5 day)
**Theme**: Code Quality

**Current State**:
- Multiple `catch` blocks that log but don't properly handle errors
- Some intentional (fallback behavior), some may hide bugs

**Proposed Solution**:
1. Audit each catch block
2. Add proper error handling or re-throw
3. Document intentional error swallowing with comments
4. Consider using `Result<T, E>` pattern for expected failures

---

### P3-13. Cilium Factory Placeholders

**Status**: Open
**Effort**: Medium (2-3 days)
**Theme**: Code Quality

**Current State**:
- Multiple Cilium resource factories are placeholders:
  - `CiliumGatewayClassConfig`
  - `CiliumEnvoyConfig`
  - `CiliumEgressGatewayPolicy`
  - `CiliumLocalRedirectPolicy`
  - `CiliumCIDRGroup`
  - `CiliumBGPClusterConfig`
  - `CiliumBGPPeeringPolicy`
  - `CiliumBGPAdvertisement`
  - `CiliumLoadBalancerIPPool`
  - `CiliumL2AnnouncementPolicy`

**Proposed Solution**:
1. Implement factories as needed by users
2. Remove placeholder files if not planned
3. Add "not implemented" errors instead of empty exports

---

### P3-14. Hardcoded Timeout Values

**Status**: Open
**Effort**: Low (0.5 day)
**Theme**: Code Quality
**Risk**: Inflexible for different environments

**Current Behavior**:
- Default timeout of 300000ms (5 min) hardcoded in multiple places
- `src/alchemy/deployers.ts`: `timeout: options.timeout ?? 300000`
- `src/alchemy/resource-registration.ts`: `timeout: props.options?.timeout ?? 300000`

**Proposed Solution**:
1. Create a central configuration module for default values
2. Allow environment variable overrides
3. Document timeout configuration options

---

## Completed Items

### ✅ CRD Transformation Logging

**Completed**: 2025-12-21
**Solution**: Added detailed logging to `fixCRDSchemaForK8s133` showing:
- CRD name
- Number of changes
- Specific changes made (field paths and reasons)
- Warning note about validation behavior changes

### ✅ Kubernetes Client Version Pinning

**Completed**: 2025-12-21
**Solution**: Pinned to commit `67d6aa4` instead of `main` branch

---

## Effort Summary

| Priority | Items | Total Effort |
|----------|-------|--------------|
| P0 | 2 | 2-4 days |
| P1 | 2 (1 done) | 1.5 days |
| P2 | 3 | 4-6.5 days |
| P3 | 6 | 5-7.5 days |
| **Total** | **13** | **12.5-19 days** |

## Recommended Execution Order

1. **Sprint 1 (Week 1-2)**: P0 items - Deployment Safety
   - P0-1: Flux Bootstrap Strategy
   - P0-2: Readiness Evaluator

2. **Sprint 2 (Week 3)**: P1 items - Runtime Stability
   - P1-4: Bun Client Token Refresh
   - P1-5: Event Monitor Reconnection

3. **Sprint 3 (Week 4-5)**: P2 items - Architecture
   - P2-7: Memory Optimization (quick win)
   - P2-8: Type Safety Audit (ongoing)
   - P2-6: Magic String Parsing (if time permits)

4. **Sprint 4 (Week 6)**: P3 items - Code Quality
   - P3-9: Console Logging Cleanup
   - P3-10: Deprecated Function Removal
   - P3-14: Hardcoded Timeout Values
   - P3-11, P3-12, P3-13: As time permits

---

## Notes

- Items should be moved to GitHub Issues for tracking
- Priority may change based on user feedback
- Some items may be deferred if not blocking production use
- P2-6 (Magic String Parsing) is high effort and may be deferred to Q2
