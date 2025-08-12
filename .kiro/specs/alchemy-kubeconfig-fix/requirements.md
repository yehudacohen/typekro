# Requirements Document

## Introduction

The Alchemy integration tests are failing with TLS errors because the kubeconfig configuration is not being properly honored in the Alchemy deployment path. The issue occurs when the AlchemyDeploymentStrategy creates new DirectDeploymentEngine instances in the alchemy resource handlers, which load kubeconfig from default instead of using the test-configured kubeconfig.

## Requirements

### Requirement 1

**User Story:** As a developer running integration tests, I want the kubeconfig TLS settings to be properly honored in Alchemy deployments, so that tests can run successfully with test clusters that use self-signed certificates.

#### Acceptance Criteria

1. WHEN a kubeconfig with `skipTLSVerify: true` is passed to AlchemyDeploymentStrategy THEN the alchemy resource handlers SHALL use the same kubeconfig configuration
2. WHEN alchemy resource handlers create DirectDeploymentEngine instances THEN they SHALL use the complete kubeconfig from the test instead of loading from default
3. WHEN the test cluster uses self-signed certificates THEN the alchemy deployment SHALL not fail with TLS verification errors

### Requirement 2

**User Story:** As a developer, I want the alchemy deployment to preserve the complete kubeconfig context, so that deployments work correctly with custom cluster configurations.

#### Acceptance Criteria

1. WHEN a custom kubeconfig is provided with specific cluster, user, and context settings THEN the alchemy resource handlers SHALL preserve all these settings
2. WHEN the kubeconfig contains custom server URLs or authentication settings THEN these SHALL be maintained in the alchemy deployment path
3. WHEN multiple contexts are available in the kubeconfig THEN the currently selected context SHALL be used consistently

### Requirement 3

**User Story:** As a developer, I want the kubeconfig serialization to be complete and accurate, so that all necessary configuration is passed through the alchemy resource system.

#### Acceptance Criteria

1. WHEN kubeconfig options are serialized for alchemy THEN all necessary cluster, user, and context information SHALL be included
2. WHEN the serialized kubeconfig is reconstructed in alchemy handlers THEN it SHALL be functionally equivalent to the original kubeconfig
3. WHEN TLS settings, authentication, or server URLs are configured THEN these SHALL be preserved through the serialization process