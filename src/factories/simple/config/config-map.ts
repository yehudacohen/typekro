/**
 * Simple ConfigMap Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes ConfigMap resources with sensible defaults.
 */

import { configMap } from '../../kubernetes/config/config-map.js';
import type { V1ConfigMapData } from '../../kubernetes/types.js';
import type { Enhanced } from '../../../core/types.js';
import type { ConfigMapConfig } from '../types.js';

/**
 * Creates a simple ConfigMap with sensible defaults
 *
 * @param config - Configuration for the config map
 * @returns Enhanced ConfigMap resource
 */
export function ConfigMap(
  config: ConfigMapConfig
): Enhanced<V1ConfigMapData, unknown> {
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