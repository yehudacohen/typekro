# Requirements Document

## Introduction

This feature enables TypeKro to deploy YAML files and directories through **YAML factory functions** that return **deployment closures**. These deployment closures execute before Enhanced resources with automatic CRD dependency handling, path resolution for local/Git sources, and seamless integration with TypeKro's deployment strategies. The system automatically detects CRDs, waits for establishment, and handles complex deployment dependencies without requiring users to specify ordering or async operations. This capability works in both Direct and Kro factory modes, making it essential for deploying infrastructure components like Helm Controller and Kustomize Controller, and ultimately enables TypeKro to bootstrap its own runtime dependencies as a TypeScript-based package manager for Kubernetes clusters.

## Requirements

### Requirement 1

**User Story:** As a platform engineer, I want to use YAML factory functions to deploy static manifests via deployment closures, so that I can deploy static Kubernetes manifests alongside my composed Enhanced resources.

#### Acceptance Criteria

1. WHEN I use a YAML factory function THEN TypeKro SHALL create a deployment closure that references the file path
2. WHEN I reference local or Git-based YAML files THEN TypeKro SHALL load the content at deployment time
3. WHEN I deploy the resource graph THEN TypeKro SHALL execute deployment closures to apply the YAML content to the cluster
4. IF the YAML contains multiple documents THEN TypeKro SHALL handle each document as a separate Kubernetes resource
5. WHEN the YAML file cannot be loaded THEN TypeKro SHALL provide clear path resolution errors

### Requirement 2

**User Story:** As a platform engineer, I want to use YAML factory functions for directory structures containing YAML files, so that I can deploy entire Helm charts or Kustomize overlays via deployment closures.

#### Acceptance Criteria

1. WHEN I use a directory YAML factory function THEN TypeKro SHALL create a deployment closure that recursively processes all YAML files in the directory
2. WHEN I specify file patterns THEN TypeKro SHALL only include matching files
3. WHEN I exclude certain files THEN TypeKro SHALL respect exclusion patterns
4. WHEN the directory contains subdirectories THEN TypeKro SHALL maintain the directory structure in metadata
5. WHEN files have dependencies THEN TypeKro SHALL determine the correct application order

### Requirement 3

**User Story:** As a platform engineer, I want to reference GitHub repositories containing YAML manifests, so that I can deploy third-party controllers and operators without copying files locally.

#### Acceptance Criteria

1. WHEN I specify a Git repository using git: URLs THEN TypeKro SHALL fetch the repository content at deployment time
2. WHEN I specify a specific branch or tag using @ref syntax THEN TypeKro SHALL use that version
3. WHEN I specify a subdirectory path in the Git URL THEN TypeKro SHALL only process files from that path
4. WHEN the repository is private THEN TypeKro SHALL support authentication via Git credentials
5. WHEN Git content cannot be fetched THEN TypeKro SHALL provide clear error messages

### Requirement 4

**User Story:** As a platform engineer, I want to use Helm and Kustomize resources with TypeKro references, so that I can customize templated manifests based on my resource graph configuration.

#### Acceptance Criteria

1. WHEN I use schema references in Helm values THEN TypeKro SHALL resolve them at deployment time
2. WHEN I use CEL expressions in Helm values THEN TypeKro SHALL evaluate them correctly
3. WHEN I reference other resources in Kustomize patches THEN TypeKro SHALL resolve cross-resource dependencies
4. WHEN reference resolution fails THEN TypeKro SHALL provide clear error messages
5. WHEN Helm or Kustomize templating fails THEN the respective controller SHALL handle the error appropriately

### Requirement 5

**User Story:** As a platform engineer, I want to deploy Helm Controller using YAML file resources, so that I can then use Helm charts in my TypeKro compositions.

#### Acceptance Criteria

1. WHEN I define Helm Controller manifests as YAML resources THEN TypeKro SHALL deploy them successfully
2. WHEN Helm Controller is deployed THEN TypeKro SHALL wait for it to be ready before proceeding
3. WHEN I create HelmRelease resources THEN TypeKro SHALL apply them after Helm Controller is ready
4. WHEN Helm Controller manages resources THEN TypeKro SHALL not interfere with Helm's lifecycle management
5. WHEN I update Helm Controller configuration THEN TypeKro SHALL apply changes without disrupting existing releases

### Requirement 6

**User Story:** As a platform engineer, I want to deploy Kustomize Controller using YAML file resources, so that I can use Kustomize overlays in my TypeKro compositions.

#### Acceptance Criteria

1. WHEN I define Kustomize Controller manifests as YAML resources THEN TypeKro SHALL deploy them successfully
2. WHEN Kustomize Controller is deployed THEN TypeKro SHALL wait for it to be ready before proceeding
3. WHEN I create Kustomization resources THEN TypeKro SHALL apply them after Kustomize Controller is ready
4. WHEN Kustomize Controller manages resources THEN TypeKro SHALL respect Kustomize's resource ownership
5. WHEN I update Kustomization configurations THEN TypeKro SHALL apply changes correctly

### Requirement 7

**User Story:** As a platform engineer, I want to bootstrap the TypeKro runtime using YAML file resources, so that I can deploy Kro Controller and its dependencies as a self-contained composition.

#### Acceptance Criteria

1. WHEN I define a TypeKro bootstrap composition THEN it SHALL include all necessary dependencies
2. WHEN I deploy the bootstrap composition THEN it SHALL install Kro Controller, Helm Controller, and Kustomize Controller
3. WHEN the bootstrap is complete THEN TypeKro SHALL be able to deploy ResourceGraphDefinitions
4. WHEN I update the bootstrap composition THEN it SHALL upgrade components without breaking existing resources
5. WHEN the bootstrap fails THEN it SHALL provide clear rollback capabilities
6. WHEN I create a complete GitOps platform THEN I SHALL be able to deploy Kro (Direct mode), then Flux (Kro mode), then Istio (Helm) in a single workflow

### Requirement 8

**User Story:** As a developer, I want type-safe interfaces for YAML file resources, so that I can use them with full TypeScript support and IDE integration.

#### Acceptance Criteria

1. WHEN I define YAML file resources THEN TypeKro SHALL provide typed interfaces
2. WHEN I reference YAML content properties THEN I SHALL get autocomplete and type checking
3. WHEN I make configuration errors THEN TypeScript SHALL catch them at compile time
4. WHEN I refactor resource names THEN IDE refactoring SHALL work correctly
5. WHEN I use the resources in compositions THEN the magic proxy system SHALL work seamlessly
6. WHEN I use YAML resources in Kro mode with dynamic references THEN TypeKro SHALL provide clear error messages

### Requirement 9

**User Story:** As a platform engineer, I want custom readiness evaluation for YAML resources, so that I can ensure complex deployments are fully ready before proceeding.

#### Acceptance Criteria

1. WHEN I deploy YAML resources without factory-provided readiness evaluators THEN TypeKro SHALL reject the deployment with a clear error message for safety
2. WHEN I provide custom readiness evaluators THEN TypeKro SHALL use them to determine resource readiness
3. WHEN readiness evaluators need cluster state THEN TypeKro SHALL provide access to cluster resources
4. WHEN readiness evaluation fails THEN TypeKro SHALL provide clear error messages
5. WHEN readiness evaluation times out THEN TypeKro SHALL fail the deployment with appropriate error handling
6. WHEN I want immediate readiness THEN I SHALL provide a custom evaluator that returns ready immediately

### Requirement 10

**User Story:** As a platform engineer, I want to manage YAML file resources with the same lifecycle as other TypeKro resources, so that I have consistent deployment and management patterns.

#### Acceptance Criteria

1. WHEN I deploy YAML file resources THEN they SHALL participate in dependency resolution
2. WHEN I update YAML file resources THEN TypeKro SHALL detect changes and redeploy
3. WHEN I delete YAML file resources THEN TypeKro SHALL clean up the associated Kubernetes resources
4. WHEN YAML resources have dependencies THEN TypeKro SHALL wait for dependencies to be ready
5. WHEN YAML resources fail to deploy THEN TypeKro SHALL provide rollback capabilities

### Requirement 11

**User Story:** As a platform engineer, I want YAML file resources to work in both Direct and Kro factory modes, so that I can use the same compositions regardless of deployment strategy.

#### Acceptance Criteria

1. WHEN I use YAML resources with static values THEN they SHALL work in both Direct and Kro modes
2. WHEN I use YAML resources with dynamic references in Direct mode THEN they SHALL resolve correctly at deployment time
3. WHEN I use YAML resources with dynamic references in Kro mode THEN TypeKro SHALL raise clear validation errors
4. WHEN validation fails in Kro mode THEN the error message SHALL explain the limitation and suggest alternatives
5. WHEN I deploy via Kro factory THEN YAML closures SHALL execute before RGD creation

### Requirement 12

**User Story:** As a developer, I want comprehensive documentation and examples for YAML file resources, so that I can quickly learn and implement GitOps patterns with TypeKro.

#### Acceptance Criteria

1. WHEN I visit the TypeKro documentation THEN I SHALL find a dedicated guide for YAML file resources
2. WHEN I read the examples THEN I SHALL see practical use cases for Helm Controller and Kustomize Controller deployment
3. WHEN I follow the bootstrap tutorial THEN I SHALL be able to set up a complete TypeKro runtime from scratch
4. WHEN I need API reference THEN I SHALL find complete documentation for all YAML resource factory functions
5. WHEN I encounter issues THEN I SHALL find troubleshooting guides with common problems and solutions
6. WHEN I need to understand mode differences THEN I SHALL find clear guidance on Direct vs Kro mode capabilities

### Requirement 13

**User Story:** As a maintainer, I want the e2e bootstrap script to use TypeKro compositions instead of kubectl commands, so that our infrastructure deployment demonstrates TypeKro best practices and maintains consistency.

#### Acceptance Criteria

1. WHEN I run the e2e setup script THEN it SHALL use `typeKroRuntimeBootstrap()` composition instead of kubectl commands
2. WHEN the bootstrap composition deploys THEN it SHALL use `yamlFile()` for Flux controllers (matching integration test patterns)
3. WHEN the bootstrap composition deploys THEN it SHALL use `helmResource()` for Kro controller deployment
4. WHEN bootstrap deployment completes THEN all controllers SHALL be ready and functional
5. WHEN bootstrap fails THEN the script SHALL provide clear error messages and cleanup procedures
6. WHEN I examine the bootstrap code THEN it SHALL serve as a reference example for infrastructure deployment patterns