/**
 * Shared conflict handling logic for YAML resource deployment.
 *
 * Both `yamlFile` and `yamlDirectory` need identical 409-conflict resolution
 * when creating Kubernetes resources. This module extracts that pattern into
 * a single reusable function.
 */

import { ensureError } from '../../../core/errors.js';
import { getErrorStatusCode } from '../../../core/kubernetes/errors.js';
import { getComponentLogger } from '../../../core/logging/index.js';
import type { AppliedResource, DeploymentContext } from '../../../core/types/deployment.js';
import type { KubernetesResource } from '../../../core/types/kubernetes.js';

const logger = getComponentLogger('yaml-conflict-handler');

/** Strategies for handling 409 Conflict errors during resource creation. */
export type ConflictStrategy = 'replace' | 'skipIfExists' | 'fail';

/**
 * Build the {@link AppliedResource} record for a given manifest.
 */
function toAppliedResource(manifest: KubernetesResource): AppliedResource {
  return {
    kind: manifest.kind || 'Unknown',
    name: manifest.metadata?.name || 'unknown',
    namespace: manifest.metadata?.namespace || undefined,
    apiVersion: manifest.apiVersion || 'v1',
  };
}

/**
 * Handle a 409 Conflict error according to the chosen deployment strategy.
 *
 * @param error - The original caught error (must have status code 409).
 * @param manifest - The manifest that triggered the conflict.
 * @param strategy - The deployment strategy to apply.
 * @param deploymentContext - Provides access to the Kubernetes API client.
 * @returns The {@link AppliedResource} if the conflict was resolved, or
 *          re-throws if the strategy is `'fail'`.
 */
export async function handleConflict(
  error: unknown,
  manifest: KubernetesResource,
  strategy: ConflictStrategy,
  deploymentContext: DeploymentContext
): Promise<AppliedResource> {
  const resourceName = `${manifest.kind}/${manifest.metadata?.name}`;

  if (strategy === 'skipIfExists') {
    logger.info('Skipping existing resource (409 conflict)', { resourceName, strategy });
    return toAppliedResource(manifest);
  }

  if (strategy === 'replace') {
    logger.info('Replacing existing resource (409 conflict)', { resourceName, strategy });
    try {
      if (deploymentContext.kubernetesApi) {
        // Check if resource exists first
        let existing: unknown;
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
        } catch (readError: unknown) {
          // If it's a 404, the resource doesn't exist
          if (getErrorStatusCode(readError) !== 404) {
            throw readError;
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
      return toAppliedResource(manifest);
    } catch (replaceError: unknown) {
      logger.error('Failed to replace resource', ensureError(replaceError), {
        resourceName,
      });
      throw replaceError;
    }
  }

  // strategy === 'fail' (default behavior)
  throw error;
}
