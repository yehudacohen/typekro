# Deployment Methods

TypeKro supports multiple deployment strategies to fit different workflows, environments, and organizational needs. Choose the method that best suits your use case.

## Deployment Methods Overview

| Method | Best For | Complexity | Live Status | GitOps | Enterprise |
|--------|----------|------------|-------------|--------|------------|
| **[Direct](./direct.md)** | Development, Testing | Low | ✅ Yes | ❌ No | ❌ No |
| **[GitOps](./gitops.md)** | Production, Teams | Medium | ❌ No | ✅ Yes | ✅ Yes |
| **[KRO](./kro.md)** | Advanced Orchestration | High | ✅ Yes | ✅ Yes | ✅ Yes |
| **[Alchemy](./alchemy.md)** | Enterprise Grade | High | ✅ Yes | ✅ Yes | ✅ Yes |
| **[Helm](./helm.md)** | Package Management | Medium | ❌ No | ✅ Yes | ✅ Yes |

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

### Choose **GitOps** if:
- You want version-controlled infrastructure
- You need audit trails and approval workflows
- You're deploying to production environments
- You're working with a team

```typescript
const yaml = graph.toYaml(spec);
writeFileSync('deployment.yaml', yaml);
// Commit to Git → ArgoCD/Flux deploys
```

### Choose **KRO Integration** if:
- You need advanced resource orchestration
- You want declarative status management
- You need complex dependency handling
- You're building platform abstractions

```typescript
const factory = graph.factory('kro', { namespace: 'prod' });
await factory.deploy(spec);
```

### Choose **Alchemy** if:
- You need enterprise-grade deployment capabilities
- You want advanced traffic management
- You need multi-cluster deployments
- You require compliance and governance

```typescript
const factory = graph.factory('alchemy', { 
  namespace: 'prod',
  cluster: 'us-west-2'
});
await factory.deploy(spec);
```

### Choose **Helm** if:
- You're packaging applications for distribution
- You need templated deployments
- You want to leverage the Helm ecosystem
- You're migrating from existing Helm charts

```typescript
const helmChart = graph.toHelmChart(spec);
writeFileSync('Chart.yaml', helmChart);
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

// 2. Watch for changes
devFactory.onStatusUpdate((status) => {
  console.log('App status:', status);
});
```

### Staging/Production Workflow

For production-ready deployments:

```typescript
// 1. Generate YAML for staging
const stagingYaml = graph.toYaml({
  name: 'my-app-staging',
  image: 'my-app:v1.2.3',
  environment: 'staging'
});

// 2. Generate YAML for production
const prodYaml = graph.toYaml({
  name: 'my-app-prod',
  image: 'my-app:v1.2.3',
  environment: 'production'
});

// 3. Commit to Git repository
writeFileSync('k8s/staging/app.yaml', stagingYaml);
writeFileSync('k8s/production/app.yaml', prodYaml);

// 4. GitOps tool (ArgoCD/Flux) deploys automatically
```

### Multi-Environment Deployment

Deploy the same application across multiple environments:

```typescript
const environments = ['dev', 'staging', 'prod'];

for (const env of environments) {
  const factory = graph.factory(
    env === 'dev' ? 'direct' : 'kro',
    { namespace: env }
  );
  
  await factory.deploy({
    name: `my-app-${env}`,
    image: env === 'prod' ? 'my-app:v1.2.3' : 'my-app:latest',
    replicas: env === 'prod' ? 5 : 2,
    environment: env
  });
}
```

## Deployment Configuration

### Common Configuration Options

All deployment methods support common configuration:

```typescript
const factory = graph.factory('method', {
  namespace: 'my-namespace',        // Target namespace
  timeout: 300000,                  // Deployment timeout (5 minutes)
  waitForReady: true,               // Wait for resources to be ready
  labels: {                         // Additional labels
    'managed-by': 'typekro',
    'team': 'platform'
  },
  annotations: {                    // Additional annotations
    'deployment.kubernetes.io/revision': '1'
  }
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

Direct and KRO deployments provide live status:

```typescript
const factory = graph.factory('direct');
await factory.deploy(spec);

// Get current status
const status = await factory.getStatus();
console.log('Current status:', status);

// Listen for updates
factory.onStatusUpdate((newStatus) => {
  console.log('Status changed:', newStatus);
});

// Monitor specific fields
factory.onFieldChange('ready', (ready) => {
  console.log('Readiness changed:', ready);
});
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
const factory = graph.factory('alchemy', {
  namespace: 'production',
  secretProvider: {
    type: 'vault',
    endpoint: 'https://vault.company.com',
    path: 'secret/myapp'
  }
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

Choose your deployment method and dive deeper:

- **[Direct Deployment](./direct.md)** - Quick start for development
- **[GitOps](./gitops.md)** - Production-ready workflows
- **[KRO Integration](./kro.md)** - Advanced orchestration
- **[Alchemy Integration](./alchemy.md)** - Enterprise deployment
- **[Helm Integration](./helm.md)** - Package management

Or explore related topics:

- **[Runtime Behavior](../runtime-behavior.md)** - Understanding status and references
- **[Examples](../../examples/)** - Real-world deployment examples
- **[Performance](../performance.md)** - Optimizing deployments