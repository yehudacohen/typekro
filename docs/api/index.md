# API Reference

Complete reference for TypeKro APIs, functions, and types.

## Core Composition API

### [kubernetesComposition](./kubernetes-composition.md)

The primary API for creating typed resource graphs.

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment } from 'typekro/simple';

const webApp = kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: type({ name: 'string', image: 'string' }),
    status: type({ ready: 'boolean' })
  },
  (spec) => {
    const deploy = Deployment({ id: 'deploy', name: spec.name, image: spec.image });
    return { ready: deploy.status.readyReplicas > 0 };
  }
);
```

## Expression APIs

### [CEL Expressions](./cel.md)

Explicit CEL expressions for advanced patterns.

```typescript
import { Cel } from 'typekro';

// Most cases: use natural JavaScript (auto-converted to CEL)
ready: deployment.status.readyReplicas > 0

// Advanced: explicit CEL for complex list operations
Cel.expr('size(pods.filter(p, p.status.phase == "Running"))')
```

### [YAML & Helm Closures](./yaml-closures.md)

Deploy external YAML files and Helm charts.

```typescript
import { helmRelease } from 'typekro';
import { YamlFile, HelmChart } from 'typekro/simple';

// Simple YAML file
YamlFile('./manifests/crds.yaml')

// Simple Helm chart
HelmChart('nginx', 'https://charts.bitnami.com/bitnami', 'nginx')

// Full HelmRelease configuration
helmRelease({ 
  id: 'nginx',
  name: 'nginx', 
  chart: { repository: 'https://charts.bitnami.com/bitnami', name: 'nginx' } 
})
```

## Type System

### [Core Types](./types.md)

Essential TypeScript types: `Enhanced`, `RefOrValue`, `KubernetesRef`, `CelExpression`.

## Factory Functions

### [Factory Functions](/api/factories/)

All factory functions: Deployment, Service, ConfigMap, etc.

### [Kubernetes](/api/kubernetes/)

Native Kubernetes resources: Deployment, Service, ConfigMap, Secret, etc.

### [Cilium](./cilium/)

Cilium network policies. Import: `import * as cilium from 'typekro/cilium'`

### [Cert-Manager](./cert-manager/)

Certificate management. Import: `import * as certManager from 'typekro/cert-manager'`

### [Flux](./flux/)

GitOps: HelmRelease, HelmRepository. Import: `import { helmRelease } from 'typekro'`

### [Kro](./kro/)

ResourceGraphDefinition and TypeKro runtime bootstrap.

## Quick Reference

### Import Patterns

See [Import Patterns](./imports.md) for complete import documentation.

```typescript
// Core APIs
import { kubernetesComposition, Cel, externalRef } from 'typekro';

// Simple factories (recommended)
import { Deployment, Service, ConfigMap } from 'typekro/simple';

// Helm integration
import { helmRelease, helmRepository } from 'typekro';

// Types
import type { Enhanced, KubernetesRef } from 'typekro';
```

### Common Patterns

```typescript
import { Deployment, Service } from 'typekro/simple';

// Cross-resource references
const db = Deployment({ id: 'db', name: 'db', image: 'postgres' });
const dbService = Service({
  id: 'dbSvc',
  name: 'db-svc',
  selector: { app: 'db' },
  ports: [{ port: 5432 }]
});
const app = Deployment({
  id: 'app',
  name: 'app',
  image: 'myapp',
  env: { DB_HOST: dbService.status.clusterIP }
});

// Status expressions (JavaScript auto-converted to CEL)
return {
  ready: app.status.readyReplicas >= spec.replicas,
  url: `https://${spec.hostname}`
};
```

## Next Steps

- [Getting Started](/guide/getting-started) - 5-minute quick start
- [kubernetesComposition](./kubernetes-composition.md) - Primary composition API
- [Factory Functions](./factories/) - All factory functions
