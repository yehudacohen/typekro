# API Reference

Complete reference for all TypeKro APIs, functions, and types.

## Core Functions

### [toResourceGraph](./to-resource-graph.md)
The primary function for creating typed resource graphs.

```typescript
const graph = toResourceGraph(name, builder, schema);
```

### [Factory Functions](./factories.md)
Pre-built functions for creating common Kubernetes resources.

```typescript
import { 
  simpleDeployment, 
  simpleService, 
  simpleConfigMap 
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
- `simpleDeployment` - Create Kubernetes Deployments
- `simpleStatefulSet` - Create StatefulSets
- `simpleDaemonSet` - Create DaemonSets
- `simpleJob` - Create Jobs
- `simpleCronJob` - Create CronJobs

### Networking
- `simpleService` - Create Services
- `simpleIngress` - Create Ingress resources
- `simpleNetworkPolicy` - Create NetworkPolicies

### Storage
- `simplePvc` - Create PersistentVolumeClaims
- `simplePv` - Create PersistentVolumes
- `simpleStorageClass` - Create StorageClasses

### Configuration
- `simpleConfigMap` - Create ConfigMaps
- `simpleSecret` - Create Secrets

### RBAC
- `simpleRole` - Create Roles
- `simpleRoleBinding` - Create RoleBindings
- `simpleServiceAccount` - Create ServiceAccounts
- `simpleClusterRole` - Create ClusterRoles
- `simpleClusterRoleBinding` - Create ClusterRoleBindings

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
const app = toResourceGraph('my-app', (schema) => ({
  deployment: simpleDeployment({
    name: schema.spec.name,
    image: schema.spec.image
  })
}), { spec: AppSpec, status: AppStatus });

// Cross-resource references
const database = simpleDeployment({ name: 'db' });
const app = simpleDeployment({
  env: { DB_HOST: database.status.podIP }
});

// CEL expressions
const status = {
  ready: Cel.expr(deployment.status.readyReplicas, '> 0'),
  url: Cel.template('https://%s', ingress.status.loadBalancer.ingress[0].hostname)
};

// Factory deployment
const factory = await graph.factory('direct', { namespace: 'prod' });
await factory.deploy(spec);
```

### Import Paths

```typescript
// Core functions
import { toResourceGraph, Cel } from 'typekro';

// Factory functions
import { 
  simpleDeployment, 
  simpleService,
  simpleConfigMap,
  simpleSecret
} from 'typekro';

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

const factory = await graph.factory('direct', {
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
const graph = toResourceGraph('app', builder, {
  spec: StrictAppSpec,
  status: AppStatus
});
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

- **Documentation**: [TypeKro Docs](/)
- **Examples**: [Examples Gallery](/examples/)
- **Issues**: [GitHub Issues](https://github.com/yehudacohen/typekro/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yehudacohen/typekro/discussions)