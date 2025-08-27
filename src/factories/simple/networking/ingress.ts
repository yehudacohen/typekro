/**
 * Simple Ingress Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes Ingress resources with sensible defaults.
 */

import type { Enhanced } from '../../../core/types.js';
import { ingress } from '../../kubernetes/networking/ingress.js';
import type { V1IngressSpec } from '../../kubernetes/types.js';
import type { IngressConfig } from '../types.js';

/**
 * Creates a simple Ingress with sensible defaults
 *
 * @param config - Configuration for the ingress
 * @returns Enhanced Ingress resource
 */
export function Ingress(config: IngressConfig): Enhanced<V1IngressSpec, any> {
  return ingress({
    ...(config.id && { id: config.id }),
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
      ...(config.annotations && { annotations: config.annotations }),
    },
    spec: {
      ...(config.ingressClassName && { ingressClassName: config.ingressClassName }),
      ...(config.rules && { rules: config.rules }),
      ...(config.tls && { tls: config.tls }),
    },
  });
}
