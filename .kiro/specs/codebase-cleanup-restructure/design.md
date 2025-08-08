# Codebase Cleanup and Restructure Design

## Overview

This design outlines a comprehensive approach to cleaning up and restructuring the TypeKro codebase. The focus is on implementing modern TypeScript tooling, eliminating dead code, improving organization, and establishing maintainable patterns that will support long-term development.

## Architecture

### Linting and Code Quality Tools

```typescript
// Recommended tooling stack for bun compatibility
interface ToolingStack {
  linter: '@typescript-eslint/eslint-plugin' | 'biome';
  formatter: 'prettier' | 'biome';
  typeChecker: 'typescript';
  bundleAnalyzer: 'bun-analyzer' | 'webpack-bundle-analyzer';
}
```

**Tool Selection Criteria:**
- **Biome**: Fast, bun-compatible, all-in-one solution (linting + formatting)
- **ESLint + Prettier**: More mature ecosystem, extensive plugin support
- **TypeScript**: Continue using for type checking

### Proposed Directory Structure

```
src/
├── core/
│   ├── types/                    # Type definitions organized by domain
│   │   ├── index.ts             # Main type exports
│   │   ├── kubernetes.ts        # Kubernetes-related types
│   │   ├── references.ts        # Reference and proxy types
│   │   ├── serialization.ts     # Serialization types
│   │   └── deployment.ts        # Deployment-specific types
│   ├── deployment/              # Direct deployment functionality
│   │   ├── index.ts
│   │   ├── engine.ts            # DirectDeploymentEngine
│   │   ├── readiness.ts         # Resource readiness checking
│   │   ├── rollback.ts          # Rollback functionality
│   │   └── types.ts             # Deployment-specific types
│   ├── serialization/           # Kro serialization and YAML generation
│   │   ├── index.ts
│   │   ├── serializer.ts        # Main serialization logic
│   │   ├── yaml-generator.ts    # YAML generation
│   │   └── resource-processor.ts # Resource processing
│   ├── references/              # Reference resolution system
│   │   ├── index.ts
│   │   ├── resolver.ts          # ReferenceResolver
│   │   ├── cel-evaluator.ts     # CEL expression evaluation
│   │   └── schema-proxy.ts      # Schema proxy functionality
│   ├── dependencies/            # Dependency analysis and resolution
│   │   ├── index.ts
│   │   ├── resolver.ts          # DependencyResolver
│   │   ├── graph.ts             # DependencyGraph
│   │   └── analysis.ts          # Dependency analysis utilities
│   └── factory.ts               # Core factory utilities (createResource, etc.)
├── factories/                   # Resource factory functions organized by ecosystem
│   ├── index.ts                 # Main factory exports
│   ├── kubernetes/              # Kubernetes resource factories
│   │   ├── index.ts
│   │   ├── workloads/           # Workload resources
│   │   │   ├── index.ts
│   │   │   ├── deployment.ts    # deployment()
│   │   │   ├── job.ts           # job()
│   │   │   ├── stateful-set.ts  # statefulSet()
│   │   │   ├── cron-job.ts      # cronJob()
│   │   │   ├── daemon-set.ts    # daemonSet()
│   │   │   ├── replica-set.ts   # replicaSet()
│   │   │   └── replication-controller.ts # replicationController()
│   │   ├── networking/          # Networking resources
│   │   │   ├── index.ts
│   │   │   ├── service.ts       # service()
│   │   │   ├── ingress.ts       # ingress()
│   │   │   ├── network-policy.ts # networkPolicy()
│   │   │   ├── endpoints.ts     # endpoints()
│   │   │   ├── endpoint-slice.ts # endpointSlice()
│   │   │   └── ingress-class.ts # ingressClass()
│   │   ├── storage/             # Storage resources
│   │   │   ├── index.ts
│   │   │   ├── persistent-volume.ts # persistentVolume()
│   │   │   ├── persistent-volume-claim.ts # persistentVolumeClaim()
│   │   │   ├── storage-class.ts # storageClass()
│   │   │   ├── volume-attachment.ts # volumeAttachment()
│   │   │   ├── csi-driver.ts    # csiDriver()
│   │   │   └── csi-node.ts      # csiNode()
│   │   ├── rbac/                # RBAC resources
│   │   │   ├── index.ts
│   │   │   ├── role.ts          # role()
│   │   │   ├── role-binding.ts  # roleBinding()
│   │   │   ├── cluster-role.ts  # clusterRole()
│   │   │   ├── cluster-role-binding.ts # clusterRoleBinding()
│   │   │   └── service-account.ts # serviceAccount()
│   │   ├── config/              # Configuration resources
│   │   │   ├── index.ts
│   │   │   ├── config-map.ts    # configMap()
│   │   │   └── secret.ts        # secret()
│   │   ├── policy/              # Policy resources
│   │   │   ├── index.ts
│   │   │   ├── pod-disruption-budget.ts # podDisruptionBudget()
│   │   │   ├── resource-quota.ts # resourceQuota()
│   │   │   └── limit-range.ts   # limitRange()
│   │   ├── core/                # Core Kubernetes resources
│   │   │   ├── index.ts
│   │   │   ├── pod.ts           # pod()
│   │   │   ├── namespace.ts     # namespace()
│   │   │   ├── node.ts          # node()
│   │   │   └── component-status.ts # componentStatus()
│   │   ├── autoscaling/         # Autoscaling resources
│   │   │   ├── index.ts
│   │   │   ├── horizontal-pod-autoscaler.ts # horizontalPodAutoscaler()
│   │   │   └── horizontal-pod-autoscaler-v1.ts # horizontalPodAutoscalerV1()
│   │   ├── certificates/        # Certificate resources
│   │   │   ├── index.ts
│   │   │   └── certificate-signing-request.ts # certificateSigningRequest()
│   │   ├── coordination/        # Coordination resources
│   │   │   ├── index.ts
│   │   │   └── lease.ts         # lease()
│   │   ├── admission/           # Admission control resources
│   │   │   ├── index.ts
│   │   │   ├── mutating-webhook-configuration.ts # mutatingWebhookConfiguration()
│   │   │   └── validating-webhook-configuration.ts # validatingWebhookConfiguration()
│   │   ├── extensions/          # Extension resources
│   │   │   ├── index.ts
│   │   │   └── custom-resource-definition.ts # customResourceDefinition()
│   │   └── scheduling/          # Scheduling resources
│   │       ├── index.ts
│   │       ├── priority-class.ts # priorityClass()
│   │       └── runtime-class.ts # runtimeClass()
│   ├── helm/                    # Future: Helm chart factories
│   │   ├── index.ts
│   │   ├── chart.ts             # helmChart()
│   │   └── release.ts           # helmRelease()
│   ├── crossplane/              # Future: Crossplane resource factories
│   │   ├── index.ts
│   │   ├── composition.ts       # crossplaneComposition()
│   │   └── composite-resource-definition.ts # crossplaneXRD()
│   ├── argocd/                  # Future: ArgoCD resource factories
│   │   ├── index.ts
│   │   ├── application.ts       # argoApplication()
│   │   └── app-project.ts       # argoAppProject()
│   └── kustomize/               # Future: Kustomize resource factories
│       ├── index.ts
│       ├── kustomization.ts     # kustomization()
│       └── patch.ts             # kustomizePatch()
│   └── utils/                   # Shared utilities
│       ├── index.ts
│       ├── type-guards.ts       # Type guard functions
│       └── helpers.ts           # General helper functions
├── alchemy/                     # Alchemy integration (existing)
└── index.ts                     # Main package exports
```

### Code Organization Principles

1. **Domain-Driven Structure**: Group related functionality together
2. **Clear Boundaries**: Each module has a specific responsibility
3. **Minimal Coupling**: Reduce dependencies between modules
4. **Consistent Exports**: Use index.ts files for clean public APIs
5. **Type Co-location**: Keep types close to their usage
6. **Ecosystem Separation**: Organize factories by target ecosystem (Kubernetes, Helm, etc.)
7. **Resource Type Grouping**: Group similar resources within each ecosystem

### Factory Organization Strategy

The current monolithic `factory.ts` file (865 lines) will be restructured into a hierarchical organization that supports both current Kubernetes resources and future ecosystem expansion.

**Current State Problems**:
- Single 865-line file with 40+ factory functions
- All resource types mixed together without clear organization
- Difficult to navigate and maintain
- No clear path for adding non-Kubernetes resources

**Proposed Factory Architecture**:

```typescript
// Factory organization by ecosystem and resource type
interface FactoryOrganization {
  kubernetes: {
    workloads: ['deployment', 'job', 'statefulSet', 'cronJob', 'daemonSet', 'replicaSet', 'replicationController'];
    networking: ['service', 'ingress', 'networkPolicy', 'endpoints', 'endpointSlice', 'ingressClass'];
    storage: ['persistentVolume', 'persistentVolumeClaim', 'storageClass', 'volumeAttachment', 'csiDriver', 'csiNode'];
    rbac: ['role', 'roleBinding', 'clusterRole', 'clusterRoleBinding', 'serviceAccount'];
    config: ['configMap', 'secret'];
    policy: ['podDisruptionBudget', 'resourceQuota', 'limitRange'];
    core: ['pod', 'namespace', 'node', 'componentStatus'];
    autoscaling: ['horizontalPodAutoscaler', 'horizontalPodAutoscalerV1'];
    certificates: ['certificateSigningRequest'];
    coordination: ['lease'];
    admission: ['mutatingWebhookConfiguration', 'validatingWebhookConfiguration'];
    extensions: ['customResourceDefinition'];
    scheduling: ['priorityClass', 'runtimeClass'];
  };
  // Future ecosystems
  helm: ['chart', 'release'];
  crossplane: ['composition', 'compositeResourceDefinition'];
  argocd: ['application', 'appProject'];
  kustomize: ['kustomization', 'patch'];
}
```

**Factory File Structure Pattern**:
```typescript
// Example: factories/kubernetes/workloads/deployment.ts
import { createResource } from '../../../core/factory.js';
import type { V1Deployment, V1DeploymentSpec, V1DeploymentStatus } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types.js';

export function deployment(resource: V1Deployment): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  // Factory implementation
  return createResource({
    ...resource,
    apiVersion: resource.apiVersion || 'apps/v1',
    kind: resource.kind || 'Deployment'
  });
}
```

**Index File Pattern**:
```typescript
// factories/kubernetes/workloads/index.ts
export { deployment } from './deployment.js';
export { job } from './job.js';
export { statefulSet } from './stateful-set.js';
export { cronJob } from './cron-job.js';
export { daemonSet } from './daemon-set.js';
export { replicaSet } from './replica-set.js';
export { replicationController } from './replication-controller.js';

// factories/kubernetes/index.ts
export * from './workloads/index.js';
export * from './networking/index.js';
export * from './storage/index.js';
export * from './rbac/index.js';
export * from './config/index.js';
export * from './policy/index.js';
export * from './core/index.js';
export * from './autoscaling/index.js';
export * from './certificates/index.js';
export * from './coordination/index.js';
export * from './admission/index.js';
export * from './extensions/index.js';
export * from './scheduling/index.js';

// factories/index.ts
export * from './kubernetes/index.js';
// Future:
// export * from './helm/index.js';
// export * from './crossplane/index.js';
// export * from './argocd/index.js';
// export * from './kustomize/index.js';
```

**Benefits of Factory Reorganization**:

1. **Scalability**: Easy to add new ecosystems without affecting existing code
2. **Maintainability**: Small, focused files instead of 865-line monolith
3. **Team Collaboration**: Multiple developers can work on different resource types
4. **Better IDE Experience**: Faster navigation and autocomplete
5. **Selective Imports**: Better tree-shaking and bundle optimization
6. **Clear Ownership**: Each file has a single, clear responsibility
7. **Future-Proof**: Structure supports Helm, Crossplane, ArgoCD, Kustomize expansion

**Migration Strategy**:
1. Create new directory structure with placeholder files
2. Move factory functions one category at a time
3. Update imports incrementally
4. Maintain backward compatibility through re-exports
5. Remove old factory.ts once migration is complete

## Implementation Strategy

### Phase 1: Tooling Setup

**Biome Integration** (Recommended for bun compatibility):
```json
// biome.json
{
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noExplicitAny": "error",
        "noUnusedVariables": "error"
      },
      "style": {
        "useImportType": "error"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  },
  "organizeImports": {
    "enabled": true
  }
}
```

**Alternative ESLint Setup**:
```json
// .eslintrc.json
{
  "extends": [
    "@typescript-eslint/recommended",
    "@typescript-eslint/recommended-requiring-type-checking"
  ],
  "rules": {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": "error",
    "@typescript-eslint/consistent-type-imports": "error",
    "@typescript-eslint/prefer-readonly": "error"
  }
}
```

### Phase 2: Dead Code Analysis

**Automated Detection Strategy**:
```typescript
interface DeadCodeAnalysis {
  unusedExports: string[];
  unusedImports: string[];
  unusedVariables: string[];
  deprecatedFunctions: string[];
  unreachableCode: string[];
}

// Tools to use:
// - ts-unused-exports
// - typescript compiler API
// - Custom analysis scripts
```

### Phase 3: Gradual Restructuring

**Migration Strategy**:
1. Create new directory structure
2. Move files incrementally with proper re-exports
3. Update imports gradually
4. Maintain backward compatibility during transition
5. Remove old structure once migration is complete

**Example Migration Pattern**:
```typescript
// Old: src/core/direct-deployment.ts
// New: src/core/deployment/engine.ts

// Temporary bridge during migration
// src/core/direct-deployment.ts
export { DirectDeploymentEngine } from './deployment/engine.js';
export type { DeploymentOptions, DeploymentResult } from './deployment/types.js';
```

**Factory Reorganization Migration**:
```typescript
// Phase 1: Create new structure while keeping old factory.ts
// factories/kubernetes/workloads/deployment.ts
export function deployment(resource: V1Deployment): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  // Move implementation from old factory.ts
}

// Phase 2: Update old factory.ts to re-export from new location
// src/core/factory.ts (temporary bridge)
export { deployment } from '../factories/kubernetes/workloads/deployment.js';
export { service } from '../factories/kubernetes/networking/service.js';
// ... other re-exports

// Phase 3: Update main index.ts to import from new factories
// src/index.ts
export * from './factories/index.js';

// Phase 4: Remove old factory.ts once all imports are updated
```

### Phase 4: Import/Export Optimization

**Consistent Export Patterns**:
```typescript
// src/core/deployment/index.ts
export { DirectDeploymentEngine } from './engine.js';
export { ResourceReadinessChecker } from './readiness.js';
export { RollbackManager } from './rollback.js';
export type * from './types.js';

// src/core/index.ts
export * from './deployment/index.js';
export * from './serialization/index.js';
export * from './references/index.js';
export * from './types/index.js';
```

**Type-Only Import Enforcement**:
```typescript
// Before
import { SomeType, someFunction } from './module.js';

// After
import type { SomeType } from './module.js';
import { someFunction } from './module.js';
```

## Error Handling Strategy

### Linting Error Categories

1. **Critical Errors** (Block CI):
   - `no-explicit-any`
   - `no-unused-vars`
   - Type errors

2. **Warnings** (Should fix):
   - Deprecated API usage
   - Inconsistent naming
   - Missing documentation

3. **Style Issues** (Auto-fixable):
   - Import organization
   - Formatting inconsistencies
   - Trailing whitespace

### Migration Risk Mitigation

1. **Comprehensive Testing**: Run full test suite after each change
2. **Incremental Changes**: Small, focused commits
3. **Rollback Plan**: Keep old structure until new one is proven
4. **Documentation Updates**: Update docs alongside code changes

## Performance Considerations

### Bundle Size Optimization

```typescript
// Tree-shaking friendly exports
// Instead of:
export * from './large-module.js';

// Use specific exports:
export { specificFunction, SpecificType } from './large-module.js';
```

### Build Performance

- Use TypeScript project references for faster builds
- Implement incremental compilation
- Optimize import paths to reduce resolution time

## Quality Metrics

### Success Criteria

1. **Code Quality**:
   - Zero linting errors
   - 100% test coverage maintained
   - No `any` types in production code

2. **Bundle Size**:
   - Reduce bundle size by 10-15%
   - Improve tree-shaking effectiveness

3. **Developer Experience**:
   - Faster build times
   - Better IDE support
   - Clearer error messages

4. **Maintainability**:
   - Reduced cyclomatic complexity
   - Clear module boundaries
   - Consistent code patterns
   - Factory functions organized by ecosystem and resource type
   - No single file exceeding 200 lines (down from 865-line factory.ts)

## Integration Points

### Build System Integration

```json
// package.json scripts
{
  "scripts": {
    "lint": "biome check src/",
    "lint:fix": "biome check --apply src/",
    "format": "biome format --write src/",
    "type-check": "tsc --noEmit",
    "build": "bun run lint && bun run type-check && bun run build:lib",
    "pre-commit": "bun run lint && bun run type-check"
  }
}
```

### CI/CD Integration

```yaml
# GitHub Actions example
- name: Code Quality Check
  run: |
    bun run lint
    bun run type-check
    bun run test
```

## Migration Timeline

### Week 1: Tooling Setup
- Install and configure linting tools
- Set up automated formatting
- Integrate with build system

### Week 2: Dead Code Analysis
- Run automated analysis
- Identify unused code
- Create removal plan

### Week 3-4: Gradual Restructuring
- Create new directory structure
- Move files incrementally
- Update imports and exports

### Week 5: Cleanup and Optimization
- Remove dead code
- Optimize imports
- Update documentation

### Week 6: Validation and Polish
- Comprehensive testing
- Performance validation
- Final cleanup

This design provides a systematic approach to cleaning up and restructuring the TypeKro codebase while maintaining backward compatibility and improving developer experience.