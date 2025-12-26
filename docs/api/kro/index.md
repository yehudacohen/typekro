---
title: Kro Factories
description: Factory functions for Kro CRDs
---

# Kro Factories

Factory functions for Kubernetes Resource Orchestrator (Kro) CRDs.

## What is Kro?

[Kubernetes Resource Orchestrator](https://kro.run/) enables:

- **Runtime Dependencies** - Resources reference each other's runtime state
- **CEL Expressions** - Dynamic values evaluated at runtime
- **Automatic Reconciliation** - Self-healing infrastructure

## Quick Example

```typescript
import { kubernetesComposition } from 'typekro';
import { Deployment } from 'typekro/simple';

const WebApp = kubernetesComposition(definition, (spec) => {
  const deploy = Deployment({ id: 'app', name: spec.name, image: spec.image });
  return { ready: deploy.status.readyReplicas > 0 };
});

// Deploy using Kro (creates ResourceGraphDefinition)
const factory = WebApp.factory('kro', { namespace: 'default' });
await factory.deploy({ name: 'my-app', image: 'nginx' });

// Or generate YAML for GitOps
const yaml = WebApp.toYaml();
```

## Available Factories

### Core

| Factory | Description |
|---------|-------------|
| `resourceGraphDefinition` | Kro RGD resource (from `typekro/kro`) |

### Compositions

| Composition | Description |
|-------------|-------------|
| `typeKroRuntimeBootstrap` | Install Kro controller |

## TypeKro + Kro Integration

TypeKro generates Kro ResourceGraphDefinitions from TypeScript compositions:

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

// TypeScript composition
const app = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1alpha1',
  kind: 'WebApp',
  spec: type({ name: 'string', replicas: 'number' }),
  status: type({ ready: 'boolean', url: 'string' })
}, (spec) => {
  const deploy = Deployment({ 
    id: 'deploy', 
    name: spec.name, 
    replicas: spec.replicas 
  });
  const svc = Service({ 
    id: 'svc', 
    name: `${spec.name}-svc`, 
    selector: { app: spec.name },
    ports: [{ port: 80 }]
  });
  
  return {
    ready: deploy.status.readyReplicas >= spec.replicas,
    url: `http://${svc.status.clusterIP}`
  };
});

// Generates Kro YAML with CEL expressions
const yaml = app.toYaml();
```

## Direct vs Kro Deployment

| Mode | Description | Use When |
|------|-------------|----------|
| `direct` | TypeKro deploys resources directly | Simple deployments, no Kro controller |
| `kro` | Creates ResourceGraphDefinition | Runtime CEL, self-healing, GitOps |

```typescript
// Direct: TypeKro handles deployment
const directFactory = app.factory('direct', { namespace: 'prod' });

// Kro: Kro controller handles deployment
const kroFactory = app.factory('kro', { namespace: 'prod' });
```

## Installing Kro

See [Runtime Bootstrap](/api/kro/compositions/runtime) for complete setup instructions.

```typescript
import { typeKroRuntimeBootstrap } from 'typekro';

const runtime = typeKroRuntimeBootstrap();
const factory = runtime.factory('direct', { 
  namespace: 'flux-system',
  timeout: 300000 
});
await factory.deploy({ namespace: 'flux-system' });
```

## Next Steps

- [Runtime Bootstrap](/api/kro/compositions/runtime) - Install Kro controller
- [Deployment Modes](/guide/deployment-modes) - Direct vs Kro deployment
- [Kubernetes Factories](/api/kubernetes/) - Core Kubernetes resources
