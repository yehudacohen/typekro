---
title: APISix Factories
description: Factory functions for APISix Ingress Controller
---

# APISix Factories

::: warning Experimental
APISix factories are experimental. The API may change in future releases.
:::

Factory functions for deploying APISix Ingress Controller via Helm.

## Installation

```typescript
import * as apisix from 'typekro/apisix';
```

## Quick Example

```typescript
import * as apisix from 'typekro/apisix';

// Bootstrap APISix with Helm
const bootstrap = apisix.apisixBootstrap({
  namespace: 'apisix',
  config: {
    gateway: { type: 'LoadBalancer' },
    dashboard: { enabled: true }
  }
});
```

## Available Factories

| Factory | Description |
|---------|-------------|
| `apisixBootstrap` | Deploy APISix via Helm with sensible defaults |
| `apisixHelmRelease` | Full HelmRelease configuration for APISix |

## Bootstrap Configuration

```typescript
interface APISixBootstrapConfig {
  namespace?: string;
  version?: string;
  config?: {
    gateway?: {
      type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
      replicas?: number;
    };
    dashboard?: {
      enabled?: boolean;
    };
    ingress?: {
      enabled?: boolean;
      className?: string;
    };
  };
}
```

## Usage in Compositions

```typescript
import { kubernetesComposition } from 'typekro';
import * as apisix from 'typekro/apisix';

const infrastructure = kubernetesComposition(definition, (spec) => {
  apisix.apisixBootstrap({
    namespace: 'apisix',
    config: {
      gateway: { type: 'LoadBalancer', replicas: spec.replicas }
    }
  });

  return { ready: true };
});
```

## Prerequisites

APISix bootstrap requires Flux CD installed in your cluster. See [Kro Runtime Bootstrap](/api/kro/compositions/runtime) for setup.

## KRO YAML Credentials

`apisixBootstrap.toYaml()` without a spec generates a ResourceGraphDefinition and requires concrete APISIX admin credentials. Set both `APISIX_ADMIN_KEY` and `APISIX_VIEWER_KEY` in the environment before calling it, or pass `gateway.adminCredentials` when generating a custom resource with `toYaml(spec)`.

Those credential values are embedded in the generated YAML because Helm values must be concrete at RGD generation time. Treat the output as secret material and avoid committing or logging it in release artifacts.

## Next Steps

- [Kubernetes Factories](/api/kubernetes/) - Core Kubernetes resources
- [Helm Integration](/examples/helm-integration) - More Helm patterns
