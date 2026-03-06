# Deployment Modes

TypeKro supports multiple deployment strategies. Choose based on your workflow and requirements.

## Quick Decision Matrix

| Mode | Best For | Requires Kro Controller | CEL Evaluation |
|------|----------|-------------------------|----------------|
| **Direct** | Development, testing, simple deployments | No | At deploy time |
| **Kro** | Production, runtime dependencies, GitOps | Yes | At runtime (continuous) |
| **Alchemy** | Production orchestration with Alchemy framework | No | At deploy time |
| **Auto** | Automatic mode selection based on environment | Depends | Depends |
| **YAML Generation** | GitOps workflows, CI/CD pipelines | No | N/A |

> **Note:** `auto` mode is reserved for future use. When specified in `DeploymentOptions.mode`, it will automatically select `direct` or `kro` based on whether a Kro controller is detected in the cluster. Currently, use `direct` or `kro` explicitly.
>
> **Note:** `alchemy` mode deploys through the [Alchemy](https://github.com/sam-goodwin/alchemy) framework, providing state management and lifecycle tracking. Pass `alchemyScope` in factory options to enable it.

## Value Resolution Behavior

The table below shows how each value type is handled across factory modes and operations.

**Key:** Resolve = substituted with concrete value | CEL = emitted as `${...}` expression | Error = throws with guidance

### `deploy(spec)` — deploys resources to the cluster

| Value Type | Direct Mode | Kro Mode |
|---|---|---|
| **Literal** (compile-time known) | Resolve | Embedded in CR instance |
| **`schema.spec.*`** (magic proxy) | Resolve (from spec) | Embedded in CR instance |
| **`$field`** (forced KubernetesRef) | Resolve (from spec) | Embedded in CR instance |
| **`resources.X.status.Y`** (cross-resource ref) | Resolve (from live cluster, level-by-level) | Kro controller resolves at runtime |
| **`Cel.expr()`** | Evaluate via angular-expressions at deploy time | Kro controller evaluates at runtime |
| **`Cel.template()`** | Evaluate via angular-expressions at deploy time | Kro controller evaluates at runtime |
| **Template literal** (`` `${schema.spec.name}-app` ``) | Resolve (marker string → spec value) | Kro controller resolves `${schema.spec.name}` |
| **`includeWhen` / `forEach` / `readyWhen`** | Evaluated by composition re-execution | Emitted as Kro directives |

### `toYaml(spec)` — generates YAML offline (no cluster access)

| Value Type | Direct Mode | Kro Mode |
|---|---|---|
| **Literal** (compile-time known) | Resolve | Embedded in CR instance |
| **`schema.spec.*`** (magic proxy) | Resolve (from spec) | Embedded in CR instance |
| **`$field`** (forced KubernetesRef) | **Error** — Kro optional access (`.?field`) requires Kro | CEL `${resource.data.?field}` |
| **`resources.X.status.Y`** (cross-resource ref) | **Error** — needs cluster state | CEL `${X.status.Y}` |
| **`Cel.expr()`** | **Error** — explicit CEL requires Kro or `deploy()` | CEL `${expression}` |
| **`Cel.template()`** | **Error** — explicit CEL requires Kro or `deploy()` | CEL `${template}` |
| **Template literal** (`` `${schema.spec.name}-app` ``) | Resolve (marker string → spec value) | CEL `${schema.spec.name}-app` |
| **`includeWhen` / `forEach` / `readyWhen`** | Evaluated by composition re-execution | Emitted as Kro directives |

### `resourceGraph.toYaml()` — generates Kro ResourceGraphDefinition YAML (no spec)

All references are emitted as CEL expressions for the Kro controller. This is always Kro-mode output regardless of how you later create factories.

> **Why does direct mode `toYaml()` error on CEL/KubernetesRef?**
>
> Direct mode `toYaml()` generates plain Kubernetes manifests. These must be valid YAML that
> `kubectl apply` can process. CEL expressions and cross-resource references have no meaning
> outside of Kro. If your resource graph uses these features, use `deploy()` (which resolves
> everything at runtime) or `factory('kro')` (which generates Kro-managed YAML).

## When is Kro Required?

**Direct mode** deploys resources immediately and evaluates CEL expressions once at deployment time. No additional controllers needed.

**Kro mode** creates ResourceGraphDefinitions that the Kro controller manages. CEL expressions are evaluated continuously against live cluster state.

| Feature | Direct Mode | Kro Mode |
|---------|-------------|----------|
| Resource deployment | ✅ Immediate | ✅ Via Kro controller |
| Cross-resource references | ✅ Resolved at deploy time | ✅ Resolved at runtime |
| Status expressions | ✅ Evaluated once | ✅ Continuously updated |
| Runtime dependencies | ❌ Static values only | ✅ Live cluster state |
| Continuous reconciliation | ❌ No | ✅ Yes |
| Controller required | ❌ No | ✅ Kro controller |

**Use Direct mode when:**
- Developing and testing locally
- Simple deployments without runtime dependencies
- You don't want to install additional controllers

**Use Kro mode when:**
- Resources need to reference each other's live state
- You want continuous reconciliation
- Status should update as cluster state changes

## Direct Deployment

Deploy resources immediately to any Kubernetes cluster. No additional controllers required.

```typescript
const factory = webapp.factory('direct', { namespace: 'dev' });
await factory.deploy({ name: 'my-app', image: 'nginx:latest', replicas: 2 });
```

**When to use:**
- Local development and rapid iteration
- Testing compositions before production
- Simple deployments without runtime dependencies
- Teams not ready to install Kro controller

**How it works:**
1. TypeKro resolves all references at deployment time
2. Resources deploy in dependency order
3. Waits for readiness (configurable)
4. Returns live status from cluster

### Streaming Control Plane Logs

Enable real-time Kubernetes event streaming during deployment:

```typescript
const factory = webapp.factory('direct', {
  namespace: 'dev',
  eventMonitoring: {
    enabled: true,
    eventTypes: ['Normal', 'Warning', 'Error'],
    includeChildResources: true
  },
  debugLogging: {
    enabled: true,
    statusPolling: true,
    readinessEvaluation: true,
    verboseMode: true
  },
  progressCallback: (event) => {
    console.log(`[${event.type}]`, event);
  }
});
```

### Environment Variables for Debugging

```bash
# Set log level (trace, debug, info, warn, error, fatal)
export TYPEKRO_LOG_LEVEL=debug

# Enable debug mode for factory operations
export TYPEKRO_DEBUG=true

# Enable pretty-printed logs for development
export TYPEKRO_LOG_PRETTY=true
```

## Kro Deployment

::: info What is Kro?
[Kro](https://kro.run) is a Kubernetes controller that manages ResourceGraphDefinitions - custom resources that define how to create and manage groups of related resources. TypeKro generates these definitions; Kro runs them.
:::

Generate ResourceGraphDefinitions for the Kro controller to manage. Enables runtime dependencies and continuous reconciliation.

```typescript
const factory = webapp.factory('kro', { namespace: 'prod' });
await factory.deploy({ name: 'my-app', image: 'nginx:latest', replicas: 5 });
```

**When to use:**
- Production deployments with runtime dependencies
- Resources that reference each other's live state
- Continuous reconciliation requirements
- Advanced CEL expression evaluation

**How it works:**
1. TypeKro generates a ResourceGraphDefinition
2. Kro controller creates and manages resources
3. CEL expressions evaluate against live cluster state
4. Status updates automatically as resources change

### Kro Factory with Event Monitoring

```typescript
const factory = webapp.factory('kro', {
  namespace: 'prod',
  timeout: 600000,
  eventMonitoring: {
    enabled: true,
    eventTypes: ['Warning', 'Error'],
    includeChildResources: true
  },
  progressCallback: (event) => {
    if (event.type === 'kubernetes-event') {
      console.log(`K8s Event: ${event.message}`);
    }
  }
});
```

### Runtime Dependencies

Kro excels at runtime dependencies between resources:

```typescript
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

const stack = kubernetesComposition(definition, (spec) => {
  const db = Deployment({ id: 'db', name: 'postgres', image: 'postgres:15' });
  const dbService = Service({ 
    id: 'dbService',
    name: 'postgres-svc', 
    selector: { app: 'postgres' },
    ports: [{ port: 5432 }]
  });
  
  const app = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    env: {
      // Runtime reference - resolved by Kro against live cluster state
      DATABASE_HOST: dbService.status.clusterIP
    }
  });
  
  return {
    ready: db.status.readyReplicas > 0 && app.status.readyReplicas > 0,
    dbEndpoint: `${dbService.status.clusterIP}:5432`
  };
});
```

## YAML Generation

Generate deterministic YAML for GitOps workflows. Works with ArgoCD, Flux, or any GitOps tool.

```typescript
// Generate ResourceGraphDefinition YAML
const rgdYaml = webapp.toYaml();

// Generate instance YAML
const factory = webapp.factory('kro');
const instanceYaml = factory.toYaml({ name: 'prod-app', image: 'nginx:v1.0', replicas: 3 });

// Write to files for GitOps
writeFileSync('k8s/rgd.yaml', rgdYaml);
writeFileSync('k8s/instance.yaml', instanceYaml);
```

**When to use:**
- Version-controlled infrastructure
- Audit trails and approval workflows
- CI/CD pipeline integration
- Team collaboration with pull requests

## Configuration Options

### Direct Factory Options

```typescript
const factory = webapp.factory('direct', {
  namespace: 'production',
  timeout: 300000,           // 5 minute timeout
  waitForReady: true,        // Wait for resources to be ready
  
  // Event monitoring - stream control plane logs
  eventMonitoring: {
    enabled: true,
    eventTypes: ['Normal', 'Warning', 'Error'],
    includeChildResources: true,
    deduplicationWindow: 60,
    maxEventsPerSecond: 100
  },
  
  // Debug logging
  debugLogging: {
    enabled: true,
    statusPolling: true,
    readinessEvaluation: true,
    verboseMode: false
  },
  
  // Progress callback for custom handling
  progressCallback: (event) => {
    console.log(`[${event.type}]`, event);
  }
});
```

### Kro Factory Options

```typescript
const factory = webapp.factory('kro', {
  namespace: 'production',
  timeout: 600000,           // 10 minute timeout for complex graphs
  
  // Event monitoring works with Kro mode too
  eventMonitoring: {
    enabled: true,
    eventTypes: ['Warning', 'Error']
  }
});
```

## Environment Patterns

### Development

```typescript
const devFactory = webapp.factory('direct', {
  namespace: 'dev',
  waitForReady: false,  // Fast iteration
  timeout: 60000,
  debugLogging: { enabled: true, verboseMode: true }
});
```

### Production

```typescript
const prodFactory = webapp.factory('kro', {
  namespace: 'production',
  timeout: 600000,
  eventMonitoring: { enabled: true, eventTypes: ['Warning', 'Error'] }
});

// Or generate YAML for GitOps
const yaml = prodFactory.toYaml(prodSpec);
```

## Next Steps

- [Getting Started](./getting-started.md) - Deploy your first app
- [External References](./external-references.md) - Cross-composition coordination
