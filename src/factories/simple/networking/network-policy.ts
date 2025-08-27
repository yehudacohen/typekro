/**
 * Simple NetworkPolicy Factory
 *
 * This module provides a simplified factory function for creating
 * Kubernetes NetworkPolicy resources with sensible defaults.
 */

import type { Enhanced } from '../../../core/types.js';
import { networkPolicy } from '../../kubernetes/networking/network-policy.js';
import type { V1NetworkPolicySpec } from '../../kubernetes/types.js';
import type { NetworkPolicyConfig } from '../types.js';

/**
 * Creates a simple NetworkPolicy with sensible defaults
 *
 * @param config - Configuration for the network policy
 * @returns Enhanced NetworkPolicy resource
 */
export function NetworkPolicy(config: NetworkPolicyConfig): Enhanced<V1NetworkPolicySpec, any> {
  return networkPolicy({
    ...(config.id && { id: config.id }),
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: { app: config.name },
    },
    spec: {
      podSelector: config.podSelector,
      ...(config.policyTypes && { policyTypes: config.policyTypes }),
      ...(config.ingress && { ingress: config.ingress }),
      ...(config.egress && { egress: config.egress }),
    },
  });
}
