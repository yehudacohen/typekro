# Design Document

## Overview

This design outlines a comprehensive unit testing framework for deployment strategies and related components based on code coverage analysis. The framework addresses low-coverage areas identified in the codebase, focusing on deployment strategies, factory implementations, schema proxy systems, and serialization components. The goal is to achieve high test coverage while providing early detection of issues like the recent `createResourcesProxy` bug.

## Coverage Analysis and Targets

Based on the code coverage report, the following components require enhanced unit test coverage:

**High Priority (Low Coverage):**
- `BaseDeploymentStrategy`: 46.67% function coverage → Target: 90%+
- `DirectResourceFactory`: 87.50% function coverage, 68.41% line coverage → Target: 95%+
- `KroResourceFactory`: 57.58% function coverage, 30.71% line coverage → Target: 85%+
- `DirectDeploymentEngine`: 80.39% function coverage, 58.60% line coverage → Target: 90%+
- `schema-proxy.ts`: 70.00% function coverage, 37.62% line coverage → Target: 90%+
- `validation.ts`: 66.67% function coverage, 36.09% line coverage → Target: 85%+

**Medium Priority:**
- `event-streamer.ts`: 0.00% function coverage, 8.33% line coverage
- Various factory implementations with 50% function coverage
- Simple factory functions with minimal coverage

## Architecture

### Test Structure Organization

```
test/unit/
├── deployment-strategies/
│   ├── shared/
│   │   ├── mock-factories.ts          # Reusable mock creation utilities
│   │   ├── test-scenarios.ts          # Common test scenarios and data
│   │   └── assertion-helpers.ts       # Custom assertions for resource references
│   ├── base-strategy-comprehensive.test.ts    # BaseDeploymentStrategy unit tests
│   ├── resource-reference-resolution.test.ts  # Core resource reference testing
│   ├── status-builder-integration.test.ts     # Status builder proxy testing
│   ├── cross-strategy-consistency.test.ts     # Behavior consistency across strategies
│   ├── advanced-error-scenarios.test.ts       # Advanced error handling tests
│   └── regression-prevention.test.ts          # Specific regression test cases
├── factories/
│   ├── direct-resource-factory.test.ts        # DirectResourceFactory unit tests
│   └── kro-resource-factory.test.ts           # KroResourceFactory unit tests
├── deployment/
│   └── direct-deployment-engine.test.ts       # DirectDeploymentEngine unit tests
├── references/
│   ├── schema-proxy.test.ts                   # Schema proxy system unit tests
│   └── reference-resolver.test.ts             # Reference resolution unit tests
├── serialization/
│   ├── validation.test.ts                     # Validation logic unit tests
│   └── yaml-serialization.test.ts             # YAML serialization unit tests
└── integration/
    └── deployment-component-integration.test.ts # Cross-component integration tests
```

### Core Testing Components

#### 1. Mock Infrastructure

**MockDeploymentStrategyFactory**
- Creates testable instances of all deployment strategy types
- Provides configurable mock dependencies (deployment engines, kubeconfig, etc.)
- Supports both success and failure scenarios

**MockResourceBuilder**
- Generates realistic enhanced resources for testing
- Supports various resource types (Deployment, Service, ConfigMap, etc.)
- Provides both valid and edge-case resource configurations

**MockStatusBuilder**
- Configurable status builder functions for testing
- Can simulate various resource reference patterns
- Supports both successful and failing status computation

#### 2. Resource Reference Testing Framework

**ResourceReferenceValidator**
- Validates that resource field access creates proper `KubernetesRef` objects
- Checks CEL expression generation from resource references
- Verifies proxy wrapper behavior

**CELExpressionAnalyzer**
- Parses and validates generated CEL expressions
- Detects invalid references (like `undefined.field`)
- Ensures proper field path construction

#### 3. Cross-Strategy Test Harness

**StrategyBehaviorComparator**
- Runs identical test scenarios across all deployment strategies
- Compares outputs to ensure consistency
- Identifies behavioral differences between strategies

## Components and Interfaces

### Mock Factory Interface

```typescript
interface MockDeploymentStrategyConfig {
  strategyType: 'direct' | 'alchemy' | 'kro';
  mockDeploymentResult?: Partial<DeploymentResult>;
  mockKubeConfig?: Partial<k8s.KubeConfig>;
  shouldFailDeployment?: boolean;
  shouldFailStatusBuilder?: boolean;
}

interface MockResourceConfig {
  resourceType: string;
  hasStatus?: boolean;
  statusFields?: Record<string, any>;
  metadata?: Partial<k8s.V1ObjectMeta>;
}
```

### Test Scenario Definitions

```typescript
interface ResourceReferenceScenario {
  name: string;
  resources: Record<string, MockResourceConfig>;
  statusBuilder: (schema: any, resources: any) => any;
  expectedCELExpressions: string[];
  expectedErrors?: string[];
}

interface CrossStrategyScenario {
  name: string;
  spec: any;
  expectedBehavior: {
    shouldSucceed: boolean;
    expectedStatusFields: string[];
    expectedResourceCount: number;
  };
}
```

### Custom Assertions

```typescript
// Custom Jest matchers for resource reference testing
expect.extend({
  toBeKubernetesRef(received: any): jest.CustomMatcherResult;
  toGenerateValidCEL(received: string): jest.CustomMatcherResult;
  toHaveProxiedResources(received: any): jest.CustomMatcherResult;
  toBehaveLikeOtherStrategies(received: any, others: any[]): jest.CustomMatcherResult;
});
```

## Data Models

### Test Data Structures

**StandardTestResources**
- Predefined set of common Kubernetes resources for testing
- Includes Deployment, Service, ConfigMap, Secret, PVC
- Each resource has realistic metadata, spec, and status fields

**ResourceReferencePatterns**
- Common patterns of resource references used in status builders
- Examples: `resources.webapp.status.readyReplicas`, `resources.database.spec.replicas`
- Both valid and invalid reference patterns for negative testing

**CELExpressionExpectations**
- Expected CEL expressions for each resource reference pattern
- Validation rules for proper CEL syntax and field paths
- Error patterns for invalid references

## Error Handling

### Error Detection Strategies

1. **Proxy Wrapper Detection**
   - Verify that resources passed to status builders are wrapped with `createResourcesProxy`
   - Detect when raw enhanced resources are passed without proxy wrapping
   - Validate that proxy behavior is consistent across all strategies

2. **CEL Expression Validation**
   - Parse generated CEL expressions to ensure valid syntax
   - Check for invalid field references (like `undefined.field`)
   - Verify that resource IDs match expected patterns

3. **Resource Reference Resolution**
   - Test that field access on proxied resources creates `KubernetesRef` objects
   - Validate that reference metadata (resourceId, fieldPath) is correct
   - Ensure that serialization converts references to proper CEL expressions

### Error Reporting

**Detailed Error Messages**
- Clear indication of which deployment strategy failed
- Specific resource reference that caused the issue
- Expected vs actual CEL expression or proxy behavior
- Suggestions for fixing the detected issue

**Regression Detection**
- Specific test cases for known issues (like the `createResourcesProxy` bug)
- Clear labeling of regression tests vs general functionality tests
- Integration with CI/CD to prevent regression deployment

## Testing Strategy

### Unit Test Categories

1. **BaseDeploymentStrategy Comprehensive Tests**
   - Test enhanced proxy creation with metadata generation and status building
   - Verify error scenarios including status builder failures and missing resources
   - Test strategy mode reporting and resource key mapping logic
   - Validate the `createResourcesProxy` integration that was recently fixed

2. **Factory Implementation Tests**
   - **DirectResourceFactory**: Client provider creation, deployment engine initialization, resource resolution
   - **KroResourceFactory**: RGD deployment, instance management, status operations
   - Test factory lifecycle including creation, deployment, rollback, and cleanup
   - Validate error handling for cluster connectivity and configuration issues

3. **Deployment Engine Tests**
   - Test deployment execution including resource application and dependency resolution
   - Verify rollback operations including resource deletion and error recovery
   - Test engine configuration and client provider integration
   - Validate error scenarios including API failures and resource conflicts

4. **Schema Proxy and Reference System Tests**
   - Test `createResourcesProxy` and `createSchemaProxy` functionality
   - Verify proxy behavior with nested objects, arrays, and complex field paths
   - Test reference resolution including CEL expression evaluation
   - Validate error handling for invalid field access patterns

5. **Serialization and Validation Tests**
   - Test ResourceGraphDefinition validation including schema and CEL expressions
   - Verify YAML serialization for resource graphs and status mappings
   - Test validation edge cases including malformed inputs and circular references
   - Validate CEL expression optimization and reference resolution

6. **Cross-Strategy Consistency Tests**
   - Run identical scenarios across DirectDeploymentStrategy, AlchemyDeploymentStrategy, KroDeploymentStrategy
   - Compare outputs to ensure behavioral consistency
   - Identify and document any necessary differences between strategies

7. **Advanced Error Scenario Tests**
   - Test behavior when Kubernetes API calls fail during status hydration
   - Verify error propagation and recovery mechanisms
   - Test timeout scenarios and resource cleanup failures
   - Validate error message quality and debugging information

8. **Regression Prevention Tests**
   - Specific tests for the `createResourcesProxy` issue and other known bugs
   - Tests for prototype corruption issues and global mocking problems
   - Proactive tests for potential future resource reference issues

### Test Execution Strategy

**Fast Feedback Loop**
- All tests should run in under 5 seconds total
- No external dependencies (Kubernetes cluster, network calls)
- Comprehensive mocking of all external systems

**Comprehensive Coverage**
- Test all deployment strategy types
- Cover all common resource reference patterns
- Include both success and failure scenarios

**Clear Test Organization**
- Group tests by functionality (resource references, status builders, etc.)
- Use descriptive test names that explain the scenario being tested
- Include setup and teardown for consistent test isolation

## Performance Considerations

### Test Execution Performance

- Use lightweight mocks instead of real Kubernetes objects where possible
- Cache mock objects that are reused across multiple tests
- Minimize test setup overhead through shared fixtures

### Memory Usage

- Clean up mock objects after each test to prevent memory leaks
- Use factory functions instead of large static test data objects
- Implement proper teardown for any created resources or listeners

## Security Considerations

### Test Data Security

- Ensure test data doesn't contain real credentials or sensitive information
- Use placeholder values for all configuration that might contain secrets
- Validate that test mocks don't accidentally expose real system information

### Test Isolation

- Ensure tests don't interfere with each other's state
- Prevent tests from making real network calls or file system modifications
- Validate that mock configurations are properly isolated between test runs