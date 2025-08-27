# KRO Integration

TypeKro is built on top of Kubernetes Resource Orchestrator (KRO), which provides advanced resource orchestration with runtime dependencies and continuous reconciliation. This guide covers how to use TypeKro with KRO for production-grade infrastructure management.

## What is KRO?

**Kubernetes Resource Orchestrator (KRO)** is an open-source project by AWS Labs, with contributions from Google, Microsoft, and the broader Kubernetes community. KRO enables:

- **Runtime Dependencies** - Resources can reference each other's live cluster state
- **Continuous Reconciliation** - Automatic updates when dependencies change
- **CEL Expressions** - Dynamic resource configuration using Google's Common Expression Language
- **Custom Resource Types** - Define your own Kubernetes resource types with TypeScript schemas
- **GitOps Native** - Generates standard Kubernetes YAML for any GitOps workflow

## KRO vs Direct Mode

| Feature | Direct Mode | KRO Mode |
|---------|-------------|----------|
| **Setup** | No dependencies | Requires KRO controller |
| **Runtime Dependencies** | Limited | Full support |
| **Continuous Reconciliation** | Manual | Automatic |
| **CEL Expressions** | Basic | Advanced |
| **GitOps** | YAML generation | Native ResourceGraphDefinitions |
| **Production Use** | Development/Testing | Production recommended |

## Installing KRO

### Prerequisites

- Kubernetes cluster with admin access
- kubectl configured for your cluster  
- Cluster version 1.20+ recommended
- TypeKro installed in your project

### TypeKro Bootstrap vs Manual Installation

| Approach | Pros | Cons |
|----------|------|------|
| **TypeKro Bootstrap** | • Type-safe installation<br>• Includes Flux CD for HelmRelease support<br>• Automatic readiness checking<br>• Consistent with TypeKro patterns | • Requires TypeKro dependency<br>• More opinionated setup |
| **Manual kubectl** | • Direct control<br>• Minimal dependencies<br>• Official installation method | • Manual YAML management<br>• No readiness guarantees<br>• No Flux integration |

### Install KRO Controller

#### Option 1: TypeKro Bootstrap (Recommended)

Use TypeKro's built-in bootstrap composition for a complete runtime setup:

```typescript
import { typeKroRuntimeBootstrap } from 'typekro';

async function bootstrapKroEnvironment() {
  // Create bootstrap composition
  const bootstrap = typeKroRuntimeBootstrap({
    namespace: 'flux-system',
    fluxVersion: 'v2.4.0',
    kroVersion: '0.3.0'
  });

  // Deploy with direct factory
  const factory = bootstrap.factory('direct', {
    namespace: 'flux-system',
    waitForReady: true,
    timeout: 300000 // 5 minutes
  });

  console.log('Installing Flux CD and KRO...');
  const result = await factory.deploy({
    namespace: 'flux-system'
  });

  console.log('KRO environment ready!', result.status);
}

bootstrapKroEnvironment().catch(console.error);
```

This approach:
- ✅ Installs Flux CD controllers in `flux-system` namespace
- ✅ Installs KRO via HelmRelease in `kro` namespace  
- ✅ Uses proper dependency management and readiness checking
- ✅ Provides TypeScript-native installation experience

#### Option 2: Manual kubectl Installation

```bash
# Install the latest KRO release
kubectl apply -f https://github.com/awslabs/kro/releases/latest/download/kro.yaml

# Verify installation
kubectl get pods -n kro-system
kubectl get crd | grep kro.run
```

### Verify Installation

```bash
# Check Flux controllers (if using TypeKro bootstrap)
kubectl get pods -n flux-system

# Check KRO controller is running
kubectl get pods -n kro

# Verify ResourceGraphDefinition CRD is installed
kubectl explain resourcegraphdefinition

# Check HelmRelease status (if using TypeKro bootstrap)
kubectl get helmrelease -n kro
```

## Basic KRO Integration

### Simple Resource Graph with KRO

```typescript
import { type } from 'arktype';
import { kubernetesComposition, Cel } from 'typekro'; import { Deployment, Service } from 'typekro/simple';

const WebAppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  environment: '"development" | "staging" | "production"'
});

const WebAppStatus = type({
  url: 'string',
  phase: 'string',
  readyReplicas: 'number',
  healthy: 'boolean'
});

const kroWebApp = kubernetesComposition({
  {
    name: 'kro-webapp',
    apiVersion: 'example.com/v1alpha1',
    kind: 'KroWebApp',
    spec: WebAppSpec,
    status: WebAppStatus,
  },
  (schema) => ({
    deployment: Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [{ containerPort: 3000 }]
    }),
    
    service: Service({
      name: Cel.expr(schema.spec.name, '-service'),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }],
      type: schema.spec.environment === 'production' ? 'LoadBalancer' : 'ClusterIP'
    })
  }),
  (schema, resources) => ({
    // KRO will automatically evaluate these CEL expressions
    url: Cel.expr(
      schema.spec.environment, 
      '== "production" ? "http://" + ',
      resources.service.status.loadBalancer.ingress[0].ip,
      ': "http://" + ',
      resources.service.spec.clusterIP
    ),
    
    phase: resources.deployment.status.phase,
    readyReplicas: resources.deployment.status.readyReplicas,
    
    healthy: Cel.expr(
      resources.deployment.status.readyReplicas,
      '== ',
      resources.deployment.spec.replicas,
      '&& ',
      resources.deployment.status.phase,
      '== "Running"'
    )
  })
);
```

### Deploy with KRO

```typescript
// Option 1: Use KRO factory for direct deployment
const kroFactory = kroWebApp.factory('kro', {
  namespace: 'production'
});

await kroFactory.deploy({
  name: 'production-webapp',
  image: 'myapp:v1.0.0',
  replicas: 5,
  environment: 'production'
});

// Option 2: Generate YAML for GitOps
const rgdYaml = kroWebApp.toYaml();
const instanceYaml = kroWebApp.toYaml({
  name: 'production-webapp',
  image: 'myapp:v1.0.0',
  replicas: 5,
  environment: 'production'
});

// Apply with kubectl
// kubectl apply -f webapp-rgd.yaml
// kubectl apply -f webapp-instance.yaml
```

## Advanced KRO Features

### Runtime Dependencies

KRO excels at handling complex runtime dependencies between resources:

```typescript
const databaseStack = kubernetesComposition({
  {
    name: 'database-stack',
    apiVersion: 'data.example.com/v1alpha1',
    kind: 'DatabaseStack',
    spec: DatabaseStackSpec,
    status: DatabaseStackStatus,
  },
  (schema) => ({
    // Database deployment
    database: Deployment({
      name: Cel.expr(schema.spec.name, '-db'),
      image: 'postgres:15',
      env: {
        POSTGRES_DB: schema.spec.database.name,
        POSTGRES_USER: schema.spec.database.user,
        POSTGRES_PASSWORD: schema.spec.database.password
      },
      ports: [{ containerPort: 5432 }]
    }),
    
    // Database service
    databaseService: Service({
      name: Cel.expr(schema.spec.name, '-db-service'),
      selector: { app: Cel.expr(schema.spec.name, '-db') },
      ports: [{ port: 5432, targetPort: 5432 }]
    }),
    
    // Application waits for database to be ready
    app: Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      
      // KRO ensures database is ready before starting app
      env: {
        DATABASE_URL: Cel.template(
          'postgresql://%s:%s@%s:5432/%s',
          schema.spec.database.user,
          schema.spec.database.password,
          databaseService.status.clusterIP,  // Runtime resolution
          schema.spec.database.name
        ),
        
        // Only start when database is ready
        WAIT_FOR_DB: Cel.expr(
          database.status.readyReplicas, '> 0 ? "ready" : "waiting"'
        )
      },
      
      // Readiness probe that checks database connection
      readinessProbe: {
        exec: {
          command: ['sh', '-c', 'pg_isready -h $DATABASE_HOST -p 5432']
        },
        initialDelaySeconds: 10,
        periodSeconds: 5
      }
    }),
    
    appService: Service({
      name: Cel.expr(schema.spec.name, '-service'),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    })
  }),
  (schema, resources) => ({
    // Status is automatically updated by KRO
    databaseReady: Cel.expr(resources.database.status.readyReplicas, '> 0'),
    appReady: Cel.expr(resources.app.status.readyReplicas, '> 0'),
    
    databaseEndpoint: Cel.template(
      '%s:5432',
      resources.databaseService.status.clusterIP
    ),
    
    appEndpoint: Cel.template(
      'http://%s',
      resources.appService.status.clusterIP
    ),
    
    // Complex dependency logic
    fullyOperational: Cel.expr(
      resources.database.status.readyReplicas, '> 0 && ',
      resources.app.status.readyReplicas, '> 0 && ',
      resources.databaseService.status.clusterIP, '!= ""'
    )
  })
);
```

### Dynamic Scaling with KRO

```typescript
const autoScalingStack = kubernetesComposition({
  { name: 'autoscaling-stack', schema: { spec: AutoScalingSpec, status: AutoScalingStatus } },
  (schema) => ({
    app: Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      
      // Dynamic replica count based on conditions
      replicas: Cel.expr(
        schema.spec.environment, 
        '== "production" ? ',
        schema.spec.scaling.maxReplicas,
        ': ',
        schema.spec.scaling.minReplicas
      ),
      
      resources: {
        requests: {
          cpu: schema.spec.resources.cpu,
          memory: schema.spec.resources.memory
        },
        limits: {
          cpu: Cel.expr(schema.spec.resources.cpu, '+ "00m"'),  // Add 00m to base CPU
          memory: Cel.expr(schema.spec.resources.memory, '+ "256Mi"')  // Add 256Mi to base memory
        }
      }
    }),
    
    service: Service({
      name: Cel.expr(schema.spec.name, '-service'),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    }),
    
    hpa: Hpa({
      name: Cel.expr(schema.spec.name, '-hpa'),
      scaleTargetRef: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name: schema.spec.name
      },
      minReplicas: schema.spec.scaling.minReplicas,
      maxReplicas: schema.spec.scaling.maxReplicas,
      
      // Dynamic target based on environment
      targetCPUUtilizationPercentage: Cel.expr(
        schema.spec.environment,
        '== "production" ? 70 : 90'
      )
    })
  }),
  (schema, resources) => ({
    currentReplicas: resources.app.status.readyReplicas,
    desiredReplicas: resources.app.spec.replicas,
    maxReplicas: resources.hpa.spec.maxReplicas,
    
    scalingActive: Cel.expr(
      resources.hpa.status.currentReplicas,
      '!= ',
      resources.hpa.status.desiredReplicas
    ),
    
    cpuUtilization: resources.hpa.status.currentCPUUtilizationPercentage || 0
  })
);
```

### Multi-Environment Configuration

KRO makes it easy to deploy the same application across different environments using the factory pattern:

```typescript
import { type } from 'arktype';
import { kubernetesComposition, Cel } from 'typekro'; import { Deployment, Service } from 'typekro/simple';

const WebAppSpec = type({
  name: 'string',
  image: 'string',
  environment: '"development" | "staging" | "production"'
});

const WebAppStatus = type({
  ready: 'boolean',
  url: 'string',
  environment: 'string'
});

const multiEnvApp = kubernetesComposition({
  {
    name: 'multi-env-app',
    apiVersion: 'apps.example.com/v1',
    kind: 'MultiEnvApp',
    spec: WebAppSpec,
    status: WebAppStatus
  },
  (schema) => ({
    // Simple deployment with environment-aware configuration
    app: Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: Cel.conditional(
        schema.spec.environment === 'production',
        5,
        Cel.conditional(schema.spec.environment === 'staging', 3, 1)
      ),
      ports: [8080],
      env: {
        NODE_ENV: schema.spec.environment,
        LOG_LEVEL: Cel.conditional(
          schema.spec.environment === 'production',
          'warn',
          'debug'
        )
      }
    }),
    
    // Service with environment-appropriate type
    service: Service({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 8080 }],
      type: Cel.conditional(
        schema.spec.environment === 'production',
        'LoadBalancer',
        'ClusterIP'
      )
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, ' > 0'),
    url: Cel.conditional(
      schema.spec.environment === 'production',
      Cel.template('https://%s.example.com', schema.spec.name),
      Cel.template('http://%s', resources.service.spec.clusterIP)
    ),
    environment: schema.spec.environment
  })
);

// Deploy to different environments using the same code
async function deployToEnvironments() {
  // Development
  const devFactory = multiEnvApp.factory('direct', { namespace: 'dev' });
  await devFactory.deploy({
    name: 'myapp-dev',
    image: 'myapp:latest',
    environment: 'development'
  });
  
  // Staging  
  const stagingFactory = multiEnvApp.factory('kro', { namespace: 'staging' });
  await stagingFactory.deploy({
    name: 'myapp-staging',
    image: 'myapp:v1.2.0',
    environment: 'staging'
  });
  
  // Production
  const prodFactory = multiEnvApp.factory('kro', { namespace: 'production' });
  await prodFactory.deploy({
    name: 'myapp',
    image: 'myapp:v1.1.5',
    environment: 'production'
  });
}
);
```

## KRO Resource Graph Lifecycle

### 1. ResourceGraphDefinition Creation

When you use KRO mode, TypeKro generates a ResourceGraphDefinition:

```yaml
apiVersion: kro.run/v1alpha1
kind: ResourceGraphDefinition
metadata:
  name: webapp
spec:
  schema:
    spec:
      type: object
      properties:
        name: { type: string }
        image: { type: string }
        replicas: { type: integer }
        environment: { type: string, enum: ["development", "staging", "production"] }
    status:
      type: object
      properties:
        url: { type: string }
        phase: { type: string }
        readyReplicas: { type: integer }
        healthy: { type: boolean }
  
  graph:
    nodes:
      deployment:
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: ${spec.name}
        spec:
          replicas: ${spec.replicas}
          # ... rest of deployment spec
      
      service:
        apiVersion: v1
        kind: Service
        metadata:
          name: ${spec.name}-service
        spec:
          selector:
            app: ${spec.name}
          # ... rest of service spec
    
    statusMappings:
      url: |
        spec.environment == "production" ? 
        "http://" + nodes.service.status.loadBalancer.ingress[0].ip :
        "http://" + nodes.service.spec.clusterIP
      phase: nodes.deployment.status.phase
      readyReplicas: nodes.deployment.status.readyReplicas
      healthy: |
        nodes.deployment.status.readyReplicas == nodes.deployment.spec.replicas &&
        nodes.deployment.status.phase == "Running"
```

### 2. Instance Deployment

Create an instance of your ResourceGraphDefinition:

```yaml
apiVersion: example.com/v1alpha1
kind: WebApp
metadata:
  name: production-webapp
  namespace: production
spec:
  name: production-webapp
  image: myapp:v1.0.0
  replicas: 5
  environment: production
```

### 3. KRO Controller Processing

The KRO controller:
1. **Reads the instance** and matches it to the ResourceGraphDefinition
2. **Evaluates CEL expressions** to generate concrete resource specifications
3. **Creates resources** in the correct dependency order
4. **Monitors status** and updates the instance status automatically
5. **Handles updates** by re-evaluating expressions and updating resources

## Monitoring KRO Deployments

### Check ResourceGraphDefinition Status

```bash
# List all ResourceGraphDefinitions
kubectl get resourcegraphdefinition

# Get detailed information
kubectl describe resourcegraphdefinition webapp

# Check if RGD is ready
kubectl get rgd webapp -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
```

### Monitor Instance Status

```bash
# Check instance status
kubectl get webapp production-webapp -o yaml

# Watch status updates in real-time
kubectl get webapp production-webapp -w

# Get specific status fields
kubectl get webapp production-webapp -o jsonpath='{.status.url}'
kubectl get webapp production-webapp -o jsonpath='{.status.healthy}'
```

### Debug KRO Issues

```bash
# Check KRO controller logs
kubectl logs -n kro-system deployment/kro-controller-manager

# Check resource events
kubectl describe webapp production-webapp

# Validate CEL expressions
kubectl get rgd webapp -o jsonpath='{.spec.statusMappings}'
```

## Advanced KRO Patterns

### Conditional Resource Creation

```typescript
const conditionalStack = kubernetesComposition({
  { name: 'conditional-stack', schema: { spec: ConditionalSpec } },
  (schema) => ({
    app: Deployment({
      name: schema.spec.name,
      image: schema.spec.image
    }),
    
    service: Service({
      name: Cel.expr(schema.spec.name, '-service'),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    }),
    
    // Only create monitoring resources in production
    ...(schema.spec.environment === 'production' && {
      serviceMonitor: {
        apiVersion: 'monitoring.coreos.com/v1',
        kind: 'ServiceMonitor',
        metadata: {
          name: Cel.expr(schema.spec.name, '-monitor')
        },
        spec: {
          selector: {
            matchLabels: { app: schema.spec.name }
          },
          endpoints: [{
            port: 'metrics',
            path: '/metrics'
          }]
        }
      }
    }),
    
    // Only create ingress for external environments
    ...(schema.spec.external && {
      ingress: Ingress({
        name: Cel.expr(schema.spec.name, '-ingress'),
        rules: [{
          host: schema.spec.hostname,
          http: {
            paths: [{
              path: '/',
              pathType: 'Prefix',
              backend: {
                service: {
                  name: service.metadata.name,
                  port: { number: 80 }
                }
              }
            }]
          }
        }]
      })
    })
  }),
  (schema, resources) => ({
    hasMonitoring: schema.spec.environment === 'production',
    hasIngress: schema.spec.external,
    
    accessUrl: Cel.expr(
      schema.spec.external,
      '? "https://" + ',
      schema.spec.hostname,
      ': "http://" + ',
      resources.service.spec.clusterIP
    )
  })
);
```

### Cross-Graph Dependencies

```typescript
// Shared infrastructure graph
const infraGraph = kubernetesComposition({
  { name: 'infrastructure', schema: { spec: InfraSpec, status: InfraStatus } },
  (schema) => ({
    database: Deployment({
      name: 'shared-database',
      image: 'postgres:15'
    }),
    
    databaseService: Service({
      name: 'shared-database-service',
      selector: { app: 'shared-database' },
      ports: [{ port: 5432, targetPort: 5432 }]
    }),
    
    redis: Deployment({
      name: 'shared-redis',
      image: 'redis:7'
    }),
    
    redisService: Service({
      name: 'shared-redis-service',
      selector: { app: 'shared-redis' },
      ports: [{ port: 6379, targetPort: 6379 }]
    })
  }),
  (schema, resources) => ({
    databaseEndpoint: Cel.template(
      '%s:5432',
      resources.databaseService.status.clusterIP
    ),
    
    redisEndpoint: Cel.template(
      '%s:6379',
      resources.redisService.status.clusterIP
    ),
    
    ready: Cel.expr(
      resources.database.status.readyReplicas, '> 0 && ',
      resources.redis.status.readyReplicas, '> 0'
    )
  })
);

// Application that depends on shared infrastructure
const appWithInfra = kubernetesComposition({
  { name: 'app-with-infra', schema: { spec: AppWithInfraSpec } },
  (schema) => ({
    app: Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      env: {
        // Reference shared infrastructure endpoints
        DATABASE_URL: Cel.template('postgresql://user:pass@%s/myapp', schema.spec.infrastructure.databaseEndpoint),
        REDIS_URL: Cel.template('redis://%s/0', schema.spec.infrastructure.redisEndpoint),
        
        // Wait for infrastructure to be ready
        WAIT_FOR_INFRA: Cel.expr(
          schema.spec.infrastructure.ready,
          '? "ready" : "waiting"'
        )
      }
    })
  }),
  (schema, resources) => ({
    appReady: Cel.expr(resources.app.status.readyReplicas, '> 0'),
    
    infraReady: schema.spec.infrastructure.ready,
    
    fullyReady: Cel.expr(
      resources.app.status.readyReplicas, '> 0 && ',
      schema.spec.infrastructure.ready
    )
  })
);
```

## KRO Best Practices

### 1. Design for Reconciliation

```typescript
// ✅ Design resources that can be safely reconciled
const reconcilableStack = kubernetesComposition({
  definition,
  (schema) => ({
    app: Deployment({
      name: schema.spec.name,
      image: schema.spec.image,
      
      // Use declarative configuration
      replicas: schema.spec.replicas,
      
      // Idempotent environment variables
      env: {
        APP_VERSION: schema.spec.version,
        DEPLOYMENT_TIME: Cel.expr('string(now())')  // Updated on each reconciliation
      }
    })
  }),
  statusBuilder
);
```

### 2. Use Meaningful Status

```typescript
// ✅ Provide actionable status information
const statusBuilder = (schema, resources) => ({
  // High-level state
  phase: resources.app.status.phase,
  
  // Operational metrics
  replicas: {
    desired: resources.app.spec.replicas,
    ready: resources.app.status.readyReplicas,
    available: resources.app.status.availableReplicas
  },
  
  // Service information
  endpoints: {
    internal: Cel.template('http://%s:80', resources.service.spec.clusterIP),
    external: Cel.expr(
      resources.service.status.loadBalancer.ingress,
      '.size() > 0 ? "http://" + ',
      resources.service.status.loadBalancer.ingress[0].ip,
      ': null'
    )
  },
  
  // Health indicators
  healthy: Cel.expr(
    resources.app.status.readyReplicas,
    '== ',
    resources.app.spec.replicas
  ),
  
  // Timestamp for tracking
  lastUpdated: Cel.expr('string(now())')
});
```

### 3. Handle Dependencies Gracefully

```typescript
// ✅ Design robust dependency chains
const dependentStack = kubernetesComposition({
  definition,
  (schema) => ({
    database: Deployment({
      name: 'database',
      image: 'postgres:15'
    }),
    
    app: Deployment({
      name: 'app',
      image: schema.spec.image,
      
      // Safe dependency reference with fallback
      env: {
        DATABASE_HOST: Cel.expr(
          database.status.readyReplicas,
          '> 0 ? ',
          database.status.podIP,
          ': "localhost"'  // Fallback value
        )
      },
      
      // Readiness probe that waits for database
      readinessProbe: {
        exec: {
          command: ['sh', '-c', 'nc -z $DATABASE_HOST 5432']
        },
        initialDelaySeconds: 30,
        periodSeconds: 10
      }
    })
  }),
  statusBuilder
);
```

## Troubleshooting KRO Integration

### Common Issues

**ResourceGraphDefinition not found:**
```bash
# Check if RGD was created
kubectl get rgd
kubectl describe rgd webapp

# Verify KRO controller is running
kubectl get pods -n kro-system
```

**CEL expression evaluation errors:**
```bash
# Check instance status for CEL errors
kubectl describe webapp my-app

# Validate CEL expressions manually
kubectl get rgd webapp -o jsonpath='{.spec.statusMappings.url}'
```

**Resource creation failures:**
```bash
# Check resource events
kubectl get events --sort-by=.metadata.creationTimestamp

# Check individual resource status
kubectl get deployment,service,configmap -l app=my-app
```

**Status not updating:**
```bash
# Check KRO controller logs
kubectl logs -n kro-system deployment/kro-controller-manager -f

# Verify resource status in cluster
kubectl get deployment my-app -o jsonpath='{.status}'
```

## Migration from Direct to KRO Mode

### 1. Test with Dual Deployment

```typescript
// Deploy the same graph in both modes for comparison
const directFactory = graph.factory('direct', { namespace: 'test-direct' });
const kroFactory = graph.factory('kro', { namespace: 'test-kro' });

// Deploy to both environments
await Promise.all([
  directFactory.deploy(spec),
  kroFactory.deploy(spec)
]);

// Compare results
const directStatus = await directFactory.getStatus();
const kroStatus = await kroFactory.getStatus();
```

### 2. Gradual Migration

```typescript
// Start with non-critical applications
const testApps = ['test-app-1', 'test-app-2'];
for (const app of testApps) {
  const kroFactory = graph.factory('kro');
  await kroFactory.deploy({ name: app, /* ... */ });
}

// Monitor and validate before migrating production
```

### 3. Rollback Strategy

```typescript
// Keep direct deployment as backup
const rollbackPlan = {
  async rollback() {
    // Delete KRO resources
    await kubectl('delete', 'webapp', 'my-app');
    
    // Deploy with direct mode
    const directFactory = graph.factory('direct');
    await directFactory.deploy(lastKnownGoodSpec);
  }
};
```

## Next Steps

- **[GitOps Workflows](./gitops.md)** - Use KRO with GitOps for production deployments
- **[Alchemy Integration](./alchemy.md)** - Extend to multi-cloud with Alchemy
- **[Status Hydration](../status-hydration.md)** - Deep dive into KRO status management
- **[Debugging Guide](../debugging.md)** - Debug KRO deployment issues