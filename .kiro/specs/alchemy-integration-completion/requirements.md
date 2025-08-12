# Requirements Document

## Introduction

This spec focuses on completing the Alchemy integration functionality in TypeKro to achieve comprehensive resource registration and management across both deployment modes. Currently, the Alchemy integration follows different patterns for Kro and Direct deployment modes, with the Direct mode having incomplete implementation. The goal is to ensure that:

**For Kro deployment mode:** Each RGD gets one Alchemy resource type registered, and each instance of each RGD gets a separate Alchemy resource registered.

**For Direct deployment mode:** Each individual Kubernetes resource in the resource graph gets its own Alchemy resource type registered (derived from the factory used or Kubernetes kind), and each instance of each resource gets a separate Alchemy resource registered.

This spec will implement the missing functionality and ensure consistent Alchemy resource registration patterns across both deployment modes.

## Requirements

### Requirement 1: Individual Resource Registration for Direct Mode

**User Story:** As a developer using TypeKro with direct deployment mode and Alchemy integration, I want each individual Kubernetes resource in my resource graph to be registered as a separate Alchemy resource type so that they are properly managed through the Alchemy resource management system.

#### Acceptance Criteria

1. WHEN a DirectResourceFactory deploys with Alchemy THEN each individual Kubernetes resource in the resource graph SHALL be registered as a separate Alchemy resource type
2. WHEN resource types are registered THEN they SHALL use naming patterns like `kubernetes::Deployment`, `kubernetes::Service`, `kubernetes::ConfigMap` based on the Kubernetes kind
3. WHEN multiple instances of the same resource type are deployed THEN each instance SHALL get a separate Alchemy resource registration
4. WHEN resource registration occurs THEN it SHALL use ensureResourceTypeRegistered to avoid conflicts and handle existing registrations
5. WHEN resource IDs are created THEN they SHALL use createAlchemyResourceId with appropriate namespacing and uniqueness
6. WHEN the deployment completes THEN each resource SHALL be tracked individually in the Alchemy state system
7. WHEN resources are deleted THEN each individual Alchemy resource SHALL be properly cleaned up

### Requirement 2: Complete AlchemyDeploymentStrategy Implementation

**User Story:** As a developer using TypeKro, I want the AlchemyDeploymentStrategy to perform actual deployments with individual resource registration so that the deployment behavior is consistent and complete.

#### Acceptance Criteria

1. WHEN AlchemyDeploymentStrategy.executeDeployment is called THEN it SHALL perform actual deployment operations instead of returning mock results
2. WHEN the strategy processes a resource graph THEN it SHALL register each individual Kubernetes resource as a separate Alchemy resource type
3. WHEN the strategy creates deployers THEN it SHALL use DirectTypeKroDeployer for individual resource deployments
4. WHEN the strategy handles errors THEN it SHALL use the same error handling patterns as other deployment strategies
5. WHEN the strategy logs operations THEN it SHALL use structured logging consistent with the rest of the codebase
6. WHEN the TODO comment is removed THEN the implementation SHALL be complete and functional
7. WHEN Alchemy scope validation fails THEN it SHALL throw appropriate errors with clear messages

### Requirement 3: Consistent Resource Registration Patterns

**User Story:** As a developer using TypeKro with Alchemy, I want consistent resource registration patterns across both Kro and Direct deployment modes so that the Alchemy integration behaves predictably.

#### Acceptance Criteria

1. WHEN Kro mode deploys with Alchemy THEN each RGD SHALL get one Alchemy resource type registered (like `kro::ResourceGraphDefinition`)
2. WHEN Kro mode creates instances THEN each instance of each RGD SHALL get a separate Alchemy resource registered (like `kro::WebApp`)
3. WHEN Direct mode deploys with Alchemy THEN each individual Kubernetes resource SHALL get its own Alchemy resource type registered (like `kubernetes::Deployment`)
4. WHEN Direct mode creates instances THEN each instance of each resource SHALL get a separate Alchemy resource registered
5. WHEN resource types are inferred THEN they SHALL be derived from the Kubernetes kind field or factory function used
6. WHEN resource registration occurs THEN it SHALL follow the same patterns as existing Alchemy providers (like cloudflare::Worker)
7. WHEN resources are managed THEN they SHALL support the full lifecycle including creation, updates, and deletion

### Requirement 4: Resource Type Inference and Naming

**User Story:** As a developer using TypeKro with Alchemy, I want resource types to be automatically inferred and named consistently so that I can easily identify and manage resources in the Alchemy system.

#### Acceptance Criteria

1. WHEN Direct mode registers Kubernetes resources THEN resource types SHALL be named using the pattern `kubernetes::{Kind}` (e.g., `kubernetes::Deployment`)
2. WHEN Kro mode registers RGDs THEN resource types SHALL be named using the pattern `kro::ResourceGraphDefinition`
3. WHEN Kro mode registers instances THEN resource types SHALL be named using the pattern `kro::{Kind}` where Kind comes from the schema definition
4. WHEN resource type inference occurs THEN it SHALL prioritize the Kubernetes kind field over factory function names
5. WHEN resource IDs are generated THEN they SHALL include namespace, resource name, and type information for uniqueness
6. WHEN multiple factories deploy the same resource type THEN they SHALL share the same Alchemy resource type registration
7. WHEN resource types are registered THEN they SHALL follow the same naming conventions as existing Alchemy providers

### Requirement 5: Error Handling and Validation

**User Story:** As a developer using Alchemy integration, I want comprehensive error handling so that I can diagnose and resolve deployment issues effectively.

#### Acceptance Criteria

1. WHEN Alchemy scope validation fails THEN it SHALL provide clear error messages indicating what is missing or invalid using validateAlchemyScope
2. WHEN resource registration fails THEN it SHALL handle the error gracefully and provide actionable feedback
3. WHEN individual resource deployment fails THEN it SHALL capture and report the underlying errors with context
4. WHEN resource type inference fails THEN it SHALL provide clear error messages about the resource structure
5. WHEN timeout conditions occur THEN it SHALL handle them gracefully and provide meaningful error messages
6. WHEN resource cleanup fails THEN it SHALL log errors and continue with other resources to avoid partial cleanup states
7. WHEN multiple resources fail THEN it SHALL collect and report all errors rather than failing on the first error

### Requirement 6: Testing and Validation

**User Story:** As a maintainer of TypeKro, I want comprehensive tests for the Alchemy integration so that the functionality is reliable and regressions are prevented.

#### Acceptance Criteria

1. WHEN individual resource registration tests are written THEN they SHALL cover successful registration scenarios for each Kubernetes resource type
2. WHEN error handling tests are written THEN they SHALL cover all major error conditions including scope validation and deployment failures
3. WHEN integration tests are created THEN they SHALL validate the complete deployment flow with individual resource registration
4. WHEN the tests run THEN they SHALL not use mock results but test actual deployment logic and resource registration
5. WHEN the tests validate resource registration THEN they SHALL ensure proper integration with ensureResourceTypeRegistered for each resource type
6. WHEN Alchemy integration tests are written THEN they SHALL NOT mock Alchemy dependencies but use real Alchemy scope and providers
7. WHEN Alchemy integration tests are created THEN they SHALL follow the same pattern as the existing typekro-alchemy-integration.test.ts
8. WHEN Alchemy tests create resources THEN they SHALL use real Alchemy providers and validate state through alchemyScope.state.all()
9. WHEN tests validate resource type inference THEN they SHALL verify correct naming patterns for both Kro and Direct modes
10. WHEN tests check resource lifecycle THEN they SHALL verify creation, updates, and deletion of individual Alchemy resources

### Requirement 7: Documentation and Examples

**User Story:** As a developer learning to use TypeKro with Alchemy, I want clear documentation and examples so that I can understand how the individual resource registration works across both deployment modes.

#### Acceptance Criteria

1. WHEN the implementation is complete THEN it SHALL include JSDoc comments explaining individual resource registration patterns
2. WHEN examples are provided THEN they SHALL demonstrate real-world usage of Alchemy integration in both Kro and Direct modes
3. WHEN error handling is documented THEN it SHALL explain common error scenarios and their resolutions
4. WHEN the API is documented THEN it SHALL explain the relationship between resource registration, type inference, and deployment strategies
5. WHEN resource type naming is documented THEN it SHALL explain the naming conventions and patterns used
6. WHEN troubleshooting guides are provided THEN they SHALL help users diagnose and resolve Alchemy integration issues
7. WHEN migration guides are created THEN they SHALL help users understand the differences between Kro and Direct mode Alchemy integration