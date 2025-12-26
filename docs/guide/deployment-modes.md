# Deployment Modes

TypeKro supports multiple deployment strategies. Choose based on your workflow and requirements.

## Quick Decision Matrix

| Mode | Best For | Requires Kro Controller | CEL Evaluation |
|------|----------|-------------------------|----------------|
| **Direct** | Development, testing, simple deployments | No | At deploy time |
| **Kro** | Production, runtime dependencies, GitOps | Yes | At runtime (continuous) |
| **YAML Generation** | GitOps workflows, CI/CD pipelines | No | N/A |

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
