# Implementation Plan

- [x] 1. Set up Cilium ecosystem directory structure and core types
  - Create directory structure following established factory ecosystem pattern
  - Define core TypeScript interfaces for Cilium configuration and status
  - Set up proper exports and index files
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 1.1 Create Cilium factory directory structure
  - Create `src/factories/cilium/` directory with subdirectories
  - Create index files for proper module organization
  - Set up TypeScript configuration for the new ecosystem
  - _Requirements: 4.1, 4.2_

- [x] 1.2 Define core Cilium type definitions
  - Create `src/factories/cilium/types.ts` with comprehensive interfaces
  - Define CiliumBootstrapConfig and CiliumBootstrapStatus interfaces
  - Define common types used across Cilium resources (LabelSelector, etc.)
  - _Requirements: 5.1, 5.2, 6.1, 6.2_

- [x] 1.3 Set up Cilium exports and module structure
  - Create main `src/factories/cilium/index.ts` export file
  - Update `src/factories/index.ts` to include Cilium ecosystem
  - Ensure proper TypeScript module resolution
  - _Requirements: 4.5, 4.6_

- [x] 2. Implement Cilium Helm integration wrappers with type safety and end-to-end testing
  - Create typed wrappers around existing `helmRepository` and `helmRelease` factories
  - Add Cilium-specific configurations and reuse existing readiness evaluators
  - Implement comprehensive Helm values mapping system with validation
  - **QUALITY GATES**: All TypeScript compilation must pass without errors (`bun run typecheck`)
  - **TESTING REQUIREMENTS**: Integration tests in `test/integration/cilium/` using both `kro` and `direct` factories with `.deploy()` method
  - **SETUP**: Use `bun run test:integration` and `scripts/e2e-setup.sh` for test environment
  - Test with real Helm deployments in test clusters
  - _Requirements: 1.1, 1.2, 1.3, 3.1_

- [x] 2.1 Create Cilium HelmRepository wrapper with type safety and testing
  - Create wrapper around existing `helmRepository` factory in `resources/helm.ts`
  - Add Cilium-specific default configuration (official Cilium chart repository URL)
  - Add type-safe configuration interface for Cilium repository settings
  - Reuse existing `helmRepositoryReadinessEvaluator` from Helm factories
  - **a**: `bun run typecheck` must pass without errors
  - **TESTING REQUIREMENTS**: 
    - Unit tests in `test/factories/cilium/` for wrapper functionality
    - Integration tests in `test/integration/cilium/` testing actual HelmRepository creation
    - Test both `kro` and `direct` factory patterns using `.deploy()` method
    - Use `scripts/e2e-setup.sh` for test cluster setup
  - Test with real HelmRepository creation and readiness evaluation
  - _Requirements: 1.1, 3.1_

- [x] 2.2 Create Cilium HelmRelease wrapper with type safety and end-to-end testing
  - Create wrapper around existing `helmRelease` factory in `resources/helm.ts`
  - Add Cilium-specific default configuration (chart name, repository reference)
  - Add type-safe configuration interface for Cilium Helm values
  - Reuse existing `helmReleaseReadinessEvaluator` from Helm factories
  - **QUALITY GATES**: `bun run typecheck` must pass without errors
  - **TESTING REQUIREMENTS**: 
    - Unit tests in `test/factories/cilium/` for wrapper functionality
    - Integration tests in `test/integration/cilium/` testing actual HelmRelease deployment
    - Test both `kro` and `direct` factory patterns using `.deploy()` method
    - Use `scripts/e2e-setup.sh` for test cluster setup
    - Validate complete Cilium deployment and readiness evaluation
  - Test complete Cilium deployment and readiness evaluation in test cluster
  - _Requirements: 1.1, 1.4, 3.1_

- [ ] 2.3 Implement comprehensive Helm values mapping system with validation and testing
  - Create system to map TypeKro configuration to Helm values
  - Implement default values matching Cilium chart defaults
  - Add comprehensive validation for all configuration options
  - **QUALITY GATES**: `bun run typecheck` must pass without errors
  - **TESTING REQUIREMENTS**: 
    - Unit tests in `test/factories/cilium/` for mapping and validation functions
    - Integration tests in `test/integration/cilium/` testing actual Helm deployments with various configurations
    - Test both `kro` and `direct` factory patterns using `.deploy()` method
    - Use `scripts/e2e-setup.sh` for test cluster setup
  - Test with various configuration scenarios and validate generated Helm values
  - Test actual Cilium deployments with different configurations
  - _Requirements: 1.2, 1.3, 5.1_

- [ ] 3. Create comprehensive Cilium bootstrap composition with end-to-end testing
  - Implement complete bootstrap composition using kubernetesComposition
  - Add comprehensive configuration schema with ArkType integration
  - Implement CEL-based status expressions for integration points
  - **QUALITY GATES**: All TypeScript compilation must pass without errors (`bun run typecheck`)
  - **TESTING REQUIREMENTS**: Integration tests in `test/integration/cilium/` using both `kro` and `direct` factories with `.deploy()` method
  - **SETUP**: Use `bun run test:integration` and `scripts/e2e-setup.sh` for test environment
  - Test with real Cilium deployments and validate all status outputs
  - _Requirements: 1.1, 1.6, 1.7, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10_

- [-] 3.1 Implement comprehensive CiliumBootstrapConfig schema with ArkType integration
  - Define comprehensive configuration interface covering all major Helm values
  - Create ArkType schemas for both spec and status interfaces
  - Include cluster, networking, security, BGP, Gateway API, and observability options
  - Add proper TypeScript validation and default value handling
  - Test schema validation with various configuration scenarios
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10_

- [-] 3.2 Implement bootstrap composition function with kubernetesComposition
  - Create `ciliumBootstrap` composition using kubernetesComposition pattern
  - Implement resource creation (HelmRepository and HelmRelease) with proper IDs
  - Add comprehensive Helm values mapping from configuration schema
  - Test composition creation and resource generation
  - _Requirements: 1.1, 1.4, 1.5_

- [ ] 3.3 Implement comprehensive CEL-based status expressions with testing
  - Create CEL-based status expressions for all integration points
  - Expose health endpoints, metrics endpoints, socket paths, and readiness states
  - Implement sophisticated status logic using Cel.expr and Cel.template
  - Test status expression generation and CEL conversion
  - Test with real Cilium deployments to validate status accuracy
  - _Requirements: 1.6, 1.7, 7.6_

- [ ] 3.4 Test bootstrap composition end-to-end with real deployments
  - Test complete Cilium deployment using the bootstrap composition
  - Validate all configuration options work with real Helm deployments
  - Test status expressions with live Cilium installations
  - Validate integration points are accessible and functional
  - **QUALITY GATES**: `bun run typecheck` must pass without errors
  - **TESTING REQUIREMENTS**: 
    - Integration tests in `test/integration/cilium/` testing complete bootstrap composition
    - Test both `kro` and `direct` factory patterns using `.deploy()` method
    - Use `scripts/e2e-setup.sh` for test cluster setup
    - **CRITICAL**: Test with `waitForReady: true` (no shortcuts)
  - Test composition readiness based on underlying resource readiness
  - _Requirements: 3.1, 3.6, 3.7, 1.5_

- [ ] 4. Implement core networking CRD factories with embedded readiness evaluators and end-to-end testing
  - Create factory functions for CiliumNetworkPolicy and CiliumClusterwideNetworkPolicy in `resources/networking.ts`
  - Embed readiness evaluators in the same file as factory functions
  - Test with real network policy creation and enforcement validation
  - _Requirements: 2.2, 2.3, 3.2, 5.1, 5.2, 5.3, 5.4_

- [ ] 4.1 Create CiliumNetworkPolicy factory with embedded readiness evaluator and testing
  - Implement factory function with comprehensive spec interface in `resources/networking.ts`
  - Embed readiness evaluator function in the same file
  - Add proper validation for policy rules and selectors
  - Include support for ingress, egress, and L7 rules
  - Test with real CiliumNetworkPolicy creation and policy enforcement validation
  - Test readiness evaluation with actual policy application status
  - _Requirements: 2.2, 5.1, 5.2, 3.2_

- [ ] 4.2 Create CiliumClusterwideNetworkPolicy factory with embedded readiness evaluator and testing
  - Implement factory function for cluster-wide policies in `resources/networking.ts`
  - Embed readiness evaluator function in the same file
  - Add node selector support and cluster-wide rule validation
  - Ensure proper RBAC and security considerations
  - Test with real CiliumClusterwideNetworkPolicy creation and enforcement
  - Test readiness evaluation with actual cluster-wide policy status
  - _Requirements: 2.3, 5.1, 5.2, 3.2_

- [ ] 4.3 Test networking resources integration with TypeKro features
  - Test networking resources with kubernetesComposition integration
  - Test cross-resource references and dependency resolution
  - Test serialization to YAML and ResourceGraphDefinitions
  - Validate networking resources work with both direct and Kro deployment
  - Test with real applications and validate network policy enforcement
  - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [ ] 4.4 Add networking resources to main exports with comprehensive testing
  - Export networking factories from resources/networking.ts
  - Update main index.ts to include networking resources
  - Ensure proper TypeScript type exports and IDE experience
  - Test all exports work correctly and provide proper autocomplete
  - _Requirements: 4.5, 4.6, 4.7, 5.1_

- [ ] 5. Implement BGP CRD factories with embedded readiness evaluators and BGP session testing
  - Create factory functions for BGP-related CRDs in `resources/bgp.ts`
  - Embed readiness evaluators for BGP session establishment in the same file
  - Test with real BGP configurations and session establishment validation
  - _Requirements: 2.4, 3.3, 5.1, 5.2, 5.3, 5.4_

- [ ] 5.1 Create CiliumBGPClusterConfig factory with embedded readiness evaluator and testing
  - Implement factory for BGP cluster configuration in `resources/bgp.ts`
  - Embed readiness evaluator for BGP session establishment in the same file
  - Add support for BGP instances and peer configurations with validation
  - Include proper validation for ASN and peer settings
  - Test with real BGP cluster configuration and session establishment
  - Test readiness evaluation with actual BGP session status
  - _Requirements: 2.4, 5.1, 5.2, 3.3_

- [ ] 5.2 Create CiliumBGPPeeringPolicy factory with embedded readiness evaluator and testing
  - Implement factory for legacy BGP peering policy in `resources/bgp.ts`
  - Embed readiness evaluator for BGP peer connectivity in the same file
  - Add virtual router configuration and neighbor support
  - Include migration path documentation to new BGP CRDs
  - Test with real BGP peering policy creation and peer establishment
  - Test readiness evaluation with actual BGP peer status
  - _Requirements: 2.4, 5.1, 5.2, 3.3_

- [ ] 5.3 Create CiliumBGPAdvertisement factory with embedded readiness evaluator and testing
  - Implement factory for BGP route advertisements in `resources/bgp.ts`
  - Embed readiness evaluator for route advertisement status in the same file
  - Add support for service and pod CIDR advertisements
  - Include proper advertisement policy configuration and validation
  - Test with real BGP advertisement configuration and route propagation
  - Test readiness evaluation with actual route advertisement status
  - _Requirements: 2.4, 5.1, 5.2, 3.3_

- [ ] 5.4 Test BGP resources integration with real BGP infrastructure
  - Test BGP resources with kubernetesComposition integration
  - Test with real BGP routers and validate session establishment
  - Test route advertisement and traffic routing functionality
  - Validate BGP resources work with both direct and Kro deployment
  - Test cross-resource dependencies and BGP configuration updates
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 3.3_

- [ ] 6. Implement load balancer CRD factories with embedded readiness evaluators and end-to-end testing
  - Create factory functions for load balancer IP pools and L2 announcements in `resources/load-balancer.ts`
  - Embed readiness evaluators in the same file as factory functions
  - Test with real load balancer configurations and service integration validation
  - _Requirements: 2.5, 2.6, 3.4, 5.1, 5.2, 5.3, 5.4_

- [ ] 6.1 Create CiliumLoadBalancerIPPool factory with embedded readiness evaluator and testing
  - Implement factory for load balancer IP pool management in `resources/load-balancer.ts`
  - Embed readiness evaluator for IP pool availability in the same file
  - Add CIDR block configuration and service selector support with validation
  - Include IP pool availability and allocation tracking
  - Test with real CiliumLoadBalancerIPPool creation and service integration
  - Test readiness evaluation with actual IP pool allocation status
  - _Requirements: 2.5, 5.1, 5.2, 3.4_

- [ ] 6.2 Create CiliumL2AnnouncementPolicy factory with embedded readiness evaluator and testing
  - Implement factory for L2 network announcements in `resources/load-balancer.ts`
  - Embed readiness evaluator for L2 announcement policy application in the same file
  - Add node selector and service selector configuration with validation
  - Include interface and announcement scope settings
  - Test with real CiliumL2AnnouncementPolicy creation and L2 announcement validation
  - Test readiness evaluation with actual L2 announcement status
  - _Requirements: 2.6, 5.1, 5.2, 3.4_

- [ ] 6.3 Test load balancer resources integration with real load balancer functionality
  - Test load balancer resources with kubernetesComposition integration
  - Test with real load balancer services and validate IP allocation
  - Test L2 announcement functionality with actual network traffic
  - Validate load balancer resources work with both direct and Kro deployment
  - Test cross-resource dependencies and load balancer configuration updates
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 3.4_

- [ ] 7. Implement Gateway API CRD factories with embedded readiness evaluators and end-to-end testing
  - Create factory functions for Gateway API integration in `resources/gateway.ts`
  - Embed readiness evaluators in the same file as factory functions
  - Test with real Gateway API configurations and traffic routing validation
  - _Requirements: 2.8, 2.9, 3.5, 5.1, 5.2, 5.3, 5.4_

- [ ] 7.1 Create CiliumGatewayClassConfig factory with embedded readiness evaluator and testing
  - Implement factory for Gateway API class configuration in `resources/gateway.ts`
  - Embed readiness evaluator for Gateway API configuration in the same file
  - Add gateway type and deployment configuration support with validation
  - Include resource requirements and scaling options
  - Test with real CiliumGatewayClassConfig creation and Gateway API integration
  - Test readiness evaluation with actual Gateway API configuration status
  - _Requirements: 2.8, 5.1, 5.2, 3.5_

- [ ] 7.2 Create CiliumEnvoyConfig factory with embedded readiness evaluator and testing
  - Implement factory for Envoy proxy configuration in `resources/gateway.ts`
  - Embed readiness evaluator for Envoy configuration acceptance in the same file
  - Add service reference and backend service support with validation
  - Include Envoy resource configuration and validation
  - Test with real CiliumEnvoyConfig creation and Envoy configuration application
  - Test readiness evaluation with actual Envoy configuration status
  - _Requirements: 2.9, 5.1, 5.2, 3.5_

- [ ] 7.3 Create CiliumClusterwideEnvoyConfig factory with embedded readiness evaluator and testing
  - Implement factory for cluster-wide Envoy configuration in `resources/gateway.ts`
  - Embed readiness evaluator for cluster-wide Envoy configuration in the same file
  - Add cluster-wide proxy settings and policies with validation
  - Include proper RBAC and security considerations
  - Test with real CiliumClusterwideEnvoyConfig creation and cluster-wide application
  - Test readiness evaluation with actual cluster-wide Envoy status
  - _Requirements: 2.9, 5.1, 5.2, 3.5_

- [ ] 7.4 Test Gateway API resources integration with real traffic routing
  - Test Gateway API resources with kubernetesComposition integration
  - Test with real Gateway API controllers and validate traffic routing
  - Test Envoy configuration with actual HTTP/HTTPS traffic
  - Validate Gateway API resources work with both direct and Kro deployment
  - Test cross-resource dependencies and Gateway API configuration updates
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 3.5_

- [ ] 8. Implement additional security and observability CRD factories with embedded readiness evaluators and end-to-end testing
  - Create factory functions for remaining Cilium CRDs in `resources/security.ts` and `resources/observability.ts`
  - Embed readiness evaluators in the same files as factory functions
  - Test with real security policies and observability configurations
  - _Requirements: 2.7, 2.10, 2.11, 2.12, 3.1, 3.6, 3.7_

- [ ] 8.1 Create CiliumEgressGatewayPolicy factory with embedded readiness evaluator and testing
  - Implement factory for egress gateway policy configuration in `resources/security.ts`
  - Embed readiness evaluator for egress gateway policy application in the same file
  - Add egress node selection and gateway configuration with validation
  - Include proper validation for egress routing rules
  - Test with real CiliumEgressGatewayPolicy creation and egress traffic validation
  - Test readiness evaluation with actual egress gateway status
  - _Requirements: 2.7, 5.1, 5.2, 3.1_

- [ ] 8.2 Create CiliumLocalRedirectPolicy factory with embedded readiness evaluator and testing
  - Implement factory for local traffic redirection in `resources/security.ts`
  - Embed readiness evaluator for local redirect policy application in the same file
  - Add local service redirection and policy configuration with validation
  - Include validation for redirect targets and rules
  - Test with real CiliumLocalRedirectPolicy creation and traffic redirection validation
  - Test readiness evaluation with actual local redirect status
  - _Requirements: 2.11, 5.1, 5.2, 3.1_

- [ ] 8.3 Create CiliumCIDRGroup factory with embedded readiness evaluator and testing
  - Implement factory for CIDR group management in `resources/security.ts`
  - Embed readiness evaluator for CIDR group availability in the same file
  - Add CIDR block grouping and labeling support with validation
  - Include proper validation for CIDR ranges
  - Test with real CiliumCIDRGroup creation and CIDR group usage validation
  - Test readiness evaluation with actual CIDR group status
  - _Requirements: 2.12, 5.1, 5.2, 3.1_

- [ ] 8.4 Test security and observability resources integration with real functionality
  - Test security and observability resources with kubernetesComposition integration
  - Test with real security policies and validate traffic enforcement
  - Test observability features with actual monitoring and metrics collection
  - Validate resources work with both direct and Kro deployment
  - Test cross-resource dependencies and configuration updates
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 3.1_

- [ ] 9. Integrate with existing TypeKro features
  - Ensure Cilium resources work with kubernetesComposition and toResourceGraph
  - Test serialization to YAML and ResourceGraphDefinitions
  - Validate dependency resolution and cross-resource references
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8_

- [ ] 9.1 Test kubernetesComposition integration
  - Create comprehensive tests for Cilium resources in compositions
  - Validate CEL expression generation and status mapping
  - Test cross-resource references and dependency resolution
  - _Requirements: 7.1, 7.6_

- [ ] 9.2 Test toResourceGraph integration
  - Ensure Cilium resources work with declarative API pattern
  - Validate resource builder and status builder integration
  - Test schema proxy functionality with Cilium resources
  - _Requirements: 7.8, 7.6_

- [ ] 9.3 Test serialization and deployment
  - Validate YAML generation for all Cilium resources
  - Test direct deployment and Kro deployment strategies
  - Ensure proper ResourceGraphDefinition generation
  - _Requirements: 7.2, 7.3, 7.4_

- [ ] 9.4 Test factory pattern integration
  - Validate Cilium compositions work as reusable factories
  - Test factory input/output type safety
  - Ensure proper integration with existing factory patterns
  - _Requirements: 7.7_

- [ ] 10. Add comprehensive documentation and examples
  - Create clear API documentation for all Cilium functions
  - Add practical examples for common use cases
  - Document integration patterns with other systems
  - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ] 10.1 Create API documentation
  - Add JSDoc documentation for all public functions
  - Document configuration options and status outputs
  - Include type information and usage examples
  - _Requirements: 8.3_

- [ ] 10.2 Create bootstrap composition examples
  - Add examples for common Cilium deployment scenarios
  - Include different configuration patterns and use cases
  - Document best practices and recommended settings
  - _Requirements: 8.1_

- [ ] 10.3 Create CRD usage examples
  - Add examples for each major CRD type
  - Include common network policy and BGP configuration patterns
  - Document integration with Kubernetes resources
  - _Requirements: 8.2_

- [ ] 10.4 Create integration examples
  - Add examples showing Cilium status consumption by other compositions
  - Document how to use Cilium endpoints in other systems
  - Include troubleshooting and debugging guidance
  - _Requirements: 8.4_

- [ ] 11. Finalize ecosystem template and create comprehensive documentation
  - Document the established template pattern for future ecosystem integrations
  - Create comprehensive API documentation with real-world examples
  - Validate template consistency and reusability
  - _Requirements: All requirements validation, 8.1, 8.2, 8.3, 8.4_

- [ ] 11.1 Document ecosystem template pattern with embedded readiness evaluators
  - Document the co-location pattern for readiness evaluators and factory functions
  - Create template guidelines for future ecosystem integrations
  - Document test-driven development approach for ecosystem implementations
  - Provide examples of proper directory structure and organization
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

- [ ] 11.2 Create comprehensive API documentation with working examples
  - Add JSDoc documentation for all public functions with real examples
  - Document configuration options and status outputs with actual deployments
  - Include troubleshooting guides based on real deployment scenarios
  - Create migration guides and best practices documentation
  - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ] 11.3 Validate ecosystem template reusability and consistency
  - Validate that the implementation follows consistent patterns
  - Test that the structure can be replicated for other ecosystems
  - Ensure consistency with existing TypeKro patterns and conventions
  - Create checklist for future ecosystem implementations
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

- [ ] 11.4 Performance validation and production readiness assessment
  - Test performance with large-scale Cilium deployments
  - Validate resource usage and memory efficiency
  - Test with multiple concurrent deployments and updates
  - Assess production readiness and create deployment recommendations
  - _Requirements: All non-functional requirements_

**Note:** All testing is integrated into implementation tasks above. This phase focuses on documentation, template validation, and production readiness rather than separate testing phases.