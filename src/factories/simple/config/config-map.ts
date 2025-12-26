/**
 * Simple ConfigMap Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes ConfigMap resources with sensible defaults.
 */

import type { Enhanced } from '../../../core/types.js';
import { configMap } from '../../kubernetes/config/config-map.js';
import type { ConfigMapConfig } from '../types.js';

// ConfigMaps don't have a spec field in Kubernetes - data is at the root level
// We use an empty spec type to match the base factory
type ConfigMapSpec = {}

type ConfigMapStatus = {}

/**
 * Creates a simple ConfigMap with sensible defaults
 *
 * Note: ConfigMaps don't have a spec field in Kubernetes. The data, binaryData,
 * and immutable fields are at the root level of the resource.
 *
 * @param config - Configuration for the config map
 * @returns Enhanced ConfigMap resource
 */
export function ConfigMap(config: ConfigMapConfig): Enhanced<ConfigMapSpec, ConfigMapStatus> {
  return configMap({
    ...(config.id && { id: config.id }),
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
    },
    data: config.data,
  });
}
