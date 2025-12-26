---
title: Custom Integrations
description: Build type-safe factory functions for custom CRDs
---

# Custom Integrations

Build type-safe factory functions for custom CRDs and third-party resources.

## createResource API

The `createResource` function is the foundation for building custom factories:

```typescript
import { createResource } from 'typekro';
import type { Enhanced } from 'typekro';

function createResource<TSpec, TStatus>(
  resource: KubernetesResource<TSpec, TStatus>
): Enhanced<TSpec, TStatus>
```

**Parameters:**
- `resource.apiVersion` - Kubernetes API version (e.g., `cert-manager.io/v1`)
- `resource.kind` - Resource kind (e.g., `Certificate`)
- `resource.metadata` - Standard Kubernetes metadata
- `resource.spec` - Resource specification (typed as `TSpec`)
- `resource.id` - Optional ID for cross-resource references

**Returns:** `Enhanced<TSpec, TStatus>` - A resource with magic proxy support for status references.

## Quick Example

```typescript
import { createResource } from 'typekro';
import type { Enhanced } from 'typekro';

interface CertificateSpec {
  secretName: string;
  issuerRef: { name: string; kind: string };
  dnsNames: string[];
}

interface CertificateStatus {
  ready: boolean;
  notAfter?: string;
}

function Certificate(config: {
  id: string;
  name: string;
  secretName: string;
  issuer: string;
  dnsNames: string[];
}): Enhanced<CertificateSpec, CertificateStatus> {
  return createResource({
    apiVersion: 'cert-manager.io/v1',
    kind: 'Certificate',
    metadata: { name: config.name },
    spec: {
      secretName: config.secretName,
      issuerRef: { name: config.issuer, kind: 'ClusterIssuer' },
      dnsNames: config.dnsNames
    },
    id: config.id
  });
}
```

## The Enhanced Type

`Enhanced<TSpec, TStatus>` wraps resources with TypeKro's magic proxy:

```typescript
const resource: Enhanced<MySpec, MyStatus> = createResource({...});

resource.spec.fieldName;        // Type-safe spec access
resource.status.ready;          // Becomes CEL at runtime
resource.id;                    // Resource's unique ID
```

## Basic Factory Pattern

```typescript
import { createResource } from 'typekro';
import type { Enhanced } from 'typekro';

// 1. Define spec and status interfaces
interface MyResourceSpec {
  name: string;
  config: Record<string, string>;
}

interface MyResourceStatus {
  ready: boolean;
  message?: string;
}

// 2. Create the factory function
function MyResource(config: {
  id: string;
  name: string;
  config?: Record<string, string>;
}): Enhanced<MyResourceSpec, MyResourceStatus> {
  return createResource({
    apiVersion: 'example.com/v1',
    kind: 'MyResource',
    metadata: { name: config.name },
    spec: {
      name: config.name,
      config: config.config ?? {}
    },
    id: config.id
  });
}
```

## Custom Readiness Evaluators

Readiness evaluators determine when a resource is considered "ready" during deployment. TypeKro uses these to wait for resources before proceeding.

### The `withReadinessEvaluator` Method

Every `Enhanced` resource has a `withReadinessEvaluator()` method that lets you define custom readiness logic:

```typescript
import { createResource } from 'typekro';
import type { Enhanced, ReadinessEvaluator } from 'typekro';

const certificateReadiness: ReadinessEvaluator = (liveResource) => {
  const conditions = liveResource.status?.conditions ?? [];
  const readyCondition = conditions.find((c: any) => c.type === 'Ready');
  
  return {
    ready: readyCondition?.status === 'True',
    message: readyCondition?.message ?? 'Certificate not ready'
  };
};

function Certificate(config: CertificateConfig): Enhanced<CertificateSpec, CertificateStatus> {
  return createResource({
    apiVersion: 'cert-manager.io/v1',
    kind: 'Certificate',
    metadata: { name: config.name },
    spec: { /* ... */ },
    id: config.id
  }).withReadinessEvaluator(certificateReadiness);
}
```

### ReadinessEvaluator Interface

```typescript
type ReadinessEvaluator<T extends KubernetesResource = KubernetesResource> = (
  resource: T
) => ResourceStatus | Promise<ResourceStatus>;

interface ResourceStatus {
  ready: boolean;
  reason?: string;   // Short reason code (e.g., 'MinimumReplicasAvailable')
  message?: string;  // Human-readable message
}
```

### Common Readiness Patterns

```typescript
// Condition-based (most CRDs use this pattern)
const conditionReadiness: ReadinessEvaluator = (resource) => {
  const ready = resource.status?.conditions?.find((c: any) => c.type === 'Ready');
  return { ready: ready?.status === 'True', message: ready?.message ?? 'Waiting' };
};

// Phase-based (Pods, PVCs, etc.)
const phaseReadiness: ReadinessEvaluator = (resource) => {
  const phase = resource.status?.phase;
  return { ready: phase === 'Running' || phase === 'Active', message: `Phase: ${phase}` };
};

// Replica-based (Deployments, StatefulSets)
const replicaReadiness: ReadinessEvaluator = (resource) => {
  const desired = resource.spec?.replicas ?? 1;
  const ready = resource.status?.readyReplicas ?? 0;
  return { ready: ready >= desired, message: `${ready}/${desired} replicas ready` };
};

// Async readiness (for external checks)
const asyncReadiness: ReadinessEvaluator = async (resource) => {
  const endpoint = resource.status?.endpoint;
  if (!endpoint) return { ready: false, message: 'No endpoint yet' };
  
  try {
    const response = await fetch(`${endpoint}/health`);
    return { ready: response.ok, message: response.ok ? 'Healthy' : 'Unhealthy' };
  } catch {
    return { ready: false, message: 'Health check failed' };
  }
};
```

## Resource Dependencies

Use `withDependencies()` to explicitly declare that a resource depends on other resources:

```typescript
const app = Deployment({
  id: 'app',
  name: 'my-app',
  image: 'nginx'
}).withDependencies('database', 'configMap');
// App will wait for 'database' and 'configMap' resources to be ready
```

This is useful when TypeKro can't automatically detect dependencies (e.g., when using environment variables that reference other resources by name rather than by reference).

## Using in Compositions

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment } from 'typekro/simple';
import { Certificate } from './factories/cert-manager';

const SecureApp = kubernetesComposition({
  name: 'secure-app',
  apiVersion: 'example.com/v1',
  kind: 'SecureApp',
  spec: type({ name: 'string', domain: 'string', image: 'string' }),
  status: type({ ready: 'boolean', url: 'string', certReady: 'boolean' })
}, (spec) => {
  const cert = Certificate({
    id: 'tlsCert',
    name: `${spec.name}-tls`,
    secretName: `${spec.name}-tls-secret`,
    issuer: 'letsencrypt-prod',
    dnsNames: [spec.domain]
  });

  const deploy = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image
  });

  return {
    ready: deploy.status.readyReplicas > 0,
    url: `https://${spec.domain}`,
    certReady: cert.status.conditions?.[0]?.status === 'True'
  };
});
```

## Best Practices

```typescript
// ✅ Type everything explicitly
function MyResource(config: MyConfig): Enhanced<MySpec, MyStatus> {
  return createResource<MySpec, MyStatus>({...});
}

// ✅ Require resource IDs
interface MyConfig {
  id: string;  // Required for cross-references
  name: string;
}

// ✅ Provide sensible defaults
function MyResource(config: {
  id: string;
  name: string;
  replicas?: number;
}): Enhanced<MySpec, MyStatus> {
  return createResource({
    spec: { replicas: config.replicas ?? 1 },
    id: config.id
  });
}
```

## Next Steps

- [ArkType Schemas](/advanced/arktype-schemas) - Define spec and status types
- [Resource IDs](/advanced/resource-ids) - Cross-resource reference patterns
