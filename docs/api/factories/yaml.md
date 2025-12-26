# YAML Integration API

TypeKro provides specialized deployment closures for integrating existing YAML manifests into your compositions. These functions allow you to leverage existing Kubernetes YAML files alongside TypeKro's Enhanced resources.

## yamlFile()

Deploy a single YAML file from local filesystem or remote Git repository.

### Signature

```typescript
import { yamlFile } from 'typekro';

function yamlFile(config: YamlFileConfig): DeploymentClosure<AppliedResource[]>

interface YamlFileConfig {
  name: string;                    // Unique identifier for the deployment closure
  path: string;                    // File path or Git URL
  namespace?: string;              // Target namespace for resources
  deploymentStrategy?: 'replace' | 'skipIfExists' | 'fail'; // Default: 'replace'
}
```

### Examples

#### Local File
```typescript
const nginxConfig = yamlFile({
  name: 'nginx-config',
  path: './manifests/nginx-deployment.yaml',
  namespace: 'web-apps'
});
```

#### Remote HTTPS URL
```typescript  
const fluxSystem = yamlFile({
  name: 'flux-bootstrap',
  path: 'https://github.com/fluxcd/flux2/releases/latest/download/install.yaml',
  deploymentStrategy: 'skipIfExists'
});
```

#### Git Repository
```typescript
const helmController = yamlFile({
  name: 'helm-controller',
  path: 'git:github.com/fluxcd/helm-controller/config/default@main',
  deploymentStrategy: 'replace'
});
```

## yamlDirectory()

Deploy all YAML files from a directory with optional filtering.

### Signature

```typescript
import { yamlDirectory } from 'typekro';

function yamlDirectory(config: YamlDirectoryConfig): DeploymentClosure<AppliedResource[]>

interface YamlDirectoryConfig {
  name: string;                    // Unique identifier for the deployment closure  
  path: string;                    // Directory path or Git URL
  recursive?: boolean;             // Search subdirectories (default: false)
  include?: string[];              // Glob patterns to include
  exclude?: string[];              // Glob patterns to exclude
  namespace?: string;              // Target namespace for resources
  deploymentStrategy?: 'replace' | 'skipIfExists' | 'fail'; // Default: 'replace'
}
```

### Examples

#### Local Directory with Filtering
```typescript
const appManifests = yamlDirectory({
  name: 'app-manifests',
  path: './k8s-manifests',
  recursive: true,
  include: ['*.yaml', '*.yml'],
  exclude: ['*-test.yaml', 'tmp-*.yaml'],
  namespace: 'production'
});
```

#### Git Repository Directory
```typescript
const crdDefinitions = yamlDirectory({
  name: 'operator-crds',
  path: 'git:github.com/prometheus-operator/prometheus-operator/example/rbac@v0.68.0',
  include: ['*-crd.yaml'],
  deploymentStrategy: 'skipIfExists'
});
```

## Path Formats

Both functions support multiple path formats:

### Local Paths
```typescript
// Relative paths
path: './manifests/config.yaml'
path: './k8s-directory'

// Absolute paths  
path: '/home/user/manifests/app.yaml'
path: '/etc/kubernetes/manifests'
```

### HTTPS URLs
```typescript
// Direct file downloads
path: 'https://github.com/fluxcd/flux2/releases/latest/download/install.yaml'
path: 'https://raw.githubusercontent.com/org/repo/main/config.yaml'
```

### Git Repository URLs
```typescript
// Git repository syntax: git:host/org/repo/path@ref
path: 'git:github.com/fluxcd/helm-controller/config/default@main'
path: 'git:gitlab.com/company/k8s-configs/prod@v1.2.0' 
path: 'git:bitbucket.org/team/manifests/staging@feature-branch'
```

## Deployment Strategies

Control how resources are handled when they already exist in the cluster:

### replace (Default)
```typescript
const manifests = yamlFile({
  name: 'app-config',
  path: './config.yaml',
  deploymentStrategy: 'replace'  // Update existing resources
});
```

### skipIfExists
```typescript
const bootstrap = yamlFile({
  name: 'one-time-setup', 
  path: './bootstrap.yaml',
  deploymentStrategy: 'skipIfExists'  // Only deploy if resources don't exist
});
```

### fail
```typescript
const criticalConfig = yamlFile({
  name: 'critical-resources',
  path: './critical.yaml', 
  deploymentStrategy: 'fail'  // Fail deployment if resources exist
});
```

## Integration with Compositions

YAML deployment closures integrate seamlessly with TypeKro compositions alongside Enhanced resources:

### Basic Integration
```typescript
import { kubernetesComposition, yamlFile, Cel } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

const webApp = kubernetesComposition(definition, (spec) => {
  // YAML deployment closure
  const externalConfig = yamlFile({
    name: 'legacy-config',
    path: './legacy-manifests/config.yaml'
  });

  // Enhanced resources
  const app = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    env: {
      EXTERNAL_CONFIG_LOADED: 'true'
    }
  });

  const service = Service({
    id: 'service',
    name: `${spec.name}-service`,
    selector: { app: spec.name },
    ports: [{ port: 80 }]
  });

  return {
    // Enhanced resources provide live status
    ready: app.status.readyReplicas > 0,
    endpoint: service.status.clusterIP,
    
    // YAML closures don't have status - use static values
    legacyConfigDeployed: true
  };
});
```

### Multi-Environment Pattern
```typescript
import { kubernetesComposition, yamlFile, yamlDirectory } from 'typekro';
import { Deployment } from 'typekro/simple';

const multiEnvApp = kubernetesComposition(definition, (spec) => {
  // Environment-specific manifests
  const envConfig = yamlFile({
    name: 'env-config',
    path: `./environments/${spec.environment}.yaml`,
    namespace: spec.namespace
  });

  // Shared bootstrap resources
  const bootstrap = yamlDirectory({
    name: 'bootstrap-resources',
    path: './bootstrap',
    include: ['*.yaml'],
    deploymentStrategy: 'skipIfExists'
  });

  const app = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    replicas: spec.environment === 'production' ? 3 : 1
  });

  return {
    ready: app.status.readyReplicas > 0,
    environment: spec.environment,
    bootstrapped: true
  };
});
```

## Important Notes

### No Status Monitoring
YAML deployment closures return `DeploymentClosure<AppliedResource[]>`, not `Enhanced<>` resources:

```typescript
// ❌ Don't reference YAML closure status
return {
  configReady: resources.yamlConfig?.status.ready  // This won't work
};

// ✅ Use static values for YAML closures
return {
  configDeployed: true,  // Static value
  appReady: Cel.expr<boolean>(app.status.readyReplicas, ' > 0')  // Enhanced resource status
};
```

### Automatic Registration
Both functions automatically register as deployment closures in the composition context, enabling proper serialization and deployment orchestration.

### Git Authentication
Git URLs use the same authentication as your local git configuration. Ensure proper access tokens or SSH keys are configured for private repositories.

### Namespace Override
The `namespace` parameter applies to **all** resources found in the YAML files, overriding any namespace specified within the manifests.

## Common Use Cases

### Bootstrap Infrastructure
```typescript
const fluxBootstrap = yamlFile({
  name: 'flux-system',
  path: 'https://github.com/fluxcd/flux2/releases/latest/download/install.yaml',
  deploymentStrategy: 'skipIfExists'
});
```

### Legacy Migration
```typescript
const legacyManifests = yamlDirectory({
  name: 'legacy-configs',
  path: './existing-k8s',
  recursive: true,
  exclude: ['*-temp.yaml', 'old-*'],
  namespace: 'migrated-apps'
});
```

### Third-Party Operators
```typescript
const prometheusOperator = yamlDirectory({
  name: 'prometheus-crds',
  path: 'git:github.com/prometheus-operator/prometheus-operator/example/rbac@v0.68.0',
  include: ['*-crd.yaml', '*-rbac.yaml']
});
```

### Helm Chart Dependencies
```typescript
const helmDependencies = yamlFile({
  name: 'cert-manager-crds',
  path: 'https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.crds.yaml',
  deploymentStrategy: 'skipIfExists'
});
```

## Error Handling

Common errors and solutions:

```typescript
try {
  const factory = composition.factory('direct', { namespace: 'production' });
  await factory.deploy(spec);
} catch (error) {
  if (error.message.includes('YAML file not found')) {
    console.error('Check that the YAML file path exists and is accessible');
  }
  
  if (error.message.includes('Git authentication failed')) {
    console.error('Verify git credentials and repository access');
  }
  
  if (error.message.includes('Resource already exists')) {
    console.error('Consider using deploymentStrategy: "skipIfExists" or "replace"');
  }
}
```

## Performance Considerations

- **Local files** are fastest for development
- **HTTPS URLs** require network access but are cached
- **Git repositories** may be slower due to clone operations
- **Large directories** with many files may impact deployment time
- **Recursive scanning** adds overhead - use `include`/`exclude` patterns to limit scope

## Related APIs

- [kubernetesComposition](../kubernetes-composition) - Creating compositions with YAML integration
- [Factory Functions](./) - Enhanced resource factory functions
- [CEL Expressions](../cel) - Dynamic expressions for status builders


## Next Steps

- **[kubernetesComposition API](../kubernetes-composition.md)** - Creating compositions with YAML
- **[Factory Functions](./)** - Enhanced resource factories
- **[Deployment Modes](../../guide/deployment-modes.md)** - Deployment strategies
