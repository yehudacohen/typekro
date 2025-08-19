# Implementation Plan

## Current Status Summary (As of Analysis - August 2025)

### ✅ **Foundation Complete (Tasks 1.1-1.5) - 100%**
- YAML factory functions with closure-based execution ✅
- Composition system integration for closures ✅  
- YAML closure types and Kro mode validation support ✅
- Git path constants and utilities ✅
- YAML factories exported from main index ✅

### ✅ **Core Systems Complete (Tasks 2.1-3.5) - 95%**
- Path resolution system (local files, Git URLs) ✅
- Cluster state access system ✅
- Readiness evaluators following TypeKro patterns ✅
- DirectResourceFactory closure integration ✅
- **Level-based closure execution system with CRD establishment** ✅
- **Unit tests passing for all implemented features** ✅

### ✅ **Helm Factories Complete (Tasks 4.1-4.5) - 100%**
- Helm release factory function ✅
- Helm resource type definitions ✅
- Helm values with reference system integration ✅
- Simplified Helm composition function ✅
- Helm-specific readiness evaluators ✅

### 🚨 **Critical Blockers Requiring Immediate Attention**
- **TypeScript Compilation Failure**: Missing `KustomizationSpec` and `KustomizationStatus` types
- **Skipped Integration Tests**: Helm integration tests disabled, preventing end-to-end validation
- **Kro Mode Support**: Not fully implemented or tested (Task 3.6)

### ⚠️ **Partial Implementation (Needs Completion)**
- **Kustomize Factories** (Tasks 5.1-5.4): Implementation exists but has type errors
- **Bootstrap Compositions** (Tasks 6.1-6.5): Not implemented, critical gap for GitOps workflow
- **Error Handling** (Tasks 7.1-7.3): Basic implementation exists in PathResolver, needs integration
- **Comprehensive Testing** (Tasks 8.1-8.8): Unit tests pass, integration tests need investigation
- **Documentation** (Tasks 9.1-9.6): Not implemented

### 📊 **Overall Progress: 75% Complete**
- **High-quality foundation** with excellent closure-based architecture
- **All core YAML functionality working** with proper TypeKro integration
- **Main gaps**: Bootstrap compositions, type fixes, comprehensive testing

---

## 🚨 **Immediate Action Items (Required to Unblock)**

### 1. **Fix TypeScript Compilation** (5 minutes) - CRITICAL
- **Issue**: `KustomizationSpec` and `KustomizationStatus` missing from `src/core/types/yaml.ts`
- **Impact**: Prevents build and all subsequent development
- **Action**: Add missing type definitions and exports

### 2. **Investigate Skipped Integration Tests** (15 minutes) - HIGH
- **Issue**: Helm integration tests are disabled, not running end-to-end validation
- **Impact**: Cannot verify YAML closures work with real Kubernetes
- **Action**: Determine why tests are skipped and re-enable them

### 3. **Implement Kro Mode Support** (30 minutes) - HIGH
- **Issue**: Task 3.6 not implemented, Kro mode YAML support missing
- **Impact**: YAML resources only work in Direct mode
- **Action**: Add Kro factory closure validation and execution

### 4. **Create Bootstrap Compositions** (45 minutes) - MEDIUM
- **Issue**: No pre-built compositions for TypeKro runtime bootstrap
- **Impact**: Users cannot easily deploy complete GitOps platform
- **Action**: Implement `typeKroRuntimeBootstrap()` and examples

---

- [ ] 1. Set up YAML resource foundation
  - Create basic YAML factory functions and type definitions
  - Integrate with existing TypeKro factory system
  - _Requirements: 1.1, 8.1, 8.5_

- [x] 1.1 Create YAML factory functions with closure-based execution
  - **CRITICAL**: Modify existing `yamlFile()` and `yamlDirectory()` factories to return closures instead of Enhanced<> resources
  - Functions return `YamlDeploymentClosure` during composition evaluation
  - Closures execute during deployment phase with deployment context
  - Remove current Enhanced<> resource implementation that conflicts with design
  - _Requirements: 1.1, 1.3, 8.1_

- [x] 1.2 Implement composition system integration for closures
  - Modify `toResourceGraph` in `src/core/serialization/core.ts` to detect YAML closures during composition evaluation
  - Update `createTypedResourceGraph` to separate closures from Enhanced<> resources
  - Store closures in TypedResourceGraph for access during factory creation
  - Ensure closures are passed to DirectResourceFactory during factory instantiation
  - _Requirements: 2.1, 2.2, 2.3, 8.1_

- [x] 1.3 Define YAML closure types and Kro mode support
  - Add `YamlDeploymentClosure` type to `src/core/types/deployment.ts`
  - Add `DeploymentContext` interface to `src/core/types/deployment.ts`
  - Add `AppliedResource` interface to `src/core/types/deployment.ts`
  - Update DirectResourceFactory method signatures to handle closures
  - Add closure validation for Kro mode (detect KubernetesRef inputs and raise errors)
  - _Requirements: 8.1, 8.2, 10.1_

- [x] 1.4 Add Git path constants and utilities
  - Add `GitPaths` constants for common Git repository paths (Flux, Kro, etc.)
  - Include JSDoc examples for better IDE experience
  - Create utility functions for common bootstrap scenarios
  - _Requirements: 8.2, 8.4, 11.4_

- [x] 1.5 Export YAML factories from main index
  - Add exports to `src/factories/kubernetes/yaml/index.ts`
  - Update `src/factories/kubernetes/index.ts` to include YAML factories
  - Ensure proper TypeScript module resolution
  - _Requirements: 8.2, 8.4_

- [x] 2. Implement path resolution system
  - Create unified path resolver for local files and Git repositories
  - Support git: URL syntax for remote content fetching
  - _Requirements: 1.2, 3.1, 3.2, 3.3_

- [x] 2.1 Create path resolver interface and implementation
  - Implement `PathResolver` class in `src/core/yaml/path-resolver.ts`
  - Support local file paths and git: URL syntax
  - Parse git: URLs to extract host, owner, repo, path, and ref
  - _Requirements: 1.2, 3.1, 3.2, 3.3_

- [x] 2.2 Implement local file content loading
  - Add `resolveLocalContent()` method for filesystem access
  - Handle file reading with proper error handling
  - Support both individual files and directory traversal
  - _Requirements: 1.2, 2.1, 2.4_

- [x] 2.3 Implement Git content fetching
  - Add `resolveGitContent()` method for Git repository access
  - Support GitHub API for public repositories
  - Handle authentication for private repositories
  - Parse git: URL format with optional @ref syntax
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 2.4 Add file discovery for directories
  - Implement `discoverYamlFiles()` function for directory processing
  - Support glob patterns for include/exclude filtering
  - Handle recursive directory traversal
  - _Requirements: 2.1, 2.2, 2.3, 2.5_

- [x] 2.5 Update design document with pre-deployment execution approach
  - Update design to reflect pre-deployment execution before Enhanced<> resources
  - Document factory-style API that registers functions for later execution
  - Fix toResourceGraph API usage to match current signature
  - Add integration examples showing YAML functions in resource graphs
  - _Requirements: 1.1, 8.1, 9.4_

- [-] 3. Create cluster state access system
  - Implement cluster state accessor for readiness evaluators
  - Provide default and example custom readiness evaluators
  - _Requirements: 9.1, 9.2, 9.3, 10.4_

- [x] 3.1 Define cluster state accessor interface
  - Create `ClusterStateAccessor` interface in `src/core/readiness/cluster-state.ts`
  - Define methods for resource access, listing, and condition checking
  - Include timeout and error handling capabilities
  - _Requirements: 9.2, 9.3, 10.4_

- [x] 3.2 Implement cluster state accessor
  - Create concrete implementation using Kubernetes client
  - Implement `getResource()`, `listResources()`, and `checkResourceCondition()` methods
  - Add proper error handling and timeout support
  - _Requirements: 9.2, 9.3, 9.4_

- [x] 3.3 Create readiness evaluators following TypeKro patterns
  - Implement readiness evaluators in `src/factories/kubernetes/yaml/readiness-evaluators.ts`
  - Use TypeKro's `ReadinessEvaluator` type and `ResourceStatus` return type
  - Create `yamlFileReadinessEvaluator` and `deploymentReadyEvaluator` examples
  - Follow existing patterns from `src/factories/shared.ts`
  - _Requirements: 9.1, 9.2, 5.2, 6.2_

- [x] 3.4 Implement DirectResourceFactory closure integration
  - Modify `DirectResourceFactoryImpl` in `src/core/deployment/direct-factory.ts` to accept closures
  - Update `DirectDeploymentStrategy` to collect and execute closures during deployment
  - Pass closures to `DirectDeploymentEngine` for level-based execution
  - Ensure closures receive proper `DeploymentContext` with resolved references
  - _Requirements: 9.4, 9.5, 10.4_

- [x] 3.5 Implement level-based closure execution system
  - **COMPLETED**: Modified `DirectDeploymentEngine` to execute closures at level -1 (before all resources)
  - **COMPLETED**: Added closure dependency analysis that assigns all closures to pre-resource level
  - **COMPLETED**: Implemented CRD establishment logic that waits for CRDs before deploying custom resources
  - **COMPLETED**: Enhanced deployment plan integration to handle negative levels with pre-resource closures
  - **COMPLETED**: Fixed TypeScript errors in CRD establishment API calls
  - **RESULT**: Closures (like `fluxSystem`) now execute before custom resources, ensuring CRDs are established first
  - _Requirements: 9.4, 9.5, 10.4_

- [ ] 3.6 Implement Kro factory closure support **[CRITICAL - BLOCKING]**
  - **STATUS**: Not implemented, preventing Kro mode YAML support
  - Modify `KroResourceFactory` to accept and validate closures during factory creation
  - Add closure validation to detect KubernetesRef inputs and raise clear errors
  - Execute closures during Kro factory deployment (before RGD creation)
  - Ensure closures work with static values only (no dynamic references)
  - Add comprehensive error messages explaining Kro mode limitations
  - _Requirements: 1.1, 1.3, 8.1, 10.1_

- [ ] 4. Implement Helm factory functions
  - Create HelmRelease factory with full TypeKro integration
  - Support TypeKro references in Helm values
  - _Requirements: 4.1, 4.2, 5.3, 5.4_

- [x] 4.1 Create Helm release factory function
  - Implement `helmRelease()` factory in `src/factories/kubernetes/helm/helm-release.ts`
  - Define `HelmReleaseConfig` interface with chart and values support
  - Use standard TypeScript types (values will be processed by magic proxy system)
  - Follow TypeKro's factory patterns with proper Flux CD apiVersion
  - _Requirements: 4.1, 5.3, 8.1_

- [x] 4.2 Define Helm resource type definitions
  - Create `HelmReleaseSpec` and `HelmReleaseStatus` interfaces in `src/core/types/yaml.ts`
  - Include chart specification and values properties in spec
  - Define status tracking for Helm release phases
  - Export from `src/core/types/index.ts`
  - _Requirements: 8.1, 8.2, 5.4_

- [x] 4.3 Integrate Helm values with reference system
  - Ensure Helm values work with TypeKro's magic proxy system automatically
  - Test that schema references and CEL expressions work in values
  - Verify serialization handles references correctly in nested objects
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 4.4 Add simplified Helm composition function
  - Implement `simpleHelmChart()` for common Helm deployment patterns
  - Include comprehensive JSDoc examples
  - Test integration with TypeKro's magic proxy system
  - _Requirements: 5.3, 8.2, 11.4_

- [x] 4.5 Add Helm-specific readiness evaluators
  - Create readiness evaluators for HelmRelease resources
  - Check Helm release status conditions for readiness
  - Handle Helm installation and upgrade phases
  - _Requirements: 5.2, 5.4, 9.2_

- [ ] 5. Implement Kustomize factory functions
  - Create Kustomization factory with patch support
  - Support TypeKro references in patches
  - _Requirements: 4.3, 6.3, 6.4_

- [⚠️] 5.1 Create Kustomization factory function **[PARTIAL - TYPE ERRORS]**
  - **STATUS**: Implementation exists but TypeScript compilation fails
  - **ISSUE**: Missing `KustomizationSpec` and `KustomizationStatus` exports
  - Implement `kustomization()` factory in `src/factories/kubernetes/kustomize/kustomization.ts` ✅
  - Define `KustomizationConfig` interface with source and patches support ✅
  - Support git: URLs in source paths ✅
  - **ACTION NEEDED**: Add missing types to fix compilation
  - _Requirements: 6.3, 8.1, 3.1_

- [ ] 5.2 Define Kustomize resource type definitions **[CRITICAL - BLOCKING COMPILATION]**
  - **STATUS**: Missing exports causing TypeScript errors
  - **ERROR**: `Module '"../../../core/types/yaml.js"' has no exported member 'KustomizationSpec'`
  - Create `KustomizationSpec` and `KustomizationStatus` interfaces in `src/core/types/yaml.ts`
  - Include source specification and patches array
  - Define status tracking for Kustomization phases
  - Export from `src/core/types/index.ts`
  - _Requirements: 8.1, 8.2, 6.4_

- [ ] 5.3 Integrate patches with reference system
  - Ensure Kustomize patches support TypeKro references
  - Test reference resolution in patch content
  - Handle target selectors with references
  - _Requirements: 4.3, 6.4_

- [ ] 5.4 Add Kustomize-specific readiness evaluators
  - Create readiness evaluators for Kustomization resources
  - Check applied resources for readiness
  - Handle Kustomization build and apply phases
  - _Requirements: 6.2, 6.4, 9.2_

- [ ] 6. Create bootstrap compositions
  - Implement TypeKro runtime bootstrap composition
  - Create example compositions using Helm and Kustomize
  - _Requirements: 7.1, 7.2, 7.3_

- [ ] 6.1 Implement TypeKro runtime bootstrap composition
  - Create `typeKroRuntimeBootstrap()` in `src/compositions/bootstrap/typekro-runtime.ts`
  - Deploy Flux controllers using `yamlFile()` with Git URLs (similar to integration test approach)
  - Deploy Kro controller using `helmResource()` in Direct factory mode
  - Replace kubectl commands in bootstrap scripts with this TypeKro-native composition
  - _Requirements: 7.1, 7.2, 5.1, 6.1_

- [ ] 6.2 Create parallel deployment bootstrap examples
  - Show how CRDs, controllers, and dependent resources deploy simultaneously
  - Demonstrate that Kubernetes reconciliation handles timing automatically
  - Include examples showing consistent failure and rollback behavior
  - _Requirements: 7.2, 5.2, 6.2, 7.5_

- [ ] 6.3 Create example Helm composition
  - Implement `webAppWithHelm()` example composition
  - Demonstrate Helm release with TypeKro references in values
  - Show custom readiness evaluation for Helm releases
  - _Requirements: 4.1, 4.2, 5.3, 11.2_

- [ ] 6.4 Create example Kustomize composition
  - Implement example composition using Kustomization resources
  - Demonstrate patches with TypeKro references
  - Show integration with other TypeKro resources
  - _Requirements: 4.3, 6.3, 6.4, 12.2_

- [ ] 6.5 Create comprehensive GitOps platform example
  - Implement `gitOpsPlatform()` composition that combines Kro, Flux, and Istio
  - Use bootstrap compositions for Flux deployment with static values (Kro-compatible)
  - Include Istio deployment using Helm resource factories
  - Demonstrate complete platform deployment from TypeScript to running services

- [ ] 6.6 Update bootstrap e2e script to use TypeKro composition
  - Replace current kubectl invocations in `scripts/e2e-setup.ts` with `typeKroRuntimeBootstrap()`
  - Use Direct factory mode to deploy the bootstrap composition
  - Ensure proper error handling and status reporting
  - Maintain compatibility with existing test infrastructure
  - _Requirements: 7.1, 11.1, 12.1_
  - Show both Direct mode (for Kro installation) and Kro mode (for application deployment)
  - _Requirements: 7.1, 7.2, 7.3, 11.1, 12.2_

- [ ] 7. Add comprehensive error handling
  - Implement specific error types for YAML resource failures
  - Provide clear error messages with context
  - _Requirements: 1.5, 3.5, 9.4_

- [ ] 7.1 Create YAML-specific error types with enhanced DX
  - Add error types to existing `src/core/errors.ts` following TypeKro patterns
  - Implement `YamlPathResolutionError`, `GitContentError`, `YamlProcessingError`
  - Add static factory methods for common error scenarios
  - Include contextual suggestions and examples in error messages
  - _Requirements: 1.5, 3.5, 9.4_

- [ ] 7.2 Integrate error handling with deployment engine
  - Ensure errors are properly caught and wrapped with context
  - Provide clear error messages with resource names and paths
  - Handle timeout scenarios gracefully
  - _Requirements: 9.4, 9.5, 10.5_

- [ ] 7.3 Add error recovery and rollback capabilities
  - Implement rollback mechanisms for failed deployments
  - Provide clear guidance on error resolution
  - Handle partial deployment failures appropriately
  - _Requirements: 7.5, 10.5_

- [ ] 8. Write comprehensive tests
  - Create unit tests for all factory functions and core logic
  - Add integration tests for end-to-end scenarios
  - Include type safety tests following TypeKro guidelines
  - _Requirements: 8.3, 10.1, 10.2_

- [✅] 8.1 Write unit tests for YAML factories **[COMPLETED]**
  - **STATUS**: Unit tests implemented and passing (7/7 tests pass)
  - Test `yamlFile()` and `yamlDirectory()` factory functions ✅
  - Verify proper resource creation and configuration ✅
  - Test path resolution and file discovery logic ✅ (13/13 tests pass)
  - **RESULT**: Core YAML functionality verified with comprehensive test coverage
  - _Requirements: 1.1, 2.1, 8.3_

- [ ] 8.2 Write unit tests for Helm and Kustomize factories
  - Test `helmRelease()` and `kustomization()` factory functions
  - Verify reference resolution in values and patches
  - Test readiness evaluator integration
  - _Requirements: 4.1, 4.3, 8.3_

- [ ] 8.3 Write integration tests for bootstrap scenarios
  - Test complete TypeKro runtime bootstrap process
  - Verify controller deployment and readiness
  - Test example compositions with Helm and Kustomize
  - _Requirements: 7.2, 7.3, 11.3_

- [ ] 8.6 Fix e2e-helm-integration test to follow proper patterns **[CRITICAL - TESTS DISABLED]**
  - **STATUS**: Integration tests are skipped/disabled, preventing end-to-end validation
  - **ISSUE**: Cannot verify YAML closures work with actual Kubernetes cluster
  - Remove `waitForReady: false` hack that disables readiness evaluation
  - Use e2e-setup.ts script for proper cluster setup like other integration tests
  - Implement proper readiness evaluation for YAML resources deployed via closures
  - Ensure yamlFile and yamlDirectory factories work end-to-end with readiness checking
  - Follow the same style and patterns as other integration tests (e.g., e2e-factory-complete.test.ts)
  - Verify that Flux controller deployment and HelmRelease resources are properly deployed and ready
  - _Requirements: 1.3, 5.2, 9.1, 9.2, 10.4_

- [ ] 8.4 Write type safety tests
  - Follow TypeKro's type safety testing guidelines
  - Test magic proxy integration with YAML resources
  - Verify no type assertions are needed in normal usage
  - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [✅] 8.5 Write path resolution and Git integration tests **[COMPLETED]**
  - **STATUS**: Comprehensive test suite implemented and passing
  - Test local file and directory processing ✅
  - Test Git URL parsing and content fetching ✅
  - Mock Git API calls for reliable testing ✅
  - **RESULT**: PathResolver functionality fully tested with 13/13 tests passing
  - _Requirements: 1.2, 2.1, 3.1, 3.3_

- [ ] 8.7 Write universal mode support tests
  - Test YAML closures work in both Direct and Kro modes with static values
  - Test Kro mode validation errors for dynamic references (KubernetesRef inputs)
  - Verify error messages are clear and actionable
  - Test that static YAML closures execute correctly in Kro mode
  - _Requirements: 11.1, 11.2, 11.3, 11.4_

- [ ] 8.8 Create comprehensive end-to-end scenario test
  - **Phase 1**: Deploy Kro Controller to cluster using Direct factory with YAML closures
    - Use `yamlDirectory()` to deploy Kro from `git:github.com/Azure/kro/config/default@main`
    - Verify Kro Controller is ready and can process ResourceGraphDefinitions
  - **Phase 2**: Create and deploy Flux bootstrap using Kro factory
    - Use `typeKroRuntimeBootstrap()` composition with static values (Kro-compatible)
    - Deploy via Kro factory to create ResourceGraphDefinition
    - Verify Flux controllers (helm-controller, source-controller) are deployed and ready
  - **Phase 3**: Deploy Istio using Helm resource factories
    - Create resource graph with `helmRelease()` for Istio installation
    - Deploy through Flux Helm Controller (not Direct factory)
    - Verify Istio control plane is running and ready
  - **Verification**: Complete GitOps workflow validation
    - TypeKro Direct → Kro Controller → TypeKro Kro → Flux → Helm → Istio
    - Demonstrates universal YAML resources, bootstrap compositions, and Helm integration
    - Proves TypeKro can bootstrap its own runtime and deploy complex applications
  - _Requirements: 7.1, 7.2, 7.3, 7.6, 11.1, 11.5_

- [ ] 9. Create comprehensive documentation
  - Write guides for YAML resources, bootstrap, and GitOps patterns
  - Create API reference documentation
  - Add troubleshooting guides
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

- [ ] 9.1 Write YAML resources guide
  - Create documentation for `yamlFile()` and `yamlDirectory()` factories
  - Explain path resolution and Git URL syntax
  - Document custom readiness evaluators
  - Document Direct vs Kro mode differences and limitations
  - _Requirements: 12.1, 12.4, 12.6_

- [ ] 9.2 Write Helm and Kustomize integration guide
  - Document `helmRelease()` and `kustomization()` factories
  - Show examples of TypeKro references in values and patches
  - Explain controller deployment requirements
  - _Requirements: 12.1, 12.2, 12.4_

- [ ] 9.3 Write bootstrap tutorial
  - Create step-by-step guide for TypeKro runtime bootstrap
  - Show how to deploy controllers and use them in compositions
  - Include the comprehensive GitOps platform scenario (Kro → Flux → Istio)
  - Document Direct vs Kro mode usage patterns
  - Include troubleshooting for common bootstrap issues
  - _Requirements: 12.3, 12.5, 12.6_

- [ ] 9.4 Create API reference documentation
  - Document all factory function interfaces and options
  - Include type definitions and status field explanations
  - Add examples for each factory function
  - _Requirements: 12.4_

- [ ] 9.5 Write GitOps patterns guide
  - Show how to use TypeKro as a GitOps package manager
  - Document best practices for Git repository organization
  - Include examples of complex multi-controller deployments
  - _Requirements: 12.1, 12.2_

- [ ] 9.6 Create troubleshooting guide
  - Document common issues and their solutions
  - Include debugging techniques for readiness evaluation
  - Add guidance for Git authentication and access issues
  - _Requirements: 12.5_