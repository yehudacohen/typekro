---
title: Pebble Factories
description: Factory functions for Pebble ACME Test Server
---

# Pebble Factories

::: warning Experimental
Pebble factories are experimental. The API may change in future releases.
:::

Factory functions for deploying Pebble ACME test server - useful for testing cert-manager in development environments.

## What is Pebble?

Pebble is a small ACME test server from Let's Encrypt. It's useful for:

- Testing cert-manager configurations locally
- CI/CD pipelines that need certificate issuance
- Development environments without real DNS

## Installation

```typescript
import * as pebble from 'typekro/pebble';
```

## Quick Example

```typescript
import * as pebble from 'typekro/pebble';

const testServer = pebble.pebbleBootstrap({
  namespace: 'pebble'
});
```

## Available Factories

| Factory | Description |
|---------|-------------|
| `pebbleBootstrap` | Deploy Pebble ACME server via Helm |
| `pebbleHelmRelease` | Full HelmRelease configuration |

## Usage with Cert-Manager

Pebble is typically used alongside cert-manager for testing:

```typescript
import { kubernetesComposition } from 'typekro';
import * as pebble from 'typekro/pebble';
import { clusterIssuer } from 'typekro/cert-manager';

const testEnvironment = kubernetesComposition(definition, (spec) => {
  pebble.pebbleBootstrap({ namespace: 'pebble' });

  clusterIssuer({
    name: 'pebble-issuer',
    spec: {
      acme: {
        server: 'https://pebble.pebble.svc.cluster.local:14000/dir',
        skipTLSVerify: true,
        privateKeySecretRef: { name: 'pebble-account-key' },
        solvers: [{ http01: { ingress: { class: 'nginx' } } }]
      }
    }
  });

  return { ready: true };
});
```

## Prerequisites

Pebble bootstrap requires Flux CD installed in your cluster. See [Kro Runtime Bootstrap](/api/kro/compositions/runtime) for setup.

## Next Steps

- [Cert-Manager](/api/cert-manager/) - Certificate management
- [Kubernetes Factories](/api/kubernetes/) - Core resources
