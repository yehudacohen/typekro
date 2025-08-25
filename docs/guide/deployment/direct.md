# Direct Deployment

Direct deployment allows you to deploy TypeKro resource graphs directly to a Kubernetes cluster without requiring external orchestrators like KRO. This is perfect for development, testing, and scenarios where you need immediate feedback and simple deployment workflows.

## Overview

Direct deployment provides:

- **Immediate deployment** to any Kubernetes cluster
- **Real-time status feedback** through live cluster querying
- **Simple debugging** with direct kubectl integration
- **Rapid iteration** for development workflows
- **No additional dependencies** beyond kubectl access

```typescript
import { toResourceGraph, simple } from 'typekro';

const webApp = toResourceGraph(/* ... */);

// Deploy directly to cluster
const factory = webApp.factory('direct', {
  namespace: 'development'
});

await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 2
});

console.log('Deployed! 🚀');
```

## Prerequisites

### Required Tools

- **kubectl** configured with cluster access
- **Node.js 18+** or **Bun** runtime
- **TypeKro** installed in your project

### Cluster Requirements

- Valid **kubeconfig** for target cluster
- **RBAC permissions** for resource creation
- **Network access** to Kubernetes API server

### Quick Setup Verification

```bash
# Test cluster access
kubectl cluster-info
kubectl get nodes

# Verify permissions
kubectl auth can-i create deployments
kubectl auth can-i create services
kubectl auth can-i get pods
```

## Bootstrap Runtime (Optional)

If you plan to use HelmRelease resources or want to set up a complete TypeKro runtime environment, you can use the bootstrap composition to install Flux CD and KRO:

```typescript
// bootstrap-cluster.ts
import { typeKroRuntimeBootstrap } from 'typekro';

async function setupCluster() {
  const bootstrap = typeKroRuntimeBootstrap({
    namespace: 'flux-system',
    fluxVersion: 'v2.4.0',
    kroVersion: '0.3.0'
  });

  const factory = bootstrap.factory('direct', {
    namespace: 'flux-system',
    waitForReady: true,
    timeout: 300000
  });

  console.log('Setting up TypeKro runtime...');
  await factory.deploy({ namespace: 'flux-system' });
  console.log('Runtime ready!');
}

setupCluster().catch(console.error);
```

This setup enables:
- **HelmRelease support** for Helm chart deployments
- **Advanced KRO features** like runtime dependencies  
- **GitOps workflows** with Flux CD integration
- **Production-ready** monitoring and management

## Basic Direct Deployment

For complete examples, see:
- **[Basic WebApp Pattern](../../examples/basic-webapp.md)** - Simple app with deployment + service
- **[Database + Application](../../examples/database-app.md)** - Full stack with database

### Quick Direct Deployment
```typescript
// 1. Create factory
const factory = webapp.factory('direct', { namespace: 'dev' });

// 2. Deploy application  
await factory.deploy({
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 2,
  environment: 'development'
});

// 3. Check status
const status = await factory.getStatus();
console.log('App ready:', status.ready);
```

### Deployment with Configuration

```typescript
const factory = simpleApp.factory('direct', {
  namespace: 'development',
  timeout: 300000,           // 5 minute timeout
  waitForReady: true,        // Wait for resources to be ready
  kubeconfig: '~/.kube/config', // Custom kubeconfig path
  context: 'dev-cluster'     // Specific kubectl context
});
```

## Factory Configuration Options

### Basic Options

```typescript
interface DirectFactoryOptions {
  namespace?: string;        // Target namespace (default: 'default')
  timeout?: number;         // Deployment timeout in milliseconds
  waitForReady?: boolean;   // Wait for resources to be ready
  kubeconfig?: string;      // Path to kubeconfig file
  context?: string;         // Kubernetes context to use
}
```

### Advanced Options

```typescript
const factory = graph.factory('direct', {
  // Basic configuration
  namespace: 'production',
  timeout: 600000,          // 10 minutes
  
  // Resource management
  waitForReady: true,
  readinessTimeout: 300000,  // 5 minutes for readiness
  
  // Authentication
  kubeconfig: '/path/to/kubeconfig',
  context: 'production-cluster',
  
  // Deployment behavior
  replaceExisting: true,     // Replace existing resources
  dryRun: false,            // Actually deploy (set true for validation)
  
  // Monitoring
  statusUpdateInterval: 10000, // Check status every 10 seconds
  
  // Error handling
  retryAttempts: 3,
  retryBackoff: 'exponential'
});
```

## Deployment Lifecycle

### 1. Resource Creation

```typescript
const factory = graph.factory('direct');

// Deploy resources
const deployment = await factory.deploy({
  name: 'my-app',
  image: 'app:v1.0.0',
  replicas: 2
});

console.log('Resources created:', deployment.resources);
```

### 2. Status Monitoring

```typescript
// Check deployment status
const status = await factory.getStatus();
console.log('Current status:', status);

// Wait for specific conditions
await factory.waitForCondition(
  (status) => status.readyReplicas >= 2,
  { timeout: 300000 }
);

// Listen for status updates
factory.onStatusUpdate((newStatus) => {
  console.log('Status changed:', newStatus);
});
```

### 3. Resource Management

```typescript
// Update deployment
await factory.update({
  name: 'my-app',
  image: 'app:v1.1.0',  // New image version
  replicas: 5           // Scale up
});

// Restart deployment
await factory.restart();

// Scale specific resources
await factory.scale('deployment', 3);

// Delete deployment
await factory.delete();
```

## Environment-Specific Deployments

### Development Environment

```typescript
const devFactory = graph.factory('direct', {
  namespace: 'development',
  waitForReady: false,      // Deploy quickly without waiting
  timeout: 60000,           // Short timeout for fast feedback
  replaceExisting: true     // Replace existing dev resources
});

await devFactory.deploy({
  name: 'dev-app',
  image: 'app:latest',
  replicas: 1,
  environment: 'development'
});
```

### Staging Environment

```typescript
const stagingFactory = graph.factory('direct', {
  namespace: 'staging',
  waitForReady: true,       // Ensure readiness
  timeout: 300000,          // Moderate timeout
  context: 'staging-cluster'
});

await stagingFactory.deploy({
  name: 'staging-app',
  image: 'app:v1.2.0-rc1',
  replicas: 2,
  environment: 'staging'
});
```

### Production Environment

```typescript
const prodFactory = graph.factory('direct', {
  namespace: 'production',
  waitForReady: true,       // Must be ready
  timeout: 600000,          // Longer timeout
  readinessTimeout: 300000, // Wait for full readiness
  context: 'production-cluster',
  retryAttempts: 5          // More retries
});

await prodFactory.deploy({
  name: 'prod-app',
  image: 'app:v1.2.0',
  replicas: 5,
  environment: 'production'
});
```

## Multi-Resource Deployments

### Database and Application Stack

```typescript
const fullStack = toResourceGraph(
  { name: 'fullstack', schema: { spec: FullStackSpec } },
  (schema) => ({
    // Database
    database: simple.Deployment({
      name: Cel.expr(schema.spec.name, '-db'),
      image: 'postgres:15',
      env: {
        POSTGRES_DB: schema.spec.database.name,
        POSTGRES_USER: schema.spec.database.user,
        POSTGRES_PASSWORD: schema.spec.database.password
      },
      ports: [{ containerPort: 5432 }]
    }),
    
    databaseService: simple.Service({
      name: Cel.expr(schema.spec.name, '-db-service'),
      selector: { app: Cel.expr(schema.spec.name, '-db') },
      ports: [{ port: 5432, targetPort: 5432 }]
    }),
    
    // Wait for database before starting app
    app: simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      env: {
        DATABASE_URL: Cel.template('postgresql://%s:%s@%s:5432/%s', schema.spec.database.user, schema.spec.database.password, databaseService.metadata.name, schema.spec.database.name)
      },
      ports: [{ containerPort: 3000 }]
    }),
    
    appService: simple.Service({
      name: Cel.expr(schema.spec.name, '-service'),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    })
  }),
  (schema, resources) => ({
    databaseReady: Cel.expr(resources.database.status.readyReplicas, '> 0'),
    appReady: Cel.expr(resources.app.status.readyReplicas, '> 0'),
    url: Cel.template('http://%s', resources.appService.spec.clusterIP),
    
    fullyReady: Cel.expr(
      resources.database.status.readyReplicas, '> 0 && ',
      resources.app.status.readyReplicas, '> 0'
    )
  })
);

// Deploy with dependency ordering
const factory = fullStack.factory('direct', {
  namespace: 'default',
  waitForReady: true
});

await factory.deploy({
  name: 'my-fullstack',
  image: 'myapp:latest',
  database: {
    name: 'myapp',
    user: 'appuser',
    password: 'secretpassword'
  }
});
```

### Microservices Deployment

```typescript
const microservices = toResourceGraph(
  { name: 'microservices', schema: { spec: MicroservicesSpec } },
  (schema) => {
    const services = {};
    
    // Create deployments for each service
    schema.spec.services.forEach(service => {
      services[service.name] = simple.Deployment({
        name: service.name,
        image: service.image,
        replicas: service.replicas,
        ports: [{ containerPort: service.port }],
        env: service.env
      });
      
      services[Cel.expr(service.name, 'Service')] = simple.Service({
        name: Cel.expr(service.name, '-service'),
        selector: { app: service.name },
        ports: [{ port: service.port, targetPort: service.port }]
      });
    });
    
    return services;
  },
  (schema, resources) => {
    const serviceStatus = {};
    
    schema.spec.services.forEach(service => {
      serviceStatus[service.name] = {
        ready: Cel.expr(resources[service.name].status.readyReplicas, '> 0'),
        endpoint: Cel.template('http://%s:%d', resources[Cel.expr(service.name, 'Service')].spec.clusterIP, service.port)
      };
    });
    
    return {
      services: serviceStatus,
      allReady: Cel.expr(
        schema.spec.services.map(s => 
          Cel.expr(resources[s.name].status.readyReplicas, ' > 0')
        ).join(' && ')
      )
    };
  }
);
```

## Deployment Patterns

### Rolling Deployment

```typescript
async function rollingDeployment() {
  const factory = graph.factory('direct');
  
  // Deploy new version with zero downtime
  await factory.update({
    name: 'my-app',
    image: 'app:v2.0.0',
    replicas: 3,
    strategy: 'RollingUpdate',
    maxUnavailable: 1,
    maxSurge: 1
  });
  
  // Wait for rollout to complete
  await factory.waitForRollout();
  console.log('Rolling deployment completed');
}
```

### Blue-Green Deployment

```typescript
async function blueGreenDeployment() {
  const factory = graph.factory('direct');
  
  // Deploy green version alongside blue
  const greenDeployment = await factory.deploy({
    name: 'my-app-green',
    image: 'app:v2.0.0',
    replicas: 3
  });
  
  // Wait for green to be ready
  await factory.waitForCondition(
    (status) => status.readyReplicas >= 3
  );
  
  // Switch traffic to green
  await factory.updateService('my-app-service', {
    selector: { app: 'my-app-green' }
  });
  
  // Clean up blue version
  await factory.deleteDeployment('my-app-blue');
}
```

### Canary Deployment

```typescript
async function canaryDeployment() {
  const factory = graph.factory('direct');
  
  // Deploy canary with 10% traffic
  await factory.deploy({
    name: 'my-app-canary',
    image: 'app:v2.0.0',
    replicas: 1  // 10% of production traffic
  });
  
  // Monitor canary metrics
  const canaryHealthy = await monitorCanaryHealth();
  
  if (canaryHealthy) {
    // Scale up canary and scale down main
    await factory.scale('my-app-canary', 3);
    await factory.scale('my-app', 0);
    
    // Promote canary to main
    await factory.promote('my-app-canary', 'my-app');
  } else {
    // Rollback canary
    await factory.delete('my-app-canary');
  }
}
```

## Advanced Features

### Health Checks and Readiness

```typescript
const healthyApp = toResourceGraph(
  { name: 'healthy-app', schema: { spec: AppSpec } },
  (schema) => ({
    app: simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      ports: [{ containerPort: 3000 }],
      
      // Health check configuration
      livenessProbe: {
        httpGet: { path: '/health', port: 3000 },
        initialDelaySeconds: 30,
        periodSeconds: 10,
        timeoutSeconds: 5,
        failureThreshold: 3
      },
      
      readinessProbe: {
        httpGet: { path: '/ready', port: 3000 },
        initialDelaySeconds: 5,
        periodSeconds: 5,
        timeoutSeconds: 3,
        failureThreshold: 2
      }
    })
  }),
  (schema, resources) => ({
    healthy: Cel.expr(
      resources.app.status.readyReplicas, 
      '== ', 
      resources.app.spec.replicas
    )
  })
);

// Deploy with health monitoring
const factory = healthyApp.factory('direct', {
  waitForReady: true,
  readinessTimeout: 120000  // 2 minutes for health checks
});
```

### Resource Limits and Scaling

```typescript
const scalableApp = toResourceGraph(
  { name: 'scalable-app', schema: { spec: ScalableAppSpec } },
  (schema) => ({
    app: simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      
      // Resource constraints
      resources: {
        requests: {
          cpu: schema.spec.resources.cpu.min,
          memory: schema.spec.resources.memory.min
        },
        limits: {
          cpu: schema.spec.resources.cpu.max,
          memory: schema.spec.resources.memory.max
        }
      }
    }),
    
    // Horizontal Pod Autoscaler
    hpa: simple.Hpa({
      name: Cel.expr(schema.spec.name, '-hpa'),
      scaleTargetRef: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name: schema.spec.name
      },
      minReplicas: schema.spec.scaling.min,
      maxReplicas: schema.spec.scaling.max,
      targetCPUUtilizationPercentage: 80
    })
  }),
  (schema, resources) => ({
    currentReplicas: resources.app.status.readyReplicas,
    desiredReplicas: resources.app.spec.replicas,
    autoscalingEnabled: true
  })
);
```

### Persistent Storage

```typescript
const statefulApp = toResourceGraph(
  { name: 'stateful-app', schema: { spec: StatefulAppSpec } },
  (schema) => ({
    storage: simple.Pvc({
      name: Cel.expr(schema.spec.name, '-storage'),
      size: schema.spec.storage.size,
      storageClass: schema.spec.storage.class,
      accessModes: ['ReadWriteOnce']
    }),
    
    app: simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      
      volumeMounts: [{
        name: 'data',
        mountPath: '/data'
      }],
      
      volumes: [{
        name: 'data',
        persistentVolumeClaim: {
          claimName: storage.metadata.name
        }
      }]
    })
  }),
  (schema, resources) => ({
    storageReady: resources.storage.status.phase === 'Bound',
    storagePath: '/data',
    storageSize: schema.spec.storage.size
  })
);
```

## Debugging and Troubleshooting

### Enable Debug Logging

```typescript
import { createLogger } from 'typekro';

const logger = createLogger({
  level: 'debug',
  pretty: true
});

const factory = graph.factory('direct', {
  logger,
  namespace: 'development'
});
```

### Deployment Inspection

```typescript
// Get detailed deployment information
const deployment = await factory.getDeploymentDetails();
console.log('Deployment details:', deployment);

// Check resource events
const events = await factory.getResourceEvents();
console.log('Resource events:', events);

// Inspect resource YAML
const yaml = await factory.getResourceYaml('deployment', 'my-app');
console.log('Deployment YAML:', yaml);
```

### Error Handling

```typescript
try {
  await factory.deploy(spec);
} catch (error) {
  if (error instanceof ResourceDeploymentError) {
    console.error('Deployment failed:', error.message);
    console.error('Failed resources:', error.failedResources);
    
    // Get detailed error information
    for (const resource of error.failedResources) {
      const events = await factory.getResourceEvents(resource.kind, resource.name);
      console.error(Cel.template('Events for %s:', resource.name), events);
    }
  }
}
```

### Dry Run Mode

```typescript
// Test deployment without actually creating resources
const factory = graph.factory('direct', {
  dryRun: true,
  namespace: 'development'
});

const dryRunResult = await factory.deploy(spec);
console.log('Dry run result:', dryRunResult);
console.log('Would create resources:', dryRunResult.resources);
```

## Performance Optimization

### Parallel Deployment

```typescript
// Deploy multiple independent resources in parallel
const factory = graph.factory('direct', {
  parallelDeployment: true,
  maxConcurrency: 5
});
```

### Resource Caching

```typescript
const factory = graph.factory('direct', {
  cacheResourceDefinitions: true,
  cacheTTL: 300000  // 5 minutes
});
```

### Batch Operations

```typescript
// Deploy multiple applications in batch
const apps = ['app1', 'app2', 'app3'];
const deployments = await Promise.all(
  apps.map(name => factory.deploy({
    name,
    image: Cel.template('%s:latest', name),
    replicas: 2
  }))
);
```

## Integration with CI/CD

### GitHub Actions Integration

```typescript
// deploy.ts - deployment script for CI/CD
import { config } from './config.js';
import { webApp } from './webapp.js';

async function deploy() {
  const environment = process.env.ENVIRONMENT || 'development';
  const imageTag = process.env.IMAGE_TAG || 'latest';
  
  const factory = webApp.factory('direct', {
    namespace: environment,
    context: config[environment].cluster,
    timeout: 600000
  });
  
  await factory.deploy({
    name: Cel.template('myapp-%s', environment),
    image: Cel.template('myregistry/myapp:%s', imageTag),
    replicas: config[environment].replicas,
    environment
  });
  
  console.log(Cel.template('✅ Deployed to %s', environment));
}

deploy().catch(process.exit(1));
```

### GitLab CI Integration

```yaml
# .gitlab-ci.yml
deploy:
  stage: deploy
  script:
    - bun install
    - bun run deploy
  environment:
    name: $CI_COMMIT_REF_SLUG
  only:
    - main
    - develop
```

## Best Practices

### 1. Environment Separation

```typescript
// ✅ Use different namespaces for environments
const environments = {
  dev: { namespace: 'development', replicas: 1 },
  staging: { namespace: 'staging', replicas: 2 },
  prod: { namespace: 'production', replicas: 5 }
};

const env = process.env.NODE_ENV || 'dev';
const config = environments[env];

const factory = graph.factory('direct', config);
```

### 2. Resource Naming

```typescript
// ✅ Use consistent, descriptive names
const factory = graph.factory('direct');
await factory.deploy({
  name: Cel.template('%s-%s', appName, environment),
  image: Cel.template('%s/%s:%s', registry, appName, version),
  replicas: config.replicas
});
```

### 3. Error Recovery

```typescript
// ✅ Implement retry logic and rollback
async function deployWithRollback() {
  const factory = graph.factory('direct');
  
  try {
    await factory.deploy(newVersion);
  } catch (error) {
    console.error('Deployment failed, rolling back...');
    await factory.rollback();
    throw error;
  }
}
```

### 4. Resource Cleanup

```typescript
// ✅ Clean up temporary resources
process.on('SIGINT', async () => {
  console.log('Cleaning up resources...');
  await factory.delete();
  process.exit(0);
});
```

## Next Steps

- **[KRO Integration](./kro.md)** - Advanced orchestration with KRO
- **[GitOps Workflows](./gitops.md)** - Deploy via GitOps with YAML generation
- **[Status Hydration](../status-hydration.md)** - Monitor deployment status
- **[Troubleshooting](../troubleshooting.md)** - Debug deployment issues