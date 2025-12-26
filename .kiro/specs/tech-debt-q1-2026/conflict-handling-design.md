# Conflict Handling and Kro CEL Schema Design

## Problem Statement

### Issue 1: 409 AlreadyExists Errors
When deploying resources, the framework throws errors when resources already exist in the cluster. This causes test failures and poor user experience when:
- Running tests multiple times without cleanup
- Deploying to clusters with existing resources
- Idempotent deployment scenarios

### Issue 2: Kro CEL Schema Errors
The Kro controller fails to process HelmRelease resources with arbitrary `spec.values`:
```
failed to extract CEL expressions from schema for resource helmRelease: 
error getting field schema for path spec.values.cluster: schema not found for field cluster
```

This happens because:
1. HelmRelease `spec.values` uses `x-kubernetes-preserve-unknown-fields: true`
2. Kro tries to extract CEL expressions from all fields
3. Kro doesn't have a schema for arbitrary Helm values fields

## Implemented Solutions

### Solution 1: Conflict Strategy Configuration (IMPLEMENTED)

#### DirectDeploymentEngine (src/core/deployment/engine.ts)

Added `conflictStrategy` option to `DeploymentOptions`:

```typescript
export type ConflictStrategy = 'warn' | 'fail' | 'patch' | 'replace';

export interface DeploymentOptions {
  // ... existing options ...
  
  /**
   * Strategy for handling resource conflicts (409 AlreadyExists)
   * - 'warn': Log warning and treat as success (default)
   * - 'fail': Throw error on conflict
   * - 'patch': Attempt to patch the existing resource
   * - 'replace': Delete and recreate the resource
   */
  conflictStrategy?: ConflictStrategy;
}
```

**Default Behavior**: `'warn'` - Log a warning and continue, treating the existing resource as successfully deployed.

**Implementation in engine.ts**:
- On 409 error, checks `conflictStrategy` option
- `'warn'`: Logs warning, fetches existing resource, returns it as deployed
- `'fail'`: Throws `ResourceConflictError`
- `'patch'`: Attempts strategic merge patch
- `'replace'`: Deletes then creates

#### Integration Test Utilities (test/integration/shared-kubeconfig.ts)

Added utility functions for integration tests that use raw k8sApi calls:

```typescript
// Create resource with conflict handling
export async function createResourceWithConflictHandling<T>(
  k8sApi: k8s.KubernetesObjectApi,
  resource: T | { toJSON?: () => T },
  options: CreateResourceOptions = {}
): Promise<T>

// Delete resource if it exists (ignores 404)
export async function deleteResourceIfExists(
  k8sApi: k8s.KubernetesObjectApi,
  resource: k8s.KubernetesObject,
  verbose = true
): Promise<boolean>
```

### Solution 2: Kro Helm Values Handling (DOCUMENTED)

The Kro controller issue is a known limitation. When creating ResourceGraphDefinitions that include HelmRelease resources with arbitrary values, the values field cannot contain CEL expressions that Kro will try to evaluate.

**Recommended Approaches**:

1. **Use Direct Deployment for Helm**: For HelmRelease resources with complex values, use direct deployment strategy instead of Kro
2. **Static Values Only**: Ensure HelmRelease `spec.values` only contains static values, not CEL expressions
3. **Simple CEL Expressions**: Use `has(helmRelease.status)` style expressions that don't reference nested values fields

**Example of Working Pattern**:
```typescript
// In kubernetesComposition status builder:
return {
  // Use has() to check for status existence - doesn't require schema for values
  phase: Cel.expr<string>('has(helmRelease.status) ? "Ready" : "Installing"'),
  ready: Cel.expr<boolean>('has(helmRelease.status)'),
  // Use static values for fields that would reference spec.values
  version: '1.18.1',
  encryptionEnabled: true,
};
```

## Test Updates (COMPLETED)

Updated integration tests to:
1. Use `createResourceWithConflictHandling()` with `conflictStrategy: 'warn'` by default
2. Use `deleteResourceIfExists()` for cleanup to handle missing resources gracefully
3. Validate core structure (chart name, repository URL) rather than specific values that may differ

### Updated Tests:
- `test/integration/cert-manager/helm-integration.test.ts`
- `test/integration/external-dns/helm-integration.test.ts`

### Remaining Tests to Update:
- `test/integration/cilium/bootstrap-composition.test.ts`
- `test/integration/apisix/helm-integration.test.ts`
- `test/integration/pebble/helm-integration.test.ts`
