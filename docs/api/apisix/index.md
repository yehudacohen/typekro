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
  name: 'apisix',
  namespace: 'apisix',
  gateway: {
    type: 'LoadBalancer',
    adminCredentials: {
      admin: process.env.APISIX_ADMIN_KEY!,
      viewer: process.env.APISIX_VIEWER_KEY!,
    },
  },
  ingressController: { enabled: true },
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
  name: string;
  namespace?: string;
  version?: string;
  installCRDs?: boolean;
  replicaCount?: number;
  gateway?: {
    type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
    http?: {
      enabled?: boolean;
      servicePort?: number;
      containerPort?: number;
    };
    https?: {
      enabled?: boolean;
      servicePort?: number;
      containerPort?: number;
    };
    ingress?: {
      enabled?: boolean;
      annotations?: Record<string, string>;
      hosts?: string[];
    };
    adminCredentials?: {
      admin?: string;
      viewer?: string;
    };
  };
  ingressController?: {
    enabled?: boolean;
    resources?: object;
    env?: Array<{ name: string; value?: string }>;
  };
}
```

## Usage in Compositions

```typescript
import { kubernetesComposition } from 'typekro';
import * as apisix from 'typekro/apisix';

const infrastructure = kubernetesComposition(definition, (spec) => {
  apisix.apisixBootstrap({
    name: 'apisix',
    namespace: 'apisix',
    gateway: {
      type: 'LoadBalancer',
      // Required for KRO YAML generation unless APISIX_ADMIN_KEY and
      // APISIX_VIEWER_KEY are set in the generation environment.
      adminCredentials: {
        admin: 'replace-with-admin-key',
        viewer: 'replace-with-viewer-key',
      },
    },
    replicaCount: spec.replicas,
    ingressController: { enabled: true },
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
