# YAML & Helm Integration

Deploy external YAML files and Helm charts within TypeKro compositions.

## Overview

YAML closures are deployment-time functions that apply external manifests alongside your TypeKro resources. They integrate seamlessly with the composition system.

## YamlFile()

Deploys manifests from a YAML file using the simplified API.

### Syntax

```typescript
import { YamlFile } from 'typekro/simple';

function YamlFile(path: string, namespace?: string): DeploymentClosure<AppliedResource[]>
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` | File path or URL to YAML manifest |
| `namespace` | `string` (optional) | Target namespace override |

### Examples

**Basic usage:**

```typescript
import { YamlFile } from 'typekro/simple';

const crds = YamlFile('./manifests/crds.yaml');
```

**With namespace:**

```typescript
import { YamlFile } from 'typekro/simple';

const manifests = YamlFile('./manifests/app.yaml', 'production');
```

**From URL:**

```typescript
import { YamlFile } from 'typekro/simple';

const flux = YamlFile('https://github.com/fluxcd/flux2/releases/download/v2.0.0/install.yaml');
```

**In a composition:**

```typescript
import { kubernetesComposition } from 'typekro';
import { Deployment, YamlFile } from 'typekro/simple';

const app = kubernetesComposition(definition, (spec) => {
  // YAML closure - deployed alongside resources
  YamlFile('./crds.yaml');

  // Regular resource
  const deploy = Deployment({ id: 'deploy', name: spec.name, image: spec.image });

  return { ready: deploy.status.readyReplicas > 0 };
});
```

## yamlFile() (Advanced)

For advanced configuration, use the full `yamlFile()` factory from the main package:

```typescript
import { yamlFile } from 'typekro';

const flux = yamlFile({
  name: 'flux-install',
  path: 'https://github.com/fluxcd/flux2/releases/download/v2.0.0/install.yaml',
  namespace: 'flux-system',
  deploymentStrategy: 'serverSideApply',
  fieldManager: 'typekro-bootstrap',
  forceConflicts: false
});
```

### Advanced Configuration

```typescript
interface YamlFileConfig {
  name: string;                    // Identifier for the closure
  path: string;                    // File path or URL
  namespace?: string;              // Target namespace
  deploymentStrategy?: 'replace' | 'skipIfExists' | 'fail' | 'serverSideApply';
  manifestTransform?: (manifest: KubernetesResource) => KubernetesResource;
  fieldManager?: string;           // For serverSideApply (default: 'typekro')
  forceConflicts?: boolean;        // For serverSideApply (default: false)
}
```

### Deployment Strategies

| Strategy | Behavior |
|----------|----------|
| `replace` | Update existing resources (default) |
| `skipIfExists` | Skip if resource already exists |
| `fail` | Fail if resource exists |
| `serverSideApply` | Use server-side apply for safe merging |

## HelmChart()

Simplified Helm chart deployment using Flux HelmRelease. For full configuration control, use [`helmRelease()`](#helmrelease) instead.

### HelmChart vs helmRelease

| | `HelmChart` | `helmRelease` |
|---|-------------|---------------|
| **Import** | `typekro/simple` | `typekro` |
| **Use case** | Quick chart deployment | Full configuration control |
| **Arguments** | Positional: `(name, repo, chart, values?)` | Config object |
| **Features** | Basic values only | interval, namespace, version, id |

### Syntax

```typescript
import { HelmChart } from 'typekro/simple';

function HelmChart(
  name: string,
  repository: string,
  chart: string,
  values?: Record<string, any>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus>
```

### Examples

**Basic chart:**

```typescript
import { HelmChart } from 'typekro/simple';

const nginx = HelmChart(
  'nginx',
  'https://charts.bitnami.com/bitnami',
  'nginx'
);
```

**With values:**

```typescript
import { HelmChart } from 'typekro/simple';

const redis = HelmChart(
  'redis',
  'https://charts.bitnami.com/bitnami',
  'redis',
  {
    auth: { enabled: false },
    replica: { replicaCount: 3 }
  }
);
```

**With schema references:**

```typescript
import { kubernetesComposition } from 'typekro';
import { HelmChart } from 'typekro/simple';

const app = kubernetesComposition(definition, (spec) => {
  const db = HelmChart(
    'postgresql',
    'https://charts.bitnami.com/bitnami',
    'postgresql',
    {
      auth: {
        database: spec.dbName,
        postgresPassword: spec.dbPassword
      },
      primary: {
        persistence: { size: spec.storageSize }
      }
    }
  );

  return { dbReady: db.status.conditions?.[0]?.status === 'True' };
});
```

## helmRelease()

Full HelmRelease factory with complete configuration.

### Syntax

```typescript
import { helmRelease } from 'typekro';

function helmRelease(config: HelmReleaseConfig): Enhanced<HelmReleaseSpec, HelmReleaseStatus>
```

### Configuration

```typescript
interface HelmReleaseConfig {
  id?: string;             // Resource ID for cross-references
  name: string;
  namespace?: string;
  interval?: string;       // Reconciliation interval (default: '5m')
  chart: {
    repository: string;    // Helm repository URL
    name: string;          // Chart name
    version?: string;      // Chart version
  };
  values?: Record<string, any>;
}
```

### Example

```typescript
import { helmRelease } from 'typekro';

const release = helmRelease({
  id: 'myApp',
  name: 'my-app',
  namespace: 'production',
  interval: '10m',
  chart: {
    repository: 'https://charts.example.com',
    name: 'my-chart',
    version: '1.2.3'
  },
  values: {
    replicaCount: 3,
    image: { tag: 'v1.0.0' }
  }
});
```

## helmRepository()

Creates a Flux HelmRepository resource.

### Syntax

```typescript
import { helmRepository } from 'typekro';

function helmRepository(config: HelmRepositoryConfig): Enhanced<HelmRepositorySpec, HelmRepositoryStatus>
```

### Configuration

```typescript
interface HelmRepositoryConfig {
  id?: string;             // Resource ID for cross-references
  name: string;
  namespace?: string;
  url: string;
  interval?: string;       // Sync interval (default: '5m')
  type?: 'default' | 'oci';
}
```

### Example

```typescript
import { helmRepository } from 'typekro';

const repo = helmRepository({
  id: 'bitnamiRepo',
  name: 'bitnami',
  namespace: 'flux-system',
  url: 'https://charts.bitnami.com/bitnami',
  interval: '10m'
});
```

## Integration with Status

YAML closures don't have status fields like Enhanced resources. Use other resources for status:

```typescript
import { kubernetesComposition } from 'typekro';
import { HelmChart, YamlFile } from 'typekro/simple';

const app = kubernetesComposition(definition, (spec) => {
  // YAML closure - no status
  YamlFile('./crds.yaml');

  // HelmRelease - has status
  const helm = HelmChart('app', 'https://charts.example.com', 'app');

  // Use HelmRelease status
  return {
    ready: helm.status.conditions?.[0]?.status === 'True'
  };
});
```

## Next Steps

- [Flux Factories](/api/flux/) - Full Flux integration
- [kubernetesComposition](./kubernetes-composition.md) - Using closures in compositions
- [Deployment Modes](/guide/deployment-modes) - Direct vs Kro deployment
