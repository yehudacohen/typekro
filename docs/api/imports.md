# Import Patterns

All TypeKro import patterns in one place.

## Core APIs

```typescript
// Main composition API
import { kubernetesComposition, Cel, externalRef } from 'typekro';

// Runtime bootstrap (for Kro mode)
import { typeKroRuntimeBootstrap } from 'typekro';

// Types (use 'import type' for type-only imports)
import type { Enhanced, KubernetesRef, RefOrValue, CelExpression } from 'typekro';
```

## Simple Factories (Recommended)

```typescript
// Direct imports - most common pattern
import { Deployment, Service, ConfigMap, Secret } from 'typekro/simple';
import { Ingress, NetworkPolicy } from 'typekro/simple';
import { StatefulSet, Job, CronJob, DaemonSet } from 'typekro/simple';
import { Pvc, PersistentVolume, Hpa } from 'typekro/simple';
import { YamlFile, HelmChart } from 'typekro/simple';

// Alternative: namespace import
import { simple } from 'typekro';
const deploy = simple.Deployment({ id: 'app', name: 'app', image: 'nginx' });
```

## Core Factories (Full Kubernetes API)

For full control over Kubernetes resource specs:

```typescript
import { 
  deployment, service, configMap, secret,
  role, roleBinding, clusterRole, clusterRoleBinding, serviceAccount
} from 'typekro';

// Full Kubernetes API access
const deploy = deployment({
  id: 'app',
  metadata: { name: 'app', namespace: 'prod', labels: { ... } },
  spec: {
    replicas: 3,
    selector: { matchLabels: { app: 'my-app' } },
    template: { /* full pod template */ }
  }
});
```

## Helm Integration

```typescript
// Full HelmRelease/HelmRepository configuration
import { helmRelease, helmRepository } from 'typekro';

// Simplified Helm chart (from simple factories)
import { HelmChart } from 'typekro/simple';
```

### HelmChart vs helmRelease

| | `HelmChart` | `helmRelease` |
|---|-------------|---------------|
| **Import** | `typekro/simple` | `typekro` |
| **Use case** | Quick chart deployment | Full configuration control |
| **Config** | `(name, repo, chart, values?)` | `{ name, chart: {...}, values, ... }` |

```typescript
// HelmChart - simple, positional arguments
const redis = HelmChart('redis', 'https://charts.bitnami.com/bitnami', 'redis', {
  replica: { replicaCount: 3 }
});

// helmRelease - full configuration object
const redis = helmRelease({
  id: 'redis',
  name: 'redis',
  namespace: 'cache',
  interval: '10m',
  chart: {
    repository: 'https://charts.bitnami.com/bitnami',
    name: 'redis',
    version: '17.x'
  },
  values: { replica: { replicaCount: 3 } }
});
```

## Ecosystem-Specific Imports

```typescript
// Cilium network policies
import * as cilium from 'typekro/cilium';

// Cert-Manager certificates
import * as certManager from 'typekro/cert-manager';
// Or import specific functions:
import { certificate, clusterIssuer, issuer } from 'typekro/cert-manager';

// Flux GitOps
import { gitRepository } from 'typekro/flux';

// APISix ingress
import * as apisix from 'typekro/apisix';

// External-DNS
import * as externalDns from 'typekro/external-dns';

// Pebble ACME test server
import * as pebble from 'typekro/pebble';
```

## Additional Core Factories

Beyond the common factories, TypeKro exports many more:

```typescript
import { 
  // Core resources
  namespace, pod,
  
  // Storage
  persistentVolume, persistentVolumeClaim, storageClass,
  
  // Networking
  ingress, networkPolicy,
  
  // Workloads
  statefulSet, daemonSet, job, cronJob
} from 'typekro';
```

## Utility Functions

```typescript
// Resource creation for custom CRDs
import { createResource } from 'typekro';

// Type guards
import { isKubernetesRef, isCelExpression } from 'typekro';

// Debugging
import { enableCompositionDebugging, getCompositionDebugLogs } from 'typekro';
```

## Schema Definitions

```typescript
// ArkType for schema definitions
import { type } from 'arktype';

const AppSpec = type({
  name: 'string',
  replicas: 'number',
  'image?': 'string'
});
```

## Quick Reference

| What you need | Import from |
|---------------|-------------|
| `kubernetesComposition` | `typekro` |
| `Deployment`, `Service`, etc. | `typekro/simple` |
| `helmRelease`, `helmRepository` | `typekro` |
| `HelmChart` (simple) | `typekro/simple` |
| `Cel` expressions | `typekro` |
| `externalRef` | `typekro` |
| `createResource` | `typekro` |
| `typeKroRuntimeBootstrap` | `typekro` |
| RBAC factories | `typekro` |
| Cilium policies | `typekro/cilium` |
| Cert-Manager | `typekro/cert-manager` |
| Flux GitOps | `typekro/flux` |
| Types | `typekro` (with `import type`) |

## Enhanced Resource Methods

All factory functions return `Enhanced` resources with these methods:

```typescript
const deploy = Deployment({ id: 'app', name: 'app', image: 'nginx' });

// Custom readiness evaluation
deploy.withReadinessEvaluator((resource) => ({
  ready: resource.status?.readyReplicas === resource.spec?.replicas,
  message: `${resource.status?.readyReplicas}/${resource.spec?.replicas} ready`
}));

// Explicit dependencies (when auto-detection isn't enough)
deploy.withDependencies('database', 'configMap');
```

See [Custom Integrations](/advanced/custom-integrations) for details on these methods.
