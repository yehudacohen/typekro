# kubernetesComposition API

The primary API for creating typed resource graphs with full type safety and automatic CEL generation.

## Syntax

```typescript
function kubernetesComposition<TSpec, TStatus>(
  definition: {
    name: string;
    apiVersion: string;
    kind: string;
    spec: ArkTypeSchema<TSpec>;
    status: ArkTypeSchema<TStatus>;
  },
  compositionFunction: (spec: MagicProxy<TSpec>) => TStatus
): ResourceGraph<TSpec, TStatus>
```

## Parameters

### `definition`

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Unique name for the resource graph |
| `apiVersion` | `string` | Kubernetes API version (e.g., `example.com/v1alpha1`) |
| `kind` | `string` | Kubernetes resource kind (e.g., `WebApp`) |
| `spec` | `ArkTypeSchema` | ArkType schema defining the spec structure |
| `status` | `ArkTypeSchema` | ArkType schema defining the status structure |

### `compositionFunction`

Function that receives a magic proxy of the spec and:
1. Creates resources (automatically registered)
2. Returns status object with JavaScript expressions (auto-converted to CEL)

## Returns

A `ResourceGraph` instance with methods:

| Method | Description |
|--------|-------------|
| `factory(mode, options)` | Create deployment factory (`'direct'` or `'kro'`) |
| `toYaml(spec?)` | Generate YAML representation |

## Basic Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

const webApp = kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: type({ name: 'string', image: 'string', replicas: 'number' }),
    status: type({ ready: 'boolean', url: 'string' })
  },
  (spec) => {
    const deploy = Deployment({
      id: 'deploy',
      name: spec.name,
      image: spec.image,
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
  }
);
```

## Cross-Resource References

Resources can reference each other's fields:

```typescript
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

const app = kubernetesComposition(definition, (spec) => {
  const db = Deployment({ id: 'db', name: 'db', image: 'postgres' });
  const dbService = Service({
    id: 'dbSvc',
    name: 'db-svc',
    selector: { app: 'db' },
    ports: [{ port: 5432 }]
  });
  
  const api = Deployment({
    id: 'api',
    name: 'api',
    image: spec.image,
    env: {
      DATABASE_HOST: dbService.status.clusterIP,  // Reference service's status
      DATABASE_PORT: '5432'
    }
  });

  return { ready: api.status.readyReplicas > 0 };
});
```

## Status Expressions

JavaScript expressions in the return object are automatically converted to CEL:

```typescript
return {
  // Boolean expressions
  ready: deploy.status.readyReplicas >= spec.replicas,
  
  // String templates
  url: `https://${ingress.status.loadBalancer.ingress[0].hostname}`,
  
  // Conditionals
  phase: deploy.status.readyReplicas > 0 ? 'running' : 'pending',
  
  // Fallbacks
  endpoint: svc.status.loadBalancer?.ingress?.[0]?.ip || 'pending'
};
```

## Deployment

```typescript
// Direct deployment (immediate, no Kro controller)
const factory = webApp.factory('direct', { namespace: 'production' });
await factory.deploy({ name: 'my-app', image: 'nginx', replicas: 3 });

// Kro deployment (creates ResourceGraphDefinition)
const kroFactory = webApp.factory('kro', { namespace: 'production' });
await kroFactory.deploy({ name: 'my-app', image: 'nginx', replicas: 3 });

// Generate YAML for GitOps
const yaml = webApp.toYaml({ name: 'my-app', image: 'nginx', replicas: 3 });
```

## Factory Options

```typescript
interface FactoryOptions {
  namespace?: string;           // Target namespace
  timeout?: number;             // Deployment timeout (ms)
  waitForReady?: boolean;       // Wait for resources to be ready
  
  // Event monitoring - stream control plane logs
  eventMonitoring?: {
    enabled?: boolean;
    eventTypes?: ('Normal' | 'Warning' | 'Error')[];
    includeChildResources?: boolean;
  };
  
  // Debug logging
  debugLogging?: {
    enabled?: boolean;
    statusPolling?: boolean;
    readinessEvaluation?: boolean;
    verboseMode?: boolean;
  };
  
  // Progress callback for custom handling
  progressCallback?: (event: DeploymentEvent) => void;
}
```

## The `id` Parameter

Every resource needs an `id` for cross-resource references:

```typescript
import { Deployment } from 'typekro/simple';

const deploy = Deployment({
  id: 'webDeploy',  // Required for references
  name: spec.name,
  image: spec.image
});

// Now you can reference it
return { replicas: deploy.status.readyReplicas };
```

## Next Steps

- [CEL Expressions](./cel.md) - Advanced expression patterns
- [Factory Functions](./factories/) - All factory functions
