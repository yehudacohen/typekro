---
title: Flux Factories
description: Factory functions for Flux CRDs
---

# Flux Factories

Factory functions for Flux CD Custom Resource Definitions.

## Import

```typescript
// Helm factories from main package
import { helmRelease, helmRepository } from 'typekro';

// Source factories from subpath
import { gitRepository } from 'typekro/flux';
```

## Quick Example

```typescript
import { helmRelease, helmRepository } from 'typekro';

const repo = helmRepository({
  name: 'bitnami',
  url: 'https://charts.bitnami.com/bitnami',
  id: 'bitnami'
});

const release = helmRelease({
  name: 'redis',
  chart: { 
    repository: 'https://charts.bitnami.com/bitnami', 
    name: 'redis' 
  },
  values: { replica: { replicaCount: 3 } },
  id: 'redis'
});
```

## Available Factories

| Factory | Import | Description |
|---------|--------|-------------|
| `helmRelease` | `typekro` | Deploy Helm charts via Flux |
| `helmRepository` | `typekro` | Helm chart repository source |
| `HelmChart` | `typekro/simple` | Simplified Helm deployment |
| `gitRepository` | `typekro/flux` | Git repository source |

## helmRelease()

Full HelmRelease configuration for deploying Helm charts.

```typescript
import { helmRelease } from 'typekro';

const release = helmRelease({
  id: 'myApp',
  name: 'my-app',
  namespace: 'production',
  interval: '10m',
  chart: {
    repository: 'https://charts.example.com',
    name: 'my-chart',
    version: '1.2.3'
  },
  values: {
    replicaCount: 3,
    image: { tag: 'v1.0.0' }
  }
});
```

## helmRepository()

Creates a Flux HelmRepository resource.

```typescript
import { helmRepository } from 'typekro';

const repo = helmRepository({
  id: 'bitnamiRepo',
  name: 'bitnami',
  namespace: 'flux-system',
  url: 'https://charts.bitnami.com/bitnami',
  interval: '10m'
});
```

## Type-Safe Helm Values

Schema references work in Helm values:

```typescript
import { kubernetesComposition, helmRelease } from 'typekro';

const app = kubernetesComposition(definition, (spec) => {
  const release = helmRelease({
    id: 'app',
    name: 'app',
    chart: { repository: 'https://charts.example.com', name: 'myapp' },
    values: {
      replicaCount: spec.replicas,      // Schema reference
      image: { tag: spec.version },     // Nested reference
      config: {
        database: spec.dbName,
        logLevel: spec.logLevel
      }
    }
  });

  return {
    ready: release.status.conditions?.[0]?.status === 'True'
  };
});
```

## Usage in Compositions

```typescript
import { type } from 'arktype';
import { kubernetesComposition, helmRelease } from 'typekro';

const DatabaseSpec = type({
  name: 'string',
  size: 'string',
  replicas: 'number'
});

const database = kubernetesComposition({
  name: 'database',
  apiVersion: 'data.example.com/v1',
  kind: 'Database',
  spec: DatabaseSpec,
  status: type({ ready: 'boolean' })
}, (spec) => {
  const db = helmRelease({
    id: 'db',
    name: spec.name,
    chart: {
      repository: 'https://charts.bitnami.com/bitnami',
      name: 'postgresql',
      version: '12.x'
    },
    values: {
      primary: { persistence: { size: spec.size } },
      readReplicas: { replicaCount: spec.replicas }
    }
  });

  return {
    ready: db.status.conditions?.[0]?.status === 'True'
  };
});
```

## Prerequisites

HelmRelease requires Flux CD installed in your cluster:

```bash
# Install Flux CLI
brew install fluxcd/tap/flux

# Bootstrap Flux
flux bootstrap github \
  --owner=<your-org> \
  --repository=<your-repo> \
  --path=clusters/my-cluster
```

Or use the [TypeKro Runtime Bootstrap](/api/kro/compositions/runtime) to install Flux and Kro together.

## Next Steps

- [YAML Closures](/api/yaml-closures) - Alternative deployment methods
- [Kubernetes Factories](/api/kubernetes/) - Core Kubernetes resources
- [Runtime Bootstrap](/api/kro/compositions/runtime) - Install Flux and Kro
