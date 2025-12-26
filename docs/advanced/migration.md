# Migration Guide

Migrate to TypeKro from existing infrastructure tools incrementally.

## From Raw YAML

Use `YamlFile()` to include existing manifests while adding new TypeKro resources:

```typescript
import { kubernetesComposition } from 'typekro';
import { Service, YamlFile } from 'typekro/simple';
import { type } from 'arktype';

const app = kubernetesComposition({
  name: 'migrated-app',
  apiVersion: 'example.com/v1',
  kind: 'MigratedApp',
  spec: type({ name: 'string' }),
  status: type({ ready: 'boolean' })
}, (spec) => {
  // Include existing YAML - no changes needed
  YamlFile('./k8s/existing-deployment.yaml');

  // Add new TypeKro resources alongside
  const service = Service({
    id: 'svc',
    name: spec.name,
    selector: { app: spec.name },
    ports: [{ port: 80 }]
  });

  return { ready: true };
});
```

Migrate incrementally:
1. Start by wrapping existing YAML with `YamlFile()`
2. Add new resources using TypeKro factories
3. Gradually replace YAML files with TypeKro equivalents

## From Helm

### Option 1: Replace Helm Templates

Convert Helm templates to type-safe TypeKro:

```typescript
// Before: values.yaml + templates/deployment.yaml
// After: Pure TypeScript

import { kubernetesComposition } from 'typekro';
import { Deployment } from 'typekro/simple';
import { type } from 'arktype';

const app = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: type({
    name: 'string',
    replicas: 'number',
    image: 'string'
  }),
  status: type({ ready: 'boolean' })
}, (spec) => {
  const deploy = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    replicas: spec.replicas
  });

  return { ready: deploy.status.readyReplicas > 0 };
});
```

### Option 2: Keep Existing Charts

Use `helmRelease()` to deploy existing Helm charts with type-safe values:

```typescript
import { kubernetesComposition, helmRelease, helmRepository } from 'typekro';
import { type } from 'arktype';

const app = kubernetesComposition({
  name: 'nginx-app',
  apiVersion: 'example.com/v1',
  kind: 'NginxApp',
  spec: type({ replicas: 'number' }),
  status: type({ ready: 'boolean' })
}, (spec) => {
  const repo = helmRepository({
    id: 'bitnami',
    name: 'bitnami',
    url: 'https://charts.bitnami.com/bitnami'
  });

  const release = helmRelease({
    id: 'nginx',
    name: 'nginx',
    chart: {
      repository: 'https://charts.bitnami.com/bitnami',
      name: 'nginx'
    },
    values: {
      replicaCount: spec.replicas  // Type-safe values from spec
    }
  });

  return { ready: true };
});
```

## From CDK8s

Replace CDK8s constructs with TypeKro factories:

```typescript
// Before (CDK8s):
// new KubeDeployment(this, 'deployment', {
//   spec: { replicas: 3, ... }
// });

// After (TypeKro):
import { Deployment } from 'typekro/simple';

const deploy = Deployment({
  id: 'deployment',
  name: 'my-app',
  image: 'nginx',
  replicas: 3
});
```

Key differences from CDK8s:
- No construct tree - resources auto-register in composition context
- Runtime references via CEL expressions (not just deploy-time)
- Direct deployment without synth step
- Status expressions for runtime state

## From Pulumi

Replace Pulumi resources with TypeKro:

```typescript
// Before (Pulumi):
// const deployment = new k8s.apps.v1.Deployment(...);
// export const ip = deployment.status.loadBalancer.ingress[0].ip;

// After (TypeKro):
import { kubernetesComposition } from 'typekro';
import { Service } from 'typekro/simple';

const app = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: type({ name: 'string' }),
  status: type({ ip: 'string' })
}, (spec) => {
  const svc = Service({
    id: 'svc',
    name: spec.name,
    type: 'LoadBalancer',
    ports: [{ port: 80 }]
  });

  return {
    ip: svc.status.loadBalancer.ingress[0].ip  // Runtime reference
  };
});
```

Key differences from Pulumi:
- Stateless - no state backend required
- GitOps-ready YAML output via `toYaml()`
- Runtime references via CEL (evaluated by Kro, not at deploy-time)
- No provider configuration needed

## Exporting Static YAML

Export compositions as static YAML for review or GitOps:

```typescript
import { writeFileSync } from 'fs';

// Generate YAML for review
const yaml = webapp.toYaml();
console.log(yaml);

// Write to file for GitOps
writeFileSync('./manifests/webapp.yaml', yaml);
```

The generated YAML works with any Kubernetes tooling:
- `kubectl apply -f manifests/`
- ArgoCD Application pointing to the manifests directory
- Flux Kustomization

## Compatibility Matrix

| Tool | Compatibility | Notes |
|------|--------------|-------|
| kubectl | ✅ Full | Apply generated YAML directly |
| ArgoCD | ✅ Full | GitOps workflows with generated manifests |
| Flux | ✅ Full | HelmRelease integration, Kustomization support |
| Kustomize | ✅ Full | Use `YamlFile()` with kustomization.yaml |
| Helm | ✅ Full | `helmRelease()` for existing charts |

## Kro Controller Requirements

Some TypeKro features require the Kro controller:

| Feature | Without Kro | With Kro |
|---------|-------------|----------|
| Resource deployment | ✅ Direct mode | ✅ Kro mode |
| Cross-resource references | ❌ Static only | ✅ Runtime CEL |
| Status expressions | ❌ Not evaluated | ✅ Runtime evaluation |
| Status propagation | ❌ Manual | ✅ Automatic |

For static deployments without runtime features, use Direct mode:

```typescript
const factory = webapp.factory('direct', { namespace: 'default' });
await factory.deploy({ name: 'app', image: 'nginx' });
```

For full runtime features, deploy the Kro controller first:

```typescript
import { typeKroRuntimeBootstrap } from 'typekro';

// Bootstrap Kro controller
const runtime = typeKroRuntimeBootstrap();
const runtimeFactory = runtime.factory('direct', { namespace: 'kro-system' });
await runtimeFactory.deploy({});

// Now use Kro mode for runtime features
const factory = webapp.factory('kro', { namespace: 'default' });
await factory.deploy({ name: 'app', image: 'nginx' });
```

## Gradual Adoption Strategy

1. **Week 1**: Wrap existing YAML with `yamlFile()`
2. **Week 2**: Add new resources using TypeKro factories
3. **Week 3**: Replace simple YAML files with TypeKro equivalents
4. **Week 4**: Add status expressions for runtime state
5. **Ongoing**: Migrate remaining resources as needed

## Next Steps

- [Getting Started](/guide/getting-started) - Quick start guide
- [Deployment Modes](/guide/deployment-modes) - Direct vs Kro deployment
- [YAML Integration](/api/yaml-closures) - YamlFile and HelmChart
- [Helm Integration](/examples/helm-integration) - HelmRelease examples
