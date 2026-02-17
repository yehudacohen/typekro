# Requirements Document

## Introduction

This document specifies the requirements for upgrading the `@kubernetes/client-node` package from version 0.20.0 to the `main` branch (post-1.4.0 with PR #2688 fix). This is a major version upgrade that involves significant breaking changes, including a switch from the deprecated `request` library to `fetch` as the HTTP backend, ESM module support, and changes to error handling patterns.

## Version Selection Analysis

| Version | Status | Notes |
|---------|--------|-------|
| main branch | ✅ Recommended | Has fix for #2670 (PR #2688 merged Nov 8, 2025) |
| 1.4.0 | ❌ Blocked | Regression bug #2670 - `loadYaml` loses spec content for custom resources |
| 1.3.0 | ⚠️ Fallback | Stable, works correctly with `loadYaml` but misses 1.4.0 improvements |

**Recommended Approach:** Install from the `main` branch which includes:
- All 1.4.0 features (Kubernetes 1.34.x support, abort signal support, etc.)
- Fix for #2670 (PR #2688) - Knative Service YAML parsing by checking API groups

**Installation:** `bun add @kubernetes/client-node@github:kubernetes-client/javascript`

**Why main branch:** TypeKro uses `loadYaml` in `src/core/kubernetes/api.ts` and `loadAllYaml` in `src/core/deployment/kro-factory.ts` to parse ResourceGraphDefinitions and other custom resources. The 1.4.0 regression would cause these to lose their spec content, but this is fixed in main.

**Future:** When version 1.5.0 is released, we can switch to the npm package for more stable dependency management.

The upgrade is necessary to:
- Maintain compatibility with newer Kubernetes API versions (1.33.x, 1.34.x)
- Benefit from bug fixes and security updates
- Remove dependency on the deprecated `request` library
- Gain access to new features like abort signal support, improved authentication, and ObjectCache from makeInformer

## Glossary

- **KubeConfig**: Configuration object that holds cluster connection details, authentication credentials, and context information
- **KubernetesObjectApi**: Generic API client for performing CRUD operations on any Kubernetes resource
- **CoreV1Api**: API client for core Kubernetes resources (Pods, Services, ConfigMaps, Secrets, etc.)
- **AppsV1Api**: API client for application resources (Deployments, StatefulSets, DaemonSets, etc.)
- **CustomObjectsApi**: API client for custom resources and CRDs
- **Watch**: API for watching changes to Kubernetes resources in real-time
- **ESM**: ECMAScript Modules - the standard JavaScript module system
- **fetch**: Modern HTTP client API that replaces the deprecated `request` library
- **HttpError**: Error class used in 0.x versions for HTTP errors (removed in 1.x)

## Requirements

### Requirement 1

**User Story:** As a developer, I want the kubernetes client to be upgraded to the latest version, so that I can benefit from bug fixes, security updates, and new features.

#### Acceptance Criteria

1. WHEN the upgrade is complete THEN the TypeKro System SHALL use `@kubernetes/client-node` from main branch (post-1.4.0 with PR #2688 fix), or version 1.5.0+ when released
2. WHEN the upgrade is complete THEN the TypeKro System SHALL have no remaining dependencies on the deprecated `request` library
3. WHEN the upgrade is complete THEN the TypeKro System SHALL pass all existing unit tests without modification to test assertions
4. WHEN the upgrade is complete THEN the TypeKro System SHALL pass all existing integration tests without modification to test assertions

### Requirement 2

**User Story:** As a developer, I want the error handling to work correctly with the new client version, so that I can properly handle API errors.

#### Acceptance Criteria

1. WHEN an API call fails with an HTTP error THEN the TypeKro System SHALL catch and handle the error appropriately
2. WHEN an API call returns a 404 status THEN the TypeKro System SHALL handle it as a "not found" condition
3. WHEN an API call returns a 409 status THEN the TypeKro System SHALL handle it as a "conflict" condition
4. WHEN an API call fails with a network error THEN the TypeKro System SHALL provide meaningful error messages

### Requirement 3

**User Story:** As a developer, I want the Watch functionality to continue working, so that I can monitor Kubernetes resources in real-time.

#### Acceptance Criteria

1. WHEN watching resources THEN the TypeKro System SHALL receive events for resource changes
2. WHEN a watch connection is interrupted THEN the TypeKro System SHALL handle the disconnection gracefully
3. WHEN creating a Watch instance THEN the TypeKro System SHALL use the correct API from the new client version

### Requirement 4

**User Story:** As a developer, I want all API client types to remain compatible, so that existing code continues to work.

#### Acceptance Criteria

1. WHEN using V1Deployment, V1Service, V1Pod and other resource types THEN the TypeKro System SHALL import them from the new client version without type errors
2. WHEN using KubeConfig THEN the TypeKro System SHALL configure clusters, users, and contexts correctly
3. WHEN using makeApiClient THEN the TypeKro System SHALL create properly configured API clients
4. WHEN using KubernetesObjectApi THEN the TypeKro System SHALL perform CRUD operations on resources

### Requirement 5

**User Story:** As a developer, I want the module system to be compatible with the project's ESM configuration, so that imports work correctly.

#### Acceptance Criteria

1. WHEN importing from `@kubernetes/client-node` THEN the TypeKro System SHALL use ESM-compatible import syntax
2. WHEN building the project THEN the TypeKro System SHALL compile without module resolution errors
3. WHEN running tests THEN the TypeKro System SHALL execute without ESM-related errors

### Requirement 6

**User Story:** As a developer, I want the authentication mechanisms to continue working, so that I can connect to Kubernetes clusters securely.

#### Acceptance Criteria

1. WHEN loading kubeconfig from default location THEN the TypeKro System SHALL authenticate successfully
2. WHEN using token-based authentication THEN the TypeKro System SHALL include the token in API requests
3. WHEN using certificate-based authentication THEN the TypeKro System SHALL use the certificates correctly
4. WHEN skipTLSVerify is configured THEN the TypeKro System SHALL disable TLS verification as specified

### Requirement 7

**User Story:** As a developer, I want the retry and timeout mechanisms to continue working, so that transient failures are handled gracefully.

#### Acceptance Criteria

1. WHEN an API call times out THEN the TypeKro System SHALL retry according to the configured retry policy
2. WHEN a transient network error occurs THEN the TypeKro System SHALL retry the operation
3. WHEN all retries are exhausted THEN the TypeKro System SHALL throw an appropriate error with context
