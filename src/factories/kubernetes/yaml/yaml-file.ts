import * as yaml from 'js-yaml';
import { isKubernetesRef } from '../../../core/dependencies/type-guards.js';
import { getComponentLogger } from '../../../core/logging/index.js';
import type { KubernetesRef } from '../../../core/types/common.js';
import type {
  AppliedResource,
  DeploymentClosure,
  DeploymentContext,
} from '../../../core/types/deployment.js';
import type { KubernetesResource } from '../../../core/types/kubernetes.js';
import { PathResolver } from '../../../core/yaml/path-resolver.js';
import { registerDeploymentClosure } from '../../shared.js';

const logger = getComponentLogger('yaml-file');

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

/**
 * Apply a manifest using server-side apply (PATCH with application/apply-patch+yaml)
 *
 * Server-side apply is safer than replace because it:
 * 1. Merges changes instead of replacing the entire resource
 * 2. Tracks field ownership to prevent conflicts
 * 3. Preserves fields managed by other controllers
 *
 * @param kubernetesApi - The Kubernetes API client
 * @param manifest - The manifest to apply
 * @param fieldManager - The field manager name (identifies who owns the fields)
 * @param forceConflicts - Whether to force ownership of conflicting fields
 */
async function applyWithServerSideApply(
  kubernetesApi: any,
  manifest: KubernetesResource,
  fieldManager: string,
  forceConflicts: boolean
): Promise<void> {
  const resourceName = `${manifest.kind}/${manifest.metadata?.name}`;

  try {
    // Server-side apply uses PATCH with specific content type
    // The kubernetes client's patch method supports this via options
    await kubernetesApi.patch(
      manifest,
      undefined, // pretty
      undefined, // dryRun
      fieldManager, // fieldManager
      forceConflicts // force
    );

    logger.debug('Applied resource using server-side apply', {
      resource: resourceName,
      fieldManager,
      forceConflicts,
    });
  } catch (error: any) {
    // If the resource doesn't exist, create it
    const statusCode =
      error?.response?.statusCode ||
      error?.statusCode ||
      error?.body?.code;

    if (statusCode === 404) {
      logger.debug('Resource not found, creating with server-side apply', {
        resource: resourceName,
      });
      await kubernetesApi.create(manifest);
    } else {
      throw error;
    }
  }
}

export interface YamlFileConfig {
  name: string;
  path: string; // Supports: "./local/file.yaml", "git:github.com/org/repo/path/file.yaml"
  namespace?: string | KubernetesRef<string>; // Can reference dynamically generated namespace
  deploymentStrategy?: 'replace' | 'skipIfExists' | 'fail' | 'serverSideApply'; // Default: 'replace'
  /**
   * Optional transform function to apply to each manifest before deployment.
   * Useful for applying fixes or modifications to external manifests.
   *
   * @example
   * ```typescript
   * import { fixCRDSchemaForK8s133 } from '../../../core/utils/crd-schema-fix.js';
   *
   * yamlFile({
   *   name: 'flux-install',
   *   path: 'https://github.com/fluxcd/flux2/releases/download/v2.7.5/install.yaml',
   *   manifestTransform: fixCRDSchemaForK8s133,
   * });
   * ```
   */
  manifestTransform?: (manifest: KubernetesResource) => KubernetesResource;
  /**
   * Field manager name for server-side apply operations.
   * Only used when deploymentStrategy is 'serverSideApply'.
   * @default 'typekro'
   */
  fieldManager?: string;
  /**
   * Force conflicts during server-side apply.
   * When true, takes ownership of conflicting fields from other managers.
   * Only used when deploymentStrategy is 'serverSideApply'.
   * @default false
   */
  forceConflicts?: boolean;
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
 *     webapp: simple.Deployment({
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
  // Use generic deployment closure registration for composition context support
  return registerDeploymentClosure(() => {
    // Create the deployment closure
    const closure = async (deploymentContext: DeploymentContext): Promise<AppliedResource[]> => {
      const pathResolver = new PathResolver();

      // Resolve any references in the config (e.g., namespace could reference another resource)
      const resolvedNamespace =
        config.namespace && isKubernetesRef(config.namespace)
          ? await deploymentContext.resolveReference(config.namespace)
          : config.namespace;

      const resolvedContent = await pathResolver.resolveContent(config.path, config.name);
      const rawManifests = parseYamlManifests(resolvedContent.content);

      // Apply optional manifest transform (e.g., CRD schema fixes)
      const manifests = config.manifestTransform
        ? rawManifests.map(config.manifestTransform)
        : rawManifests;

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
              if (strategy === 'serverSideApply') {
                await applyWithServerSideApply(
                  deploymentContext.kubernetesApi,
                  manifest,
                  config.fieldManager || 'typekro',
                  config.forceConflicts || false
                );
              } else {
                await deploymentContext.kubernetesApi.create(manifest);
              }
            } else {
              throw new Error('No Kubernetes API available for YAML deployment');
            }
          } else if (deploymentContext.kubernetesApi) {
            if (strategy === 'serverSideApply') {
              await applyWithServerSideApply(
                deploymentContext.kubernetesApi,
                manifest,
                config.fieldManager || 'typekro',
                config.forceConflicts || false
              );
            } else {
              await deploymentContext.kubernetesApi.create(manifest);
            }
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
          // Extract status code from various error formats
          const statusCode =
            error?.response?.statusCode ||
            error?.statusCode ||
            error?.body?.code ||
            (typeof error?.message === 'string' && error.message.includes('HTTP-Code: 409')
              ? 409
              : undefined);

          // Handle conflicts (409) based on deployment strategy
          // Note: 422 validation errors are NOT handled here - they should fail hard
          // as they indicate a real problem with the manifest
          if (statusCode === 409) {
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
                    // In the new API, methods return objects directly (no .body wrapper)
                    existing = await deploymentContext.kubernetesApi.read({
                      apiVersion: manifest.apiVersion,
                      kind: manifest.kind,
                      metadata: {
                        name: manifest.metadata?.name || '',
                        namespace: manifest.metadata?.namespace || 'default',
                      },
                    });
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

    return closure;
  }, config.name);
}

/**
 * Simplified YAML file factory for quick usage
 * @example
 * ```typescript
 * simple.YamlFile('./manifests/configmap.yaml')
 * simple.YamlFile('git:github.com/fluxcd/flux2/manifests/install/flux-system.yaml@main', 'flux-system')
 * ```
 */
/**
 * @deprecated Use simple.YamlFile() instead - import { simple } from 'typekro'; simple.YamlFile(...)
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
