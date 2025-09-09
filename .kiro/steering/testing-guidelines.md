# Testing Guidelines

## Overview

This document provides comprehensive testing guidance for TypeKro, covering type safety validation, status builder patterns, and integration testing setup. These guidelines ensure that our tests validate real-world usage patterns while maintaining the developer experience that TypeKro promises.

For broader development practices and problem-solving methodology, see [Development Standards](development-standards.md). For understanding the system architecture being tested, refer to the [Architecture Guide](architecture-guide.md).

## Type Safety Testing

### Core Principle

When building TypeScript libraries that emphasize type safety and developer experience, our tests must validate that the type system actually works as intended. Tests should demonstrate real-world usage patterns without circumventing the type system.

### Rules for Type-Safe Testing

#### ❌ NEVER Use Type Assertions in Tests
```typescript
// BAD - This bypasses the type system we're trying to validate
const result = someFunction(value as any);
const ref = resource.status.field as SomeType;
```

#### ✅ ALWAYS Test Real Type Safety
```typescript
// GOOD - This validates that types actually work
const result = someFunction(value); // Should compile without assertions
const ref = resource.status.field; // Should be properly typed
```

#### ❌ NEVER Cast Away Type Errors
```typescript
// BAD - Hiding type issues that users will encounter
DATABASE_HOST: database.status.podIP as any
selector: { app: deploy.metadata?.labels?.app as any }
```

#### ✅ ALWAYS Use Natural TypeScript Patterns
```typescript
// GOOD - This is how real users would write code
DATABASE_HOST: database.status.podIP
selector: { app: deploy.metadata?.labels?.app }
```

### Testing Type Safety Scenarios

#### 1. Cross-Resource References
Test that references between resources work naturally:
```typescript
const database = simple.Deployment({ 
  name: 'db', 
  image: 'postgres',
  id: 'database'
});
const webapp = simple.Deployment({
  name: 'web',
  image: 'nginx',
  env: {
    // This should compile and be type-safe
    DB_HOST: database.status.podIP
  },
  id: 'webapp'
});
```

#### 2. IDE Experience Validation
Tests should validate what developers see in their IDE:
```typescript
// The type system should provide autocomplete and error checking
const deploy = simple.Deployment({ 
  name: 'app', 
  image: 'nginx',
  id: 'deployment'
});

// These should all be properly typed without assertions
expect(deploy.metadata?.name).toBe('app');
expect(deploy.spec?.replicas).toBe(1);

// References should be typed correctly
const statusRef = deploy.status.readyReplicas;
expect(isKubernetesRef(statusRef)).toBe(true);
```

#### 3. Error Scenarios
Test that the type system prevents common mistakes:
```typescript
// These should cause TypeScript compilation errors:
// simple.Deployment({ name: 'test' }); // Missing required 'image'
// simple.Service({ name: 'svc' }); // Missing required 'ports' and 'selector'
```

### Test Structure Guidelines

#### Use Real-World Patterns
```typescript
describe('Developer Experience', () => {
  it('should support natural cross-resource references', () => {
    const db = simple.Deployment({ 
      name: 'database', 
      image: 'postgres',
      id: 'database'
    });
    const api = simple.Deployment({
      name: 'api',
      image: 'node',
      env: {
        DATABASE_URL: db.status.podIP // Natural, no casting
      },
      id: 'api'
    });
    
    // Validate the reference was created correctly
    const dbRef = api.spec?.template?.spec?.containers?.[0]?.env?.find(
      e => e.name === 'DATABASE_URL'
    )?.value;
    
    expect(isKubernetesRef(dbRef)).toBe(true);
  });
});
```

#### Test Compilation Success
```typescript
import { simple } from 'typekro';

describe('Type Safety', () => {
  it('should compile without type assertions', () => {
    // This test passes if TypeScript compilation succeeds
    const deployment = simple.Deployment({
      name: 'test-app',
      image: 'nginx:latest',
      id: 'testDeployment'
    }); // No 'as any' anywhere
    
    expect(deployment).toBeDefined();
    expect(deployment.metadata?.name).toBeDefined();
  });
});
```

### Why Type Safety Testing Matters

1. **Real User Experience**: Tests should mirror how actual developers will use the library
2. **Type System Validation**: We need to prove our types actually work, not bypass them
3. **IDE Experience**: Autocomplete, error checking, and refactoring should work naturally
4. **Regression Prevention**: Type-safe tests catch when we accidentally break the developer experience

### Type Safety Enforcement

- Code reviews should flag any `as any`, `as unknown`, or similar type assertions in tests
- Tests that require type casting indicate a problem with the library design, not the test
- If a test needs type casting, the library API should be improved instead

Remember: **If our tests need `as any`, our users will too - and that defeats the purpose of TypeKro.**

### CRITICAL: Factory Function Type Safety Requirements

**NEVER use `Enhanced<any>` or `any` types in factory functions. This is completely unacceptable and defeats the entire purpose of TypeScript.**

#### ❌ NEVER Do This:
```typescript
export function myFactory(config: MyConfig): Enhanced<any> {
  // This is completely unacceptable - no type safety!
}
```

#### ✅ ALWAYS Do This:
```typescript
export function myFactory(config: MyConfig): Enhanced<MySpec, MyStatus> {
  // Proper type safety with specific spec and status types
}
```

**Requirements:**
- Every factory function MUST return `Enhanced<TSpec, TStatus>` with proper types
- Every CRD factory MUST define proper spec and status interfaces
- All type definitions MUST be based on actual Kubernetes/CRD schemas
- Code reviews MUST reject any factory using `any` types

This principle aligns with the broader [Development Standards](development-standards.md) philosophy of fixing root problems rather than masking symptoms.

## Status Builder Testing

### Supported Patterns

TypeKro automatically converts JavaScript expressions to CEL expressions when they contain resource or schema references. You can write natural JavaScript code and TypeKro handles the conversion seamlessly.

#### ✅ SUPPORTED: Natural JavaScript Expressions

Both `kubernetesComposition` and `toResourceGraph` support natural JavaScript expressions:

```typescript
// In kubernetesComposition
kubernetesComposition(definition, (spec) => {
  const deployment = simple.Deployment({ 
    name: spec.name, 
    image: spec.image,
    id: 'deployment'
  });
  
  // Natural JavaScript expressions - automatically converted to CEL
  return {
    ready: deployment.status.readyReplicas >= spec.replicas,
    url: `https://${spec.hostname}`,
    phase: deployment.status.readyReplicas > 0 ? 'running' : 'pending',
    // JavaScript fallback patterns work perfectly
    endpoint: deployment.status.clusterIP || 'pending',
    replicas: deployment.status.readyReplicas || 0,
  };
});

// In toResourceGraph status builders
toResourceGraph(definition, 
  (schema) => ({ /* resources */ }),
  (_schema, resources) => ({
    // All JavaScript patterns work and are converted to CEL
    ready: resources.webapp.status.readyReplicas >= 1,
    url: `https://${resources.service.status.clusterIP}/api`,
    // Fallback patterns with || operator
    endpoint: resources.service.status.loadBalancer?.ingress?.[0]?.ip || 'pending',
    replicas: resources.webapp.status.readyReplicas || 0,
    // Complex conditional expressions
    phase: resources.webapp.status.readyReplicas === 0 
      ? 'stopped'
      : resources.webapp.status.readyReplicas < resources.webapp.spec.replicas
        ? 'scaling'
        : 'ready',
  })
);
```

#### ✅ SUPPORTED: Explicit CEL (Escape Hatch)

For complex operations not supported by JavaScript-to-CEL conversion:

```typescript
// Use explicit CEL for advanced list operations
podNames: Cel.expr('resources.deployment.status.pods.map(item, item.metadata.name)'),
healthyPods: Cel.expr('size(resources.deployment.status.pods.filter(p, p.status.phase == "Running"))'),
```

### How JavaScript-to-CEL Conversion Works

TypeKro's JavaScript-to-CEL conversion system automatically detects expressions containing resource or schema references and converts them to equivalent CEL expressions. This enables natural JavaScript development while producing CEL expressions for runtime evaluation.

**Supported JavaScript Patterns:**
- Boolean expressions: `a > b`, `a === b`, `a && b`, `a || b`
- Arithmetic: `a + b`, `a * b`, `(a / b) * 100`
- Template literals: `` `https://${host}/api` ``
- Conditional expressions: `condition ? 'yes' : 'no'`
- Fallback patterns: `value || 'default'`
- Optional chaining: `obj?.prop?.nested`
- Complex nested expressions

For more details on this conversion process, see the [Architecture Guide](architecture-guide.md#stage-3-javascript-to-cel-analysis-analysis-time).

### JavaScript-to-CEL Testing Guidelines

When testing JavaScript-to-CEL conversion:

1. **Test Natural JavaScript Patterns**: Verify that common JavaScript expressions convert correctly
2. **Validate Serialization**: Ensure JavaScript expressions serialize to proper CEL format
3. **Test Fallback Patterns**: Verify that `||` operators and optional chaining work correctly
4. **Focus on Real-World Usage**: Test patterns developers actually use

#### Example JavaScript-to-CEL Tests
```typescript
describe('JavaScript to CEL Conversion', () => {
  it('should convert JavaScript boolean expressions to CEL', () => {
    const statusBuilder = (resources) => ({
      ready: resources.deployment.status.readyReplicas > 0
    });
    
    const serialized = serializeStatusBuilder(statusBuilder);
    expect(serialized).toContain('${deployment.status.readyReplicas > 0}');
  });
  
  it('should convert JavaScript fallback patterns to CEL', () => {
    const statusBuilder = (resources) => ({
      replicas: resources.deployment.status.readyReplicas || 0
    });
    
    const serialized = serializeStatusBuilder(statusBuilder);
    expect(serialized).toContain('${deployment.status.readyReplicas || 0}');
  });
  
  it('should convert template literals to CEL', () => {
    const statusBuilder = (schema, resources) => ({
      url: `https://${resources.service.status.clusterIP}/api`
    });
    
    const serialized = serializeStatusBuilder(statusBuilder);
    expect(serialized).toContain('${string(service.status.clusterIP)}');
  });
});
```

### Status Builder Test Writing Guidelines

When writing tests for status builders:

1. **Use natural JavaScript patterns** - write code as developers would
2. **Test both APIs** - `kubernetesComposition` and `toResourceGraph`
3. **Verify conversion accuracy** - ensure JavaScript converts to correct CEL
4. **Test edge cases** - optional chaining, fallbacks, complex expressions
5. **Validate runtime behavior** - test that CEL expressions evaluate correctly
- Tests should validate CEL expression generation, not JavaScript runtime behavior
- Code reviews should ensure status builder tests use only supported patterns## Integra
tion Testing

### Overview

Integration tests in TypeKro require a real Kubernetes cluster to validate actual resource deployment and readiness evaluation. This section explains how to set up the test environment and run integration tests effectively.

### Cluster Setup

#### If You Don't Have a Cluster

**Use the e2e-setup script to create a test cluster:**

```bash
bun run scripts/e2e-setup.ts
```

For detailed tooling setup and environment configuration, see [Tooling Requirements](tooling-requirements.md).

This script will:
- Create a kind cluster named `typekro-e2e-test`
- Set up the `typekro-test` namespace
- Install necessary components (Kro controller, Flux, etc.)
- Configure kubectl context properly

#### If You Have an Existing Cluster

Ensure your cluster has:
- Kro controller installed
- Flux controllers installed (for Helm integration tests)
- A `typekro-test` namespace
- Proper RBAC permissions

### Running Integration Tests

#### For Development and Debugging Single Tests

**IMPORTANT**: For running individual test files during development, use this workflow:

1. **Set up the cluster once** (only needs to be done once):
   ```bash
   bun run scripts/e2e-setup.ts
   ```

2. **Run individual test files** (can be repeated many times):
   ```bash
   bun test test/integration/cilium/integration.test.ts
   ```

3. **Enable debug logging** (if needed):
   ```bash
   TYPEKRO_LOG_LEVEL=debug bun test test/integration/cilium/integration.test.ts
   ```

4. **Clean up when done** (optional):
   ```bash
   bun run scripts/e2e-cleanup.sh
   ```

#### For CI/CD and Full Test Runs

**All Integration Tests** (sets up cluster, runs all tests, cleans up):
```bash
bun run test:integration
```

**Debug Mode** (runs all tests, leaves cluster alive for debugging):
```bash
bun run test:integration:debug
```

#### Key Differences

- `bun test <file>` - Runs a single test file against existing cluster
- `bun run test:integration` - Runs ALL tests, destroys cluster after
- `bun run test:integration:debug` - Runs ALL tests, leaves cluster for debugging
- `TYPEKRO_LOG_LEVEL=debug` - Enables debug logging for any test command

### Test Timeouts

Integration tests use reasonable timeouts:
- Resource creation: 60 seconds
- Readiness evaluation: 120 seconds
- Complete deployment: 300 seconds (5 minutes)

If tests consistently timeout, check cluster resources and network connectivity.

### Troubleshooting Integration Tests

#### If Tests Timeout

1. **Check cluster status:**
   ```bash
   kubectl get nodes
   kubectl get pods -A
   ```

2. **Check test namespace:**
   ```bash
   kubectl get all -n typekro-test
   ```

3. **Check Kro controller:**
   ```bash
   kubectl get pods -n kro-system
   kubectl logs -n kro-system deployment/kro-controller-manager
   ```

4. **Check Flux controllers:**
   ```bash
   kubectl get pods -n flux-system
   kubectl logs -n flux-system deployment/source-controller
   kubectl logs -n flux-system deployment/helm-controller
   ```

#### If Resources Don't Deploy

1. **Check resource creation:**
   ```bash
   kubectl get helmrepositories -A
   kubectl get helmreleases -A
   ```

2. **Check resource status:**
   ```bash
   kubectl describe helmrepository <name> -n <namespace>
   kubectl describe helmrelease <name> -n <namespace>
   ```

3. **Check events:**
   ```bash
   kubectl get events -n typekro-test --sort-by='.lastTimestamp'
   ```

#### Common Integration Test Issues

1. **Cluster Not Ready**: Ensure all system pods are running before starting tests
2. **Resource Conflicts**: Clean up resources between test runs to avoid conflicts
3. **Network Issues**: Check that the cluster can pull container images
4. **RBAC Problems**: Verify that the test service account has necessary permissions
5. **Controller Issues**: Ensure Kro and Flux controllers are healthy and responsive

### Integration Test Best Practices

1. **Always use the e2e-setup script** for consistent test environments
2. **Run integration tests in isolation** to avoid resource conflicts
3. **Check cluster state** before running tests if they're failing
4. **Use kubectl for debugging** when tests don't behave as expected
5. **Keep the cluster running** between test runs for faster iteration
6. **Clean up resources** after tests complete to avoid state pollution
7. **Use meaningful test names** that describe what functionality is being tested
8. **Test both success and failure scenarios** where appropriate
9. **Validate actual Kubernetes state** not just TypeKro internal state
10. **Use appropriate timeouts** based on the complexity of the deployment

### Integration Test Structure

#### Recommended Test Organization
```typescript
describe('Integration: Feature Name', () => {
  beforeAll(async () => {
    // Set up test environment
    // Ensure cluster is ready
  });

  afterAll(async () => {
    // Clean up test resources
    // Leave cluster in clean state
  });

  it('should deploy resources successfully', async () => {
    // Test resource deployment
    // Validate Kubernetes state
  });

  it('should handle readiness evaluation', async () => {
    // Test readiness checking
    // Validate status updates
  });

  it('should clean up resources properly', async () => {
    // Test resource cleanup
    // Validate complete removal
  });
});
```

#### Test Environment Validation
```typescript
beforeAll(async () => {
  // Verify cluster connectivity
  const nodes = await kubectl.getNodes();
  expect(nodes.length).toBeGreaterThan(0);

  // Verify required controllers
  const kroController = await kubectl.getPods('kro-system');
  expect(kroController.some(pod => pod.status.phase === 'Running')).toBe(true);

  // Verify test namespace
  await kubectl.ensureNamespace('typekro-test');
});
```

### Cleanup and Maintenance

#### Cluster Cleanup

The e2e-setup script creates a persistent cluster for debugging. To clean up:

```bash
bun run scripts/e2e-cleanup.sh
```

#### Resource Cleanup

Always clean up test resources to prevent interference between test runs:

```typescript
afterEach(async () => {
  // Clean up resources created in this test
  await kubectl.deleteAllInNamespace('typekro-test');
  
  // Wait for cleanup to complete
  await kubectl.waitForNamespaceEmpty('typekro-test');
});
```

### Integration Testing with Different Deployment Strategies

#### Testing Direct Deployment
```typescript
it('should deploy using direct strategy', async () => {
  const factory = graph.factory('direct', { 
    namespace: 'typekro-test',
    waitForReady: true 
  });
  
  const instance = await factory.deploy({ name: 'test-app', image: 'nginx', replicas: 1 });
  
  // Validate direct Kubernetes resources
  const deployment = await kubectl.getDeployment('test-app', 'typekro-test');
  expect(deployment.status.readyReplicas).toBeGreaterThan(0);
});
```

#### Testing Kro Deployment
```typescript
it('should deploy using kro strategy', async () => {
  const factory = graph.factory('kro', { 
    namespace: 'typekro-test',
    waitForReady: true 
  });
  
  const instance = await factory.deploy({ name: 'test-app', image: 'nginx', replicas: 1 });
  
  // Validate ResourceGraphDefinition and instance
  const rgd = await kubectl.getResourceGraphDefinition('test-app');
  expect(rgd.status.phase).toBe('Ready');
});
```

Remember: **Integration tests validate the complete system behavior in a real Kubernetes environment. They should test actual deployment scenarios that users will encounter.**