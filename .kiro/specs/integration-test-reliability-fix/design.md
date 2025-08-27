# Design Document

## Overview

This design addresses the integration test reliability issues by implementing robust namespace management, consistent Kubernetes client configuration, and improved error handling. The solution focuses on fixing the root causes of test failures while maintaining compatibility with the existing test infrastructure.

## Architecture

### Current Problems Analysis

1. **Client Configuration Issues**: The shared-kubeconfig.ts file contains outdated monkey-patch code that should have been reverted when downgrading to @kubernetes/client-node 0.20.0
2. **Namespace Management**: Tests are failing with 404 errors because namespaces are not being created properly or are being cleaned up prematurely
3. **Test Isolation**: Concurrent tests may be interfering with each other due to shared resources or namespace conflicts
4. **Error Handling**: Poor error messages make it difficult to diagnose cluster connection and setup issues

### Solution Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Integration Test Layer                    │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │   Test Suite A  │  │   Test Suite B  │  │ Test Suite C │ │
│  │   Namespace A   │  │   Namespace B   │  │ Namespace C  │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                 Shared Test Infrastructure                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │         Test Environment Utilities                      │ │
│  │  - TestNamespaceManager for isolation                  │ │
│  │  - Environment validation and setup                    │ │
│  │  - Test-specific configuration helpers                 │ │
│  └─────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                   Core Kubernetes Layer                     │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │         Enhanced Kubernetes API (api.ts)               │ │
│  │  - Centralized client creation functions               │ │
│  │  - Retry logic with exponential backoff               │ │
│  │  - Cluster availability and health checking            │ │
│  │  - Consistent error handling and diagnostics           │ │
│  └─────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │      Kubernetes Client Provider (client-provider.ts)   │ │
│  │  - KubeConfig management and lifecycle                 │ │
│  │  - Security configuration and TLS handling            │ │
│  │  - Singleton pattern for consistent configuration     │ │
│  └─────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                    Kubernetes Cluster                       │
│              (kind cluster: typekro-e2e-test)              │
└─────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### 1. Enhanced KubernetesClientProvider (`src/core/kubernetes/client-provider.ts`)

**Purpose**: Extend the existing KubernetesClientProvider to support all Kubernetes API client types with consistent configuration, caching, and reliability features.

**Key Changes**:
- Add methods for CoreV1Api, AppsV1Api, CustomObjectsApi client creation
- Implement client caching to avoid unnecessary recreation
- Add retry logic with exponential backoff for cluster connections
- Provide cluster availability checking and connection validation
- Maintain consistent security settings across all client types

**Interface**:
```typescript
// Extended KubernetesClientProvider methods
export class KubernetesClientProvider {
  // Existing methods...
  getCoreV1Api(): k8s.CoreV1Api;
  getAppsV1Api(): k8s.AppsV1Api;
  getCustomObjectsApi(): k8s.CustomObjectsApi;
  
  // New reliability methods
  isClusterAvailable(): Promise<boolean>;
  waitForClusterReady(timeout?: number): Promise<void>;
  withRetry<T>(operation: () => Promise<T>, options?: RetryOptions): Promise<T>;
}

// Convenience functions for backward compatibility
export function createCoreV1Api(config?: KubernetesClientConfig): k8s.CoreV1Api;
export function createAppsV1Api(config?: KubernetesClientConfig): k8s.AppsV1Api;
export function createCustomObjectsApi(config?: KubernetesClientConfig): k8s.CustomObjectsApi;
```

### 2. Namespace Lifecycle Manager

**Purpose**: Manage namespace creation, isolation, and cleanup for integration tests.

**Key Features**:
- Generate unique namespace names with timestamps and test identifiers
- Automatic cleanup using test hooks (beforeAll/afterAll)
- Conflict detection and resolution
- Resource labeling for tracking and cleanup

**Interface**:
```typescript
export class TestNamespaceManager {
  constructor(private testSuiteName: string);
  
  async createNamespace(): Promise<string>;
  async cleanupNamespace(namespace: string): Promise<void>;
  async ensureNamespaceReady(namespace: string): Promise<void>;
  
  // Automatic cleanup registration
  registerCleanup(namespace: string): void;
}
```

### 3. Enhanced Error Handling

**Purpose**: Provide clear, actionable error messages for test failures.

**Key Features**:
- Structured error types for different failure scenarios
- Diagnostic information collection
- Retry logic with exponential backoff
- Clear setup instructions for common issues

**Interface**:
```typescript
export class TestEnvironmentError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
    public readonly diagnostics?: Record<string, any>
  );
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options?: RetryOptions
): Promise<T>;
```

### 4. Test Environment Validator

**Purpose**: Validate test environment setup before running tests.

**Key Features**:
- Check cluster availability and health
- Verify required CRDs and controllers
- Validate namespace permissions
- Pre-flight checks for common issues

**Interface**:
```typescript
export interface EnvironmentValidation {
  clusterAvailable: boolean;
  kroControllerReady: boolean;
  namespacesAccessible: boolean;
  requiredCRDs: string[];
  issues: string[];
}

export async function validateTestEnvironment(): Promise<EnvironmentValidation>;
```

## Data Models

### Namespace Metadata
```typescript
interface TestNamespace {
  name: string;
  testSuite: string;
  createdAt: Date;
  labels: Record<string, string>;
  resources: KubernetesResource[];
}
```

### Retry Configuration
```typescript
interface RetryOptions {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  backoffFactor: number;
  retryableErrors: (error: Error) => boolean;
}
```

### Test Environment Status
```typescript
interface TestEnvironmentStatus {
  cluster: {
    available: boolean;
    context: string;
    server: string;
  };
  namespaces: {
    accessible: boolean;
    permissions: string[];
  };
  controllers: {
    kro: boolean;
    flux: boolean;
  };
}
```

## Error Handling

### Error Categories

1. **Cluster Connection Errors**
   - Network connectivity issues
   - Authentication failures
   - TLS certificate problems
   - Context configuration issues

2. **Namespace Management Errors**
   - Permission denied for namespace operations
   - Namespace already exists conflicts
   - Resource quota exceeded
   - Cleanup failures

3. **Resource Deployment Errors**
   - CRD not available
   - Controller not ready
   - Resource validation failures
   - Timeout waiting for readiness

### Error Recovery Strategies

1. **Automatic Retry**: For transient network and API server issues
2. **Graceful Degradation**: Skip tests when cluster is unavailable
3. **Resource Cleanup**: Always attempt cleanup even after failures
4. **Clear Diagnostics**: Provide actionable error messages with next steps

## Testing Strategy

### Unit Tests
- Test namespace generation uniqueness
- Test retry logic with mock failures
- Test error message formatting
- Test cleanup registration and execution

### Integration Tests
- Test actual cluster connection with retry logic
- Test namespace lifecycle in real cluster
- Test concurrent namespace creation
- Test cleanup after test failures

### End-to-End Tests
- Run full test suite with new infrastructure
- Verify no namespace conflicts in parallel execution
- Test recovery from cluster disconnection
- Validate cleanup completeness

## Implementation Phases

### Phase 1: Enhance Kubernetes API Client
- Add centralized client creation functions to src/core/kubernetes/api.ts
- Implement retry logic with exponential backoff for all client types
- Add cluster availability checking and connection validation
- Ensure consistent error handling across all Kubernetes API interactions

### Phase 2: Implement Namespace Lifecycle Manager
- Create TestNamespaceManager class
- Implement unique namespace generation
- Add automatic cleanup registration
- Update test suites to use namespace manager

### Phase 3: Enhanced Error Handling
- Create structured error types
- Implement retry logic with exponential backoff
- Add diagnostic information collection
- Update error messages throughout test suite

### Phase 4: Simplify Test Infrastructure
- Update shared-kubeconfig.ts to use centralized api.ts functions
- Remove test-specific client creation code and monkey-patching
- Create simple wrapper functions that delegate to the main API layer
- Ensure tests use the same reliable client creation as production code

### Phase 5: Test Environment Validation
- Implement environment validation checks
- Add pre-flight validation to test setup
- Create clear setup instructions for failures
- Integrate validation into CI/CD pipeline

### Phase 6: Integration and Validation
- Run full test suite with new infrastructure
- Fix any remaining reliability issues
- Document new test patterns and best practices
- Update CI/CD configuration if needed