import * as yaml from 'js-yaml';
import { ResourceGraphFactoryError } from '../../../core/errors.js';
import { getErrorStatusCode } from '../../../core/kubernetes/errors.js';
import type { KubernetesRef } from '../../../core/types/common.js';
import type {
  AppliedResource,
  DeploymentClosure,
  DeploymentContext,
} from '../../../core/types/deployment.js';
import type { KubernetesResource } from '../../../core/types/kubernetes.js';
import { PathResolver } from '../../../core/yaml/path-resolver.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { registerDeploymentClosure } from '../../shared.js';
import { handleConflict } from './conflict-handler.js';

/**
 * Parse YAML content into Kubernetes manifests
 */
function parseYamlManifests(yamlContent: string): KubernetesResource[] {
  const documents = yaml.loadAll(yamlContent, undefined, { schema: yaml.JSON_SCHEMA });
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
  /** Resource graph identifier. Required when `name` is dynamic (e.g. from schema references). */
  id?: string;
  path: string; // Supports: "./local/dir", "git:github.com/org/repo/path/dir"
  /** @default true */
  recursive?: boolean;
  /** @default ['**\/*.yaml', '**\/*.yml'] */
  include?: string[]; // Glob patterns
  /** @default [] */
  exclude?: string[]; // Glob patterns
  namespace?: string | KubernetesRef<string>; // Can reference dynamically generated namespace
  /** @default 'replace' */
  deploymentStrategy?: 'replace' | 'skipIfExists' | 'fail';
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
 *     app: simple.Deployment({
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
  return registerDeploymentClosure(() => {
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

          if (deploymentContext.validationOnly) {
            allResults.push({
              kind: manifest.kind || 'Unknown',
              name: manifest.metadata?.name || 'unknown',
              namespace: manifest.metadata?.namespace || undefined,
              apiVersion: manifest.apiVersion || 'v1',
            });
            continue;
          }

          try {
            // Apply via alchemy if scope is configured, otherwise direct to Kubernetes
            if (deploymentContext.alchemyScope) {
              // For now, use the Kubernetes API even when alchemy scope is available
              // TODO: Implement proper alchemy integration for YAML resources
              if (deploymentContext.kubernetesApi) {
                await deploymentContext.kubernetesApi.create(manifest);
              } else {
                throw new ResourceGraphFactoryError(
                  'No Kubernetes API available for YAML deployment',
                  config.name,
                  'deployment'
                );
              }
            } else if (deploymentContext.kubernetesApi) {
              await deploymentContext.kubernetesApi.create(manifest);
            } else {
              throw new ResourceGraphFactoryError(
                'No deployment method available: neither alchemyScope nor kubernetesApi provided',
                config.name,
                'deployment'
              );
            }

            allResults.push({
              kind: manifest.kind || 'Unknown',
              name: manifest.metadata?.name || 'unknown',
              namespace: manifest.metadata?.namespace || undefined,
              apiVersion: manifest.apiVersion || 'v1',
            });
          } catch (error: unknown) {
            // Handle conflicts based on deployment strategy
            if (getErrorStatusCode(error) === 409) {
              const result = await handleConflict(error, manifest, strategy, deploymentContext);
              allResults.push(result);
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
  }, config.name);
}
