# External Manifest Compatibility Guide

## Overview

This document describes how to handle compatibility issues when deploying external Kubernetes manifests (like Flux, Cert-Manager, etc.) that may not be compatible with newer Kubernetes versions.

## The Problem

External projects may ship CRDs and manifests that work on older Kubernetes versions but fail validation on newer versions. Common issues include:

1. **CRD Schema Validation (K8s 1.33+)**: Kubernetes 1.33 introduced stricter OpenAPI schema validation for CRDs. Fields using `x-kubernetes-preserve-unknown-fields: true` now require a `type` field.

2. **API Version Deprecations**: Older manifests may use deprecated API versions that are removed in newer Kubernetes releases.

3. **Field Validation Changes**: New Kubernetes versions may add required fields or change validation rules.

## Solution Architecture

### Principle: Keep Generic Components Agnostic

The `yamlFile` factory and other generic deployment components should remain agnostic to specific compatibility issues. Instead:

1. **Create utility functions** in `src/core/utils/` for specific fixes
2. **Apply fixes in bootstrap compositions** that use the external manifests
3. **Use the `manifestTransform` option** to apply fixes at deployment time

### Implementation Pattern

#### 1. Create a Utility Function

Create a utility in `src/core/utils/` that handles the specific compatibility issue:

```typescript
// src/core/utils/crd-schema-fix.ts
import type { KubernetesResource } from '../types/kubernetes.js';

/**
 * Fix CRD schema validation issues for Kubernetes 1.33+
 */
export function fixCRDSchemaForK8s133(manifest: KubernetesResource): KubernetesResource {
  if (manifest.kind !== 'CustomResourceDefinition') {
    return manifest;
  }
  // Apply fixes...
  return fixedManifest;
}
```

#### 2. Use in Bootstrap Composition

Apply the fix in the specific bootstrap that needs it:

```typescript
// src/core/composition/typekro-runtime/typekro-runtime.ts
import { fixCRDSchemaForK8s133 } from '../../utils/crd-schema-fix.js';

yamlFile({
  name: 'flux-system-install',
  path: `https://github.com/fluxcd/flux2/releases/download/${fluxVersion}/install.yaml`,
  deploymentStrategy: 'skipIfExists',
  manifestTransform: fixCRDSchemaForK8s133,  // Apply the fix here
});
```

### The `manifestTransform` Option

The `yamlFile` factory supports a `manifestTransform` option that allows transforming each manifest before deployment:

```typescript
interface YamlFileConfig {
  name: string;
  path: string;
  namespace?: string | KubernetesRef<string>;
  deploymentStrategy?: 'replace' | 'skipIfExists' | 'fail' | 'serverSideApply';
  /**
   * Optional transform function to apply to each manifest before deployment.
   */
  manifestTransform?: (manifest: KubernetesResource) => KubernetesResource;
  /**
   * Field manager name for server-side apply operations.
   * Only used when deploymentStrategy is 'serverSideApply'.
   * @default 'typekro'
   */
  fieldManager?: string;
  /**
   * Force conflicts during server-side apply.
   * When true, takes ownership of conflicting fields from other managers.
   * Only used when deploymentStrategy is 'serverSideApply'.
   * @default false
   */
  forceConflicts?: boolean;
}
```

### Server-Side Apply Strategy

The `serverSideApply` deployment strategy is recommended for CRD updates because it:

1. **Merges changes** instead of replacing the entire resource
2. **Tracks field ownership** to prevent conflicts with other controllers
3. **Preserves fields** managed by other controllers (like manual patches)

```typescript
yamlFile({
  name: 'flux-system-install',
  path: `https://github.com/fluxcd/flux2/releases/download/${fluxVersion}/install.yaml`,
  deploymentStrategy: 'serverSideApply',
  fieldManager: 'typekro-bootstrap',
  forceConflicts: false,  // Don't override manual patches
  manifestTransform: smartFixCRDSchemaForK8s133,
});
```

## Current Compatibility Fixes

### Kubernetes 1.33+ CRD Schema Fix

**Issue**: Flux CRDs have two problems with Kubernetes 1.33+:
1. Fields use `x-kubernetes-preserve-unknown-fields: true` without a `type` field
2. The `spec.values` field (for Helm values) lacks `x-kubernetes-preserve-unknown-fields: true`, causing Kubernetes to reject arbitrary Helm values

**Fix**: `fixCRDSchemaForK8s133` and `smartFixCRDSchemaForK8s133` in `src/core/utils/crd-schema-fix.ts`

This fix provides two functions:

1. **`fixCRDSchemaForK8s133(manifest)`**: Always applies the fix to CRDs
2. **`smartFixCRDSchemaForK8s133(manifest)`**: Only applies the fix if the CRD actually needs it (recommended)

The fix:
1. Adds `type: object` to any field with `x-kubernetes-preserve-unknown-fields: true` but no type
2. Adds `x-kubernetes-preserve-unknown-fields: true` to known fields like `values`, `valuesFrom`, and `postRenderers` that need to accept arbitrary user-defined values

**Helper functions**:
- `needsCRDSchemaFix(manifest)`: Check if a CRD needs the fix (returns `{ needsFix: boolean, issues: string[] }`)
- `fixCRDSchemasForK8s133(manifests)`: Apply fix to an array of manifests
- `smartFixCRDSchemasForK8s133(manifests)`: Smart fix for an array of manifests

**Applied in**: `typeKroRuntimeBootstrap` composition

**Error messages**:
```
# Missing type field error:
CustomResourceDefinition.apiextensions.k8s.io "helmreleases.helm.toolkit.fluxcd.io" is invalid: 
spec.versions[0].schema.openAPIV3Schema.properties[spec].properties[values].type: 
Required value: must not be empty for specified object fields

# Missing x-kubernetes-preserve-unknown-fields error (when deploying HelmRelease):
HelmRelease.helm.toolkit.fluxcd.io "my-release" is invalid:
spec.values: Invalid value: "object": unknown field "myCustomValue" not allowed
```

### Important: Deployment Strategy Considerations

The `typeKroRuntimeBootstrap` uses `deploymentStrategy: 'skipIfExists'` for the Flux installation. This means:

1. **First-time deployment**: The CRD fix is applied correctly
2. **Subsequent deployments**: Existing CRDs are skipped, so the fix is NOT re-applied

**If you have existing Flux CRDs without the fix**, you have two options:

#### Option 1: Delete and Re-deploy (Recommended for Development)
```bash
# Delete existing Flux CRDs (WARNING: This will delete all Flux resources!)
kubectl delete crd helmreleases.helm.toolkit.fluxcd.io
kubectl delete crd helmrepositories.source.toolkit.fluxcd.io
# ... delete other Flux CRDs

# Re-run the bootstrap - the fix will be applied
```

#### Option 2: Manually Apply the Fix
```bash
# Get the current CRD
kubectl get crd helmreleases.helm.toolkit.fluxcd.io -o yaml > helmrelease-crd.yaml

# Edit the YAML to add:
# 1. type: object to fields with x-kubernetes-preserve-unknown-fields
# 2. x-kubernetes-preserve-unknown-fields: true to spec.values

# Apply the fixed CRD
kubectl apply -f helmrelease-crd.yaml
```

#### Option 3: Use Server-Side Apply Strategy (Recommended for Production)
For production clusters where you want to update CRDs without disruption:

```typescript
yamlFile({
  name: 'flux-system-install',
  path: `https://github.com/fluxcd/flux2/releases/download/${fluxVersion}/install.yaml`,
  deploymentStrategy: 'serverSideApply',
  fieldManager: 'typekro-bootstrap',
  forceConflicts: false,  // Preserve manual patches
  manifestTransform: smartFixCRDSchemaForK8s133,
});
```

Server-side apply is safer because it:
- Merges changes instead of replacing the entire resource
- Preserves fields managed by other controllers
- Tracks field ownership to prevent conflicts

#### Option 4: Use 'replace' Strategy (For Fresh Clusters)
If you're setting up a fresh cluster and want to ensure the fix is always applied:

```typescript
yamlFile({
  name: 'flux-system-install',
  path: `https://github.com/fluxcd/flux2/releases/download/${fluxVersion}/install.yaml`,
  deploymentStrategy: 'replace',  // Always apply, even if exists
  manifestTransform: fixCRDSchemaForK8s133,
});
```

**Warning**: Using `replace` on CRDs can cause brief disruption to existing resources.

## Adding New Compatibility Fixes

When you encounter a new compatibility issue:

### 1. Identify the Root Cause

- Check the error message for specific validation failures
- Identify which Kubernetes version introduced the stricter validation
- Determine if this is a widespread issue or specific to certain manifests

### 2. Create a Utility Function

```typescript
// src/core/utils/your-fix.ts
import type { KubernetesResource } from '../types/kubernetes.js';

/**
 * Document the issue and the fix
 */
export function yourFix(manifest: KubernetesResource): KubernetesResource {
  // Only apply to relevant resources
  if (!shouldApplyFix(manifest)) {
    return manifest;
  }
  
  // Deep clone to avoid mutating original
  const fixed = JSON.parse(JSON.stringify(manifest));
  
  // Apply fixes
  // ...
  
  return fixed;
}
```

### 3. Apply in the Appropriate Bootstrap

```typescript
import { yourFix } from '../../utils/your-fix.js';

yamlFile({
  name: 'external-manifests',
  path: 'https://example.com/manifests.yaml',
  manifestTransform: yourFix,
});
```

### 4. Document the Fix

Add an entry to this document describing:
- The issue and error message
- Which Kubernetes versions are affected
- Which external projects are affected
- The fix that was applied

## Best Practices

### DO

- Keep fixes isolated in utility functions
- Document why the fix is needed
- Apply fixes only to the specific bootstraps that need them
- Test with both old and new Kubernetes versions when possible
- Check if upstream projects have fixed the issue in newer versions

### DON'T

- Add fixes to generic components like `yamlFile` itself
- Apply fixes globally when they're only needed for specific manifests
- Assume all CRDs need the same fix
- Forget to document the fix for future maintainers

## Monitoring for Upstream Fixes

When applying compatibility fixes, track the upstream issue:

1. **Flux CRD Schema Issue**: Monitor Flux releases for when they add `type: object` to fields with `x-kubernetes-preserve-unknown-fields`
2. **Version Updates**: When updating external dependency versions, test if the fix is still needed

## Testing Compatibility Fixes

```typescript
describe('CRD Schema Fix', () => {
  it('should add type: object to fields with x-kubernetes-preserve-unknown-fields', () => {
    const crd = {
      kind: 'CustomResourceDefinition',
      spec: {
        versions: [{
          schema: {
            openAPIV3Schema: {
              properties: {
                spec: {
                  properties: {
                    values: {
                      'x-kubernetes-preserve-unknown-fields': true,
                      // No type field
                    }
                  }
                }
              }
            }
          }
        }]
      }
    };
    
    const fixed = fixCRDSchemaForK8s133(crd);
    
    expect(fixed.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.values.type)
      .toBe('object');
  });
});
```

## Related Documentation

- [Architecture Guide](architecture-guide.md) - Overall system architecture
- [Development Standards](development-standards.md) - Code quality standards
- [Tooling Requirements](tooling-requirements.md) - Build and test tooling
