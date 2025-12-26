---
title: Cilium Factories
description: Factory functions for Cilium CRDs
---

# Cilium Factories

Factory functions for Cilium Custom Resource Definitions.

## Import

```typescript
// Import specific functions (recommended)
import { ciliumNetworkPolicy, ciliumClusterwideNetworkPolicy } from 'typekro/cilium';

// Or namespace import
import * as cilium from 'typekro/cilium';
```

## Quick Example

```typescript
import { ciliumNetworkPolicy } from 'typekro/cilium';

const policy = ciliumNetworkPolicy({
  apiVersion: 'cilium.io/v2',
  kind: 'CiliumNetworkPolicy',
  metadata: { name: 'allow-web', namespace: 'default' },
  spec: {
    endpointSelector: { matchLabels: { app: 'web' } },
    ingress: [{
      fromEndpoints: [{ matchLabels: { app: 'frontend' } }]
    }]
  }
});
```

## Available Factories

| Factory | Scope | Description |
|---------|-------|-------------|
| `ciliumNetworkPolicy` | Namespace | Namespace-scoped network policy |
| `ciliumClusterwideNetworkPolicy` | Cluster | Cluster-scoped network policy |

## ciliumNetworkPolicy()

Creates a namespace-scoped Cilium network policy.

```typescript
import { ciliumNetworkPolicy } from 'typekro/cilium';

const policy = ciliumNetworkPolicy({
  apiVersion: 'cilium.io/v2',
  kind: 'CiliumNetworkPolicy',
  metadata: { name: 'allow-web', namespace: 'default' },
  spec: {
    endpointSelector: { matchLabels: { app: 'web' } },
    ingress: [{
      fromEndpoints: [{ matchLabels: { app: 'frontend' } }],
      toPorts: [{ ports: [{ port: '80', protocol: 'TCP' }] }]
    }]
  }
});
```

## ciliumClusterwideNetworkPolicy()

Creates a cluster-scoped Cilium network policy.

```typescript
import { ciliumClusterwideNetworkPolicy } from 'typekro/cilium';

const policy = ciliumClusterwideNetworkPolicy({
  apiVersion: 'cilium.io/v2',
  kind: 'CiliumClusterwideNetworkPolicy',
  metadata: { name: 'deny-external' },
  spec: {
    endpointSelector: {},
    egress: [{
      toEntities: ['cluster']
    }]
  }
});
```

## Usage in Compositions

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment } from 'typekro/simple';
import { ciliumNetworkPolicy } from 'typekro/cilium';

const secureApp = kubernetesComposition({
  name: 'secure-app',
  apiVersion: 'example.com/v1',
  kind: 'SecureApp',
  spec: type({ name: 'string', image: 'string' }),
  status: type({ ready: 'boolean' })
}, (spec) => {
  const deploy = Deployment({ id: 'app', name: spec.name, image: spec.image });
  
  ciliumNetworkPolicy({
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: { name: `${spec.name}-policy`, namespace: 'default' },
    spec: {
      endpointSelector: { matchLabels: { app: spec.name } },
      ingress: [{
        fromEndpoints: [{ matchLabels: { role: 'frontend' } }]
      }]
    }
  });

  return { ready: deploy.status.readyReplicas > 0 };
});
```

## Prerequisites

Cilium must be installed in your cluster. See [Cilium documentation](https://docs.cilium.io/en/stable/gettingstarted/) for installation instructions.

## Next Steps

- [Kubernetes Factories](/api/kubernetes/) - Core Kubernetes resources
- [Networking API](/api/factories/networking) - Kubernetes NetworkPolicy
