---
title: APISix Factories
description: Factory functions for APISIX gateway bootstrap
---

# APISix Factories

::: warning Experimental
APISix factories are experimental. The API may change in future releases.
:::

Factory functions for deploying the APISIX gateway via Helm. The upstream chart's
`ingress-controller` subchart is currently disabled by this bootstrap to avoid a
duplicate ServiceAccount template conflict. This bootstrap does not reconcile
standard Kubernetes Ingress resources unless you deploy an APISIX ingress
controller separately.

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
  // APISIX's ingress-controller subchart is currently disabled by this
  // factory to avoid a chart ServiceAccount conflict. Deploy an APISIX
  // ingress controller separately if you need Kubernetes Ingress support.
  ingressController: { enabled: false },
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
    stream?: {
      enabled?: boolean;
      only?: boolean;
      tcp?: number[];
      udp?: number[];
    };
    ingress?: {
      enabled?: boolean;
      annotations?: Record<string, string>;
      hosts?: string[];
      tls?: Array<{ secretName?: string; hosts?: string[] }>;
    };
    adminCredentials?: {
      admin?: string;
      viewer?: string;
    };
  };
  ingressController?: {
    /**
     * Accepted for config compatibility, but the bundled ingress-controller
     * subchart is currently disabled by the factory. Deploy an APISIX ingress
     * controller separately if you need Kubernetes Ingress support.
     */
    enabled?: boolean;
    image?: object;
    resources?: object;
    nodeSelector?: Record<string, string>;
    tolerations?: object[];
    affinity?: object;
    securityContext?: object;
    containerSecurityContext?: object;
    extraArgs?: string[];
    env?: Array<{ name: string; value?: string }>;
    config?: {
      apisix?: {
        serviceNamespace?: string;
        serviceName?: string;
        servicePort?: number;
        adminAPIVersion?: string;
      };
      kubernetes?: {
        kubeconfig?: string;
        resyncInterval?: string;
        ingressClass?: string;
        ingressVersion?: string;
        watchEndpointSlices?: boolean;
        namespace?: string;
        watchedNamespace?: string;
      };
    };
  };
  apisix?: {
    image?: object;
    resources?: object;
    nodeSelector?: Record<string, string>;
    tolerations?: object[];
    affinity?: object;
    securityContext?: object;
    containerSecurityContext?: object;
    extraArgs?: string[];
    env?: Array<{ name: string; value?: string }>;
    config?: Record<string, unknown>;
  };
  dashboard?: {
    enabled?: boolean;
    image?: object;
    resources?: object;
    config?: Record<string, unknown>;
  };
  etcd?: {
    enabled?: boolean;
    replicaCount?: number;
    image?: object;
    resources?: object;
    auth?: {
      rbac?: { create?: boolean; user?: string; password?: string };
      tls?: object;
    };
  };
  serviceAccount?: {
    create?: boolean;
    name?: string;
    annotations?: Record<string, string>;
  };
  rbac?: {
    create?: boolean;
  };
  customValues?: Record<string, unknown>;
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
    ingressController: { enabled: false },
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
