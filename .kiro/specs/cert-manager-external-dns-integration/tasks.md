# Implementation Plan

- [x] 1. Set up cert-manager and external-dns ecosystem directory structures and core types with immediate integration test scaffolds
  - Create directory structures following established factory ecosystem pattern
  - Define comprehensive TypeScript interfaces for cert-manager and external-dns configuration and status
  - **IMMEDIATELY** create integration test scaffolds for all planned functionality
  - Set up proper exports and index files
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 10.1, 10.2, 10.3, 10.4_

- [x] 1.1 Create cert-manager factory directory structure with integration test scaffolds
  - Create `src/factories/cert-manager/` directory with subdirectories
  - Create index files for proper module organization
  - **IMMEDIATELY** create `test/integration/cert-manager/` directory with test scaffolds
  - Set up TypeScript configuration for the new ecosystem
  - _Requirements: 5.1, 5.2, 10.1_

- [x] 1.2 Create external-dns factory directory structure with integration test scaffolds
  - Create `src/factories/external-dns/` directory with subdirectories
  - Create index files for proper module organization
  - **IMMEDIATELY** create `test/integration/external-dns/` directory with test scaffolds
  - Set up TypeScript configuration for the new ecosystem
  - _Requirements: 5.1, 5.2, 10.1_

- [x] 1.3 Define comprehensive cert-manager type definitions
  - Create `src/factories/cert-manager/types.ts` with comprehensive interfaces
  - Define CertManagerBootstrapConfig and CertManagerBootstrapStatus interfaces using actual resource status fields
  - Define Certificate, ClusterIssuer, Issuer, Challenge, Order interfaces following cert-manager.io/v1 API
  - Define common types used across cert-manager resources
  - _Requirements: 6.1, 6.2, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9_

- [x] 1.4 Define comprehensive external-dns type definitions
  - Create `src/factories/external-dns/types.ts` with comprehensive interfaces
  - Define ExternalDnsBootstrapConfig and ExternalDnsBootstrapStatus interfaces using actual resource status fields
  - Define DNS provider configuration interfaces for all major providers
  - Define common types used across external-dns resources
  - _Requirements: 6.1, 6.2, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_

- [x] 1.5 Set up exports and module structure for both ecosystems
  - Create main export files for both cert-manager and external-dns following Cilium pattern
  - Update `src/factories/index.ts` to include both ecosystems (add after Cilium section)
  - Ensure proper TypeScript module resolution and follow established export patterns
  - Follow the same structure as `src/factories/cilium/index.ts` for consistency
  - _Requirements: 5.5, 5.6_

- [x] 2. Implement cert-manager Helm integration wrappers with type safety and early integration testing
  - Create typed wrappers around existing `helmRepository` and `helmRelease` factories
  - Add cert-manager-specific configurations and reuse existing readiness evaluators
  - Implement comprehensive Helm values mapping system with validation
  - **CRITICAL**: Write integration tests BEFORE implementing factories
  - **QUALITY GATES**: All TypeScript compilation must pass without errors (`bun run typecheck`)
  - **TESTING REQUIREMENTS**: Integration tests in `test/integration/cert-manager/` using both `kro` and `direct` factories with `.deploy()` method
  - **SETUP**: Use `bun run test:integration` and `scripts/e2e-setup.sh` for test environment
  - **LESSONS LEARNED**: 
    - Always run integration tests successfully before marking tasks complete
    - Cluster networking issues (like Cilium operator replica conflicts) can cause DNS resolution failures
    - Status builders with complex resource references need careful handling in tests
    - Use direct kubectl deployment in tests when factory patterns are too complex
    - Validate both TypeScript compilation AND actual test execution
  - Test with real Helm deployments in test clusters
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_

- [x] 2.1 Create cert-manager HelmRepository wrapper with type safety and early testing
  - **FIRST**: Write integration test scaffold for cert-manager HelmRepository deployment
  - Create wrapper around existing `helmRepository` factory in `resources/helm.ts` following Cilium pattern
  - Add cert-manager-specific default configuration (official cert-manager chart repository URL: https://charts.jetstack.io)
  - Add type-safe configuration interface for cert-manager repository settings
  - Use `createResource` from `shared.ts` and embed readiness evaluator in same file
  - **QUALITY GATES**: `bun run typecheck` must pass without errors
  - **TESTING REQUIREMENTS**: 
    - Integration tests in `test/integration/cert-manager/` testing actual HelmRepository creation
    - Test both `kro` and `direct` factory patterns using `.deploy()` method
    - Use `scripts/e2e-setup.sh` for test cluster setup
  - Test with real HelmRepository creation and readiness evaluation
  - _Requirements: 1.1, 11.1_

- [x] 2.2 Create cert-manager HelmRelease wrapper with type safety and early testing
  - **FIRST**: Write integration test scaffold for cert-manager HelmRelease deployment
  - Create wrapper around existing `helmRelease` factory in `resources/helm.ts`
  - Add cert-manager-specific default configuration (chart name, repository reference)
  - Add type-safe configuration interface for cert-manager Helm values
  - Reuse existing `helmReleaseReadinessEvaluator` from Helm factories
  - **QUALITY GATES**: `bun run typecheck` must pass without errors
  - **TESTING REQUIREMENTS**: 
    - Integration tests in `test/integration/cert-manager/` testing actual HelmRelease deployment
    - Test both `kro` and `direct` factory patterns using `.deploy()` method
    - Use `scripts/e2e-setup.sh` for test cluster setup
    - Validate complete cert-manager deployment and readiness evaluation
  - Test complete cert-manager deployment and readiness evaluation in test cluster
  - _Requirements: 1.1, 1.4, 11.1, 11.2_

- [x] 2.3 Implement comprehensive cert-manager Helm values mapping system with validation and testing
  - **FIRST**: Write integration test scaffolds for various cert-manager configurations
  - Create system to map TypeKro configuration to cert-manager Helm values
  - Implement default values matching cert-manager chart defaults
  - Add comprehensive validation for all configuration options
  - Handle CRD installation separately (following cert-manager best practices)
  - **QUALITY GATES**: `bun run typecheck` must pass without errors
  - **TESTING REQUIREMENTS**: 
    - Integration tests in `test/integration/cert-manager/` testing actual Helm deployments with various configurations
    - Test both `kro` and `direct` factory patterns using `.deploy()` method
    - Use `scripts/e2e-setup.sh` for test cluster setup
  - Test with various configuration scenarios and validate generated Helm values
  - Test actual cert-manager deployments with different configurations
  - _Requirements: 1.2, 1.3, 6.1, 11.3, 11.4_

- [x] 3. Implement external-dns Helm integration wrappers with type safety and early integration testing
  - Create typed wrappers around existing `helmRepository` and `helmRelease` factories
  - Add external-dns-specific configurations and reuse existing readiness evaluators
  - Implement comprehensive DNS provider configuration system with validation
  - **CRITICAL**: Write integration tests BEFORE implementing factories
  - **QUALITY GATES**: All TypeScript compilation must pass without errors (`bun run typecheck`)
  - **TESTING REQUIREMENTS**: Integration tests in `test/integration/external-dns/` using both `kro` and `direct` factories with `.deploy()` method
  - **SETUP**: Use `bun run test:integration` and `scripts/e2e-setup.sh` for test environment
  - Test with real Helm deployments in test clusters
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_

- [x] 3.1 Create external-dns HelmRepository wrapper with type safety and early testing
  - **FIRST**: Write integration test scaffold for external-dns HelmRepository deployment
  - Create wrapper around existing `helmRepository` factory in `resources/helm.ts`
  - Add external-dns-specific default configuration (official external-dns chart repository URL)
  - Add type-safe configuration interface for external-dns repository settings
  - Reuse existing `helmRepositoryReadinessEvaluator` from Helm factories
  - **QUALITY GATES**: `bun run typecheck` must pass without errors
  - **TESTING REQUIREMENTS**: 
    - Integration tests in `test/integration/external-dns/` testing actual HelmRepository creation
    - Test both `kro` and `direct` factory patterns using `.deploy()` method
    - Use `scripts/e2e-setup.sh` for test cluster setup
  - Test with real HelmRepository creation and readiness evaluation
  - _Requirements: 2.1, 12.1_

- [x] 3.2 Create external-dns HelmRelease wrapper with type safety and early testing
  - **FIRST**: Write integration test scaffold for external-dns HelmRelease deployment
  - Create wrapper around existing `helmRelease` factory in `resources/helm.ts`
  - Add external-dns-specific default configuration (chart name, repository reference)
  - Add type-safe configuration interface for external-dns Helm values
  - Reuse existing `helmReleaseReadinessEvaluator` from Helm factories
  - **QUALITY GATES**: `bun run typecheck` must pass without errors
  - **TESTING REQUIREMENTS**: 
    - Integration tests in `test/integration/external-dns/` testing actual HelmRelease deployment
    - Test both `kro` and `direct` factory patterns using `.deploy()` method
    - Use `scripts/e2e-setup.sh` for test cluster setup
    - Validate complete external-dns deployment and readiness evaluation
  - Test complete external-dns deployment and readiness evaluation in test cluster
  - _Requirements: 2.1, 2.4, 12.1, 12.2_

- [x] 3.3 Implement comprehensive external-dns provider configuration system with validation and testing
  - **FIRST**: Write integration test scaffolds for various DNS provider configurations
  - Create system to map TypeKro configuration to external-dns Helm values using new provider.{name}.{key} structure
  - Implement default values matching external-dns chart defaults
  - Add comprehensive validation for all DNS provider options
  - Support major DNS providers (AWS Route53, Cloudflare, Google DNS, Azure DNS)
  - **QUALITY GATES**: `bun run typecheck` must pass without errors
  - **TESTING REQUIREMENTS**: 
    - Integration tests in `test/integration/external-dns/` testing actual Helm deployments with various provider configurations
    - Test both `kro` and `direct` factory patterns using `.deploy()` method
    - Use `scripts/e2e-setup.sh` for test cluster setup
  - Test with various provider scenarios and validate generated Helm values
  - Test actual external-dns deployments with different DNS providers
  - _Requirements: 2.2, 2.3, 6.1, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_

- [ ] 4. Create comprehensive cert-manager bootstrap composition with early integration testing
  - Implement complete bootstrap composition using kubernetesComposition
  - Add comprehensive configuration schema with ArkType integration
  - Implement CEL-based status expressions using actual resource status fields for integration points
  - **CRITICAL**: Write integration tests BEFORE implementing composition
  - **QUALITY GATES**: All TypeScript compilation must pass without errors (`bun run typecheck`)
  - **TESTING REQUIREMENTS**: Integration tests in `test/integration/cert-manager/` using both `kro` and `direct` factories with `.deploy()` method
  - **SETUP**: Use `bun run test:integration` and `scripts/e2e-setup.sh` for test environment
  - Test with real cert-manager deployments and validate all status outputs derived from actual resource status
  - _Requirements: 1.1, 1.6, 1.7, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8_

- [x] 4.1 Implement comprehensive CertManagerBootstrapConfig schema with ArkType integration
  - **FIRST**: Write integration test scaffolds for cert-manager bootstrap composition
  - Define comprehensive configuration interface covering all major Helm values
  - Create ArkType schemas for both spec and status interfaces following KroCompatibleType constraints
  - **CRITICAL**: Ensure schemas use only supported types (string, number, boolean, nested objects, optional fields with '?')
  - **CRITICAL**: Avoid complex union types, functions, or arbitrary objects (see schema-compatibility-guide.md)
  - Include controller, webhook, cainjector, and monitoring options
  - Add proper TypeScript validation and default value handling
  - Test schema validation with various configuration scenarios
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9_

- [x] 4.2 Implement cert-manager bootstrap composition function with kubernetesComposition
  - Create `certManagerBootstrap` composition using kubernetesComposition pattern
  - Implement resource creation (HelmRepository and HelmRelease) with proper IDs
  - Add comprehensive Helm values mapping from configuration schema
  - Test composition creation and resource generation
  - _Requirements: 1.1, 1.4, 1.5_

- [x] 4.3 Implement comprehensive CEL-based status expressions using actual resource status fields
  - Create CEL-based status expressions for all integration points using actual resource status
  - Expose webhook endpoints from actual webhook service status: `https://${webhookService.status.clusterIP}:10250/mutate`
  - Expose metrics endpoints from actual controller service status: `http://${controllerService.status.clusterIP}:9402/metrics`
  - Expose health endpoints from actual deployment status: `http://${controllerService.status.clusterIP}:9402/healthz`
  - **CRITICAL**: Use JavaScript expressions that auto-convert to CEL (no manual CEL.expr unless necessary)
  - **CRITICAL**: Follow status-driven approach - derive all endpoints from actual resource status fields
  - Test status expression generation and CEL conversion
  - Test with real cert-manager deployments to validate status accuracy
  - _Requirements: 1.6, 1.7, 8.6_

- [x] 4.4 Test cert-manager bootstrap composition end-to-end with real deployments
  - Test complete cert-manager deployment using the bootstrap composition
  - Validate all configuration options work with real Helm deployments
  - Test status expressions with live cert-manager installations using actual resource status
  - Validate integration points are accessible and functional
  - **QUALITY GATES**: `bun run typecheck` must pass without errors
  - **TESTING REQUIREMENTS**: 
    - Integration tests in `test/integration/cert-manager/` testing complete bootstrap composition
    - Test both `kro` and `direct` factory patterns using `.deploy()` method
    - Use `scripts/e2e-setup.sh` for test cluster setup
    - **CRITICAL**: Test with `waitForReady: true` (no shortcuts)
  - Test composition readiness based on underlying resource readiness
  - _Requirements: 4.1, 4.6, 4.7, 1.5_

- [x] 5. Create comprehensive external-dns bootstrap composition with early integration testing
  - Implement complete bootstrap composition using kubernetesComposition
  - Add comprehensive configuration schema with ArkType integration
  - Implement CEL-based status expressions using actual resource status fields for integration points
  - **CRITICAL**: Write integration tests BEFORE implementing composition
  - **QUALITY GATES**: All TypeScript compilation must pass without errors (`bun run typecheck`)
  - **TESTING REQUIREMENTS**: Integration tests in `test/integration/external-dns/` using both `kro` and `direct` factories with `.deploy()` method
  - **SETUP**: Use `bun run test:integration` and `scripts/e2e-setup.sh` for test environment
  - Test with real external-dns deployments and validate all status outputs derived from actual resource status
  - _Requirements: 2.1, 2.6, 2.7, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_

- [x] 5.1 Implement comprehensive ExternalDnsBootstrapConfig schema with ArkType integration
  - **FIRST**: Write integration test scaffolds for external-dns bootstrap composition
  - Define comprehensive configuration interface covering all major Helm values
  - Create ArkType schemas for both spec and status interfaces
  - Include provider configuration, domain filters, ownership settings, and monitoring options
  - Add proper TypeScript validation and default value handling
  - Test schema validation with various configuration scenarios
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_

- [x] 5.2 Implement external-dns bootstrap composition function with kubernetesComposition
  - Create `externalDnsBootstrap` composition using kubernetesComposition pattern
  - Implement resource creation (HelmRepository and HelmRelease) with proper IDs
  - Add comprehensive Helm values mapping from configuration schema
  - Test composition creation and resource generation
  - _Requirements: 2.1, 2.4, 2.5_

- [x] 5.3 Implement comprehensive CEL-based status expressions using actual resource status fields
  - Create CEL-based status expressions for all integration points using actual resource status
  - Expose metrics endpoints from actual external-dns service status
  - Expose health endpoints from actual deployment status
  - Expose DNS management status from actual external-dns metrics
  - Implement sophisticated status logic using Cel.expr and Cel.template
  - Test status expression generation and CEL conversion
  - Test with real external-dns deployments to validate status accuracy
  - _Requirements: 2.6, 2.7, 8.6_

- [x] 5.4 Test external-dns bootstrap composition end-to-end with real deployments
  - Test complete external-dns deployment using the bootstrap composition
  - Validate all configuration options work with real Helm deployments
  - Test status expressions with live external-dns installations using actual resource status
  - Validate integration points are accessible and functional
  - **QUALITY GATES**: `bun run typecheck` must pass without errors
  - **TESTING REQUIREMENTS**: 
    - Integration tests in `test/integration/external-dns/` testing complete bootstrap composition
    - Test both `kro` and `direct` factory patterns using `.deploy()` method
    - Use `scripts/e2e-setup.sh` for test cluster setup
    - **CRITICAL**: Test with `waitForReady: true` (no shortcuts)
  - Test composition readiness based on underlying resource readiness
  - _Requirements: 4.1, 4.6, 4.7, 2.5_

- [ ] 6. Implement cert-manager CRD factories with embedded readiness evaluators and early integration testing
  - Create factory functions for Certificate, ClusterIssuer, Issuer, Challenge, Order in respective resource files
  - Embed readiness evaluators in the same files as factory functions
  - **CRITICAL**: Write integration tests BEFORE implementing factories
  - Test with real certificate issuance and validation
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 4.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8_

- [x] 6.1 Create Certificate factory with embedded readiness evaluator and early testing
  - **FIRST**: Write integration test scaffolds for Certificate resource deployment
  - Implement factory function with comprehensive spec interface in `resources/certificates.ts`
  - Use `createResource` from `shared.ts` and follow established factory patterns
  - Embed readiness evaluator function in the same file (check Certificate status conditions)
  - Add proper validation for certificate fields and lifecycle following cert-manager.io/v1 API
  - Include support for all certificate types (TLS, client auth, code signing, etc.)
  - Test with real Certificate creation and certificate issuance validation using Let's Encrypt staging
  - Test readiness evaluation with actual certificate lifecycle events
  - _Requirements: 3.2, 6.1, 6.2, 4.2_

- [x] 6.2 Create ClusterIssuer factory with embedded readiness evaluator and early testing
  - **FIRST**: Write integration test scaffolds for ClusterIssuer resource deployment
  - Implement factory function for cluster-wide certificate issuers in `resources/issuers.ts`
  - Embed readiness evaluator function in the same file
  - Add support for all issuer types (ACME, CA, Vault, Venafi, self-signed)
  - Include comprehensive ACME solver configuration (HTTP01, DNS01)
  - Test with real ClusterIssuer creation and ACME account registration
  - Test readiness evaluation with actual issuer registration status
  - _Requirements: 3.3, 6.1, 6.2, 4.2, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8_

- [x] 6.3 Create Issuer factory with embedded readiness evaluator and early testing
  - **FIRST**: Write integration test scaffolds for Issuer resource deployment
  - Implement factory function for namespace-scoped certificate issuers in `resources/issuers.ts`
  - Embed readiness evaluator function in the same file
  - Add support for all issuer types with namespace-scoped configuration
  - Test with real Issuer creation and certificate authority integration
  - Test readiness evaluation with actual issuer status
  - _Requirements: 3.4, 6.1, 6.2, 4.2_

- [x] 6.4 Create Challenge factory with embedded readiness evaluator and early testing
  - **FIRST**: Write integration test scaffolds for Challenge resource deployment
  - Implement factory function for ACME challenges in `resources/challenges.ts`
  - Embed readiness evaluator function in the same file
  - Add support for both HTTP01 and DNS01 challenge types
  - Test with real Challenge creation and ACME challenge completion
  - Test readiness evaluation with actual challenge completion status
  - _Requirements: 3.6, 6.1, 6.2, 4.2_

- [x] 6.5 Create Order factory with embedded readiness evaluator and early testing
  - **FIRST**: Write integration test scaffolds for Order resource deployment
  - Implement factory function for ACME orders in `resources/challenges.ts`
  - Embed readiness evaluator function in the same file
  - Add support for order lifecycle tracking and management
  - Test with real Order creation and ACME order fulfillment
  - Test readiness evaluation with actual order completion status
  - _Requirements: 3.7, 6.1, 6.2, 4.2_

- [x] 6.6 Test cert-manager CRD resources integration with TypeKro features
  - Test cert-manager resources with kubernetesComposition integration
  - Test cross-resource references and dependency resolution
  - Test serialization to YAML and ResourceGraphDefinitions
  - Validate cert-manager resources work with both direct and Kro deployment
  - Test with real certificate issuance scenarios and validate certificate validity
  - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ] 7. Implement comprehensive webapp integration composition with early integration testing
  - Create complete webapp composition demonstrating cert-manager + external-dns integration
  - **CRITICAL**: Write integration tests BEFORE implementing composition
  - Test with real web applications, certificate issuance, and DNS record management
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10_

- [ ] 7.1 Create webapp integration composition types and schema
  - **FIRST**: Write integration test scaffolds for webapp composition
  - Define WebappWithCertsConfig and WebappWithCertsStatus interfaces
  - Create ArkType schemas for webapp composition
  - Include application, certificate, DNS, and ingress configuration
  - Test schema validation with various webapp scenarios
  - _Requirements: 9.1, 9.2, 9.3_

- [ ] 7.2 Implement webapp composition function with cert-manager and external-dns integration
  - Create `webappWithCerts` composition using kubernetesComposition pattern
  - Integrate cert-manager bootstrap for certificate management
  - Integrate external-dns bootstrap for DNS record management
  - Create application deployment, service, and ingress resources
  - Implement automatic certificate issuance and DNS record creation
  - Test composition creation and resource generation
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [ ] 7.3 Implement comprehensive status expressions using actual resource status fields
  - Create CEL-based status expressions for all webapp components using actual resource status
  - Expose application readiness from actual deployment status
  - Expose certificate validity from actual certificate status
  - Expose DNS propagation from actual external-dns status
  - Expose ingress readiness from actual ingress status
  - Test status expression generation and CEL conversion
  - _Requirements: 9.7, 9.8, 9.9, 9.10_

- [ ] 7.4 Test webapp composition end-to-end with real deployments
  - Test complete webapp deployment using the composition
  - Validate automatic certificate issuance with Let's Encrypt staging
  - Validate automatic DNS record creation and propagation
  - Test HTTPS connectivity and certificate validity
  - Test certificate renewal scenarios
  - **QUALITY GATES**: `bun run typecheck` must pass without errors
  - **TESTING REQUIREMENTS**: 
    - Integration tests in `test/integration/webapp/` testing complete webapp composition
    - Test both `kro` and `direct` factory patterns using `.deploy()` method
    - Use `scripts/e2e-setup.sh` for test cluster setup
    - **CRITICAL**: Test with `waitForReady: true` (no shortcuts)
  - Test with real web applications and validate end-to-end functionality
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10_

- [ ] 8. Integrate with existing TypeKro features and validate dual deployment strategies
  - Ensure cert-manager and external-dns resources work with kubernetesComposition and toResourceGraph
  - Test serialization to YAML and ResourceGraphDefinitions
  - Validate dependency resolution and cross-resource references
  - **CRITICAL**: Validate both kro and direct deployment strategies work throughout
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

- [ ] 8.1 Test kubernetesComposition integration
  - Create comprehensive tests for cert-manager and external-dns resources in compositions
  - Validate CEL expression generation and status mapping using actual resource status
  - Test cross-resource references and dependency resolution
  - _Requirements: 8.1, 8.6_

- [ ] 8.2 Test toResourceGraph integration
  - Ensure cert-manager and external-dns resources work with declarative API pattern
  - Validate resource builder and status builder integration
  - Test schema proxy functionality with cert-manager and external-dns resources
  - _Requirements: 8.8, 8.6_

- [ ] 8.3 Test serialization and deployment with both strategies
  - Validate YAML generation for all cert-manager and external-dns resources
  - Test direct deployment and Kro deployment strategies
  - Ensure proper ResourceGraphDefinition generation
  - **CRITICAL**: Validate both deployment strategies work correctly
  - _Requirements: 8.2, 8.3, 8.4_

- [ ] 8.4 Test factory pattern integration
  - Validate cert-manager and external-dns compositions work as reusable factories
  - Test factory input/output type safety
  - Ensure proper integration with existing factory patterns
  - _Requirements: 8.7_

- [ ] 9. Add comprehensive documentation and examples with real deployment scenarios
  - Create clear API documentation for all cert-manager and external-dns functions
  - Add practical examples for common use cases
  - Document integration patterns with other systems
  - Include real-world deployment scenarios and troubleshooting guides
  - _Requirements: 10.1, 10.2, 10.3, 10.4_

- [ ] 9.1 Create API documentation
  - Add JSDoc documentation for all public functions
  - Document configuration options and status outputs
  - Include type information and usage examples
  - _Requirements: 10.3_

- [ ] 9.2 Create bootstrap composition examples
  - Add examples for common cert-manager and external-dns deployment scenarios
  - Include different configuration patterns and use cases
  - Document best practices and recommended settings
  - _Requirements: 10.1_

- [ ] 9.3 Create webapp integration examples
  - Add comprehensive examples for webapp composition
  - Include different certificate authorities and DNS providers
  - Document end-to-end deployment scenarios
  - _Requirements: 10.2_

- [ ] 9.4 Create troubleshooting and best practices documentation
  - Document common issues and solutions
  - Include performance optimization guidelines
  - Add security best practices for certificate and DNS management
  - Document migration guides from other certificate management solutions
  - _Requirements: 10.4_

- [ ] 10. Finalize ecosystem template and validate template quality
  - Complete comprehensive documentation with real examples
  - Finalize template structure for future ecosystem integrations
  - Create migration guides and best practices documentation
  - Validate that the implementation serves as a high-quality template
  - _Requirements: 5.8_

- [ ] 10.1 Validate template structure and patterns
  - Ensure directory structure follows established patterns
  - Validate that embedded readiness evaluators pattern is consistent
  - Confirm that early integration testing approach is documented
  - Verify that status-driven endpoints pattern is established
  - _Requirements: 5.8_

- [ ] 10.2 Create ecosystem integration template documentation
  - Document the complete process for adding new ecosystems
  - Include lessons learned from cert-manager and external-dns implementation
  - Provide step-by-step guide for future ecosystem integrations
  - Document testing strategies and quality gates
  - _Requirements: 5.8_

- [ ] 10.3 Validate production readiness
  - Ensure all components meet production quality standards
  - Validate performance characteristics
  - Confirm security best practices are followed
  - Test with realistic production scenarios
  - _Requirements: All non-functional requirements_

- [ ] 10.4 Create final validation and acceptance tests
  - Run comprehensive end-to-end tests with real deployments
  - Validate all requirements are met
  - Test with multiple DNS providers and certificate authorities
  - Confirm webapp composition works in realistic scenarios
  - **CRITICAL VALIDATION CHECKLIST**:
    - All factories use `createResource` from `shared.ts`
    - All readiness evaluators are embedded in factory files (not separate files)
    - All ArkType schemas follow KroCompatibleType constraints
    - All status expressions use actual resource status fields (not inferred values)
    - All integration tests use `.deploy()` method with both kro and direct strategies
    - All exports follow established patterns from Cilium ecosystem
  - Document any limitations or known issues
  - _Requirements: All requirements_