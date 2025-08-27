# Requirements Document

## Introduction

This feature expands comprehensive unit test coverage for deployment strategies and related components based on code coverage analysis. The goal is to achieve high test coverage for critical deployment infrastructure, prevent regressions like the recent `createResourcesProxy` issue, and ensure all deployment strategies handle resource references correctly.

## Coverage Analysis Results

Based on the code coverage report, the following areas need improved unit test coverage:

**Low Coverage Areas:**
- `src/core/deployment/strategies/base-strategy.ts`: 46.67% function coverage, 93.50% line coverage
- `src/core/deployment/direct-factory.ts`: 87.50% function coverage, 68.41% line coverage  
- `src/core/deployment/kro-factory.ts`: 57.58% function coverage, 30.71% line coverage
- `src/core/deployment/engine.ts`: 80.39% function coverage, 58.60% line coverage
- `src/core/references/schema-proxy.ts`: 70.00% function coverage, 37.62% line coverage
- `src/core/serialization/validation.ts`: 66.67% function coverage, 36.09% line coverage

**Priority Focus:** Deployment strategies, factory implementations, and resource reference handling.

## Requirements

### Requirement 1: Resource Reference Resolution Testing

**User Story:** As a developer, I want unit tests that verify resource references are properly converted to CEL expressions, so that status builders work correctly across all deployment strategies.

#### Acceptance Criteria

1. WHEN a status builder accesses `resources.webapp.status.readyReplicas` THEN the system SHALL convert this to a proper `KubernetesRef` object
2. WHEN the status builder is called with enhanced resources THEN the system SHALL wrap them with `createResourcesProxy`
3. WHEN resource references are serialized THEN the system SHALL generate valid CEL expressions like `webapp.status.readyReplicas`
4. WHEN a resource reference points to a non-existent field THEN the system SHALL handle it gracefully without throwing errors

### Requirement 2: Status Builder Integration Testing

**User Story:** As a developer, I want unit tests that verify status builders receive properly proxied resources, so that magic proxy behavior works consistently.

#### Acceptance Criteria

1. WHEN a deployment strategy calls a status builder THEN the system SHALL pass resources wrapped with `createResourcesProxy`
2. WHEN the status builder returns computed status THEN the system SHALL preserve both static fields and CEL expressions
3. WHEN status building fails THEN the system SHALL provide clear error messages and fallback gracefully
4. WHEN no status builder is provided THEN the system SHALL handle the absence without errors

### Requirement 3: Cross-Strategy Consistency Testing

**User Story:** As a developer, I want unit tests that verify all deployment strategies handle resource references identically, so that behavior is consistent across DirectDeploymentStrategy, AlchemyDeploymentStrategy, and KroDeploymentStrategy.

#### Acceptance Criteria

1. WHEN testing resource reference handling THEN all deployment strategies SHALL behave identically
2. WHEN comparing CEL expression generation THEN all strategies SHALL produce the same output for identical inputs
3. WHEN testing error scenarios THEN all strategies SHALL handle failures consistently
4. WHEN validating status hydration THEN all strategies SHALL follow the same patterns

### Requirement 4: Mock Infrastructure for Testability

**User Story:** As a developer, I want proper mocking infrastructure for deployment strategies, so that unit tests can run quickly without external dependencies.

#### Acceptance Criteria

1. WHEN creating test deployment strategies THEN the system SHALL provide mock factories for all dependencies
2. WHEN testing status builders THEN the system SHALL provide mock enhanced resources with realistic data
3. WHEN simulating deployment results THEN the system SHALL provide configurable mock deployment outcomes
4. WHEN testing error conditions THEN the system SHALL provide controllable failure scenarios

### Requirement 5: BaseDeploymentStrategy Coverage Enhancement

**User Story:** As a developer, I want comprehensive unit tests for BaseDeploymentStrategy, so that the core deployment logic is thoroughly validated.

#### Acceptance Criteria

1. WHEN testing enhanced proxy creation THEN the system SHALL validate metadata generation, status building, and API version handling
2. WHEN testing error scenarios THEN the system SHALL cover status builder failures, missing resources, and invalid configurations
3. WHEN testing strategy modes THEN the system SHALL verify correct mode reporting for direct vs kro strategies
4. WHEN testing resource key mapping THEN the system SHALL validate the complex resource ID pattern matching logic

### Requirement 6: Factory Implementation Coverage

**User Story:** As a developer, I want comprehensive unit tests for DirectResourceFactory and KroResourceFactory, so that factory behavior is reliable.

#### Acceptance Criteria

1. WHEN testing DirectResourceFactory THEN the system SHALL cover client provider creation, deployment engine initialization, and resource resolution
2. WHEN testing KroResourceFactory THEN the system SHALL cover RGD deployment, instance management, and status operations
3. WHEN testing factory error handling THEN the system SHALL cover cluster connectivity issues, invalid configurations, and deployment failures
4. WHEN testing factory lifecycle THEN the system SHALL cover creation, deployment, rollback, and cleanup operations

### Requirement 7: Schema Proxy and Reference System Coverage

**User Story:** As a developer, I want comprehensive unit tests for the schema proxy and reference resolution system, so that the magic proxy behavior is reliable.

#### Acceptance Criteria

1. WHEN testing createResourcesProxy THEN the system SHALL validate proxy creation, field access interception, and reference generation
2. WHEN testing createSchemaProxy THEN the system SHALL validate schema field access and reference creation
3. WHEN testing reference resolution THEN the system SHALL cover CEL expression evaluation, resource lookups, and error handling
4. WHEN testing proxy edge cases THEN the system SHALL cover nested objects, arrays, and complex field paths

### Requirement 8: Serialization and Validation Coverage

**User Story:** As a developer, I want comprehensive unit tests for serialization and validation components, so that YAML generation and validation is reliable.

#### Acceptance Criteria

1. WHEN testing ResourceGraphDefinition validation THEN the system SHALL cover schema validation, CEL expression validation, and resource reference validation
2. WHEN testing YAML serialization THEN the system SHALL cover resource graph serialization, status mapping serialization, and error handling
3. WHEN testing validation edge cases THEN the system SHALL cover malformed inputs, circular references, and invalid CEL expressions
4. WHEN testing optimization THEN the system SHALL cover CEL expression optimization and reference resolution

### Requirement 9: Deployment Engine Coverage

**User Story:** As a developer, I want comprehensive unit tests for DirectDeploymentEngine, so that the core deployment logic is thoroughly tested.

#### Acceptance Criteria

1. WHEN testing deployment execution THEN the system SHALL cover resource application, dependency resolution, and readiness checking
2. WHEN testing rollback operations THEN the system SHALL cover resource deletion, cleanup, and error recovery
3. WHEN testing engine configuration THEN the system SHALL cover client provider integration, namespace handling, and timeout management
4. WHEN testing engine error scenarios THEN the system SHALL cover API failures, network issues, and resource conflicts

### Requirement 10: Regression Prevention Testing

**User Story:** As a developer, I want unit tests that specifically catch the types of issues we've encountered, so that similar problems are detected early in development.

#### Acceptance Criteria

1. WHEN resource references resolve to `undefined` THEN tests SHALL fail with clear error messages
2. WHEN `createResourcesProxy` is not called THEN tests SHALL detect the missing proxy wrapper
3. WHEN CEL expressions contain invalid references THEN tests SHALL identify the problematic expressions
4. WHEN status builders receive raw objects instead of proxies THEN tests SHALL catch the incorrect behavior