/**
 * Simple Service Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes Service resources with sensible defaults.
 */

import type { Enhanced } from '../../../core/types.js';
import { service } from '../../kubernetes/networking/service.js';
import type { V1ServiceSpec, V1ServiceStatus } from '../../kubernetes/types.js';
import type { ServiceConfig } from '../types.js';

/**
 * Creates a simple Service with sensible defaults
 *
 * @param config - Configuration for the service
 * @returns Enhanced Service resource
 */
export function Service(config: ServiceConfig): Enhanced<V1ServiceSpec, V1ServiceStatus> {
  return service({
    ...(config.id && { id: config.id }),
    metadata: { name: config.name, ...(config.namespace && { namespace: config.namespace }) },
    spec: {
      selector: config.selector,
      ports: config.ports,
      ...(config.type && { type: config.type }),
      ipFamilies: ['IPv4'],
      ipFamilyPolicy: 'SingleStack',
    },
  });
}
