---
title: Cert-Manager Factories
description: Factory functions for Cert-Manager CRDs
---

# Cert-Manager Factories

Factory functions for Cert-Manager Custom Resource Definitions with built-in readiness evaluation.

## Import

```typescript
// Import specific functions (recommended)
import { certificate, clusterIssuer, issuer } from 'typekro/cert-manager';

// Or namespace import
import * as certManager from 'typekro/cert-manager';
```

## Quick Example

```typescript
import { clusterIssuer, certificate } from 'typekro/cert-manager';

// Create a Let's Encrypt issuer
const letsEncrypt = clusterIssuer({
  name: 'letsencrypt-prod',
  spec: {
    acme: {
      server: 'https://acme-v02.api.letsencrypt.org/directory',
      email: 'admin@example.com',
      privateKeySecretRef: { name: 'letsencrypt-key' },
      solvers: [{ http01: { ingress: { class: 'nginx' } } }]
    }
  }
});

// Request a certificate
const cert = certificate({
  name: 'my-app-tls',
  namespace: 'default',
  spec: {
    secretName: 'my-app-tls-secret',
    dnsNames: ['app.example.com'],
    issuerRef: { name: 'letsencrypt-prod', kind: 'ClusterIssuer' }
  },
  id: 'appCert'
});
```

## Available Factories

| Factory | Scope | Description |
|---------|-------|-------------|
| `certificate` | Namespace | TLS certificate request |
| `issuer` | Namespace | Namespace-scoped certificate issuer |
| `clusterIssuer` | Cluster | Cluster-scoped certificate issuer |

## certificate()

Creates a Certificate resource that requests a TLS certificate from an issuer.

```typescript
import { certificate } from 'typekro/cert-manager';

const cert = certificate({
  name: 'my-tls-cert',
  namespace: 'default',
  spec: {
    secretName: 'my-tls-secret',
    dnsNames: ['example.com', 'www.example.com'],
    issuerRef: {
      name: 'letsencrypt-prod',
      kind: 'ClusterIssuer'
    }
  },
  id: 'tlsCert'
});

// Status reference
return { certReady: cert.status.conditions?.[0]?.status === 'True' };
```

### Certificate Configuration

```typescript
interface CertificateSpec {
  secretName: string;                    // Secret to store the certificate
  issuerRef: {
    name: string;
    kind: 'Issuer' | 'ClusterIssuer';
    group?: string;                      // Default: 'cert-manager.io'
  };
  dnsNames?: string[];                   // DNS SANs
  ipAddresses?: string[];                // IP SANs
  duration?: string;                     // Certificate duration (default: '2160h' / 90 days)
  renewBefore?: string;                  // Renew before expiry (default: '720h' / 30 days)
  privateKey?: {
    algorithm?: 'RSA' | 'ECDSA' | 'Ed25519';
    size?: number;                       // RSA: 2048, 4096; ECDSA: 256, 384, 521
  };
  usages?: string[];                     // Key usages
}
```

## clusterIssuer()

Creates a cluster-wide certificate issuer.

### Self-Signed Issuer

```typescript
import { clusterIssuer } from 'typekro/cert-manager';

const selfSigned = clusterIssuer({
  name: 'selfsigned-issuer',
  spec: { selfSigned: {} }
});
```

### Let's Encrypt with HTTP01

```typescript
const letsEncrypt = clusterIssuer({
  name: 'letsencrypt-prod',
  spec: {
    acme: {
      server: 'https://acme-v02.api.letsencrypt.org/directory',
      email: 'admin@example.com',
      privateKeySecretRef: { name: 'letsencrypt-prod-key' },
      solvers: [{
        http01: { ingress: { class: 'nginx' } }
      }]
    }
  }
});
```

### Let's Encrypt with DNS01 (Cloudflare)

```typescript
const letsEncryptDns = clusterIssuer({
  name: 'letsencrypt-dns',
  spec: {
    acme: {
      server: 'https://acme-v02.api.letsencrypt.org/directory',
      email: 'admin@example.com',
      privateKeySecretRef: { name: 'letsencrypt-dns-key' },
      solvers: [{
        dns01: {
          cloudflare: {
            email: 'admin@example.com',
            apiTokenSecretRef: { name: 'cloudflare-api-token', key: 'api-token' }
          }
        }
      }]
    }
  }
});
```

### CA Issuer

```typescript
const caIssuer = clusterIssuer({
  name: 'ca-issuer',
  spec: {
    ca: { secretName: 'ca-key-pair' }
  }
});
```

## issuer()

Creates a namespace-scoped certificate issuer.

```typescript
import { issuer } from 'typekro/cert-manager';

const nsIssuer = issuer({
  name: 'namespace-issuer',
  namespace: 'my-namespace',
  spec: {
    ca: { secretName: 'namespace-ca-key' }
  }
});
```

## Usage in Compositions

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service, Ingress } from 'typekro/simple';
import { certificate, clusterIssuer } from 'typekro/cert-manager';

const SecureAppSpec = type({
  name: 'string',
  image: 'string',
  hostname: 'string'
});

const secureApp = kubernetesComposition({
  name: 'secure-app',
  apiVersion: 'example.com/v1',
  kind: 'SecureApp',
  spec: SecureAppSpec,
  status: type({ ready: 'boolean', certReady: 'boolean', url: 'string' })
}, (spec) => {
  const deploy = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    ports: [{ containerPort: 8080 }]
  });

  Service({
    id: 'svc',
    name: `${spec.name}-svc`,
    selector: { app: spec.name },
    ports: [{ port: 80, targetPort: 8080 }]
  });

  const cert = certificate({
    name: `${spec.name}-tls`,
    spec: {
      secretName: `${spec.name}-tls-secret`,
      issuerRef: { name: 'letsencrypt-prod', kind: 'ClusterIssuer' },
      dnsNames: [spec.hostname]
    },
    id: 'cert'
  });

  Ingress({
    id: 'ingress',
    name: spec.name,
    host: spec.hostname,
    serviceName: `${spec.name}-svc`,
    servicePort: 80,
    tls: true,
    tlsSecretName: `${spec.name}-tls-secret`
  });

  return {
    ready: deploy.status.readyReplicas > 0,
    certReady: cert.status.conditions?.[0]?.status === 'True',
    url: `https://${spec.hostname}`
  };
});
```

## Readiness Evaluation

Cert-manager factories include built-in readiness evaluators:

- **Certificate**: Ready when `Ready` condition is `True`
- **Issuer/ClusterIssuer**: Ready when `Ready` condition is `True`

```typescript
// Certificates report detailed status
cert.status.conditions     // Array of conditions
cert.status.notAfter       // Certificate expiry time
cert.status.notBefore      // Certificate valid from
cert.status.renewalTime    // Next renewal time
```

## Installing cert-manager with certManagerBootstrap

`certManagerBootstrap` installs cert-manager through a Flux `HelmRepository` and
`HelmRelease`. It renders the same chart values in direct and KRO mode.

```typescript
import { certManagerBootstrap } from 'typekro/cert-manager';

const factory = certManagerBootstrap.factory('kro', { namespace: 'platform' });

await factory.deploy({
  name: 'cert-manager',
  namespace: 'cert-manager',
  replicaCount: 2,
  crds: { enabled: true, keep: true },
  controller: {
    podDisruptionBudget: { enabled: true, minAvailable: '1' },
    topologySpreadConstraints: [
      {
        maxSkew: 1,
        topologyKey: 'topology.kubernetes.io/zone',
        whenUnsatisfiable: 'ScheduleAnyway',
        labelSelector: { matchLabels: { 'app.kubernetes.io/component': 'controller' } },
      },
    ],
  },
  webhook: { replicaCount: 2, podDisruptionBudget: { enabled: true } },
  cainjector: { replicaCount: 2, podDisruptionBudget: { enabled: true } },
});
```

| Field | Default | Notes |
|---|---|---|
| `crds.enabled` | `true` | Installs the CRDs with the chart |
| `crds.keep` | `true` | Keeps the CRDs, and with them every Certificate and Issuer, when the release is uninstalled |
| `global.leaderElection.namespace` | the install namespace | The chart's own default is `kube-system` |
| `replicaCount`, `webhook.replicaCount`, `cainjector.replicaCount` | chart default (1) | With more than 1 replica, also enable that component's `podDisruptionBudget` |
| `controller` / `webhook` / `cainjector` `.podDisruptionBudget` | off | `enabled`, plus `minAvailable` or `maxUnavailable`, not both. Each is a string holding an integer (`'1'`) or a percentage (`'50%'`); the chart renders it unquoted. The chart defaults to `minAvailable: 1` |
| `controller` / `webhook` / `cainjector` `.topologySpreadConstraints` | none | Passed to the chart unchanged. Give each constraint a `labelSelector` that matches that component's pods (`app.kubernetes.io/component: controller`, `webhook` or `cainjector`) |
| `controller` / `webhook` / `cainjector` / `startupapicheck` `.resources` | requests `10m` / `32Mi`, limits `100m` / `128Mi` | Each field is defaulted on its own |
| `startupapicheck.timeout` | `5m` | The chart's default is `1m` |
| `prometheus.enabled` | `false` | The chart's default is `true` |

The cert-manager CRDs are chart templates, not files in the chart's `crds/`
directory. So `crds.enabled` decides whether they are installed, and Flux's
`install.crds` / `upgrade.crds` policy does not apply to them.

Fields of the TypeScript config that the bootstrap schema does not declare
(`controller.tolerations`, `controller.affinity`, `controller.env`,
`customValues`, ...) apply in direct mode only. A KRO instance cannot carry them.

### Migrating from installCRDs

`installCRDs` is deprecated. cert-manager chart v1.17 and later refuse
`installCRDs` together with `crds.enabled`, so TypeKro now renders only `crds`:

- The bootstrap maps `installCRDs` to `crds.enabled` when `crds.enabled` is
  unset, so `installCRDs: false` still disables the CRDs. Replace it with
  `crds: { enabled: false }`.
- `certManagerHelmRelease` now defaults to `crds: { enabled: true, keep: true }`
  instead of `installCRDs: true`. If your `values` still set `installCRDs`, the
  factory adds no `crds` default, so the chart sees only your setting.
- An existing release keeps its CRDs. `installCRDs: true` already meant
  `crds.enabled: true` with `crds.keep: true`, so the rendered CRDs are the same.

## Prerequisites

To install cert-manager without TypeKro:

```bash
# Using Helm
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true
```

## Next Steps

- [Kubernetes Factories](/api/kubernetes/) - Core Kubernetes resources
- [Flux Factories](/api/flux/) - GitOps integration
- [Pebble](/api/pebble/) - ACME test server for development
