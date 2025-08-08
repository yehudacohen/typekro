/**
 * External reference support for Kro Factory Pattern
 *
 * This module provides functionality to create external references to CRD instances
 * for composition between ResourceGraphDefinitions.
 */

import { createResource } from '../../factories/shared.js';
import type { Enhanced, KubernetesResource } from '../types.js';

/**
 * Create external reference to CRD instance for composition between ResourceGraphDefinitions
 *
 * @param apiVersion - API version of the external CRD
 * @param kind - Kind of the external CRD
 * @param instanceName - Name of the CRD instance to reference
 * @param namespace - Optional namespace of the CRD instance
 * @returns Enhanced proxy that can be used in resource templates
 *
 * @example
 * ```typescript
 * // Reference an external database instance
 * const database = externalRef<DatabaseSpec, DatabaseStatus>(
 *   'v1alpha1',
 *   'Database',
 *   'production-db'
 * );
 *
 * // Use in resource template
 * const webapp = simpleDeployment({
 *   name: 'webapp',
 *   image: 'nginx',
 *   env: {
 *     DATABASE_URL: database.status.connectionString
 *   }
 * });
 * ```
 */
export function externalRef<TSpec extends object, TStatus extends object>(
  apiVersion: string,
  kind: string,
  instanceName: string,
  namespace?: string
): Enhanced<TSpec, TStatus> {
  // Create a KubernetesResource marked as external reference
  const resource: KubernetesResource<TSpec, TStatus> = {
    apiVersion,
    kind,
    metadata: {
      name: instanceName,
      ...(namespace && { namespace }),
    },
    spec: {} as TSpec,
    status: {} as TStatus,
    // Mark this as an external reference for serialization
    __externalRef: true,
  };

  // Use existing createResource function to get Enhanced proxy
  return createResource(resource);
}
