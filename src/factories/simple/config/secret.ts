/**
 * Simple Secret Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes Secret resources with sensible defaults.
 */

import type { Enhanced } from '../../../core/types.js';
import { secret } from '../../kubernetes/config/secret.js';
import type { V1SecretData } from '../../kubernetes/types.js';
import type { SecretConfig } from '../types.js';

/**
 * Creates a simple Secret with sensible defaults
 *
 * @param config - Configuration for the secret
 * @returns Enhanced Secret resource
 */
export function Secret(config: SecretConfig): Enhanced<V1SecretData, unknown> {
  return secret({
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
    },
    stringData: config.stringData,
  });
}
