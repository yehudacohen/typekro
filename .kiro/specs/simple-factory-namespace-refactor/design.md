# Design Document

## Overview

This design outlines the refactoring of simple* factory functions into a dedicated `simple` namespace, providing cleaner naming conventions while maintaining full backward compatibility. The solution involves creating a new directory structure, organizing exports, and updating all references across the codebase.

## Architecture

### Current State

The simple* functions are currently located in:
- **Source**: `src/core/composition/composition.ts` - Contains all simple* function implementations
- **Types**: `src/core/composition/types.ts` - Contains Simple*Config interfaces
- **Exports**: `src/core/composition/index.ts` - Exports all simple* functions
- **Main Exports**: `src/index.ts` and `src/core.ts` - Re-export simple* functions

### Architectural Rationale

The simple* functions should be moved to the factories structure because:
1. **Single Resource Creation**: Each simple* function creates a single Enhanced resource, not a resource graph
2. **Factory Pattern**: They follow the factory pattern like other functions in `src/factories/kubernetes/`
3. **Logical Grouping**: They belong with other resource creation functions, not composition functions
4. **Composition vs Factory**: Composition functions (like `kubernetesComposition`) create resource graphs, while factory functions create individual resources

### Target State

The new architecture will mirror the kubernetes factory structure exactly:

```
src/factories/
├── simple/                    # New directory mirroring kubernetes structure
│   ├── index.ts              # Simple namespace exports
│   ├── workloads/            # Mirror of kubernetes/workloads/
│   │   ├── index.ts
│   │   ├── deployment.ts     # Simple Deployment factory
│   │   ├── stateful-set.ts   # Simple StatefulSet factory
│   │   ├── job.ts            # Simple Job factory
│   │   └── cron-job.ts       # Simple CronJob factory
│   ├── networking/           # Mirror of kubernetes/networking/
│   │   ├── index.ts
│   │   ├── service.ts        # Simple Service factory
│   │   ├── ingress.ts        # Simple Ingress factory
│   │   └── network-policy.ts # Simple NetworkPolicy factory
│   ├── config/               # Mirror of kubernetes/config/
│   │   ├── index.ts
│   │   ├── config-map.ts     # Simple ConfigMap factory
│   │   └── secret.ts         # Simple Secret factory
│   ├── storage/              # Mirror of kubernetes/storage/
│   │   ├── index.ts
│   │   └── persistent-volume-claim.ts # Simple PVC factory
│   ├── autoscaling/          # Mirror of kubernetes/autoscaling/
│   │   ├── index.ts
│   │   └── horizontal-pod-autoscaler.ts # Simple HPA factory
│   └── types.ts              # Config types (moved from composition)
├── kubernetes/               # Existing kubernetes factories (unchanged)
│   ├── workloads/
│   ├── networking/
│   ├── config/
│   ├── storage/
│   ├── autoscaling/
│   └── ...
└── index.ts                  # Updated to export simple namespace

src/core/composition/
├── imperative.ts             # Keep kubernetesComposition
├── index.ts                  # Remove simple* exports, keep composition functions
└── typekro-runtime/          # Keep TypeKro runtime bootstrap
```

## Components and Interfaces

### 1. Simple Namespace Structure



#### Individual Simple Factory Files

```typescript
// src/factories/simple/workloads/deployment.ts
import { deployment } from '../../kubernetes/workloads/deployment.js';
import type { DeploymentConfig } from '../types.js';
import type { Enhanced, V1DeploymentSpec, V1DeploymentStatus, V1EnvVar } from '../../../core/types.js';

export function Deployment(config: DeploymentConfig): Enhanced<V1DeploymentSpec, V1DeploymentStatus> {
  // Implementation moved from simpleDeployment
  const env: V1EnvVar[] = config.env
    ? Object.entries(config.env).map(([name, value]) => ({ name, value }))
    : [];

  return deployment({
    ...(config.id && { id: config.id }),
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
    },
    spec: {
      replicas: config.replicas || 1,
      selector: { matchLabels: { app: config.name } },
      template: {
        metadata: { labels: { app: config.name } },
        spec: {
          containers: [
            {
              name: config.name,
              image: config.image,
              ...(env.length > 0 && { env }),
              ...(config.ports && { ports: config.ports }),
              ...(config.resources && { resources: config.resources }),
              ...(config.volumeMounts && { volumeMounts: config.volumeMounts }),
            },
          ],
          ...(config.volumes && { volumes: config.volumes }),
        },
      },
    },
  });
}
```

```typescript
// src/factories/simple/networking/service.ts
import { service } from '../../kubernetes/networking/service.js';
import type { ServiceConfig } from '../types.js';
import type { Enhanced, V1ServiceSpec, V1ServiceStatus } from '../../../core/types.js';

export function Service(config: ServiceConfig): Enhanced<V1ServiceSpec, V1ServiceStatus> {
  return service({
    ...(config.id && { id: config.id }),
    metadata: { name: config.name, ...(config.namespace && { namespace: config.namespace }) },
    spec: {
      selector: config.selector,
      ports: config.ports,
      ...(config.type && { type: config.type }),
      ipFamilies: ['IPv4'],
      ipFamilyPolicy: 'SingleStack',
    },
  });
}
```

#### Simple Namespace Organization

```typescript
// src/factories/simple/workloads/index.ts
export { Deployment } from './deployment.js';
export { StatefulSet } from './stateful-set.js';
export { Job } from './job.js';
export { CronJob } from './cron-job.js';
```

```typescript
// src/factories/simple/networking/index.ts
export { Service } from './service.js';
export { Ingress } from './ingress.js';
export { NetworkPolicy } from './network-policy.js';
```

```typescript
// src/factories/simple/index.ts
// Import from category modules
export * from './workloads/index.js';
export * from './networking/index.js';
export * from './config/index.js';
export * from './storage/index.js';
export * from './autoscaling/index.js';

// Import all functions to create the simple namespace object
import * as workloads from './workloads/index.js';
import * as networking from './networking/index.js';
import * as config from './config/index.js';
import * as storage from './storage/index.js';
import * as autoscaling from './autoscaling/index.js';

export const simple = {
  ...workloads,
  ...networking,
  ...config,
  ...storage,
  ...autoscaling
};
```

### 2. Import Patterns Support

#### Pattern 1: Namespace Import
```typescript
import { simple } from 'typekro';

const app = simple.Deployment({
  name: 'my-app',
  image: 'nginx:latest'
});
```

#### Pattern 2: Direct Import from Subpath
```typescript
import { Deployment, Service } from 'typekro/simple';

const app = Deployment({
  name: 'my-app', 
  image: 'nginx:latest'
});
```

#### Pattern 3: Namespace Import from Subpath
```typescript
import * as simple from 'typekro/simple';

const app = simple.Deployment({
  name: 'my-app',
  image: 'nginx:latest'
});
```

### 3. Main Package Exports Integration

The simple namespace will be added to the main package exports:

```typescript
// src/index.ts (updated)
export { simple } from './factories/simple/index.js';
// ... existing exports including simple* functions for backward compatibility
```

```typescript
// src/factories/index.ts (updated)  
export { simple } from './simple/index.js';
// ... existing factory exports
```

### 4. Composition Function Updates

The composition functions will be updated to use the new simple factories:

```typescript
// src/core/composition/imperative.ts (updated to use simple namespace)
import { simple } from '../../factories/simple/index.js';

// Keep composition-specific types in composition module
export interface WebServiceConfig {
  name: string;
  image: string;
  namespace?: string;
  replicas?: number;
  port: number;
  targetPort?: number;
}

export interface WebServiceComponent {
  deployment: Enhanced<V1DeploymentSpec, V1DeploymentStatus>;
  service: Enhanced<V1ServiceSpec, V1ServiceStatus>;
}

// Update createWebService to use simple namespace
export function createWebService(config: WebServiceConfig): WebServiceComponent {
  const labels = { app: config.name };

  const deployment = simple.Deployment({
    name: config.name,
    image: config.image,
    ...(config.namespace && { namespace: config.namespace }),
    ...(config.replicas && { replicas: config.replicas }),
    ports: [{ containerPort: config.targetPort ?? config.port }],
  });

  const service = simple.Service({
    name: config.name,
    selector: labels,
    ports: [{ port: config.port, targetPort: config.targetPort ?? config.port }],
    ...(config.namespace && { namespace: config.namespace }),
  });

  return { deployment, service };
}
```

This approach:
- Moves only the simple factory implementations to the factories structure
- Keeps composition-specific functions and types in the composition module
- Provides clean new function names that mirror the kubernetes factory structure exactly
- Eliminates the old simple* functions entirely for a clean codebase
- Makes the relationship between simple and full factories clear through directory structure
- Removes all backward compatibility complexity since there are no users yet

### 5. Package.json Exports Configuration

To support the `typekro/simple` import pattern:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./simple": {
      "types": "./dist/factories/simple/index.d.ts", 
      "import": "./dist/factories/simple/index.js"
    }
  }
}
```

## Data Models

### Type Definitions Organization

#### Current Types (Keep for Compatibility)
```typescript
// src/core/composition/types.ts
export interface SimpleDeploymentConfig { /* ... */ }
export interface SimpleServiceConfig { /* ... */ }
// ... other Simple*Config interfaces
```

#### Type Organization

```typescript
// src/factories/simple/types.ts (moved from composition, with clean names)
export interface DeploymentConfig {
  name: string;
  image: string;
  replicas?: number;
  namespace?: string;
  env?: Record<string, string>;
  ports?: V1Container['ports'];
  resources?: V1Container['resources'];
  volumeMounts?: V1Container['volumeMounts'];
  volumes?: V1Volume[];
  id?: string;
}

export interface ServiceConfig {
  name: string;
  selector: Record<string, string>;
  ports: V1ServicePort[];
  namespace?: string;
  type?: V1ServiceSpec['type'];
  id?: string;
}

export interface JobConfig {
  name: string;
  image: string;
  namespace?: string;
  command?: string[];
  completions?: number;
  backoffLimit?: number;
  restartPolicy?: 'OnFailure' | 'Never';
}

export interface CronJobConfig {
  name: string;
  image: string;
  schedule: string;
  namespace?: string;
  command?: string[];
}

export interface StatefulSetConfig {
  name: string;
  image: string;
  serviceName: string;
  replicas?: number;
  namespace?: string;
  env?: Record<string, string>;
  ports?: V1Container['ports'];
  volumeClaimTemplates?: V1PersistentVolumeClaim[];
}

export interface ConfigMapConfig {
  name: string;
  namespace?: string;
  data: Record<string, string>;
  id?: string;
}

export interface SecretConfig {
  name: string;
  namespace?: string;
  stringData: Record<string, string>;
}

export interface PvcConfig {
  name: string;
  namespace?: string;
  size: string;
  storageClass?: string;
  accessModes?: ('ReadWriteOnce' | 'ReadOnlyMany' | 'ReadWriteMany')[];
}

export interface HpaConfig {
  name: string;
  namespace?: string;
  target: { name: string; kind: string };
  minReplicas: number;
  maxReplicas: number;
  cpuUtilization?: number;
}

export interface IngressConfig {
  name: string;
  namespace?: string;
  ingressClassName?: string;
  rules?: V1IngressRule[];
  tls?: V1IngressTLS[];
  annotations?: Record<string, string>;
}

export interface NetworkPolicyConfig {
  name: string;
  namespace?: string;
  podSelector: V1LabelSelector;
  policyTypes?: ('Ingress' | 'Egress')[];
  ingress?: V1NetworkPolicyIngressRule[];
  egress?: V1NetworkPolicyEgressRule[];
}


```

### Function Signatures

All function signatures remain identical, only the names change:

```typescript
// Old: simpleDeployment(config: SimpleDeploymentConfig)
// New: Deployment(config: SimpleDeploymentConfig)
//      OR Deployment(config: DeploymentConfig) when imported from simple namespace
```

## Error Handling

### Import Resolution Errors

The package.json exports configuration ensures proper module resolution. If users try to import from invalid paths, they'll get clear TypeScript/Node.js module resolution errors.

### Type Compatibility

Since the new functions are aliases of the existing functions, there are no type compatibility issues. The Enhanced<> return types remain identical.

### Migration Path

Users can gradually migrate by:
1. Adding new imports alongside old ones
2. Replacing function calls one by one
3. Removing old imports when migration is complete

## Testing Strategy

### 1. Unit Tests for New Namespace

Create comprehensive tests for the new simple namespace:

```typescript
// test/factories/simple/namespace.test.ts
describe('Simple Namespace', () => {
  it('should export all simple functions with clean names', () => {
    // Test that simple.Deployment exists and works
    // Test that simple.Service exists and works
    // etc.
  });
  
  it('should maintain identical functionality to simple* functions', () => {
    // Compare outputs between simpleDeployment and simple.Deployment
  });
});
```

### 2. Import Pattern Tests

```typescript
// test/factories/simple/imports.test.ts
describe('Simple Import Patterns', () => {
  it('should support namespace import from main package', async () => {
    const { simple } = await import('../../../src/index.js');
    expect(simple.Deployment).toBeDefined();
  });
  
  it('should support direct import from simple subpath', async () => {
    const { Deployment } = await import('../../../src/factories/simple/index.js');
    expect(Deployment).toBeDefined();
  });
});
```

### 3. Backward Compatibility Tests

```typescript
// test/factories/simple/functionality.test.ts
describe('Simple Factory Functionality', () => {
  it('should create resources with identical functionality to original simple* functions', () => {
    // Verify all simple.* functions work correctly
  });
  
  it('should maintain all expected resource properties and behaviors', () => {
    // Test that simple.Deployment creates proper deployment resources
  });
});
```

### 4. Integration Tests

Update existing integration tests to use new syntax while keeping some tests with old syntax to ensure compatibility.

### 5. Documentation Tests

Ensure all code examples in documentation are valid and executable.

## Implementation Phases

### Phase 1: Core Infrastructure
1. Create `src/factories/simple/` directory structure mirroring kubernetes structure
2. Move and rename simple* function implementations to new clean names in organized files
3. Move and rename Simple*Config types to clean names
4. Update composition functions to use simple namespace
5. Remove old simple* functions and types from composition module
6. Update package.json exports configuration
7. Create basic unit tests for new namespace

### Phase 2: Integration and Testing
1. Update main package exports to include simple namespace
2. Create comprehensive test suite for new functionality
3. Add backward compatibility tests
4. Verify all import patterns work correctly

### Phase 3: Documentation and Examples Update
1. Update all examples in `examples/` directory
2. Update all documentation in `docs/` directory  
3. Update README.md and other root documentation
4. Update code comments and JSDoc

### Phase 4: Test Suite Migration
1. Update test files to use new simple namespace syntax
2. Keep some tests with old syntax for compatibility verification
3. Update test utilities and helpers
4. Verify all tests pass with new syntax

### Phase 5: Final Validation
1. Run full test suite to ensure no regressions
2. Verify bundle size hasn't increased significantly
3. Test all import patterns in isolation
4. Validate TypeScript type checking works correctly

## Migration Guide for Users

### Immediate (No Breaking Changes)
- All existing code continues to work unchanged
- New simple namespace is available for new code

### Gradual Migration
```typescript
// Before
import { simpleDeployment, simpleService } from 'typekro';

// After - Option 1: Namespace import
import { simple } from 'typekro';
const app = simple.Deployment({ /* ... */ });

// After - Option 2: Direct import
import { Deployment, Service } from 'typekro/simple';
const app = Deployment({ /* ... */ });
```

### Benefits of Migration
- Cleaner, more intuitive function names
- Better IDE autocomplete experience
- Follows common JavaScript/TypeScript naming conventions
- Easier to discover related functions in the simple namespace

## Performance Considerations

### Bundle Size Impact
- Minimal impact as functions are aliases, not duplicates
- Tree shaking will eliminate unused exports
- No runtime overhead for the namespace organization

### Build Time Impact
- Negligible impact on TypeScript compilation
- Additional export resolution is minimal overhead

### Runtime Performance
- Zero runtime impact - functions are identical
- No additional function call overhead
- Same memory footprint

## Security Considerations

No security implications as this is purely a refactoring of existing functionality with no changes to the underlying implementations.

## Future Considerations

### Deprecation Path (Future)
In a future major version, we could:
1. Mark simple* functions as deprecated (with warnings)
2. Eventually remove simple* functions in favor of simple namespace
3. This design provides a clean migration path for such changes

### Extension Points
The namespace structure makes it easy to:
- Add new simple factory functions
- Organize functions by category (workloads, networking, etc.)
- Provide specialized namespaces for different use cases

### Consistency with Ecosystem
This pattern aligns with common JavaScript/TypeScript practices:
- React: `React.Component` vs individual imports
- Lodash: `_.map` vs individual function imports
- AWS SDK: Service namespaces vs individual imports