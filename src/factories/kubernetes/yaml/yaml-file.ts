import type * as k8s from '@kubernetes/client-node';
import { PatchStrategy } from '@kubernetes/client-node';
import * as yaml from 'js-yaml';
import { isKubernetesRef } from '../../../core/dependencies/type-guards.js';
import { ResourceGraphFactoryError } from '../../../core/errors.js';
import { createBunCompatibleApiextensionsV1Api } from '../../../core/kubernetes/bun-api-client.js';
import { getErrorStatusCode } from '../../../core/kubernetes/errors.js';
import { isKubernetesError } from '../../../core/kubernetes/type-guards.js';
import { getComponentLogger } from '../../../core/logging/index.js';
import type { KubernetesRef } from '../../../core/types/common.js';
import type {
  AppliedResource,
  DeploymentClosure,
  DeploymentContext,
} from '../../../core/types/deployment.js';
import type { KubernetesResource } from '../../../core/types/kubernetes.js';
import { generateSchemaFixPatches } from '../../../core/utils/crd-schema-fix.js';
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
 * For CRDs specifically, we use a read-modify-write pattern to ensure schema
 * changes are properly applied, as server-side apply may not merge deeply
 * nested schema fields correctly.
 *
 * @param kubernetesApi - The Kubernetes API client
 * @param manifest - The manifest to apply
 * @param fieldManager - The field manager name (identifies who owns the fields)
 * @param forceConflicts - Whether to force ownership of conflicting fields
 * @param kubeConfig - Optional KubeConfig for CRD schema patching
 */
async function applyWithServerSideApply(
  kubernetesApi: any,
  manifest: KubernetesResource,
  fieldManager: string,
  forceConflicts: boolean,
  kubeConfig?: k8s.KubeConfig,
  crdPatchTimeout?: number
): Promise<void> {
  const resourceName = `${manifest.kind}/${manifest.metadata?.name}`;

  // For CRDs, use a special read-modify-write pattern to ensure schema changes are applied
  // Server-side apply may not properly merge deeply nested schema fields
  if (manifest.kind === 'CustomResourceDefinition') {
    await applyCRDWithSchemaFix(
      kubernetesApi,
      manifest,
      fieldManager,
      forceConflicts,
      kubeConfig,
      crdPatchTimeout
    );
    return;
  }

  try {
    // Server-side apply uses PATCH with specific content type
    // The kubernetes client's patch method supports this via options
    // IMPORTANT: force parameter is ONLY valid with ServerSideApply strategy
    await kubernetesApi.patch(
      manifest,
      undefined, // pretty
      undefined, // dryRun
      fieldManager, // fieldManager
      forceConflicts, // force - only valid with ServerSideApply
      PatchStrategy.ServerSideApply // patchStrategy - required for force to work
    );

    logger.debug('Applied resource using server-side apply', {
      resource: resourceName,
      fieldManager,
      forceConflicts,
    });
  } catch (error: unknown) {
    // If the resource doesn't exist, create it
    const statusCode = getErrorStatusCode(error);

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

/**
 * Apply a CRD with special handling for schema changes
 *
 * CRDs require special handling because:
 * 1. Server-side apply may not properly merge deeply nested schema fields
 * 2. The x-kubernetes-preserve-unknown-fields annotation is critical for HelmRelease values
 * 3. We need to ensure the schema changes are actually applied to the cluster
 *
 * This function uses a two-phase approach:
 * 1. First, apply the CRD using server-side apply (handles most fields)
 * 2. Then, use JSON patch via ApiextensionsV1Api to specifically update the schema fields
 *
 * @param kubernetesApi - The Kubernetes API client
 * @param manifest - The CRD manifest to apply
 * @param fieldManager - The field manager name
 * @param forceConflicts - Whether to force ownership of conflicting fields
 * @param kubeConfig - Optional KubeConfig for ApiextensionsV1Api (for JSON patching)
 */
async function applyCRDWithSchemaFix(
  kubernetesApi: any,
  manifest: KubernetesResource,
  fieldManager: string,
  forceConflicts: boolean,
  kubeConfig?: k8s.KubeConfig,
  crdPatchTimeout?: number
): Promise<void> {
  const crdName = manifest.metadata?.name || 'unknown';
  const crd = manifest as any;

  // Log what we're applying for debugging
  const valuesField =
    crd.spec?.versions?.[0]?.schema?.openAPIV3Schema?.properties?.spec?.properties?.values;
  logger.debug('Applying CRD with schema fix', {
    crdName,
    fieldManager,
    forceConflicts,
    valuesFieldHasPreserveUnknown: valuesField?.['x-kubernetes-preserve-unknown-fields'] === true,
    valuesFieldType: valuesField?.type,
  });

  try {
    // First, try server-side apply with force to take ownership of schema fields
    // This should work for most cases and properly merge the schema changes
    await kubernetesApi.patch(
      manifest,
      undefined, // pretty
      undefined, // dryRun
      fieldManager, // fieldManager
      forceConflicts, // force - take ownership of conflicting fields
      PatchStrategy.ServerSideApply // patchStrategy
    );

    logger.info('Applied CRD with server-side apply', {
      crdName,
      valuesFieldHasPreserveUnknown: valuesField?.['x-kubernetes-preserve-unknown-fields'] === true,
    });

    // After server-side apply, use JSON patch via ApiextensionsV1Api to ensure
    // the x-kubernetes-preserve-unknown-fields annotation is applied.
    // This is needed because server-side apply may not properly merge deeply nested schema fields.
    // Only call this for CRDs that are known to have fields needing the fix (e.g., HelmRelease)
    const crdsNeedingPatch = [
      'helmreleases.helm.toolkit.fluxcd.io',
      'kustomizations.kustomize.toolkit.fluxcd.io',
    ];
    if (kubeConfig && crdsNeedingPatch.includes(crdName)) {
      await applyCRDSchemaJsonPatch(kubeConfig, crd, crdPatchTimeout);
    }
  } catch (error: unknown) {
    const statusCode = getErrorStatusCode(error);
    const errDetails = isKubernetesError(error) ? error : undefined;

    if (statusCode === 404) {
      // CRD doesn't exist, create it
      logger.debug('CRD not found, creating', { crdName });
      await kubernetesApi.create(manifest);
      logger.info('Created CRD with schema fix', { crdName });
    } else if (statusCode === 422) {
      // Validation error - this might happen if there are stored versions
      // that can't be updated. Log and continue.
      logger.warn('CRD validation error during server-side apply — falling back to existing CRD', {
        crdName,
        statusCode,
        message:
          errDetails?.body?.message ?? (error instanceof Error ? error.message : String(error)),
        note: 'This may happen if the CRD has stored versions that cannot be updated. The existing CRD will be used as-is, which may cause field stripping if the schema is incomplete.',
      });
    } else {
      logger.error(
        'Failed to apply CRD with schema fix',
        error instanceof Error ? error : new Error(String(error)),
        {
          crdName,
          statusCode,
        }
      );
      throw error;
    }
  }
}

/**
 * Apply JSON patch to CRD schema using ApiextensionsV1Api
 *
 * This function uses the proper ApiextensionsV1Api to apply JSON patches to CRDs,
 * which correctly handles the deeply nested schema fields.
 *
 * @param kubeConfig - Kubernetes configuration
 * @param crd - The CRD manifest with the desired schema
 */
async function applyCRDSchemaJsonPatch(
  kubeConfig: k8s.KubeConfig,
  crd: any,
  timeout: number = 30000
): Promise<void> {
  const crdName = crd.metadata?.name || 'unknown';

  logger.debug('Starting JSON patch for CRD schema', { crdName });

  const apiextensionsApi = createBunCompatibleApiextensionsV1Api(kubeConfig);

  try {
    // Read the current CRD from the cluster to check what needs patching
    logger.debug('Reading current CRD from cluster', { crdName });
    const currentCrd = await apiextensionsApi.readCustomResourceDefinition({ name: crdName });
    logger.debug('Read current CRD successfully', { crdName });

    // Generate patches based on what the current CRD is missing
    const patches: any[] = [];
    const versions = (currentCrd as any).spec?.versions || [];

    for (let i = 0; i < versions.length; i++) {
      const version = versions[i];
      if (version.schema?.openAPIV3Schema) {
        const basePath = `/spec/versions/${i}/schema/openAPIV3Schema`;
        patches.push(...generateSchemaFixPatches(version.schema.openAPIV3Schema, basePath));
      }
    }

    if (patches.length === 0) {
      logger.debug('No JSON patches needed for CRD schema', { crdName });
      return;
    }

    logger.info('Applying JSON patch to CRD schema', {
      crdName,
      patchCount: patches.length,
      patches: patches.map((p) => p.path),
    });

    // Apply the patches using JSON Patch via ApiextensionsV1Api
    // Use a timeout to prevent hanging
    const patchPromise = apiextensionsApi.patchCustomResourceDefinition({
      name: crdName,
      body: patches,
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`JSON patch timed out after ${timeout}ms`)),
        timeout
      );
    });

    try {
      await Promise.race([patchPromise, timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }

    logger.info('CRD schema patched successfully', { crdName, patchCount: patches.length });
  } catch (error: unknown) {
    // Log but don't fail - the CRD may still work
    logger.warn('Failed to apply JSON patch to CRD schema', {
      crdName,
      error: error instanceof Error ? error.message : String(error),
      note: 'The CRD may still work, but values might be stripped',
    });
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
  /**
   * Timeout in milliseconds for CRD JSON-patch operations.
   * Only relevant when deploying CRD manifests with `serverSideApply` strategy,
   * where a follow-up JSON patch is applied to ensure schema fields like
   * `x-kubernetes-preserve-unknown-fields` are set correctly.
   * @default 30000
   */
  crdPatchTimeout?: number;
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
                  config.forceConflicts || false,
                  deploymentContext.kubeConfig,
                  config.crdPatchTimeout
                );
              } else {
                await deploymentContext.kubernetesApi.create(manifest);
              }
            } else {
              throw new ResourceGraphFactoryError(
                'No Kubernetes API available for YAML deployment',
                config.name,
                'deployment'
              );
            }
          } else if (deploymentContext.kubernetesApi) {
            if (strategy === 'serverSideApply') {
              await applyWithServerSideApply(
                deploymentContext.kubernetesApi,
                manifest,
                config.fieldManager || 'typekro',
                config.forceConflicts || false,
                deploymentContext.kubeConfig,
                config.crdPatchTimeout
              );
            } else {
              await deploymentContext.kubernetesApi.create(manifest);
            }
          } else {
            throw new ResourceGraphFactoryError(
              'No deployment method available: neither alchemyScope nor kubernetesApi provided',
              config.name,
              'deployment'
            );
          }

          results.push({
            kind: manifest.kind || 'Unknown',
            name: manifest.metadata?.name || 'unknown',
            namespace: manifest.metadata?.namespace || undefined,
            apiVersion: manifest.apiVersion || 'v1',
          });
        } catch (error: unknown) {
          // Extract status code from various error formats
          const errorMessage = error instanceof Error ? error.message : String(error);
          const statusCode =
            getErrorStatusCode(error) ||
            (errorMessage.includes('HTTP-Code: 409') ? 409 : undefined);

          // Handle conflicts (409) based on deployment strategy
          // Note: 422 validation errors are NOT handled here - they should fail hard
          // as they indicate a real problem with the manifest
          if (statusCode === 409) {
            const resourceName = `${manifest.kind}/${manifest.metadata?.name}`;

            if (strategy === 'skipIfExists') {
              logger.info('Skipping existing resource (409 conflict)', { resourceName, strategy });
              results.push({
                kind: manifest.kind || 'Unknown',
                name: manifest.metadata?.name || 'unknown',
                namespace: manifest.metadata?.namespace || undefined,
                apiVersion: manifest.apiVersion || 'v1',
              });
            } else if (strategy === 'replace') {
              logger.info('Replacing existing resource (409 conflict)', { resourceName, strategy });
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
                  } catch (error: unknown) {
                    // If it's a 404, the resource doesn't exist
                    if (getErrorStatusCode(error) !== 404) {
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
                logger.error(
                  'Failed to replace resource',
                  replaceError instanceof Error ? replaceError : undefined,
                  { resourceName }
                );
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
