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

export interface YamlFileConfig {
  name: string;
  path: string; // Supports: "./local/file.yaml", "git:github.com/org/repo/path/file.yaml"
  namespace?: string | KubernetesRef<string>; // Can reference dynamically generated namespace
  deploymentStrategy?: 'replace' | 'skipIfExists' | 'fail'; // Default: 'replace'
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
 *     webapp: simpleDeployment({
 *       name: 'nginx',
 *       image: 'nginx',
 *       replicas: schema.spec.replicas
 *     })
 *   }),
 *   (_schema, resources) => ({ ready: true })
 * );
 * ```
 */
export function yamlFile(config: YamlFileConfig): DeploymentClosure<AppliedResource[]> {
  // Return a closure that will be executed during deployment when dependencies are ready
  return async (deploymentContext: DeploymentContext): Promise<AppliedResource[]> => {
    const pathResolver = new PathResolver();

    // Resolve any references in the config (e.g., namespace could reference another resource)
    const resolvedNamespace =
      config.namespace && isKubernetesRef(config.namespace)
        ? await deploymentContext.resolveReference(config.namespace)
        : config.namespace;

    const resolvedContent = await pathResolver.resolveContent(config.path, config.name);
    const manifests = parseYamlManifests(resolvedContent.content);

    const results: AppliedResource[] = [];
    const strategy = config.deploymentStrategy || 'replace';

    for (const manifest of manifests) {
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

        results.push({
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
            results.push({
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
              results.push({
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

    return results;
  };
}

/**
 * Simplified YAML file factory for quick usage
 * @example
 * ```typescript
 * simpleYamlFile('./manifests/configmap.yaml')
 * simpleYamlFile('git:github.com/fluxcd/flux2/manifests/install/flux-system.yaml@main', 'flux-system')
 * ```
 */
export function simpleYamlFile(
  path: string,
  namespace?: string
): DeploymentClosure<AppliedResource[]> {
  const name =
    path
      .split('/')
      .pop()
      ?.replace(/\.(yaml|yml)$/, '') || 'yaml-file';
  return yamlFile({
    name,
    path,
    ...(namespace && { namespace }),
  });
}
