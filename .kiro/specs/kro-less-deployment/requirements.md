# Kro-less Deployment Requirements

## Introduction

This feature enables deployment of TypeKro resource graphs to Kubernetes clusters that don't have the Kro controller installed. Instead of relying on Kro's runtime dependency resolution, TypeKro will resolve dependencies in-process during deployment and apply resources in the correct topological order.

## Requirements

### Requirement 1: In-Process Dependency Resolution

**User Story:** As a developer, I want to deploy TypeKro resource graphs to any Kubernetes cluster, so that I don't need to install additional controllers or operators.

#### Acceptance Criteria

1. WHEN I call `factory.deploy()` with a resource spec THEN TypeKro SHALL resolve all cross-resource references in-process
2. WHEN TypeKro resolves dependencies THEN it SHALL create a topological ordering of resources for deployment
3. WHEN TypeKro encounters circular dependencies THEN it SHALL throw a descriptive error before deployment
4. WHEN TypeKro resolves CEL expressions THEN it SHALL evaluate them against the current resource state
5. WHEN a resource has unresolvable references THEN TypeKro SHALL provide clear error messages with suggestions

### Requirement 2: Direct Kubernetes Deployment

**User Story:** As a platform engineer, I want TypeKro to deploy resources directly to Kubernetes, so that I can use it in environments where custom controllers are not allowed.

#### Acceptance Criteria

1. WHEN TypeKro deploys resources THEN it SHALL use the official Kubernetes client to apply manifests
2. WHEN TypeKro applies resources THEN it SHALL respect the dependency order determined by topological sorting
3. WHEN a resource deployment fails THEN TypeKro SHALL halt deployment and provide rollback options
4. WHEN TypeKro deploys resources THEN it SHALL wait for dependencies to be ready before deploying dependent resources
5. WHEN TypeKro completes deployment THEN it SHALL return the actual Kubernetes resource objects with resolved references

### Requirement 3: Reference Resolution Strategy

**User Story:** As a developer, I want cross-resource references to be resolved automatically, so that I don't need to manually manage resource dependencies.

#### Acceptance Criteria

1. WHEN TypeKro encounters a `KubernetesRef` THEN it SHALL resolve it by querying the target resource from the cluster
2. WHEN TypeKro encounters a `CelExpression` THEN it SHALL evaluate it using the current resource state
3. WHEN a referenced resource doesn't exist yet THEN TypeKro SHALL wait for it to be created in the dependency chain
4. WHEN a referenced field is not available THEN TypeKro SHALL wait with configurable timeout
5. WHEN TypeKro resolves references THEN it SHALL cache results to avoid redundant API calls

### Requirement 4: Factory Pattern with Deployment Modes

**User Story:** As a DevOps engineer, I want to choose between different dependency resolution strategies through a clean factory pattern, so that I can optimize for my specific deployment requirements while maintaining a consistent API.

#### Acceptance Criteria

1. WHEN I call `graph.factory('direct')` THEN TypeKro SHALL return a DirectResourceFactory that uses internal dependency resolution
2. WHEN I call `graph.factory('kro')` THEN TypeKro SHALL deploy a ResourceGraphDefinition and return a KroResourceFactory that creates instances from the RGD
3. WHEN I call `factory.deploy(spec)` on any factory THEN TypeKro SHALL create a new Enhanced instance using the factory's dependency resolution strategy
4. WHEN I provide an `alchemyScope` option to factory creation THEN TypeKro SHALL create an alchemy-managed factory that wraps deployments
5. WHEN both factory types are available THEN they SHALL implement the same ResourceFactory interface with identical type safety
6. WHEN I use a DirectResourceFactory THEN it SHALL deploy individual Kubernetes resources using TypeKro dependency resolution
7. WHEN I use a KroResourceFactory THEN it SHALL create instances from the deployed RGD using Kro dependency resolution
8. WHEN I use typed resource graphs with ArkType schemas THEN factories SHALL validate specs at runtime and provide compile-time type safety

### Requirement 5: Resource State Management

**User Story:** As a developer, I want to track the state of deployed resources, so that I can monitor deployment progress and handle failures.

#### Acceptance Criteria

1. WHEN TypeKro deploys resources THEN it SHALL track the deployment state of each resource
2. WHEN a resource is successfully deployed THEN TypeKro SHALL mark it as 'deployed' with metadata
3. WHEN a resource deployment fails THEN TypeKro SHALL mark it as 'failed' with error details
4. WHEN TypeKro waits for resource readiness THEN it SHALL provide progress callbacks
5. WHEN deployment is complete THEN TypeKro SHALL return a deployment summary with all resource states

### Requirement 6: Rollback and Cleanup

**User Story:** As a platform engineer, I want the ability to rollback failed deployments, so that I can maintain cluster stability.

#### Acceptance Criteria

1. WHEN a deployment fails THEN TypeKro SHALL offer automatic rollback of successfully deployed resources
2. WHEN I call `factory.rollback()` THEN TypeKro SHALL delete resources in reverse dependency order
3. WHEN TypeKro performs rollback THEN it SHALL respect Kubernetes finalizers and graceful deletion
4. WHEN rollback completes THEN TypeKro SHALL return a summary of cleaned up resources
5. WHEN TypeKro encounters rollback errors THEN it SHALL log them but continue with remaining resources

### Requirement 7: Configuration and Customization

**User Story:** As a developer, I want to configure deployment behavior, so that I can adapt it to different environments and requirements.

#### Acceptance Criteria

1. WHEN I configure deployment timeouts THEN TypeKro SHALL respect them for resource readiness checks
2. WHEN I configure retry policies THEN TypeKro SHALL use them for failed resource deployments
3. WHEN I configure namespace mapping THEN TypeKro SHALL deploy resources to the specified namespaces
4. WHEN I configure dry-run mode THEN TypeKro SHALL validate and show what would be deployed without applying
5. WHEN I configure verbose logging THEN TypeKro SHALL provide detailed deployment progress information

### Requirement 8: Alchemy Integration

**User Story:** As a platform engineer, I want to deploy TypeKro instances to alchemy for state management, so that I can manage Kubernetes resources alongside other cloud resources with unified lifecycle management.

#### Acceptance Criteria

1. WHEN I create a factory with `alchemyScope` option THEN TypeKro SHALL create an alchemy-managed factory that wraps deployments dynamically
2. WHEN I call `factory.deploy(spec)` on an alchemy-managed factory THEN TypeKro SHALL wrap the deployment process in alchemy resource functions
3. WHEN TypeKro creates alchemy-managed instances THEN it SHALL resolve alchemy promises while preserving TypeKro references for later resolution
4. WHEN alchemy manages TypeKro instances THEN they SHALL participate in alchemy's dependency resolution and lifecycle
5. WHEN alchemy destroys a stack THEN TypeKro instances SHALL be cleaned up in proper dependency order
6. WHEN I use both regular and alchemy-managed factories THEN they SHALL produce functionally identical Kubernetes resources
7. WHEN TypeKro instances depend on other alchemy resources THEN dependencies SHALL be resolved correctly through alchemy promises
8. WHEN I use alchemy promises in Kubernetes resource fields THEN they SHALL be resolved during alchemy deployment
9. WHEN I mix alchemy promises and TypeKro references THEN both SHALL be resolved in the correct dependency order
10. WHEN DirectResourceFactory deploys to alchemy THEN it SHALL create one alchemy resource per TypeKro Kubernetes resource
11. WHEN KroResourceFactory deploys to alchemy THEN it SHALL create one alchemy resource for the RGD and one for each instance
12. WHEN alchemy-managed instances are created THEN they SHALL maintain the same type safety as direct deployments

### Requirement 9: ArkType Schema Integration

**User Story:** As a developer, I want to use ArkType schemas to define my resource specifications with full type safety, so that I get both compile-time TypeScript checking and runtime validation.

#### Acceptance Criteria

1. WHEN I define a SchemaDefinition with ArkType schemas THEN TypeKro SHALL infer TypeScript types for compile-time safety
2. WHEN I call `toResourceGraph(definition, resourceBuilder, statusBuilder)` THEN TypeKro SHALL create a typed ResourceGraph with the inferred types
3. WHEN I call `factory.deploy(spec)` THEN TypeKro SHALL validate the spec against the ArkType schema at runtime
4. WHEN spec validation fails THEN TypeKro SHALL throw a descriptive error with details about the validation failure
5. WHEN I access `schema.spec.field` in a builder function THEN TypeKro SHALL provide compile-time type checking based on the ArkType schema
6. WHEN I create external references THEN they SHALL be fully typed based on their ArkType schema definitions
7. WHEN TypeKro generates Kro schemas THEN they SHALL be automatically derived from the ArkType definitions
8. WHEN I use the schema proxy THEN it SHALL provide type-safe access to all fields defined in the ArkType schemas

### Requirement 10: Alchemy Resource Instance Creation

**User Story:** As a developer, I want TypeKro to create alchemy resource instances efficiently, so that I can seamlessly integrate TypeKro with alchemy's resource management system without conflicts.

#### Acceptance Criteria

1. WHEN TypeKro creates alchemy resource instances THEN they SHALL have deterministic resource IDs for GitOps compatibility
2. WHEN TypeKro creates multiple instances of the same resource type THEN it SHALL use unique IDs to avoid conflicts
3. WHEN TypeKro executes within alchemy context THEN it SHALL preserve all original resource properties and metadata
4. WHEN alchemy manages TypeKro resource instances THEN they SHALL integrate properly with alchemy's lifecycle management
5. WHEN TypeKro resource instances are created THEN they SHALL participate in alchemy's dependency resolution
6. WHEN alchemy resource instances are destroyed THEN TypeKro SHALL handle cleanup through alchemy's standard lifecycle hooks
7. WHEN TypeKro uses generic resource types THEN it SHALL avoid resource type registration conflicts
8. WHEN Enhanced resources are created through alchemy THEN they SHALL maintain type safety and proxy functionality

### Requirement 11: Alchemy Resource Type Management

**User Story:** As a developer, I want TypeKro to manage alchemy resource types efficiently to avoid registration conflicts while creating multiple instances, so that I can integrate TypeKro deployments with alchemy without resource type conflicts.

#### Acceptance Criteria

1. WHEN TypeKro initializes alchemy integration THEN it SHALL register generic resource types once to avoid "Resource already exists" errors
2. WHEN TypeKro deploys with alchemy-managed factory THEN it SHALL create instances of registered resource types with deterministic IDs
3. WHEN alchemy manages TypeKro resource instances THEN it SHALL handle lifecycle events (create, update, delete) automatically for each instance
4. WHEN resource instances execute THEN they SHALL have access to alchemy's state management and dependency resolution
5. WHEN deployment fails within alchemy context THEN alchemy SHALL handle cleanup and rollback automatically
6. WHEN DirectResourceFactory deploys with alchemy THEN TypeKro SHALL create one alchemy resource instance per TypeKro Kubernetes resource
7. WHEN KroResourceFactory deploys with alchemy THEN TypeKro SHALL create one alchemy resource instance for the RGD and one for each CRD instance
8. WHEN alchemy resource instances are destroyed THEN they SHALL trigger cleanup of their corresponding Kubernetes resources
9. WHEN resource instances execute THEN they SHALL preserve all TypeKro functionality including reference resolution and type safety

### Requirement 12: Compatibility and Migration

**User Story:** As an existing TypeKro user, I want the new deployment functions to work with my existing resource graphs, so that I don't need to change my code.

#### Acceptance Criteria

1. WHEN I use existing `toKroResourceGraph()` output THEN both `graph.deploy()` and `graph.deployWithAlchemy()` SHALL work without modifications
2. WHEN I have existing CEL expressions THEN they SHALL be evaluated correctly in both deployment methods
3. WHEN I have existing cross-resource references THEN they SHALL be resolved correctly in both deployment methods
4. WHEN I switch between `graph.deploy()` and `graph.deployWithAlchemy()` THEN the deployed resources SHALL be functionally identical
5. WHEN I migrate between deployment methods THEN TypeKro SHALL provide migration utilities

### Requirement 13: Real Alchemy Provider Integration

**User Story:** As a developer, I want integration tests and examples to use real alchemy providers instead of mocks, so that I can see how TypeKro actually integrates with alchemy in production scenarios.

#### Acceptance Criteria

1. WHEN integration tests run THEN they SHALL use real alchemy File provider for creating configuration files and logs
2. WHEN tests need random strings THEN they SHALL use alchemy's lowercaseId utility for generating unique identifiers
3. WHEN examples demonstrate alchemy integration THEN they SHALL show real provider usage patterns like `await File("logs/app.log", { path: "logs/app.log", content: "log entry" })`
4. WHEN tests create alchemy resources THEN they SHALL use actual alchemy providers, not Resource() mock implementations
5. WHEN integration tests complete THEN they SHALL demonstrate bidirectional value flow between real alchemy resources and TypeKro

### Requirement 14: Alchemy State File Validation

**User Story:** As a platform engineer, I want to verify that both kro resources and alchemy resources are correctly registered in the alchemy state file, so that I can ensure proper resource lifecycle management and dependency tracking.

#### Acceptance Criteria

1. WHEN integration tests deploy resources THEN they SHALL assert that kro resources (RGDs, CRD instances) are registered in alchemy state
2. WHEN alchemy resources are created THEN tests SHALL verify they appear in the alchemy state file with correct metadata
3. WHEN resources have dependencies THEN the alchemy state file SHALL correctly track dependency relationships
4. WHEN resources are deleted THEN tests SHALL verify they are removed from the alchemy state file
5. WHEN deployment fails THEN the alchemy state file SHALL reflect the failure state and cleanup status

### Requirement 15: Unified Kubernetes Apply Layer

**User Story:** As a platform engineer, I want all Kubernetes manifest applications to use consistent configuration and error handling, so that I get predictable behavior regardless of which factory type I use.

#### Acceptance Criteria

1. WHEN DirectFactory applies manifests THEN it SHALL use the shared KubernetesApplier
2. WHEN KroFactory deploys RGDs THEN it SHALL use the same KubernetesApplier
3. WHEN any factory encounters apply errors THEN they SHALL use consistent error handling and retry logic
4. WHEN factories are configured THEN they SHALL share the same kubeconfig and apply options
5. WHEN debugging apply issues THEN both factories SHALL provide consistent logging and error messages

### Requirement 16: Universal Kubernetes Resource Status Monitoring and Output Hydration

**User Story:** As a developer, I want TypeKro to wait until all Kubernetes resources (both direct and kro resources) stabilize and then hydrate output fields with actual status values, so that I can reliably access resource status and handle failures appropriately regardless of deployment mode.

#### Acceptance Criteria

1. WHEN any Kubernetes resources are deployed THEN TypeKro SHALL monitor their status until they reach desired state (Ready, Available, Bound, etc.)
2. WHEN DirectResourceFactory deploys resources THEN TypeKro SHALL monitor standard Kubernetes resources (Deployment, Service, Pod, PVC, etc.) for readiness
3. WHEN KroResourceFactory deploys resources THEN TypeKro SHALL monitor kro resources for stabilization and readiness
4. WHEN resources stabilize THEN TypeKro SHALL query their status fields and hydrate Enhanced proxy objects with live values
5. WHEN resources fail to stabilize within timeout THEN TypeKro SHALL throw descriptive exceptions with resource-specific troubleshooting suggestions
6. WHEN resources enter degraded state THEN TypeKro SHALL emit warnings and provide resource-specific degradation details
7. WHEN status fields are hydrated THEN they SHALL contain live values from the cluster, not placeholder references
8. WHEN timeouts are configured THEN TypeKro SHALL respect them for all resource types with appropriate defaults per resource type
9. WHEN DirectResourceFactory resources have status values THEN they SHALL be accessible through the Enhanced proxy after stabilization (e.g., Service.status.loadBalancer.ingress)
10. WHEN KroResourceFactory resources have output schema values THEN they SHALL be accessible through the Enhanced proxy after stabilization using CEL expressions
11. WHEN both factory types are used THEN they SHALL provide identical status monitoring and hydration behavior for Enhanced proxy objects
12. WHEN resource-specific failures occur THEN TypeKro SHALL provide targeted troubleshooting information (e.g., Pod crash loops, LoadBalancer provisioning issues, PVC binding failures)

### Requirement 17: Production-Ready Integration

**User Story:** As a platform engineer, I want comprehensive integration patterns that work against real clusters and demonstrate production deployment scenarios, so that I can confidently deploy TypeKro in production environments.

#### Acceptance Criteria

1. WHEN integration tests run THEN they SHALL deploy to real Kubernetes clusters with kro controller installed
2. WHEN tests create alchemy resources THEN they SHALL use real providers and validate state file registration
3. WHEN tests deploy kro resources THEN they SHALL wait for stabilization and validate status hydration
4. WHEN tests encounter failures THEN they SHALL validate error handling and recovery mechanisms
5. WHEN tests complete THEN they SHALL verify proper cleanup of both alchemy and kro resources
6. WHEN performance tests run THEN they SHALL validate deployment speed and resource usage under load
7. WHEN reliability tests run THEN they SHALL test network failures, timeouts, and recovery scenarios
8. WHEN examples are provided THEN they SHALL demonstrate complete production deployment patterns
9. WHEN operational guides are created THEN they SHALL include troubleshooting and best practices