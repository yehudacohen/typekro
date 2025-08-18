# Design Document

## Overview

This design adds deployment closure functions for deploying YAML files and directories through both Direct and Kro factory modes. These closures execute during the deployment phase and work universally across TypeKro's deployment strategies, making them perfect for bootstrap scenarios and deploying static manifests.

The design also includes proper TypeKro factories for Helm and Kustomize resources that integrate fully with TypeKro's composition patterns and reference system.

## Architecture

### Integration with Existing Domain Model

YAML resources integrate into TypeKro's existing architecture as simple deployment primitives:

```mermaid
graph TB
    subgraph "TypeKro Domain Model"
        Schema[Schema Proxy]
        Factory[Factory Functions]
        Composition[Composition Layer]
        References[Reference System]
        Serialization[Serialization Engine]
        Deployment[Deployment Strategies]
        Readiness[Readiness System]
    end
    
    subgraph "YAML Resources Extension"
        YamlFactory[YAML Factory Functions]
        HelmFactory[Helm Factory Functions]
        KustomizeFactory[Kustomize Factory Functions]
        ReadinessEval[Custom Readiness Evaluators]
        ClusterState[Cluster State Access]
    end
    
    Factory --> YamlFactory
    Factory --> HelmFactory
    Factory --> KustomizeFactory
    Readiness --> ReadinessEval
    ReadinessEval --> ClusterState
    
    YamlFactory --> Composition
    HelmFactory --> Composition
    KustomizeFactory --> Composition
```

### Core Principles

1. **Simple YAML Resources**: YAML functions apply static manifests with minimal configuration - no complex templating
2. **Closure-Based Architecture**: Return closures during composition, execute during deployment phase - enables future closure types
3. **Universal Mode Support**: Work in both Direct and Kro factory modes with appropriate validation
4. **Dynamic Namespace Support**: Support references to dynamically generated namespaces (Direct mode only)
5. **Alchemy Integration**: Respect alchemy scope when deployment factory has it configured
6. **Bootstrap-Friendly**: Perfect for installing CRDs, controllers, and infrastructure components
7. **Level-Based Execution**: Execute closures when their dependencies become available
8. **Consistent Failure Behavior**: YAML closures participate in the same failure and rollback semantics as Enhanced<> resources
9. **Unified Path Handling**: Support local files, directories, and Git repositories
10. **Future Extensibility**: Closure pattern supports future non-YAML deployment operations

## Components and Interfaces

### 1. YAML Factory Functions

Factory-style functions that return closures during composition, executed during deployment based on dependency levels:

```typescript
// src/factories/kubernetes/yaml/yaml-file.ts
export interface YamlFileConfig {
  name: string;
  path: string; // Supports: "./local/file.yaml", "git:github.com/org/repo/path/file.yaml"
  namespace?: string | KubernetesRef<string>; // Can reference dynamically generated namespace
}

/**
 * Deploy a YAML file during deployment phase
 * 
 * This looks like a factory function but returns a closure that executes during
 * deployment. The closure receives deployment context (including alchemy scope)
 * and applies manifests directly to Kubernetes in parallel with Enhanced<> resources.
 * 
 * @example
 * ```typescript
 * const graph = toResourceGraph(
 *   {
 *     name: 'my-app',
 *     apiVersion: 'example.com/v1alpha1',
 *     kind: 'MyApp',
 *     spec: type({ replicas: 'number' }),
 *     status: type({ ready: 'boolean' })
 *   },
 *   (schema) => ({
 *     // This returns a closure, stored in composition context
 *     crds: yamlFile({
 *       name: 'flux-crds',
 *       path: 'git:github.com/fluxcd/flux2/manifests/crds@main'
 *     }),
 *     
 *     // This is a normal Enhanced<> resource
 *     webapp: helmRelease({
 *       name: 'nginx',
 *       chart: { repository: 'https://charts.bitnami.com/bitnami', name: 'nginx' },
 *       values: { replicas: schema.spec.replicas }
 *     })
 *   }),
 *   (_schema, resources) => ({ ready: true })
 * );
 * ```
 */
export function yamlFile(config: YamlFileConfig): YamlDeploymentClosure {
  // Return a closure that will be executed during deployment when dependencies are ready
  return async (deploymentContext: DeploymentContext) => {
    const pathResolver = new PathResolver();
    
    const yamlContent = await pathResolver.resolveContent(config.path);
    const manifests = parseYamlManifests(yamlContent);
    
    const results = [];
    for (const manifest of manifests) {
      // Simple namespace override - no complex templating
      if (config.namespace && !manifest.metadata?.namespace) {
        manifest.metadata = { ...manifest.metadata, namespace: config.namespace };
      }
      
      // Apply via alchemy if scope is configured, otherwise direct to Kubernetes
      let result;
      if (deploymentContext.alchemyScope) {
        result = await deploymentContext.alchemyScope.apply(manifest);
      } else {
        const kubernetesApi = deploymentContext.kubernetesApi || getDefaultKubernetesApi();
        result = await kubernetesApi.apply(manifest);
      }
      
      results.push(result);
    }
    
    return results;
  };
}

export interface YamlDirectoryConfig {
  name: string;
  path: string;
  recursive?: boolean;
  include?: string[];
  exclude?: string[];
  namespace?: string | KubernetesRef<string>; // Can reference dynamically generated namespace
}

/**
 * Deploy YAML files from a directory during deployment phase
 * @example
 * ```typescript
 * const graph = toResourceGraph(
 *   {
 *     name: 'bootstrap',
 *     apiVersion: 'example.com/v1alpha1',
 *     kind: 'Bootstrap',
 *     spec: type({ namespace: 'string' }),
 *     status: type({ ready: 'boolean' })
 *   },
 *   (schema) => ({
 *     // Returns closure for deployment-time execution
 *     controllers: yamlDirectory({
 *       name: 'flux-controllers',
 *       path: 'git:github.com/fluxcd/flux2/manifests/install@main',
 *       namespace: 'flux-system'
 *     }),
 *     
 *     // Enhanced<> resources deploy in parallel
 *     app: helmRelease({
 *       name: 'my-app',
 *       chart: { repository: 'https://charts.example.com', name: 'app' }
 *     })
 *   }),
 *   (_schema, resources) => ({ ready: true })
 * );
 * ```
 */
export function yamlDirectory(config: YamlDirectoryConfig): YamlDeploymentClosure {
  // Return closure that will be executed during deployment
  return async (deploymentContext: DeploymentContext) => {
    const pathResolver = new PathResolver();
    const yamlFiles = await pathResolver.discoverYamlFiles(config.path, {
      recursive: config.recursive ?? true,
      include: config.include ?? ['**/*.yaml', '**/*.yml'],
      exclude: config.exclude ?? []
    });
    
    const allResults = [];
    for (const filePath of yamlFiles) {
      const yamlContent = await pathResolver.resolveContent(filePath);
      const manifests = parseYamlManifests(yamlContent);
      
      for (const manifest of manifests) {
        // Resolve namespace references
        const resolvedNamespace = config.namespace && isKubernetesRef(config.namespace)
          ? await deploymentContext.resolveReference(config.namespace)
          : config.namespace;
          
        if (resolvedNamespace && !manifest.metadata?.namespace) {
          manifest.metadata = { ...manifest.metadata, namespace: resolvedNamespace };
        }
        
        // Apply via alchemy if scope is configured, otherwise direct to Kubernetes
        let result;
        if (deploymentContext.alchemyScope) {
          result = await deploymentContext.alchemyScope.apply(manifest);
        } else {
          result = await deploymentContext.kubernetesApi!.create(manifest);
        }
        
        allResults.push({
          kind: manifest.kind,
          name: manifest.metadata?.name || 'unknown',
          namespace: manifest.metadata?.namespace,
          apiVersion: manifest.apiVersion
        });
      }
    }
    
    return allResults;
  };
}
```



/**
 * Common Git repository paths for popular controllers
 */
export const GitPaths = {
  fluxHelm: (version = 'main') => `git:github.com/fluxcd/helm-controller/config/default@${version}`,
  fluxKustomize: (version = 'main') => `git:github.com/fluxcd/kustomize-controller/config/default@${version}`,
  fluxSource: (version = 'main') => `git:github.com/fluxcd/source-controller/config/default@${version}`,
  kro: (version = 'main') => `git:github.com/Azure/kro/config/default@${version}`,
  argoCD: (version = 'stable') => `git:github.com/argoproj/argo-cd/manifests/install.yaml@${version}`,
  istio: (version = 'master') => `git:github.com/istio/istio/manifests/charts/base@${version}`,
} as const;
```

### 2. Helm and Kustomize Factory Functions

Proper factories with full TypeKro integration:

```typescript
// src/factories/kubernetes/helm/helm-release.ts
export interface HelmReleaseConfig {
  name: string;
  namespace?: string;
  chart: {
    repository: string;
    name: string;
    version?: string;
  };
  values?: Record<string, any>;
  id?: string;
}

/**
 * Deploy a Helm chart using Flux CD's HelmRelease
 * @example
 * ```typescript
 * helmRelease({
 *   name: 'nginx',
 *   chart: {
 *     repository: 'https://charts.bitnami.com/bitnami',
 *     name: 'nginx',
 *     version: '13.2.23'
 *   },
 *   values: {
 *     service: { type: 'LoadBalancer' },
 *     replicas: schema.spec.replicas
 *   }
 * })
 * ```
 */
export function helmRelease(config: HelmReleaseConfig): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return createResource({
    ...(config.id && { id: config.id }),
    apiVersion: 'helm.toolkit.fluxcd.io/v2beta1',
    kind: 'HelmRelease',
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
    },
    spec: {
      chart: config.chart,
      values: config.values,
    },
  });
}

/**
 * Simplified Helm chart factory for common use cases
 * @example
 * ```typescript
 * simpleHelmChart('nginx', 'https://charts.bitnami.com/bitnami', 'nginx', {
 *   service: { type: 'LoadBalancer' }
 * })
 * ```
 */
export function simpleHelmChart(
  name: string, 
  repository: string, 
  chart: string, 
  values?: Record<string, any>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return helmRelease({
    name,
    chart: { repository, name: chart },
    values,
  });
}
```

```typescript
// src/factories/kubernetes/kustomize/kustomization.ts
export interface KustomizationConfig {
  name: string;
  namespace?: string;
  source: {
    path: string; // Supports git: URLs
    ref?: string;
  };
  patches?: Array<{
    target: {
      kind: string;
      name?: string;
    };
    patch: string;
  }>;
  id?: string;
}

/**
 * Deploy resources using Flux CD's Kustomization
 * @example
 * ```typescript
 * kustomization({
 *   name: 'my-app',
 *   source: {
 *     path: 'git:github.com/my-org/my-app/k8s/overlays/prod@main'
 *   },
 *   patches: [{
 *     target: { kind: 'Deployment', name: 'app' },
 *     patch: `
 *       - op: replace
 *         path: /spec/replicas
 *         value: ${schema.spec.replicas}
 *     `
 *   }]
 * })
 * ```
 */
export function kustomization(config: KustomizationConfig): Enhanced<KustomizationSpec, KustomizationStatus> {
  return createResource({
    ...(config.id && { id: config.id }),
    apiVersion: 'kustomize.toolkit.fluxcd.io/v1beta2',
    kind: 'Kustomization',
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
    },
    spec: {
      source: config.source,
      patches: config.patches,
    },
  });
}
```

### 3. Level-Based Closure Execution with CRD Establishment

YAML closures integrate with the existing level-based deployment architecture with a critical enhancement: **closures execute at level -1 (before all resources)** to ensure CRD-installing closures run before custom resources that depend on those CRDs.

#### Key Design Principles

1. **Pre-Resource Execution**: All closures execute before any Enhanced<> resources to ensure CRDs are established first
2. **CRD Establishment**: Custom resources automatically wait for their CRDs to be established before deployment
3. **Parallel Closure Execution**: Multiple closures execute in parallel at the pre-resource level
4. **Dependency-Aware**: Future enhancement will support closure dependency analysis for more sophisticated ordering

#### CRD Establishment Logic

The deployment engine includes sophisticated CRD establishment logic that automatically handles the timing between CRD installation and custom resource deployment:

```typescript
// Automatic CRD establishment waiting
private async waitForCRDIfCustomResource(
  resource: any,
  options: DeploymentOptions,
  logger: any
): Promise<void> {
  // 1. Detect if resource is a custom resource (not built-in Kubernetes API)
  if (!this.isCustomResource(resource)) {
    return; // Skip built-in resources
  }

  // 2. Generate CRD name from resource (e.g., HelmRelease -> helmreleases.helm.toolkit.fluxcd.io)
  const crdName = this.getCRDNameForResource(resource);
  if (!crdName) {
    logger.warn('Could not determine CRD name for custom resource');
    return;
  }

  // 3. Wait for CRD to be established in the cluster
  await this.waitForCRDEstablishment({ metadata: { name: crdName } }, options, logger);
  
  logger.debug('CRD established, proceeding with custom resource deployment');
}

private isCustomResource(resource: any): boolean {
  // Built-in Kubernetes API groups that are NOT custom resources
  const builtInApiGroups = [
    'v1', 'apps/v1', 'networking.k8s.io/v1', 'policy/v1',
    'rbac.authorization.k8s.io/v1', 'storage.k8s.io/v1',
    // ... other built-in API groups
  ];

  return !builtInApiGroups.includes(resource.apiVersion);
}

private getCRDNameForResource(resource: any): string | null {
  // Extract group from apiVersion (e.g., "helm.toolkit.fluxcd.io/v2" -> "helm.toolkit.fluxcd.io")
  const apiVersionParts = resource.apiVersion.split('/');
  const group = apiVersionParts.length > 1 ? apiVersionParts[0] : '';

  if (!group) {
    return null; // Core API resources don't have CRDs
  }

  // Convert Kind to plural lowercase (e.g., HelmRelease -> helmreleases)
  const kind = resource.kind.toLowerCase();
  const plural = kind.endsWith('s') ? kind : `${kind}s`;

  return `${plural}.${group}`;
}
```

This ensures that:
- **Flux CRDs** are installed by `yamlFile()` closures before `HelmRelease` and `HelmRepository` resources
- **Kro CRDs** are installed before `ResourceGraphDefinition` resources  
- **Custom CRDs** are installed before any custom resources that depend on them
- **Built-in resources** (Deployments, Services, etc.) deploy immediately without waiting

```typescript
// Enhanced DirectDeploymentEngine with closure support and CRD establishment
export class DirectDeploymentEngine {
  async deployWithClosures<TSpec>(
    graph: ResourceGraph,
    closures: Record<string, DeploymentClosure>,
    options: DeploymentOptions,
    spec: TSpec
  ): Promise<DeploymentResult> {
    // 1. Analyze deployment plan for Enhanced<> resources
    const deploymentPlan = this.dependencyResolver.analyzeDeploymentOrder(graph.dependencyGraph);
    
    // 2. Analyze closure dependencies (currently assigns all to level -1)
    const closureDependencies = this.analyzeClosureDependencies(closures, spec, graph.dependencyGraph);
    
    // 3. Integrate closures into deployment plan with pre-resource level
    const enhancedPlan = this.integrateClosuresIntoPlan(deploymentPlan, closureDependencies);
    
    // 4. Execute level-by-level with closures-first approach
    for (let levelIndex = 0; levelIndex < enhancedPlan.levels.length; levelIndex++) {
      const currentLevel = enhancedPlan.levels[levelIndex];
      
      // Level 0: Execute all closures in parallel (CRD installation, etc.)
      // Level 1+: Execute Enhanced<> resources with automatic CRD establishment waiting
      const levelPromises = [
        ...currentLevel.resources.map(resourceId => this.deployResourceWithCRDWait(resourceId)),
        ...currentLevel.closures.map(closureInfo => this.executeClosure(closureInfo, deploymentContext))
      ];
      
      await Promise.allSettled(levelPromises);
    }
  }
  
  private async deployResourceWithCRDWait(resourceId: string): Promise<DeployedResource> {
    const resource = this.getResource(resourceId);
    
    // Automatically wait for CRD establishment if this is a custom resource
    await this.waitForCRDIfCustomResource(resource.manifest, options, logger);
    
    // Deploy the resource normally
    return this.deploySingleResource(resource, context, options);
  }
  
  private integrateClosuresIntoPlan(
    deploymentPlan: DeploymentPlan, 
    closureDependencies: ClosureDependencyInfo[]
  ): EnhancedDeploymentPlan {
    // Create enhanced levels with pre-resource closure level
    const enhancedLevels = [];
    
    // Level 0: Pre-resource closures (CRD installation, etc.)
    const preResourceClosures = closureDependencies.filter(c => c.level === -1);
    if (preResourceClosures.length > 0) {
      enhancedLevels.push({
        resources: [],
        closures: preResourceClosures,
      });
    }
    
    // Level 1+: Enhanced<> resources (shifted if pre-resource level exists)
    for (let i = 0; i < deploymentPlan.levels.length; i++) {
      enhancedLevels.push({
        resources: deploymentPlan.levels[i] || [],
        closures: [], // Future: closures with resource dependencies
      });
    }
    
    return { levels: enhancedLevels, ... };
  }
}
```

### 3. Integration with DirectDeploymentStrategy

YAML closures integrate with the existing deployment strategy architecture:

```typescript
// src/core/deployment/strategies/direct-strategy.ts - Enhanced to support YAML closures
export class DirectDeploymentStrategy<TSpec, TStatus> {
  protected async executeDeployment(spec: TSpec, instanceName: string): Promise<DeploymentResult> {
    try {
      // 1. Resolve Enhanced<> resources normally
      const resources = this.resourceResolver.resolveResourcesForSpec(spec);
      
      // 2. Collect YAML closures from composition
      const yamlClosures = this.collectYamlClosures();
      
      // 3. Create deployment context
      const deploymentContext: DeploymentContext = {
        kubernetesApi: this.getKubernetesApi(),
        alchemyScope: this.getAlchemyScope(),
        namespace: this.namespace
      };
      
      // 4. Execute YAML closures in parallel with Enhanced<> resource deployment
      const yamlPromises = yamlClosures.map(closure => closure(deploymentContext));
      
      // 5. Create resource graph from Enhanced<> resources
      const resourceGraph = this.createResourceGraph(resources);
      
      // 6. Deploy Enhanced<> resources in parallel with YAML closures
      const [yamlResults, deploymentResult] = await Promise.all([
        Promise.all(yamlPromises),
        this.deploymentEngine.deploy(resourceGraph, deploymentOptions)
      ]);
      
      // 7. Combine results
      return {
        ...deploymentResult,
        yamlResults: yamlResults.flat()
      };
    } catch (error) {
      throw new ResourceDeploymentError(
        `Deployment failed for ${this.factoryName}`,
        error as Error
      );
    }
  }

  private collectYamlClosures(): YamlDeploymentClosure[] {
    // Collect YAML closures from the composition context
    // This would be implemented based on how closures are stored during composition
    return this.compositionContext.yamlClosures || [];
  }
}
```

```typescript
// src/core/deployment/strategies/direct-strategy.ts - Enhanced to execute YAML closures
export class DirectDeploymentStrategy<TSpec, TStatus> {
  protected async executeDeployment(spec: TSpec, instanceName: string): Promise<DeploymentResult> {
    try {
      // 1. Resolve resources and collect YAML closures
      const { resources, yamlClosures } = this.resourceResolver.resolveResourcesForSpec(spec);
      
      // 2. Execute YAML closures in parallel
      const deploymentContext: DeploymentContext = {
        kubernetesApi: this.getKubernetesApi(),
        alchemyScope: this.getAlchemyScope(),
        namespace: this.namespace
      };
      
      const yamlPromises = yamlClosures.map(closure => closure(deploymentContext));
      
      // 3. Create resource graph from Enhanced<> resources
      const resourceGraph = this.createResourceGraph(resources);
      
      // 4. Deploy Enhanced<> resources in parallel with YAML closures
      const [yamlResults, deploymentResult] = await Promise.all([
        Promise.all(yamlPromises),
        this.deploymentEngine.deploy(resourceGraph, deploymentOptions)
      ]);
      
      // 5. Combine results
      return {
        ...deploymentResult,
        yamlResults: yamlResults.flat()
      };
    } catch (error) {
      throw new ResourceDeploymentError(
        `Deployment failed for ${this.factoryName}`,
        error as Error
      );
    }
  }
}
```

### 4. Type Definitions

Types for YAML factory functions that return deployment closures:

```typescript
// Add to src/core/types/deployment.ts

export type YamlDeploymentClosure = (deploymentContext: DeploymentContext) => Promise<AppliedResource[]>;

export interface AppliedResource {
  kind: string;
  name: string;
  namespace?: string;
  apiVersion: string;
}

export interface DeploymentContext {
  kubernetesApi?: k8s.KubernetesObjectApi;
  alchemyScope?: Scope;
  namespace?: string;
  // Level-based execution context - enables future closure extensibility
  deployedResources: Map<string, DeployedResource>; // Resources available at this level
  resolveReference: (ref: KubernetesRef) => Promise<unknown>; // Resolve cross-resource references
}
```

For Helm and Kustomize (which ARE TypeKro resources), the types are defined in the existing Helm factory implementation.

### 5. Path Resolution System

Unified system for handling local files, directories, and Git repositories:



```typescript
// src/core/yaml/path-resolver.ts
export class PathResolver {
  async resolveContent(path: string): Promise<string> {
    if (path.startsWith('git:')) {
      return this.resolveGitContent(path);
    } else {
      return this.resolveLocalContent(path);
    }
  }

  private async resolveGitContent(gitPath: string): Promise<string> {
    // Parse: git:github.com/org/repo/path/file.yaml[@ref]
    const parsed = this.parseGitPath(gitPath);
    
    // Use GitHub API or git clone to fetch content
    return this.fetchFromGit(parsed);
  }

  private async resolveLocalContent(localPath: string): Promise<string> {
    // Read from local filesystem
    return fs.readFileSync(localPath, 'utf-8');
  }

  private parseGitPath(gitPath: string): GitPathInfo {
    // Implementation to parse git: URLs
    const match = gitPath.match(/^git:([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+?)(?:@(.+))?$/);
    if (!match) {
      throw new Error(`Invalid git path: ${gitPath}`);
    }
    
    return {
      host: match[1],
      owner: match[2],
      repo: match[3],
      path: match[4],
      ref: match[5] || 'main',
    };
  }
}
```

### 6. Bootstrap Utilities

Utility functions for common bootstrap scenarios:

Pre-built compositions for common infrastructure patterns:

```typescript
// src/compositions/bootstrap/typekro-runtime.ts
import { type } from 'arktype';
import { toResourceGraph } from '../../core/factory.js';
import { namespace } from '../../factories/kubernetes/core/namespace.js';
import { yamlDirectory } from '../../factories/kubernetes/yaml/yaml-directory.js';
import { deploymentReadyEvaluator } from '../../factories/kubernetes/yaml/readiness-evaluators.js';

export function typeKroRuntimeBootstrap(config: {
  namespace?: string;
  helmController?: {
    version?: string;
  };
  kustomizeController?: {
    version?: string;
  };
  kroController?: {
    version?: string;
  };
} = {}) {
  return toResourceGraph(
    {
      name: 'typekro-runtime-bootstrap',
      apiVersion: 'typekro.dev/v1alpha1',
      kind: 'TypeKroRuntime',
      spec: type({
        namespace: 'string',
      }),
      status: type({
        phase: '"Pending" | "Installing" | "Ready" | "Failed"',
        components: {
          helmController: 'boolean',
          kustomizeController: 'boolean',
          kroController: 'boolean',
        },
      }),
    },
    (schema) => ({
      // Namespace for all components
      namespace: namespace({
        metadata: {
          name: schema.spec.namespace,
        },
      }),

      // Helm Controller from GitHub - closure executes during deployment
      helmController: yamlDirectory({
        name: 'helm-controller',
        path: `git:github.com/fluxcd/helm-controller/config/default@${config.helmController?.version ?? 'main'}`,
        namespace: schema.spec.namespace,
      }),

      // Kustomize Controller from GitHub - closure executes during deployment
      kustomizeController: yamlDirectory({
        name: 'kustomize-controller',
        path: `git:github.com/fluxcd/kustomize-controller/config/default@${config.kustomizeController?.version ?? 'main'}`,
        namespace: schema.spec.namespace,
      }),

      // Kro Controller from GitHub - closure executes during deployment
      kroController: yamlDirectory({
        name: 'kro-controller',
        path: `git:github.com/Azure/kro/config/default@${config.kroController?.version ?? 'main'}`,
        namespace: schema.spec.namespace,
      }),
    }),
    (_schema, resources) => ({
      phase: 'Ready' as const,
      components: {
        helmController: true,
        kustomizeController: true,
        kroController: true,
      },
    })
  );
}

// Example usage with Helm after bootstrap
export function webAppWithHelm(config: {
  namespace?: string;
  appName: string;
  chartVersion?: string;
}) {
  return toResourceGraph(
    {
      name: 'webapp-with-helm',
      apiVersion: 'example.com/v1alpha1',
      kind: 'WebAppHelm',
      spec: type({
        namespace: 'string',
        appName: 'string',
        hostname: 'string',
      }),
      status: type({
        phase: '"Pending" | "Installing" | "Ready" | "Failed"',
        url: 'string',
      }),
    },
    (schema) => ({
      // Deploy the app using Helm
      webapp: helmRelease({
        name: schema.spec.appName,
        namespace: schema.spec.namespace,
        chart: {
          repository: 'https://charts.bitnami.com/bitnami',
          name: 'nginx',
          version: config.chartVersion ?? '13.2.23',
        },
        values: {
          service: {
            type: 'LoadBalancer',
          },
          ingress: {
            enabled: true,
            hostname: schema.spec.hostname,
          },
        },
      }),
    }),
    (_schema, resources) => ({
      phase: 'Ready' as const,
      url: `https://${schema.spec.hostname}`,
    })
  );
}
```

### 7. Integration with Resource Graphs

YAML factory functions can be used seamlessly within resource graphs:

```typescript
// Bootstrap scenario - YAML functions execute immediately during composition
const bootstrapGraph = toResourceGraph(
  {
    name: 'bootstrap',
    apiVersion: 'example.com/v1alpha1',
    kind: 'Bootstrap',
    spec: type({ replicas: 'number' }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // These register for pre-deployment execution
    namespace: yamlFile({
      name: 'kro-namespace',
      path: './manifests/namespace.yaml'
    }),
    
    kroController: yamlDirectory({
      name: 'kro-controller',
      path: 'git:github.com/Azure/kro/config/default@main',
      namespace: 'kro-system'
    }),
    
    helmController: yamlDirectory({
      name: 'helm-controller', 
      path: 'git:github.com/fluxcd/helm-controller/config/default@main',
      namespace: 'kro-system'
    }),
    
    // This is a real TypeKro resource that deploys after YAML functions
    testApp: helmRelease({
      name: 'test-app',
      namespace: 'default',
      chart: {
        repository: 'https://charts.bitnami.com/bitnami',
        name: 'nginx'
      },
      values: {
        replicas: schema.spec.replicas
      }
    })
  }),
  (_schema, resources) => ({
    ready: true // Status builder - YAML functions don't participate in status
  })
);

// Usage - the YAML functions execute during composition, before factory creation
const factory = await bootstrapGraph.factory('kro', { namespace: 'default' });
await factory.deploy({ replicas: 3 });
```

#### Kro Mode Support

YAML closures work in Kro mode with static values only:

```typescript
// Kro mode - static values only
const graph = toResourceGraph('bootstrap', (schema) => ({
  // This works - static namespace
  crds: yamlFile({
    name: 'flux-crds',
    path: 'git:github.com/fluxcd/flux2/manifests/crds@main',
    namespace: 'flux-system' // Static string - OK
  }),
  
  // This would error - dynamic reference
  controllers: yamlDirectory({
    name: 'flux-controllers',
    path: 'git:github.com/fluxcd/flux2/manifests/install@main',
    namespace: schema.spec.namespace // KubernetesRef - ERROR in Kro mode
  })
}));

// Kro factory validates closures and raises clear errors
const kroFactory = await graph.factory('kro', { namespace: 'default' });
// Error: "Kro mode does not support dynamic references in YAML closures. 
//         Found KubernetesRef in yamlDirectory 'controllers' namespace field.
//         Use static values or switch to Direct mode."
```

#### Alchemy Integration

YAML functions automatically integrate with alchemy scope when configured:

```typescript
// When factory has alchemy scope configured
const factory = await graph.factory('direct', { 
  namespace: 'default',
  alchemyScope: myAlchemyScope  // YAML functions will use this scope
});

// YAML functions in the composition will automatically use the alchemy scope
const graph = toResourceGraph('bootstrap', (schema) => ({
  // This will be deployed via alchemy scope if configured
  crds: yamlFile({
    name: 'flux-crds',
    path: 'git:github.com/fluxcd/flux2/manifests/crds@main'
  }),
  
  // Regular TypeKro resources work normally
  app: helmRelease({
    name: 'nginx',
    chart: { repository: 'https://charts.bitnami.com/bitnami', name: 'nginx' }
  })
}), { /* schema */ });
```

#### Reconciliation-Based Dependencies

No manual sequencing needed - Kubernetes handles dependencies:

```typescript
const graph = toResourceGraph(
  {
    name: 'bootstrap',
    apiVersion: 'example.com/v1alpha1', 
    kind: 'Bootstrap',
    spec: type({ appName: 'string' }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Install CRDs - returns closure, executes during deployment
    crds: yamlFile({
      name: 'flux-crds',
      path: 'git:github.com/fluxcd/flux2/manifests/crds@main'
    }),
    
    // Install controllers - returns closure, executes during deployment
    controllers: yamlDirectory({
      name: 'flux-controllers',
      path: 'git:github.com/fluxcd/flux2/manifests/install@main',
      namespace: 'flux-system'
    }),
    
    // Deploy app - Enhanced<> resource deployed normally
    app: helmRelease({
      name: schema.spec.appName,
      chart: { repository: 'https://charts.example.com', name: 'app' }
    })
  }),
  (_schema, resources) => ({
    ready: true // YAML functions don't contribute to status
  })
);

// Key benefits of this approach:
// 1. YAML closures execute in parallel with Enhanced<> resources during deployment
// 2. Closures receive deployment context with alchemy scope and Kubernetes API
// 3. Kubernetes reconciliation handles all timing and dependencies
// 4. If anything fails, standard TypeKro rollback applies to everything
// 5. Maximum parallelism - everything happens simultaneously
```

## Data Models

### Universal Mode Support

YAML closures work in both Direct and Kro factory modes with different capabilities:

#### Direct Mode
- **Full Feature Support**: All YAML closure features work including dynamic references
- **Deployment Context**: Closures receive full deployment context with alchemy scope and Kubernetes API
- **Reference Resolution**: KubernetesRef inputs are resolved at deployment time
- **Parallel Execution**: Closures execute in parallel with Enhanced<> resource deployment

#### Kro Mode  
- **Static Values Only**: YAML closures work with static configuration values
- **Validation**: KubernetesRef inputs are detected and cause clear validation errors
- **Pre-RGD Execution**: Closures execute before ResourceGraphDefinition creation
- **Bootstrap Support**: Perfect for installing CRDs and controllers before RGD deployment

#### Mode Selection Logic
```typescript
// This works in both modes - static namespace
yamlFile({
  name: 'crds',
  path: 'git:github.com/fluxcd/flux2/manifests/crds@main',
  namespace: 'flux-system' // Static string
});

// This only works in Direct mode - dynamic reference
yamlFile({
  name: 'app-config',
  path: './config.yaml',
  namespace: schema.spec.namespace // KubernetesRef - Direct mode only
});
```

### YAML Factory Lifecycle

YAML factory functions return closures during composition, executed during deployment:

1. **Closure Creation**: Function returns closure during composition evaluation
2. **Closure Collection**: DirectResourceFactory collects closures during resource resolution
3. **Deployment Execution**: DirectDeploymentStrategy executes closures during deployment phase
4. **Path Resolution**: Load YAML content from local files or Git repositories  
5. **Direct Application**: Apply manifests directly to Kubernetes API via deployment context
6. **Parallel Execution**: Executes in parallel with Enhanced<> resource deployment
7. **Consistent Failure Handling**: Failed YAML deployments cause overall deployment failure and rollback

#### Key Characteristics

- **Factory-Style API**: Looks and feels like other TypeKro factory functions
- **Closure-Based Execution**: Returns closures during composition, executes during deployment
- **Deployment Context Integration**: Receives deployment context with alchemy scope and Kubernetes API
- **Bootstrap-Safe**: Perfect for installing CRDs and controllers alongside TypeKro resources
- **Parallel Deployment**: Executes in parallel with Enhanced<> resources for maximum speed

#### Important Distinctions

- **Not Enhanced<> Resources**: YAML functions do not return Enhanced<> objects and cannot use `.withReadinessEvaluator()`
- **Simple Configuration**: YAML functions only support basic namespace override - no complex templating or variable substitution
- **Closure vs Resource**: YAML functions return closures during composition, Enhanced<> resources return Enhanced<> objects
- **Level-Based Execution**: Closures execute when their input dependencies (like namespace references) become available
- **Future Extensibility**: The closure pattern enables future deployment operations beyond YAML (e.g., Terraform, Pulumi, custom APIs)
- **Consistent Failure Behavior**: YAML function failures cause deployment failure just like Enhanced<> resource failures
- **Unified Rollback**: Failed deployments trigger rollback of both YAML-deployed and Enhanced<> resources

#### Future Closure Types

The closure architecture enables future deployment operations:

```typescript
// Future examples - not part of this spec
terraformModule({ source: 'terraform-aws-modules/vpc/aws', variables: { ... } })
pulumiStack({ stack: 'my-org/my-stack', config: { ... } })
customApiCall({ endpoint: 'https://api.example.com/deploy', payload: { ... } })
```

### Helm/Kustomize Resource Integration

Helm and Kustomize resources integrate fully with TypeKro's reference system:

```typescript
// In a composition function
const database = simpleDeployment({
  name: 'postgres',
  image: 'postgres:13',
});

const webapp = helmRelease({
  name: 'webapp',
  namespace: schema.spec.namespace,
  chart: {
    repository: 'https://charts.bitnami.com/bitnami',
    name: 'nginx',
    version: '13.2.23',
  },
  values: {
    // These can use TypeKro references and CEL expressions
    database: {
      host: database.status.podIP,
      port: 5432,
    },
    replicas: schema.spec.replicas,
    image: {
      tag: Cel.expr(schema.spec.version, ' + "-alpine"'),
    },
  },
});
```

### Dependency Resolution

All resources participate in TypeKro's dependency graph:

- **YAML Dependencies**: YAML resources can depend on namespaces, secrets, etc.
- **Controller Dependencies**: Helm/Kustomize resources depend on their respective controllers being ready
- **Cross-references**: Helm values and Kustomize patches can reference other resource properties
- **Readiness Chain**: Custom readiness evaluators can check complex dependency chains

## Error Handling

### YAML Resource Errors

Following TypeKro's error handling patterns:

```typescript
// src/core/errors.ts additions

export class YamlPathResolutionError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceName: string,
    public readonly path: string,
    public readonly suggestions?: string[]
  ) {
    super(message, 'YAML_PATH_RESOLUTION_ERROR', {
      resourceName,
      path,
      suggestions,
    });
    this.name = 'YamlPathResolutionError';
  }

  static invalidGitUrl(resourceName: string, userInput: string): YamlPathResolutionError {
    return new YamlPathResolutionError(
      `Invalid git URL format for resource '${resourceName}'. Expected: git:github.com/owner/repo/path@ref\nGot: ${userInput}`,
      resourceName,
      userInput,
      [
        'Use format: git:github.com/owner/repo/path@ref',
        'Example: git:github.com/fluxcd/helm-controller/config/default@main',
        'Use GitPaths.fluxHelm() for common controllers',
      ]
    );
  }
}

export class GitContentError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceName: string,
    public readonly gitPath: string,
    public readonly suggestions?: string[]
  ) {
    super(message, 'GIT_CONTENT_ERROR', {
      resourceName,
      gitPath,
      suggestions,
    });
    this.name = 'GitContentError';
  }

  static repositoryNotFound(resourceName: string, gitPath: string): GitContentError {
    return new GitContentError(
      `Git repository not found for resource '${resourceName}': ${gitPath}`,
      resourceName,
      gitPath,
      [
        'Check that the repository exists and is accessible',
        'Verify the repository URL and path are correct',
        'For private repositories, ensure authentication is configured',
        'Try using a specific branch or tag: @main, @v1.0.0',
      ]
    );
  }
}

export class YamlProcessingError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceName: string,
    public readonly filePath: string,
    public readonly line?: number,
    public readonly suggestions?: string[]
  ) {
    super(message, 'YAML_PROCESSING_ERROR', {
      resourceName,
      filePath,
      line,
      suggestions,
    });
    this.name = 'YamlProcessingError';
  }

  static invalidYaml(resourceName: string, filePath: string, line?: number): YamlProcessingError {
    const lineInfo = line ? ` at line ${line}` : '';
    return new YamlProcessingError(
      `Invalid YAML syntax in resource '${resourceName}' file '${filePath}'${lineInfo}`,
      resourceName,
      filePath,
      line,
      [
        'Check YAML syntax for proper indentation and structure',
        'Ensure all strings are properly quoted',
        'Validate YAML using a linter or online validator',
        'Check for tabs vs spaces consistency',
      ]
    );
  }
}
```

## Testing Strategy

### Unit Tests

- **Factory Functions**: Test YAML, Helm, and Kustomize resource creation
- **Path Resolution**: Test local file, directory, and Git path resolution
- **Readiness Evaluators**: Test default and custom readiness evaluation logic
- **Cluster State Access**: Test cluster state accessor functionality
- **Error Handling**: Test error scenarios and error message quality

### Integration Tests

- **End-to-End**: Deploy YAML resources using DirectResourceFactory
- **Bootstrap**: Test complete TypeKro runtime bootstrap process
- **Helm Integration**: Test Helm release deployment with TypeKro references
- **Kustomize Integration**: Test Kustomization deployment with patches
- **Git Integration**: Test fetching and processing Git repositories

### Type Safety Tests

Following TypeKro's type safety testing guidelines:

```typescript
describe('YAML Factory Type Safety', () => {
  it('should provide type-safe access to YAML factory result properties', () => {
    const yamlRes = yamlFile({
      name: 'test-yaml',
      path: './test-manifests/configmap.yaml',
    });

    // These should be properly typed without assertions
    expect(yamlRes.name).toBe('test-yaml');
    expect(yamlRes.path).toBe('./test-manifests/configmap.yaml');
    
    // Should be thenable for dependency chains
    expect(typeof yamlRes.then).toBe('function');
  });

  it('should support Helm releases with TypeKro references', () => {
    const database = simpleDeployment({
      name: 'postgres',
      image: 'postgres:13',
    });

    const webapp = helmRelease({
      name: 'webapp',
      chart: {
        repository: 'https://charts.bitnami.com/bitnami',
        name: 'nginx',
        version: '13.2.23',
      },
      values: {
        database: {
          host: database.status.podIP, // Should be properly typed
        },
      },
    });

    // No type assertions needed
    expect(webapp.spec?.chart.name).toBe('nginx');
    expect(isResourceReference(webapp.spec?.values?.database?.host)).toBe(true);
  });
});
```

## Implementation Phases

### Phase 1: Core YAML Processing
- YAML factory functions (yamlFile, yamlDirectory)
- Path resolution system (local files and Git URLs)
- Integration with existing factory system
- Default readiness evaluators

### Phase 2: Cluster State Access
- ClusterStateAccessor interface and implementation
- Custom readiness evaluator support
- Integration with TypeKro's deployment strategies

### Phase 3: Helm Factory Functions
- HelmRelease factory with full TypeKro integration
- Helm Controller deployment via YAML resources
- Reference resolution in Helm values
- Helm-specific readiness evaluators

### Phase 4: Kustomize Factory Functions
- Kustomization factory with patch support
- Kustomize Controller deployment via YAML resources
- Reference resolution in patches
- Kustomize-specific readiness evaluators

### Phase 5: Bootstrap Compositions
- Pre-built bootstrap compositions
- Complete TypeKro runtime bootstrap
- Example compositions using Helm and Kustomize

### Phase 6: Documentation and Examples
- Comprehensive documentation
- Bootstrap tutorial
- GitOps patterns guide
- Migration examples

This design maintains TypeKro's philosophy of simplicity and type safety while enabling powerful GitOps patterns through proper separation of concerns between unsafe YAML resources and fully-integrated Helm/Kustomize factories.
## Simpl
e Usage Example

```typescript
const graph = toResourceGraph(
  {
    name: 'bootstrap-app',
    apiVersion: 'example.com/v1alpha1',
    kind: 'BootstrapApp',
    spec: type({ appName: 'string' }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Level 0: Create namespace first
    appNamespace: namespace({
      metadata: { name: 'my-app-system' }
    }),
    
    // Level 1: Deploy CRDs (depends on namespace reference)
    crds: yamlFile({
      name: 'flux-crds',
      path: 'git:github.com/fluxcd/flux2/manifests/crds@main',
      namespace: appNamespace.metadata.name // Simple namespace reference - no templating
    }),
    
    // Level 2: Deploy controllers (also depends on namespace)
    controllers: yamlDirectory({
      name: 'flux-controllers',
      path: 'git:github.com/fluxcd/flux2/manifests/install@main',
      namespace: appNamespace.metadata.name // Same simple reference
    }),
    
    // Level 3: Deploy app using Enhanced<> resource
    app: simpleDeployment({
      name: schema.spec.appName,
      image: 'nginx',
      namespace: appNamespace.metadata.name
    })
  }),
  (_schema, resources) => ({ ready: true })
);
```

**Key Simplicity Features:**
- YAML functions only support basic namespace override
- No complex templating or variable substitution in YAML content
- Namespace can reference dynamically created Enhanced<> resources
- Closure pattern enables future non-YAML deployment operations
- Level-based execution ensures proper dependency ordering

## Implementation Summary

The key implementation work:
1. **Create closure-based YAML functions** that return deployment closures instead of Enhanced<> resources
2. **Enhance DependencyResolver** to analyze closure dependencies on Enhanced<> resources
3. **Update DirectDeploymentEngine** to execute closures within dependency levels
4. **Extend DeploymentContext** to support reference resolution for namespace overrides
5. **Maintain simplicity** - no complex templating, just basic namespace references

This approach provides a clean foundation for YAML deployment while establishing the closure pattern for future extensibility beyond YAML resources.