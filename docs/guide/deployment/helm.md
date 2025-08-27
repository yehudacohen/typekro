# Helm Integration

Deploy applications using Helm charts with TypeKro's type-safe configuration and smart value templating. This approach combines the rich Helm ecosystem with TypeKro's magic proxy system for schema references and CEL expressions.

## Quick Start

### Basic Helm Release

Deploy a Helm chart with static configuration:

```typescript
import { kubernetesComposition, Cel helmRelease } from 'typekro';
import { HelmChart } from 'typekro/simple';
import { type } from 'arktype';

const AppSchema = type({
  name: 'string',
  version: 'string',
  replicas: 'number'
});

const appGraph = kubernetesComposition({
  name: 'nginx-app',
  apiVersion: 'example.com/v1alpha1',
  kind: 'NginxApp',
  spec: AppSchema
}, (schema) => {
    // Create repository first
    const repository = helmRepository({
      name: 'bitnami',
      url: 'https://charts.bitnami.com/bitnami',
      interval: '10m'
    });
    
    // Create app using simple factory
    const app = HelmChart(
      'nginx',
      repository.spec.url,  // Reference repository URL by field
      'nginx',
      {
        replicaCount: schema.spec.replicas,
        image: {
          tag: schema.spec.version
        }
      }
    );

    return { repository, app };
  }
);
```

### Deployment

```typescript
// Generate Kro YAML
const yaml = appGraph.toYaml();
console.log(yaml);

// Deploy with factory
const factory = appGraph.factory('kro');
await factory.deploy({
  name: 'my-nginx',
  version: '1.21.6',
  replicas: 3
});
```

## Core Concepts

### Helm Repository Management

Helm charts require repositories to be available. TypeKro automatically infers repository names from URLs:

```typescript
helmRelease({
  name: 'redis',
  chart: {
    repository: 'https://charts.bitnami.com/bitnami',  // Creates 'bitnami' HelmRepository
    name: 'redis'
  }
})

// For custom repositories, use descriptive names
helmRelease({
  name: 'my-app',
  chart: {
    repository: 'https://charts.company.com/stable',  // Creates 'stable' HelmRepository  
    name: 'my-app'
  }
})

// For OCI repositories
helmRelease({
  name: 'oci-app',
  chart: {
    repository: 'oci://registry.company.com/helm-charts',  // Creates 'oci-app-helm-repo'
    name: 'my-app'
  }
})
```

### Value Templating with TypeKro

Use TypeKro's magic proxy system for type-safe value templating:

```typescript
const WebAppSchema = type({
  name: 'string',
  image: 'string', 
  hostname: 'string',
  replicas: 'number',
  resources: {
    cpu: 'string',
    memory: 'string'
  }
});

const webappGraph = kubernetesComposition({
  {
    name: 'webapp-helm',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebAppHelm',
    spec: WebAppSchema
  },
  (schema) => ({
    webapp: helmRelease({
      name: schema.spec.name,  // Dynamic resource name
      chart: {
        repository: 'https://charts.bitnami.com/bitnami',
        name: 'nginx'
      },
      values: {
        replicaCount: schema.spec.replicas,
        image: {
          repository: 'nginx',
          tag: schema.spec.image
        },
        ingress: {
          enabled: true,
          hostname: schema.spec.hostname,
          tls: true
        },
        resources: {
          limits: {
            cpu: schema.spec.resources.cpu,
            memory: schema.spec.resources.memory
          },
          requests: {
            cpu: schema.spec.resources.cpu,
            memory: schema.spec.resources.memory
          }
        }
      }
    })
  }),
  (schema, resources) => ({
    phase: resources.webapp.status.phase,
    ready: Cel.expr<boolean>(resources.webapp.status.phase, ' == "Ready"'),
    url: Cel.template('https://%s', schema.spec.hostname)
  })
);
```

### Cross-Resource References

Reference other Kubernetes resources in Helm values:

```typescript
const fullStackGraph = kubernetesComposition({
  {
    name: 'fullstack-app',
    apiVersion: 'example.com/v1alpha1', 
    kind: 'FullStackApp',
    spec: type({
      name: 'string',
      dbPassword: 'string',
      appVersion: 'string'
    })
  },
  (schema) => ({
    // Create a secret first
    dbSecret: secret({
      name: 'db-credentials',
      data: {
        password: schema.spec.dbPassword,
        username: 'webapp'
      }
    }),
    
    // Deploy PostgreSQL via Helm
    database: helmRelease({
      name: 'postgres',
      chart: {
        repository: 'https://charts.bitnami.com/bitnami',
        name: 'postgresql'
      },
      values: {
        auth: {
          existingSecret: 'db-credentials',  // Reference the secret
          database: 'webapp'
        },
        primary: {
          persistence: {
            enabled: true,
            size: '10Gi'
          }
        }
      }
    }),
    
    // Deploy application via Helm
    webapp: helmRelease({
      name: schema.spec.name,
      chart: {
        repository: 'https://charts.company.com/apps',
        name: 'webapp'
      },
      values: {
        image: {
          tag: schema.spec.appVersion
        },
        database: {
          host: 'postgres-postgresql',  // Helm chart service name
          port: 5432,
          existingSecret: 'db-credentials'
        }
      }
    })
  }),
  (schema, resources) => ({
    databaseReady: Cel.expr<boolean>(resources.database.status.phase, ' == "Ready"'),
    appReady: Cel.expr<boolean>(resources.webapp.status.phase, ' == "Ready"'),
    ready: Cel.expr<boolean>(`
      resources.database.status.phase == "Ready" && 
      resources.webapp.status.phase == "Ready"
    `)
  })
);
```

## Advanced Patterns

### Multi-Chart Applications

For multi-chart microservices examples, see [Microservices Architecture](../../examples/microservices.md) and [Helm Patterns](../../examples/helm-patterns.md).

Key patterns for multi-chart applications:
- **Shared Infrastructure**: Deploy databases and caches first
- **Service Dependencies**: Frontend depends on backend, backend depends on database
- **Environment Consistency**: Same environment variables across all services
- **Status Aggregation**: Overall health depends on all services being ready

### Environment-Specific Configurations

Configure different Helm values per environment. See [Basic WebApp Pattern](../../examples/basic-webapp.md) for environment-specific configuration patterns.

Environment configuration strategy:
```typescript
// Environment-specific values
const configs = {
  dev: { replicas: 1, resources: { cpu: '100m' }, ingress: false },
  staging: { replicas: 2, resources: { cpu: '200m' }, ingress: true },
  production: { replicas: 5, resources: { cpu: '500m' }, ingress: true }
};

const config = configs[schema.spec.environment];
// Apply config to Helm values...
```

### Custom Helm Repositories

Configure custom Helm repositories for private charts:

```typescript
const privateChartGraph = kubernetesComposition({
  {
    name: 'private-app',
    apiVersion: 'company.com/v1alpha1',
    kind: 'PrivateApp',
    spec: type({
      name: 'string',
      chartVersion: 'string',
      credentials: {
        username: 'string',
        password: 'string'
      }
    })
  },
  (schema) => {
    // Create secret for private repository first
    const repoSecret = secret({
      name: 'helm-repo-secret',
      data: {
        username: schema.spec.credentials.username,
        password: schema.spec.credentials.password
      }
    });
    
    // Create HelmRepository resource that references secret
    const privateRepo = helmRepository({
      name: 'private-charts',
      namespace: 'flux-system',
      url: 'https://charts.private.company.com',
      secretRef: {
        name: repoSecret.metadata.name  // Reference secret by field
      }
    });
    
    // Deploy using simple factory
    const app = HelmChart(
      schema.spec.name,
      privateRepo.spec.url,  // Reference repository URL by field
      'private-app',
      {
        // Application-specific values
      }
    );

    return { repoSecret, privateRepo, app };
  },
  (schema, resources) => ({
    repositoryReady: resources.privateRepo.status.ready,
    appReady: Cel.expr<boolean>(resources.app.status.phase, ' == "Ready"'),
    phase: Cel.expr<'Pending' | 'Installing' | 'Ready' | 'Failed'>(`
      resources.privateRepo.status.ready && resources.app.status.phase == "Ready" ? 
      "Ready" : "Installing"
    `)
  })
);
```

## Deployment Workflows

### Development Workflow

For development with Helm charts:

```typescript
// Quick development deployment
const devGraph = kubernetesComposition({
  {
    name: 'dev-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'DevApp',
    spec: type({ name: 'string', debug: 'boolean' })
  },
  (schema) => ({
    app: HelmChart(
      schema.spec.name,
      'https://charts.bitnami.com/bitnami',
      'nginx',
      {
        service: { type: 'NodePort' },
        ingress: { enabled: false },
        resources: {
          limits: { cpu: '100m', memory: '128Mi' }
        },
        // Enable debug mode
        ...(schema.spec.debug && {
          extraEnvVars: [
            { name: 'DEBUG', value: 'true' },
            { name: 'LOG_LEVEL', value: 'debug' }
          ]
        })
      }
    )
  })
);

// Deploy to development
const factory = devGraph.factory('direct', { namespace: 'dev' });
await factory.deploy({ name: 'my-dev-app', debug: true });
```

### GitOps Workflow

For production deployments via GitOps:

```typescript
// Generate YAML for different environments
const environments = ['staging', 'production'];

for (const env of environments) {
  const yaml = envConfigGraph.toYaml();
  writeFileSync(`k8s/${env}/app.yaml`, yaml);
}

// Commit and let ArgoCD/Flux deploy
// git add k8s/
// git commit -m "Deploy app v1.2.3 to staging and production"
// git push
```

### CI/CD Integration

Integrate Helm deployments in CI/CD:

```typescript
// ci-cd-deployment.ts
async function deployApp(version: string, environment: string) {
  const factory = appGraph.factory('kro', { 
    namespace: environment 
  });
  
  try {
    await factory.deploy({
      name: 'my-app',
      version: version,
      environment: environment
    });
    
    // Wait for deployment to be ready
    await factory.waitForReady(300000); // 5 minute timeout
    
    console.log(`✅ Successfully deployed ${version} to ${environment}`);
    
    // Run health checks
    const status = await factory.getStatus();
    if (!status.ready) {
      throw new Error('Deployment not ready after timeout');
    }
    
  } catch (error) {
    console.error(`❌ Deployment failed: ${error.message}`);
    throw error;
  }
}

// Usage in CI/CD
await deployApp(process.env.VERSION, process.env.ENVIRONMENT);
```

## Troubleshooting

### Common Issues

#### Helm Repository Not Found

```typescript
// Issue: HelmRepository not available in cluster
// Solution: Ensure repository is created before HelmRelease

const graph = kubernetesComposition({
  { /* spec */ },
  (schema) => ({
    // Create repository first
    repo: helmRepository({
      name: 'my-repo',
      namespace: 'flux-system', 
      url: 'https://charts.example.com'
    }),
    
    // Then create release (will wait for repo)
    app: helmRelease({
      name: 'my-app',
      chart: {
        repository: 'https://charts.example.com',
        name: 'my-chart'
      }
    })
  })
);
```

#### Chart Version Conflicts

```typescript
// Issue: Chart version not found or incompatible
// Solution: Specify exact versions and validate

helmRelease({
  name: 'my-app',
  chart: {
    repository: 'https://charts.bitnami.com/bitnami',
    name: 'nginx',
    version: '13.2.23'  // Always specify version for production
  }
})
```

#### Value Serialization Issues

```typescript
// Issue: Complex TypeKro references not serializing correctly
// Solution: Use CEL expressions for complex logic

const graph = kubernetesComposition({
  { /* spec */ },
  (schema) => ({
    app: helmRelease({
      name: 'my-app',
      chart: { /* chart config */ },
      values: {
        // Don't do this - complex JavaScript logic
        // replicas: schema.spec.environment === 'production' ? 5 : 1
        
        // Do this - use simple references
        replicas: schema.spec.replicas,
        environment: schema.spec.environment
      }
    })
  }),
  // Handle complex logic in status
  (schema, resources) => ({
    replicas: Cel.expr<number>(`
      schema.spec.environment == "production" ? 5 : 1
    `)
  })
);
```

### Debug Commands

```bash
# Check HelmRepository status
kubectl get helmrepository -n flux-system

# Check HelmRelease status
kubectl get helmrelease -n your-namespace

# View Helm release details
kubectl describe helmrelease my-app -n your-namespace

# Check Flux logs
kubectl logs -n flux-system deployment/helm-controller

# View generated Helm values
kubectl get helmrelease my-app -o yaml | yq '.spec.values'
```

### Status Monitoring

Monitor Helm deployments:

```typescript
const factory = helmGraph.factory('kro');
await factory.deploy(spec);

// Monitor deployment progress
const checkStatus = async () => {
  const status = await factory.getStatus();
  console.log(`Factory Status: ${status.health}`);
  
  if (status.health === 'healthy') {
    console.log('✅ Deployment successful');
  } else if (status.health === 'failed') {
    console.error('❌ Deployment failed');
    console.error('Factory status:', status);
  }
};
await checkStatus();

// Check status periodically
const checkPhase = async () => {
  const status = await factory.getStatus();
  if (status.health === 'healthy') {
    console.log('🔄 Installing Helm chart...');
  }
};
setInterval(checkPhase, 5000);
```

## Best Practices

### Chart Selection

- **Use official charts**: Prefer Bitnami, official project charts
- **Pin versions**: Always specify chart versions for production
- **Review values**: Understand default values and override appropriately
- **Test locally**: Validate charts with `helm template` before deployment

### Value Management

- **Keep values simple**: Use TypeKro references for simple value mapping
- **Use CEL for logic**: Complex logic belongs in CEL expressions, not Helm values
- **Environment separation**: Different value files/configurations per environment
- **Secret management**: Never put secrets in values, use Kubernetes secrets

### Deployment Strategy

- **Repository management**: Centralize HelmRepository resources
- **Namespace organization**: Separate applications by namespace
- **Dependency order**: Deploy infrastructure charts before application charts
- **Rollback planning**: Understand Helm rollback capabilities

### Security

- **Private repositories**: Use secrets for authentication
- **RBAC**: Ensure proper permissions for Helm operations
- **Image scanning**: Scan chart images for vulnerabilities
- **Value validation**: Validate values before deployment

## Migration from Pure Helm

### From Helm CLI

```bash
# Old: Direct Helm commands
helm repo add bitnami https://charts.bitnami.com/bitnami
helm install my-nginx bitnami/nginx --set replicaCount=3

# New: TypeKro Helm integration
```

```typescript
const graph = kubernetesComposition({
  { /* schema */ },
  (schema) => ({
    nginx: helmRelease({
      name: 'my-nginx',
      chart: {
        repository: 'https://charts.bitnami.com/bitnami',
        name: 'nginx'
      },
      values: {
        replicaCount: 3
      }
    })
  })
);
```

### From Helm Templates

Convert existing Helm templates to TypeKro:

```yaml
# Old: values.yaml
replicaCount: 2
image:
  repository: nginx
  tag: 1.21.6
ingress:
  enabled: true
  hostname: app.example.com
```

```typescript
// New: TypeKro schema-driven
const AppSchema = type({
  replicas: 'number',
  image: 'string',
  hostname: 'string'
});

const graph = kubernetesComposition({
  { spec: AppSchema, /* ... */ },
  (schema) => ({
    app: helmRelease({
      name: 'nginx-app',
      chart: { /* chart config */ },
      values: {
        replicaCount: schema.spec.replicas,
        image: {
          repository: 'nginx',
          tag: schema.spec.image
        },
        ingress: {
          enabled: true,
          hostname: schema.spec.hostname
        }
      }
    })
  })
);
```

## Next Steps

- **[KRO Integration](./kro.md)** - Advanced orchestration with KRO
- **[GitOps](./gitops.md)** - Production GitOps workflows  
- **[Examples](../../examples/)** - Real-world Helm integration examples
- **[Performance](../performance.md)** - Optimizing Helm deployments