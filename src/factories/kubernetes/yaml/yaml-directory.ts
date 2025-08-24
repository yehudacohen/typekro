import * as yaml from 'js-yaml';
import { isKubernetesRef } from '../../../core/dependencies/type-guards.js';
import type { KubernetesRef } from '../../../core/types/common.js';
import type {
  AppliedResource,
  DeploymentClosure,
  DeploymentContext,
} from '../../../core/types/deployment.js';
import type { KubernetesResource } from '../../../core/types/kubernetes.js';
import { PathResolver } from '../../../core/yaml/path-resolver.js';
import { registerDeploymentClosure } from '../../shared.js';

/**
 * Parse YAML content into Kubernetes manifests
 */
function parseYamlManifests(yamlContent: string): KubernetesResource[] {
  const documents = yaml.loadAll(yamlContent);
  const manifests: KubernetesResource[] = [];

  for (const doc of documents) {
    if (doc && typeof doc === 'object' && 'kind' in doc && 'apiVersion' in doc) {
      manifests.push(doc as KubernetesResource);
    }
  }

  return manifests;
}

export interface YamlDirectoryConfig {
  name: string;
  path: string; // Supports: "./local/dir", "git:github.com/org/repo/path/dir"
  recursive?: boolean;
  include?: string[]; // Glob patterns
  exclude?: string[]; // Glob patterns
  namespace?: string | KubernetesRef<string>; // Can reference dynamically generated namespace
  deploymentStrategy?: 'replace' | 'skipIfExists' | 'fail'; // Default: 'replace'
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
 *     app: simpleDeployment({
 *       name: 'my-app',
 *       image: 'nginx'
 *     })
 *   }),
 *   (_schema, resources) => ({ ready: true })
 * );
 * ```
 */
export function yamlDirectory(config: YamlDirectoryConfig): DeploymentClosure<AppliedResource[]> {
  // Use generic deployment closure registration for composition context support
  return registerDeploymentClosure(
    () => {
      // Create the deployment closure
      const closure = async (deploymentContext: DeploymentContext): Promise<AppliedResource[]> => {
    const pathResolver = new PathResolver();
    const yamlFiles = await pathResolver.discoverYamlFiles(
      config.path,
      {
        recursive: config.recursive ?? true,
        include: config.include ?? ['**/*.yaml', '**/*.yml'],
        exclude: config.exclude ?? [],
      },
      config.name
    );

    const allResults: AppliedResource[] = [];
    const strategy = config.deploymentStrategy || 'replace';

    for (const discoveredFile of yamlFiles) {
      // Use the pre-fetched content from the discovered file
      const manifests = parseYamlManifests(discoveredFile.content);

      for (const manifest of manifests) {
        // Resolve namespace references
        const resolvedNamespace =
          config.namespace && isKubernetesRef(config.namespace)
            ? await deploymentContext.resolveReference(config.namespace)
            : config.namespace;

        if (resolvedNamespace && !manifest.metadata?.namespace) {
          manifest.metadata = { ...manifest.metadata, namespace: resolvedNamespace as string };
        }

        try {
          // Apply via alchemy if scope is configured, otherwise direct to Kubernetes
          if (deploymentContext.alchemyScope) {
            // For now, use the Kubernetes API even when alchemy scope is available
            // TODO: Implement proper alchemy integration for YAML resources
            if (deploymentContext.kubernetesApi) {
              await deploymentContext.kubernetesApi.create(manifest);
            } else {
              throw new Error('No Kubernetes API available for YAML deployment');
            }
          } else if (deploymentContext.kubernetesApi) {
            await deploymentContext.kubernetesApi.create(manifest);
          } else {
            throw new Error(
              'No deployment method available: neither alchemyScope nor kubernetesApi provided'
            );
          }

          allResults.push({
            kind: manifest.kind || 'Unknown',
            name: manifest.metadata?.name || 'unknown',
            namespace: manifest.metadata?.namespace || undefined,
            apiVersion: manifest.apiVersion || 'v1',
          });
        } catch (error: any) {
          // Handle conflicts based on deployment strategy
          if (error?.response?.statusCode === 409 || error?.statusCode === 409) {
            const resourceName = `${manifest.kind}/${manifest.metadata?.name}`;

            if (strategy === 'skipIfExists') {
              console.log(`⚠️ Skipping existing resource: ${resourceName}`);
              allResults.push({
                kind: manifest.kind || 'Unknown',
                name: manifest.metadata?.name || 'unknown',
                namespace: manifest.metadata?.namespace || undefined,
                apiVersion: manifest.apiVersion || 'v1',
              });
            } else if (strategy === 'replace') {
              console.log(`🔄 Replacing existing resource: ${resourceName}`);
              // Try to update/replace the resource
              try {
                if (deploymentContext.kubernetesApi) {
                  // Check if resource exists first
                  let existing: any;
                  try {
                    const readResult = await deploymentContext.kubernetesApi.read({
                      apiVersion: manifest.apiVersion,
                      kind: manifest.kind,
                      metadata: {
                        name: manifest.metadata?.name || '',
                        namespace: manifest.metadata?.namespace || 'default',
                      },
                    });
                    existing = readResult.body;
                  } catch (error: any) {
                    // If it's a 404, the resource doesn't exist
                    if (error.statusCode !== 404) {
                      throw error;
                    }
                  }

                  if (existing) {
                    // Resource exists, use patch for safer updates
                    await deploymentContext.kubernetesApi.patch(manifest);
                  } else {
                    // Resource does not exist, create it
                    await deploymentContext.kubernetesApi.create(manifest);
                  }
                }
                allResults.push({
                  kind: manifest.kind || 'Unknown',
                  name: manifest.metadata?.name || 'unknown',
                  namespace: manifest.metadata?.namespace || undefined,
                  apiVersion: manifest.apiVersion || 'v1',
                });
              } catch (replaceError) {
                console.error(`❌ Failed to replace resource ${resourceName}:`, replaceError);
                throw replaceError;
              }
            } else {
              // strategy === 'fail' (default behavior)
              throw error;
            }
          } else {
            // Non-conflict errors should always be thrown
            throw error;
          }
        }
      }
    }

    return allResults;
  };

      return closure;
    },
    config.name
  );
}

/**
 * Common Git repository paths for popular controllers
 */
export const GitPaths = {
  fluxHelm: (version = 'main') => `git:github.com/fluxcd/helm-controller/config/default@${version}`,
  fluxKustomize: (version = 'main') =>
    `git:github.com/fluxcd/kustomize-controller/config/default@${version}`,
  fluxSource: (version = 'main') =>
    `git:github.com/fluxcd/source-controller/config/default@${version}`,
  kro: (version = 'main') => `git:github.com/Azure/kro/config/default@${version}`,
  argoCD: (version = 'stable') =>
    `git:github.com/argoproj/argo-cd/manifests/install.yaml@${version}`,
  istio: (version = 'master') => `git:github.com/istio/istio/manifests/charts/base@${version}`,
} as const;
