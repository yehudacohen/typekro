# Deployment Methods

TypeKro supports multiple deployment strategies to fit different workflows, environments, and organizational needs. Choose the method that best suits your use case.

## Deployment Methods Overview

TypeKro provides two core factory modes that can be enhanced with optional integrations:

### Core Factory Modes

| Mode | Best For | Complexity | Live Status | GitOps Ready |
|------|----------|------------|-------------|--------------|
| **[Direct](./direct.md)** | Development, Testing | Low | ✅ Yes | ✅ Yes |
| **[KRO](./kro.md)** | Production, Advanced Orchestration | High | ✅ Yes | ✅ Yes |

### Optional Enhancements

| Enhancement | Works With | Purpose |
|-------------|------------|----------|
| **[Alchemy Integration](./alchemy.md)** | Direct + KRO | Infrastructure state tracking and multi-cloud resources |
| **[Helm Resources](./helm.md)** | Direct + KRO | Deploy and manage Helm charts as Enhanced resources |
| **[YAML Integration](../factories.md#yaml-integration)** | Direct + KRO | Deploy existing YAML manifests alongside Enhanced resources |

## Quick Decision Guide

### Choose **Direct Deployment** if:
- You're developing or testing locally
- You want immediate feedback and iteration
- You need live status updates
- You're prototyping or learning TypeKro

```typescript
const factory = graph.factory('direct', { namespace: 'dev' });
await factory.deploy(spec);
```

### Choose **KRO Deployment** if:
- You need advanced resource orchestration
- You want declarative status management  
- You need complex dependency handling
- You're deploying to production environments

```typescript
const factory = graph.factory('kro', { namespace: 'prod' });
await factory.deploy(spec);
```

### Use **GitOps Workflow** with:
- Version-controlled infrastructure deployments
- Audit trails and approval workflows
- Team collaboration requirements

```typescript
// Generate YAML for GitOps tools (works with both modes)
const factory = graph.factory('kro');
const yaml = factory.toYaml(spec);
writeFileSync('deployment.yaml', yaml);
// Commit to Git → ArgoCD/Flux deploys
```

### Choose **Direct** for:
- Development and testing
- Immediate feedback and iteration
- Simple deployment workflows

```typescript
const factory = graph.factory('direct', { namespace: 'dev' });
await factory.deploy(spec);
```

### Choose **KRO** for:
- Production deployments
- Advanced resource orchestration
- Declarative status management
- Complex dependency handling

```typescript
const factory = graph.factory('kro', { namespace: 'prod' });
await factory.deploy(spec);
```

### Add **Alchemy Integration** when:
- You need infrastructure state tracking
- You want multi-cloud resource management
- You require resource lifecycle management

```typescript
// Works with both Direct and KRO modes
const factory = graph.factory('direct', { 
  namespace: 'prod',
  alchemyScope: myAlchemyScope  // Alchemy state tracking
});
await factory.deploy(spec);
```

### Use **Helm Resources** when:
- You want to deploy existing Helm charts
- You need templated deployments with values
- You want HelmRelease status monitoring

```typescript
import { helmRelease } from 'typekro';

// Helm resources work with any factory mode
const graph = kubernetesComposition(definition, (spec) => ({
  myApp: helmRelease({
    name: 'nginx',
    chart: { repository: 'https://charts.bitnami.com/bitnami', name: 'nginx' },
    values: { replicaCount: spec.replicas }
  })
}));

// Deploy using any factory mode
const factory = graph.factory('direct'); // or 'kro'
await factory.deploy(spec);
```

### Use **YAML Integration** when:
- You have existing YAML manifests to integrate
- You're migrating from pure YAML to TypeKro
- You need to bootstrap infrastructure from external sources

```typescript
import { yamlFile, yamlDirectory } from 'typekro';

// YAML deployment closures work with any factory mode
const graph = kubernetesComposition(definition, (spec) => ({
  // Bootstrap Flux system
  fluxSystem: yamlFile({
    name: 'flux-bootstrap',
    path: 'https://github.com/fluxcd/flux2/releases/latest/download/install.yaml',
    deploymentStrategy: 'skipIfExists'
  }),
  
  // Deploy environment-specific manifests
  envManifests: yamlDirectory({
    name: 'env-config',
    path: `./manifests/${spec.environment}`,
    include: ['*.yaml']
  }),

  // TypeKro Enhanced resources alongside YAML
  app: Deployment({
    name: spec.name,
    image: spec.image
  })
}));

// Deploy using any factory mode
const factory = graph.factory('kro'); // or 'direct'
await factory.deploy(spec);
```

## Deployment Patterns

### Development Workflow

For rapid development and testing:

```typescript
// 1. Direct deployment for immediate feedback
const devFactory = graph.factory('direct', { 
  namespace: 'development',
  timeout: 60000
});

await devFactory.deploy({
  name: 'my-app-dev',
  image: 'my-app:latest',
  environment: 'development'
});

// 2. Get status
const status = await devFactory.getStatus();
console.log('App status:', status);
```

### Staging/Production Workflow

For production-ready deployments:

```typescript
// 1. Generate ResourceGraphDefinition YAML once
const rgdYaml = graph.toYaml();

// 2. Create factory for instance YAML generation  
const factory = graph.factory('kro');
const stagingYaml = factory.toYaml({
  name: 'my-app-staging',
  image: 'my-app:v1.2.3',
  environment: 'staging'
});

const prodYaml = factory.toYaml({
  name: 'my-app-prod',
  image: 'my-app:v1.2.3',
  environment: 'production'
});

// 3. Commit to Git repository
writeFileSync('k8s/staging/app.yaml', stagingYaml);
writeFileSync('k8s/production/app.yaml', prodYaml);

// 4. GitOps tool (ArgoCD/Flux) deploys automatically
```

### Multi-Environment Deployment with Enhancements

Deploy the same application across multiple environments using different factory configurations and optional enhancements:

```typescript
import { kubernetesComposition, yamlFile, helmRelease } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

// Composition using multiple optional enhancements
const hybridApp = kubernetesComposition(definition, (spec) => ({
  // YAML Integration - Bootstrap infrastructure
  fluxSystem: yamlFile({
    name: 'flux-bootstrap',
    path: 'https://github.com/fluxcd/flux2/releases/latest/download/install.yaml',
    deploymentStrategy: 'skipIfExists'
  }),
  
  // Helm Resource - Database
  database: helmRelease({
    name: 'postgres',
    chart: { repository: 'https://charts.bitnami.com/bitnami', name: 'postgresql' },
    values: { 
      auth: { database: spec.name },
      primary: { persistence: { size: spec.environment === 'prod' ? '100Gi' : '10Gi' } }
    }
  }),
  
  // TypeKro Enhanced Resource - Application
  app: Deployment({
    name: spec.name,
    image: spec.image,
    replicas: spec.environment === 'prod' ? 5 : 2,
    env: {
      DATABASE_HOST: 'postgres-postgresql'
    }
  }),

  service: Service({
    name: `${spec.name}-service`,
    selector: { app: spec.name },
    ports: [{ port: 80 }]
  })
}));

// Deploy across environments with different configurations
const environments = [
  { name: 'dev', mode: 'direct', alchemy: false },
  { name: 'staging', mode: 'kro', alchemy: false },
  { name: 'prod', mode: 'kro', alchemy: true }
] as const;

for (const env of environments) {
  const factoryOptions = {
    namespace: env.name,
    ...(env.alchemy && { alchemyScope: productionAlchemyScope })
  };
  
  const factory = hybridApp.factory(env.mode, factoryOptions);
  
  await factory.deploy({
    name: `my-app-${env.name}`,
    image: env.name === 'prod' ? 'my-app:v1.2.3' : 'my-app:latest',
    environment: env.name
  });
}
```

## Deployment Configuration

### Common Configuration Options

All deployment methods support common configuration:

```typescript
const factory = graph.factory('direct', {
  namespace: 'my-namespace',        // Target namespace
  timeout: 300000,                  // Deployment timeout (5 minutes)
  waitForReady: true,               // Wait for resources to be ready
  // Note: labels and annotations are set per resource, not at factory level
});
```

### Environment-Specific Configuration

Configure different settings per environment:

```typescript
const config = {
  development: {
    namespace: 'dev',
    timeout: 60000,
    waitForReady: false,    // Fast iteration
    resources: 'minimal'
  },
  staging: {
    namespace: 'staging',
    timeout: 180000,
    waitForReady: true,
    resources: 'standard'
  },
  production: {
    namespace: 'prod',
    timeout: 600000,
    waitForReady: true,
    resources: 'optimized',
    monitoring: true,
    backup: true
  }
};

const factory = graph.factory('kro', config[environment]);
```

## Status and Monitoring

### Live Status Updates

Both Direct and KRO factories provide live status, with or without Alchemy integration:

```typescript
// Works with any factory configuration
const factory = graph.factory('direct', { 
  namespace: 'prod',
  alchemyScope: myAlchemyScope  // Optional Alchemy integration
});

await factory.deploy(spec);

// Get current status
const status = await factory.getStatus();
console.log('Current status:', status);
console.log('Alchemy managed:', factory.isAlchemyManaged);

// Get all instances
const instances = await factory.getInstances();
console.log('All instances:', instances);

// Status includes both Kubernetes and Alchemy state (if enabled)
const checkStatus = async () => {
  const status = await factory.getStatus();
  console.log('Deployment status:', status);
};
setInterval(checkStatus, 5000);
```

### GitOps Status Checking

For GitOps deployments, check status via kubectl:

```bash
# Check deployment status
kubectl get deployment my-app -o json | jq '.status'

# Check custom resource status (if using KRO)
kubectl get webapp my-app -o json | jq '.status'

# Watch for changes
kubectl get webapp my-app -w
```

## Error Handling and Troubleshooting

### Common Deployment Issues

```typescript
try {
  await factory.deploy(spec);
} catch (error) {
  if (error.code === 'TIMEOUT') {
    console.error('Deployment timed out');
  } else if (error.code === 'VALIDATION_ERROR') {
    console.error('Invalid specification:', error.details);
  } else if (error.code === 'RESOURCE_CONFLICT') {
    console.error('Resource already exists:', error.resource);
  } else {
    console.error('Deployment failed:', error.message);
  }
}
```

### Debugging Deployment Issues

```typescript
// Enable debug logging
const factory = graph.factory('direct', {
  namespace: 'dev',
  debug: true,
  logger: {
    level: 'debug',
    pretty: true
  }
});

// Get detailed deployment information
const info = await factory.getDeploymentInfo();
console.log('Deployment details:', info);

// Check resource events
const events = await factory.getEvents();
console.log('Recent events:', events);
```

## Advanced Deployment Strategies

### Blue-Green Deployment

```typescript
async function blueGreenDeploy(newVersion: string) {
  // Deploy green version
  const greenFactory = graph.factory('direct', { 
    namespace: 'production' 
  });
  
  await greenFactory.deploy({
    name: 'my-app-green',
    image: `my-app:${newVersion}`,
    environment: 'production'
  });
  
  // Wait for green to be ready
  await greenFactory.waitForReady();
  
  // Switch traffic to green
  await updateTrafficSplit('my-app-green', 100);
  
  // Remove blue version
  await removeDeployment('my-app-blue');
}
```

### Canary Deployment

```typescript
async function canaryDeploy(newVersion: string) {
  // Deploy canary with 10% traffic
  const canaryFactory = graph.factory('kro', { 
    namespace: 'production' 
  });
  
  await canaryFactory.deploy({
    name: 'my-app-canary',
    image: `my-app:${newVersion}`,
    replicas: 1,  // Small canary
    environment: 'production'
  });
  
  // Gradually increase traffic
  const trafficSteps = [10, 25, 50, 100];
  for (const traffic of trafficSteps) {
    await updateTrafficSplit('my-app-canary', traffic);
    await sleep(300000); // Wait 5 minutes
    
    // Check metrics and rollback if needed
    const metrics = await checkCanaryMetrics();
    if (metrics.errorRate > 0.05) {
      await rollback();
      throw new Error('Canary deployment failed');
    }
  }
}
```

## Security and Compliance

### RBAC Configuration

```typescript
// Ensure proper RBAC for deployment
const factory = graph.factory('kro', {
  namespace: 'production',
  rbac: {
    serviceAccount: 'typekro-deployer',
    clusterRole: 'typekro-operator',
    namespace: 'kro-system'
  }
});
```

### Secret Management

```typescript
// Use external secret management
const factory = graph.factory('kro', {
  namespace: 'production'
  // Note: Secret management would be handled differently
});
```

### Network Policies

```typescript
// Apply network policies during deployment
const factory = graph.factory('kro', {
  namespace: 'production',
  networkPolicies: {
    enabled: true,
    allowIngress: ['nginx-ingress'],
    allowEgress: ['database', 'external-api']
  }
});
```

## Next Steps

Choose your deployment strategy and dive deeper:

**Core Factory Modes:**
- **[Direct Deployment](./direct.md)** - Immediate deployment for development and testing
- **[KRO Integration](./kro.md)** - Advanced orchestration for production

**Enhancement Options:**
- **[Alchemy Integration](./alchemy.md)** - Add infrastructure state tracking to any factory mode
- **[Helm Integration](./helm.md)** - Use Helm charts as Enhanced resources

**Deployment Workflows:**
- **[GitOps Workflows](./gitops.md)** - Version-controlled deployments using generated YAML

Or explore related topics:

- **[Status Hydration](../status-hydration.md)** - Understanding status and references
- **[Examples](../../examples/)** - Real-world deployment examples
- **[Performance](../performance.md)** - Optimizing deployments