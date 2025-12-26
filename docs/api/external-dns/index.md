---
title: External-DNS Factories
description: Factory functions for External-DNS
---

# External-DNS Factories

::: warning Experimental
External-DNS factories are experimental. The API may change in future releases.
:::

Factory functions for deploying External-DNS via Helm and creating DNSEndpoint resources.

## Installation

```typescript
import * as externalDns from 'typekro/external-dns';
```

## Quick Example

```typescript
import * as externalDns from 'typekro/external-dns';

// Bootstrap External-DNS with Helm
const bootstrap = externalDns.externalDnsBootstrap({
  namespace: 'external-dns',
  provider: 'cloudflare',
  config: {
    domainFilters: ['example.com'],
    policy: 'sync'
  }
});
```

## Available Factories

| Factory | Description |
|---------|-------------|
| `externalDnsBootstrap` | Deploy External-DNS via Helm |
| `externalDnsHelmRelease` | Full HelmRelease configuration |
| `dnsEndpoint` | Create DNSEndpoint custom resources |

## Bootstrap Configuration

```typescript
interface ExternalDnsBootstrapConfig {
  namespace?: string;
  provider: 'cloudflare' | 'aws' | 'azure' | 'google' | string;
  config?: {
    domainFilters?: string[];
    policy?: 'sync' | 'upsert-only';
    txtOwnerId?: string;
    interval?: string;
  };
  credentials?: {
    secretName: string;
  };
}
```

## DNSEndpoint Resource

Create DNS records directly:

```typescript
import * as externalDns from 'typekro/external-dns';

const record = externalDns.dnsEndpoint({
  metadata: { name: 'app-dns', namespace: 'default' },
  spec: {
    endpoints: [{
      dnsName: 'app.example.com',
      recordType: 'A',
      targets: ['192.168.1.100'],
      recordTTL: 300
    }]
  }
});
```

## Usage in Compositions

```typescript
import { kubernetesComposition } from 'typekro';
import * as externalDns from 'typekro/external-dns';

const app = kubernetesComposition(definition, (spec) => {
  externalDns.externalDnsBootstrap({
    namespace: 'external-dns',
    provider: 'cloudflare'
  });

  externalDns.dnsEndpoint({
    metadata: { name: `${spec.name}-dns` },
    spec: {
      endpoints: [{
        dnsName: spec.hostname,
        recordType: 'CNAME',
        targets: [spec.loadBalancerHost]
      }]
    }
  });

  return { ready: true };
});
```

## Prerequisites

External-DNS bootstrap requires Flux CD installed in your cluster. See [Kro Runtime Bootstrap](/api/kro/compositions/runtime) for setup.

## Next Steps

- [Cert-Manager](/api/cert-manager/) - TLS certificates
- [Kubernetes Factories](/api/kubernetes/) - Core resources
