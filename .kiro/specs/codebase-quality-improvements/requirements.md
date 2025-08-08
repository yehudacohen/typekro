# Requirements Document

## Introduction

This specification addresses a specific architectural issue in TypeKro: deployment engines currently use centralized, generic readiness checking logic that cannot account for resource-specific readiness requirements. Different Kubernetes resources have different readiness criteria (Deployments need ready replicas, Services need LoadBalancer ingress, StatefulSets consider update strategies), but the current system treats all resources the same way.

The goal is to decentralize readiness control, allowing each resource factory to define what makes that specific resource ready, while making minimal changes to the existing production-ready architecture.

## Requirements

### Requirement 1: Decentralized Resource Readiness Control

**User Story:** As a TypeKro factory function author, I want to define resource-specific readiness criteria so that deployment engines can accurately determine when my resources are ready without needing to understand the specifics of every resource type.

#### Acceptance Criteria

1. WHEN a factory function creates a resource THEN it SHALL be able to provide a readiness evaluation function that captures the resource's specific configuration and readiness requirements
2. WHEN a deployment engine checks resource readiness THEN it SHALL use the factory-provided readiness function if available, falling back to generic readiness checking if not provided
3. WHEN a Deployment resource is created THEN its readiness function SHALL consider both ready replicas and available replicas matching the expected replica count
4. WHEN a Service resource is created THEN its readiness function SHALL consider the service type (LoadBalancer needs ingress, ClusterIP is ready immediately, ExternalName needs externalName)
5. WHEN a StatefulSet resource is created THEN its readiness function SHALL consider the update strategy (OnDelete vs RollingUpdate have different readiness criteria)
6. WHEN a Job resource is created THEN its readiness function SHALL consider the completion count and success criteria
7. WHEN a resource type doesn't provide a readiness function THEN the deployment engine SHALL use the existing generic readiness checking as a fallback

### Requirement 2: Minimal Architectural Impact

**User Story:** As a TypeKro user with production deployments, I want readiness improvements to be implemented without breaking existing functionality or requiring changes to my deployment code.

#### Acceptance Criteria

1. WHEN readiness decentralization is implemented THEN all existing factory function signatures SHALL remain unchanged
2. WHEN readiness decentralization is implemented THEN all existing deployment workflows SHALL continue to work without modification
3. WHEN readiness decentralization is implemented THEN the existing ResourceReadinessChecker SHALL continue to work as a fallback for resources without custom readiness functions
4. WHEN readiness decentralization is implemented THEN no changes SHALL be required to user code or deployment configurations
5. WHEN a resource doesn't have a custom readiness function THEN the system SHALL behave exactly as it does today
6. WHEN the new readiness system fails THEN the deployment engine SHALL gracefully fall back to the existing polling-based readiness checking
7. WHEN readiness decentralization is implemented THEN it SHALL not interfere with resource serialization, YAML generation, or any other existing functionality

### Requirement 3: Performance and Reliability Improvements

**User Story:** As a developer deploying resources with TypeKro, I want resource readiness checking to be more accurate and potentially faster than the current generic approach.

#### Acceptance Criteria

1. WHEN using factory-provided readiness functions THEN readiness determination SHALL be more accurate than generic status checking
2. WHEN a resource has complex readiness requirements THEN the factory-provided function SHALL capture all necessary configuration details at resource creation time
3. WHEN readiness checking fails or times out THEN the system SHALL provide clear error messages indicating which specific readiness criteria were not met
4. WHEN multiple resources of the same type are deployed THEN each SHALL have its own readiness function that reflects its specific configuration (replica counts, service types, etc.)
5. WHEN readiness functions are evaluated THEN they SHALL not cause performance degradation compared to the existing system
6. WHEN readiness functions encounter errors THEN they SHALL fail gracefully and allow fallback to generic readiness checking
7. WHEN debugging readiness issues THEN developers SHALL be able to understand what specific criteria a resource is waiting for

### Requirement 4: Integrated Status Hydration

**User Story:** As a TypeKro user, I want status hydration to be efficiently integrated with readiness checking so that I get accurate status information without performance overhead from duplicate API calls.

#### Acceptance Criteria

1. WHEN a resource becomes ready THEN its status fields SHALL be hydrated using the same API call data used for readiness checking
2. WHEN DirectDeploymentEngine checks readiness THEN it SHALL coordinate with StatusHydrator to eliminate duplicate API calls
3. WHEN KroResourceFactory deploys resources THEN it SHALL maintain existing static/dynamic status field separation while using DirectDeploymentEngine
4. WHEN status hydration fails THEN it SHALL not cause deployment failure but SHALL log appropriate warnings
5. WHEN using existing StatusHydrator methods THEN they SHALL continue to work unchanged for backward compatibility
6. WHEN status fields are hydrated THEN the performance SHALL be improved by eliminating redundant API calls
7. WHEN debugging status issues THEN developers SHALL have consistent error handling between readiness checking and status hydration