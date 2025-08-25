# API Reference

Complete reference for all TypeKro APIs, functions, and types.

## Core Functions

### [kubernetesComposition](./kubernetes-composition.md) (Recommended)
The imperative composition pattern for creating typed resource graphs.

```typescript
const graph = kubernetesComposition(definition, compositionFunction);
```

### [toResourceGraph](./to-resource-graph.md) (Declarative)
Alternative declarative function for creating typed resource graphs.

```typescript
const graph = toResourceGraph(definition, resourceBuilder, statusBuilder);
```

### [Factory Functions](./factories.md)
Pre-built functions for creating common Kubernetes resources.

```typescript
import { 
  simple, 
  kubernetesComposition,
  toResourceGraph
} from 'typekro';
```

### CEL Expressions
Common Expression Language integration for dynamic field evaluation. See the [CEL Expressions Guide](../guide/cel-expressions.md) for detailed documentation.

```typescript
import { Cel } from 'typekro';

const ready = Cel.expr(deployment.status.readyReplicas, '> 0');
const url = Cel.template('https://%s/api', service.status.loadBalancer.ingress[0].hostname);
```

## Factory Functions by Category

All factory functions are documented in the [Factory Functions](./factories.md) reference. Key categories include:

### Workloads
- `Deployment` / `simple.Deployment` - Create Kubernetes Deployments
- `StatefulSet` / `simple.StatefulSet` - Create StatefulSets
- `Job` / `simple.Job` - Create Jobs
- `CronJob` / `simple.CronJob` - Create CronJobs

### Networking
- `Service` / `simple.Service` - Create Services
- `Ingress` / `simple.Ingress` - Create Ingress resources
- `NetworkPolicy` / `simple.NetworkPolicy` - Create NetworkPolicies

### Storage
- `Pvc` / `simple.Pvc` - Create PersistentVolumeClaims

### Configuration
- `ConfigMap` / `simple` - Create ConfigMaps
- `Secret` / `simple.Secret` - Create Secrets

### Autoscaling
- `Hpa` / `simple.Hpa` - Create Horizontal Pod Autoscalers

### Helm & YAML
- `HelmChart` / `simple.HelmChart` - Create Helm releases
- `YamlFile` / `simple.YamlFile` - Include YAML files

## Types

Essential TypeScript types and interfaces are documented inline with IntelliSense support. See the [Factory Functions](./factories.md) reference for detailed type information.

```typescript
interface ResourceGraph<TSpec, TStatus> {
  factory(mode: 'direct' | 'kro', options?: FactoryOptions): Promise<ResourceFactory>;
  toYaml(spec?: TSpec): string;
}

interface Enhanced<T, S> extends KubernetesResource {
  spec: T;
  status: S;
}
```

## Quick Reference

### Common Patterns

```typescript
// Basic resource graph
const app = toResourceGraph(
  {
    name: 'my-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'MyApp',
    spec: MyAppSpec,
    status: MyAppStatus,
  },
  (schema) => ({
  deployment: simple.Deployment({
    name: schema.spec.name,
    image: schema.spec.image
  })
}), { spec: AppSpec, status: AppStatus });

// Cross-resource references
const database = simple.Deployment({ name: 'db' });
const app = simple.Deployment({
  env: { DB_HOST: database.status.podIP }
});

// CEL expressions
const status = {
  ready: Cel.expr(deployment.status.readyReplicas, '> 0'),
  url: Cel.template('https://%s', ingress.status.loadBalancer.ingress[0].hostname)
};

// Factory deployment
const factory = graph.factory('direct', { namespace: 'prod' });
await factory.deploy(spec);
```

### Import Paths

```typescript
// Core functions
import { kubernetesComposition, toResourceGraph, Cel } from 'typekro';

// Factory functions (recommended - direct imports)
import { Deployment, Service, ConfigMap, Secret } from 'typekro/simple';

// Or use simple namespace
import { simple } from 'typekro';

// Direct imports (cleaner)
const deployment = Deployment({ /* ... */ });
const service = Service({ /* ... */ });

// Namespace imports (also valid)
const configMap = simple({ /* ... */ });
const secret = simple.Secret({ /* ... */ });

// Types
import type { 
  ResourceGraph,
  Enhanced,
  FactoryOptions,
  KubernetesRef
} from 'typekro';
```

## Error Handling

### Common Errors

```typescript
// Deployment errors
try {
  await factory.deploy(spec);
} catch (error) {
  if (error instanceof ResourceDeploymentError) {
    console.error('Deployment failed:', error.message);
    console.error('Failed resources:', error.failedResources);
  }
}

// Reference resolution errors
try {
  const resolved = await resolver.resolve(ref);
} catch (error) {
  if (error instanceof ReferenceResolutionError) {
    console.error('Reference resolution failed:', error.reference);
  }
}

// CEL evaluation errors
try {
  const result = await evaluator.evaluate(expression);
} catch (error) {
  if (error instanceof CelExpressionError) {
    console.error('CEL evaluation failed:', error.expression);
  }
}
```

## Configuration

### Factory Options

```typescript
interface FactoryOptions {
  namespace?: string;
  kubeconfig?: string;
  timeout?: number;
  dryRun?: boolean;
  skipTLSVerify?: boolean;
}

const factory = graph.factory('direct', {
  namespace: 'production',
  timeout: 300000,  // 5 minutes
  dryRun: false
});
```

### Logging Configuration

```typescript
import { createLogger } from 'typekro';

const logger = createLogger({
  level: 'info',
  pretty: process.env.NODE_ENV === 'development'
});
```

## Advanced Usage

### Custom Factory Functions

```typescript
import { createResource } from 'typekro';

export function customDeployment(config: CustomDeploymentConfig) {
  return createResource({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: config.name,
      labels: { app: config.name, ...config.labels }
    },
    spec: {
      replicas: config.replicas,
      selector: { matchLabels: { app: config.name } },
      template: {
        metadata: { labels: { app: config.name } },
        spec: {
          containers: [{
            name: config.name,
            image: config.image,
            // ... custom logic
          }]
        }
      }
    }
  });
}
```

### Schema Validation

```typescript
import { type } from 'arktype';

const StrictAppSpec = type({
  name: 'string>2',  // At least 3 characters
  image: 'string',
  replicas: 'number>0',  // At least 1
  environment: '"dev" | "staging" | "prod"'
});

// Validation happens automatically
const graph = toResourceGraph(
  {
    name: 'app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'App',
    spec: StrictAppSpec,
    status: AppStatus,
  },
  builder,
  statusBuilder
);
```

## Migration Guide

### From v1.x to v2.x

```typescript
// Old API (v1.x)
import { createResourceGraph } from 'typekro';

// New API (v2.x)
import { toResourceGraph } from 'typekro';
```

### Breaking Changes

- `createResourceGraph` → `toResourceGraph`
- Factory options now use `FactoryOptions` interface
- CEL expressions require explicit `Cel.expr()` or `Cel.template()`

## Support

- **Documentation**: [TypeKro Docs](../index.md)
- **Examples**: [Examples Gallery](../examples/)
- **Issues**: [GitHub Issues](https://github.com/yehudacohen/typekro/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yehudacohen/typekro/discussions)