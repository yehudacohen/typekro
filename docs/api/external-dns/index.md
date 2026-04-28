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

const factory = externalDns.externalDnsBootstrap.factory('direct', {
  namespace: 'external-dns',
  waitForReady: true,
});

await factory.deploy({
  name: 'external-dns',
  namespace: 'external-dns',
  provider: 'aws',
  domainFilters: ['example.com'],
  policy: 'sync',
  txtOwnerId: 'typekro-example',
});
```

## Available Factories

| Factory | Description |
|---------|-------------|
| `externalDnsBootstrap` | Deploy External-DNS via Helm |
| `externalDnsHelmRepository` | HelmRepository for External-DNS charts |
| `externalDnsHelmRelease` | Full HelmRelease configuration |
| `dnsEndpoint` | Create DNSEndpoint custom resources |

## Bootstrap Configuration

```typescript
interface ExternalDnsBootstrapConfig {
  name: string;
  namespace?: string;
  provider: 'aws' | 'azure' | 'cloudflare' | 'google' | 'digitalocean';
  domainFilters?: string[];
  policy?: 'sync' | 'upsert-only' | 'create-only';
  dryRun?: boolean;
  txtOwnerId?: string;
  interval?: string;
  logLevel?: 'panic' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
}
```

Use `externalDnsBootstrap.factory('direct' | 'kro', options)` to deploy the bootstrap composition. The bootstrap auto-wires AWS credentials from an `aws-route53-credentials` Secret with `access-key-id`, `secret-access-key`, and optional `session-token` keys. Other providers are accepted as Helm values, but their credential wiring must be configured separately, for example with the lower-level `externalDnsHelmRelease` factory.

When generated for KRO, dynamic Helm values are emitted as a single `spec.values` CEL object so Kro does not need to schema-check arbitrary nested chart keys.

## DNSEndpoint Resource

Create DNS records directly:

```typescript
import * as externalDns from 'typekro/external-dns';

const record = externalDns.dnsEndpoint({
  name: 'app-dns',
  namespace: 'default',
  dnsName: 'app.example.com',
  recordType: 'A',
  targets: ['192.168.1.100'],
  recordTTL: 300
});
```

## Usage in Compositions

```typescript
import { kubernetesComposition } from 'typekro';
import * as externalDns from 'typekro/external-dns';

const app = kubernetesComposition(definition, (spec) => {
  const bootstrap = externalDns.externalDnsBootstrap({
    name: 'external-dns',
    namespace: 'external-dns',
    provider: 'aws',
    domainFilters: [spec.hostname]
  });

  externalDns.dnsEndpoint({
    name: `${spec.name}-dns`,
    namespace: 'default',
    dnsName: spec.hostname,
    recordType: 'CNAME',
    targets: [spec.loadBalancerHost]
  });

  return { ready: bootstrap.status.ready };
});
```

## Prerequisites

External-DNS bootstrap requires Flux CD installed in your cluster. See [Kro Runtime Bootstrap](/api/kro/compositions/runtime) for setup.

## Next Steps

- [Cert-Manager](/api/cert-manager/) - TLS certificates
- [Kubernetes Factories](/api/kubernetes/) - Core resources
