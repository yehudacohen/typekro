# Factory Functions

Factory functions are TypeKro's building blocks for creating Kubernetes resources with type safety and intelligent defaults. They handle the complexity of Kubernetes resource configuration while providing a clean, intuitive API.

## Quick Start with Factories

```typescript
import { Deployment, Service, Ingress, ConfigMap, Secret, Job, StatefulSet, NetworkPolicy, PersistentVolumeClaim } from 'typekro/simple';

// Create resources with sensible defaults
const app = Deployment({
  name: 'web-app',
  image: 'nginx:latest',
  replicas: 3
});

const service = Service({
  name: 'web-service', 
  selector: { app: 'web-app' },
  ports: [{ port: 80, targetPort: 80 }]
});
```

Each factory function:
- **Generates valid Kubernetes YAML** with proper defaults
- **Provides type safety** with TypeScript autocomplete
- **Handles complexity** - you focus on what matters
- **Integrates seamlessly** with TypeKro's composition system

## Factory Categories

### Workloads (`simple.*`)

Control how your applications run:

```typescript
// Deployments - stateless applications
const app = Deployment({
  name: 'api-server',
  image: 'myapp:v1.0.0',
  replicas: 3,
  env: {
    NODE_ENV: 'production',
    PORT: '3000'
  },
  ports: [{ containerPort: 3000 }]
});

// StatefulSets - stateful applications  
const database = StatefulSet({
  name: 'postgres',
  image: 'postgres:15',
  replicas: 1,
  env: {
    POSTGRES_DB: 'myapp',
    POSTGRES_PASSWORD: 'secret'
  },
  volumeClaimTemplate: {
    size: '10Gi',
    storageClass: 'fast-ssd'
  }
});

// Jobs - run-to-completion workloads
const migration = Job({
  name: 'db-migration',
  image: 'myapp:v1.0.0',
  command: ['npm', 'run', 'migrate']
});
```

### Networking (`simple.*`)

Connect your applications:

```typescript
// Services - stable network endpoints
const apiService = Service({
  name: 'api-service',
  selector: { app: 'api-server' },
  ports: [{ port: 80, targetPort: 3000 }],
  type: 'ClusterIP' // or LoadBalancer, NodePort
});

// Ingress - external access with routing
const ingress = Ingress({
  name: 'api-ingress',
  host: 'api.example.com',
  serviceName: 'api-service',
  servicePort: 80,
  tls: {
    secretName: 'api-tls-cert'
  }
});

// Network Policies - security rules
const policy = NetworkPolicy({
  name: 'api-policy',
  selector: { app: 'api-server' },
  ingress: [{
    from: [{ namespaceSelector: { app: 'frontend' } }],
    ports: [{ port: 3000 }]
  }]
});
```

### Configuration (`simple.*`)

Manage application configuration:

```typescript
// ConfigMaps - configuration data
const config = ConfigMap({
  name: 'app-config',
  data: {
    'database.host': 'postgres-service',
    'database.port': '5432',
    'cache.enabled': 'true'
  }
});

// Secrets - sensitive data
const secret = Secret({
  name: 'app-secrets',
  stringData: {
    'database.password': 'supersecret',
    'api.key': 'abc123'
  }
});
```

### Storage (`simple.*`)

Manage persistent data:

```typescript
// Persistent Volume Claims
const storage = PersistentVolumeClaim({
  name: 'app-data',
  size: '50Gi',
  storageClass: 'fast-ssd',
  accessModes: ['ReadWriteOnce']
});
```

## Working with Factory Outputs

Every factory function returns an **Enhanced** resource with magical properties:

### Access Resource Properties

```typescript
const deployment = Deployment({
  name: 'web-app',
  image: 'nginx:latest'
});

// Access metadata
console.log(deployment.metadata.name);      // 'web-app'
console.log(deployment.metadata.namespace); // 'default' (or inherited)

// Access spec 
console.log(deployment.spec.replicas);      // 1 (default)
console.log(deployment.spec.template);      // Full pod template

// Access status (live from cluster)
console.log(deployment.status.readyReplicas);   // Number of ready pods
console.log(deployment.status.availableReplicas); // Available replicas
```

### Use in CEL Expressions

Enhanced resources work seamlessly with CEL:

```typescript
const app = Deployment({
  name: 'api',
  image: 'myapi:latest'
});

const service = Service({
  name: 'api-service',
  selector: { app: 'api' },
  ports: [{ port: 80 }]
});

// Create dynamic status based on resource state
return {
  ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
  endpoint: Cel.template('http://%s:80', service.status.clusterIP),
  healthy: Cel.expr<boolean>(
    app.status.readyReplicas, 
    ' == ', 
    app.spec.replicas
  )
};
```

### Chain Resource References

Resources can reference each other naturally:

```typescript
const database = Deployment({
  name: 'postgres',
  image: 'postgres:15'
});

const dbService = Service({
  name: 'postgres-service',
  selector: { app: 'postgres' }, // Matches deployment
  ports: [{ port: 5432 }]
});

const app = Deployment({
  name: 'web-app',
  image: 'myapp:latest',
  env: {
    // Reference the database service
    DATABASE_HOST: dbService.status.clusterIP,
    DATABASE_PORT: '5432'
  }
});
```

## Advanced Factory Patterns

### Environment-Specific Configuration

```typescript
const createApp = (env: 'dev' | 'staging' | 'prod') => {
  const config = {
    dev: { replicas: 1, resources: { cpu: '100m', memory: '128Mi' } },
    staging: { replicas: 2, resources: { cpu: '250m', memory: '256Mi' } },
    prod: { replicas: 5, resources: { cpu: '500m', memory: '1Gi' } }
  }[env];

  return Deployment({
    name: `app-${env}`,
    image: 'myapp:latest',
    replicas: config.replicas,
    resources: config.resources
  });
};
```

### Resource Templates

```typescript
const createMicroservice = (name: string, image: string, port: number) => {
  const deployment = Deployment({
    name,
    image,
    ports: [{ containerPort: port }],
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '512Mi' }
    }
  });

  const service = Service({
    name: `${name}-service`,
    selector: { app: name },
    ports: [{ port: 80, targetPort: port }]
  });

  return { deployment, service };
};

// Usage
const { deployment: api, service: apiService } = createMicroservice(
  'api-server', 
  'myapi:v1.0.0', 
  3000
);
```

### Conditional Resources

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  const app = Deployment({
    name: spec.name,
    image: spec.image
  });

  // Only create ingress in production
  const ingress = spec.environment === 'production' 
    ? Ingress({
        name: `${spec.name}-ingress`,
        host: `${spec.name}.example.com`,
        serviceName: `${spec.name}-service`
      })
    : null;

  return {
    ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
    hasIngress: spec.environment === 'production'
  };
});
```

## Factory Configuration Options

### Common Options

All factories support common Kubernetes resource options:

```typescript
const deployment = Deployment({
  name: 'my-app',
  namespace: 'custom-namespace',  // Override namespace
  labels: {                       // Additional labels
    team: 'platform',
    version: 'v1.0.0'
  },
  annotations: {                  // Additional annotations
    'deployment.kubernetes.io/revision': '1'
  },
  
  // Resource-specific options
  image: 'myapp:latest',
  replicas: 3
});
```

### Resource-Specific Options

Each factory has its own configuration:

```typescript
// Deployment-specific options
const app = Deployment({
  name: 'api',
  image: 'myapi:latest',
  replicas: 3,
  strategy: {                    // Update strategy
    type: 'RollingUpdate',
    rollingUpdate: {
      maxSurge: 1,
      maxUnavailable: 0
    }
  },
  securityContext: {             // Security settings
    runAsNonRoot: true,
    runAsUser: 1001
  }
});

// Service-specific options  
const service = Service({
  name: 'api-service',
  type: 'LoadBalancer',          // Service type
  selector: { app: 'api' },
  ports: [{ 
    port: 80, 
    targetPort: 3000,
    protocol: 'TCP' 
  }],
  sessionAffinity: 'ClientIP'    // Session stickiness
});
```

## Validation and Defaults

Factories provide intelligent validation and defaults:

```typescript
// ✅ This works - sensible defaults applied
const deployment = Deployment({
  name: 'my-app',
  image: 'nginx:latest'
  // replicas: 1 (default)
  // resources: reasonable defaults applied
  // securityContext: secure defaults
});

// ❌ This fails at compile time
const invalid = Deployment({
  name: 'my-app',
  // image is required!
  replicas: -1  // Must be positive
});
```

## YAML Integration

TypeKro provides specialized deployment closures for integrating existing YAML manifests into your compositions:

### `yamlFile()` - Single YAML File

Deploy YAML files from local filesystem or remote Git repositories:

```typescript
import { yamlFile } from 'typekro';

const composition = kubernetesComposition(definition, (spec) => {
  // Local YAML file
  const localManifests = yamlFile({
    name: 'nginx-config',
    path: './manifests/nginx.yaml',
    namespace: spec.namespace
  });

  // Remote Git repository 
  const fluxSystem = yamlFile({
    name: 'flux-system',
    path: 'https://github.com/fluxcd/flux2/releases/latest/download/install.yaml',
    deploymentStrategy: 'skipIfExists'
  });

  // Git repository with specific path
  const helmController = yamlFile({
    name: 'helm-controller',
    path: 'git:github.com/fluxcd/helm-controller/config/default@main',
    deploymentStrategy: 'replace'
  });

  const app = Deployment({
    name: spec.name,
    image: spec.image
  });

  return {
    ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
    // YAML files don't have status - use static values
    fluxReady: true
  };
});
```

### `yamlDirectory()` - Multiple YAML Files

Deploy entire directories of YAML files with filtering:

```typescript
import { yamlDirectory } from 'typekro';

const composition = kubernetesComposition(definition, (spec) => {
  // Deploy all YAML files in a directory
  const manifests = yamlDirectory({
    name: 'app-manifests',
    path: './k8s-manifests',
    recursive: true,
    include: ['*.yaml', '*.yml'],
    exclude: ['*-test.yaml'],
    namespace: spec.namespace
  });

  // Remote directory from Git
  const crdManifests = yamlDirectory({
    name: 'custom-crds',
    path: 'git:github.com/example/crds/manifests@v1.0.0',
    recursive: false,
    include: ['crd-*.yaml'],
    deploymentStrategy: 'skipIfExists'
  });

  const app = Deployment({
    name: spec.name,
    image: spec.image
  });

  return {
    ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
    manifestsDeployed: true
  };
});
```

### Configuration Options

Both functions support these configuration options:

```typescript
interface YamlFileConfig {
  name: string;                    // Unique identifier
  path: string;                    // File path or Git URL
  namespace?: string;              // Target namespace
  deploymentStrategy?: 'replace' | 'skipIfExists' | 'fail';
}

interface YamlDirectoryConfig extends YamlFileConfig {
  recursive?: boolean;             // Search subdirectories
  include?: string[];              // Glob patterns to include
  exclude?: string[];              // Glob patterns to exclude
}
```

### Path Formats

YAML deployment closures support multiple path formats:

```typescript
// Local relative paths
path: './manifests/app.yaml'
path: './k8s'

// Local absolute paths  
path: '/home/user/manifests/app.yaml'

// HTTPS URLs (for direct file downloads)
path: 'https://github.com/fluxcd/flux2/releases/latest/download/install.yaml'

// Git repository paths (git:host/org/repo/path@ref)
path: 'git:github.com/fluxcd/helm-controller/config/default@main'
path: 'git:gitlab.com/company/manifests/prod@v1.2.0'
path: 'git:bitbucket.org/team/configs/k8s@feature-branch'
```

### Deployment Strategies

Control how YAML resources are handled during deployment:

```typescript
// 'replace' (default) - Replace existing resources
yamlFile({
  name: 'app-config',
  path: './config.yaml',
  deploymentStrategy: 'replace'
});

// 'skipIfExists' - Only deploy if resource doesn't exist
yamlFile({
  name: 'one-time-setup',
  path: './setup.yaml', 
  deploymentStrategy: 'skipIfExists'
});

// 'fail' - Fail deployment if resource already exists
yamlFile({
  name: 'critical-config',
  path: './critical.yaml',
  deploymentStrategy: 'fail'
});
```

### Integration with Enhanced Resources

YAML deployment closures integrate seamlessly with TypeKro's Enhanced resources:

```typescript
const composition = kubernetesComposition(definition, (spec) => {
  // YAML deployment closure - deploys during execution
  const externalConfig = yamlFile({
    name: 'external-config',
    path: './external-manifests/config.yaml'
  });

  // Enhanced resource - provides type-safe status
  const app = Deployment({
    name: spec.name,
    image: spec.image,
    env: {
      EXTERNAL_CONFIG_LOADED: 'true'
    }
  });

  const service = Service({
    name: `${spec.name}-service`,
    selector: { app: spec.name },
    ports: [{ port: 80 }]
  });

  return {
    // Enhanced resources have live status
    ready: Cel.expr<boolean>(app.status.readyReplicas, ' > 0'),
    endpoint: service.status.clusterIP,
    
    // YAML closures don't have status - use static values
    externalConfigDeployed: true
  };
});
```

### Common Use Cases

**1. Bootstrap Infrastructure**
```typescript
// Deploy Flux CD system from official manifests
const fluxBootstrap = yamlFile({
  name: 'flux-system',
  path: 'https://github.com/fluxcd/flux2/releases/latest/download/install.yaml',
  deploymentStrategy: 'skipIfExists'
});
```

**2. Third-Party CRDs**
```typescript
// Deploy custom resource definitions
const operatorCRDs = yamlDirectory({
  name: 'operator-crds',
  path: 'git:github.com/prometheus-operator/prometheus-operator/example/rbac@main',
  include: ['*-crd.yaml']
});
```

**3. Legacy Manifest Migration**
```typescript
// Gradually migrate existing YAML to TypeKro
const legacyManifests = yamlDirectory({
  name: 'legacy-configs',
  path: './legacy-k8s',
  recursive: true,
  exclude: ['*-temp.yaml', 'old-*']
});
```

**4. Multi-Environment Configs**
```typescript
const envManifests = yamlFile({
  name: 'env-config',
  path: `./environments/${spec.environment}.yaml`,
  namespace: spec.namespace
});
```

### Important Notes

- **No Status Monitoring**: YAML deployment closures return `DeploymentClosure<AppliedResource[]>`, not `Enhanced<>` resources
- **Use Static Values**: In status builders, use static values like `true` instead of referencing YAML closure status
- **Automatic Registration**: Both functions automatically register as deployment closures in the composition context
- **Git Authentication**: Git URLs use the same authentication as your local git configuration
- **Namespace Override**: The `namespace` parameter applies to all resources in the YAML files

## What's Next?

Now that you understand factories, let's explore TypeKro's unique capabilities:

### Next: [Magic Proxy System →](./magic-proxy.md)
Discover how TypeKro creates seamless references between resources.

**In this learning path:**
- ✅ Your First App - Built your first TypeKro application
- ✅ Factory Functions - Mastered resource creation  
- 🎯 **Next**: Magic Proxy System - TypeKro's unique reference system
- **Coming**: External References - Cross-composition coordination
- **Finally**: Advanced Architecture - Deep technical understanding

## Quick Reference

### Essential Factory Imports
```typescript
import { Deployment, Service, ConfigMap, Secret } from 'typekro/simple';
```

### Most Common Factories
```typescript
// Workloads
Deployment({ name, image, replicas?, env?, ports? })
StatefulSet({ name, image, replicas?, volumeClaimTemplate? })
Job({ name, image, command? })

// Networking  
Service({ name, selector, ports, type? })
Ingress({ name, host, serviceName, servicePort })

// Configuration
ConfigMap({ name, data })
Secret({ name, stringData })
```

### Working with Factory Outputs
```typescript
const resource = Deployment({ /* config */ });

// Access properties
resource.metadata.name
resource.spec.replicas  
resource.status.readyReplicas

// Use in CEL expressions
Cel.expr<boolean>(resource.status.readyReplicas, ' > 0')
Cel.template('http://%s:80', resource.status.clusterIP)
```

Ready to see the magic? Continue to [Magic Proxy System →](./magic-proxy.md)