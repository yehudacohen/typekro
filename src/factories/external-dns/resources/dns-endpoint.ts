/**
 * External-DNS DNSEndpoint Resource Factory
 * 
 * Factory function for creating DNSEndpoint resources for explicit DNS record management
 * instead of relying on annotations.
 */

import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

function dnsEndpointReadinessEvaluator(resource: unknown) {
  const status = (resource as { status?: { observedGeneration?: unknown } } | null | undefined)
    ?.status;

  if (!status) {
    return {
      ready: false,
      message: 'DNSEndpoint status not available yet',
    };
  }

  const hasObservedGeneration = status.observedGeneration !== undefined;

  return {
    ready: hasObservedGeneration,
    message: hasObservedGeneration
      ? 'DNSEndpoint has been processed by external-dns'
      : 'DNSEndpoint waiting to be processed by external-dns',
  };
}

registerPortableReadinessEvaluator(
  'typekro.readiness.external-dns.dns-endpoint',
  '1',
  dnsEndpointReadinessEvaluator
);

/**
 * DNSEndpoint spec configuration
 */
export interface DNSEndpointSpec {
  endpoints: Array<{
    dnsName: string;
    recordType: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'NS' | 'SRV';
    targets: string[];
    recordTTL?: number;
    labels?: Record<string, string>;
    providerSpecific?: Array<{
      name: string;
      value: string;
    }>;
  }>;
}

/**
 * DNSEndpoint status
 */
export interface DNSEndpointStatus {
  observedGeneration?: number;
}

/**
 * Configuration for DNSEndpoint resource
 */
export interface DNSEndpointConfig {
  name: string;
  namespace?: string;
  dnsName: string;
  recordType?: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'NS' | 'SRV';
  targets: string[];
  recordTTL?: number;
  labels?: Record<string, string>;
  providerSpecific?: Array<{
    name: string;
    value: string;
  }>;
  id?: string;
}

/**
 * Creates a DNSEndpoint resource for explicit DNS record management
 * 
 * @param config - DNSEndpoint configuration
 * @returns Enhanced DNSEndpoint resource
 */
export function dnsEndpoint(config: DNSEndpointConfig): Enhanced<DNSEndpointSpec, DNSEndpointStatus> {
  return createResource<DNSEndpointSpec, DNSEndpointStatus>({
    apiVersion: 'externaldns.k8s.io/v1alpha1',
    kind: 'DNSEndpoint',
    metadata: {
      name: config.name,
      namespace: config.namespace || 'default',
      ...(config.labels && { labels: config.labels }),
    },
    spec: {
      endpoints: [{
        dnsName: config.dnsName,
        recordType: config.recordType || 'A',
        targets: config.targets,
        recordTTL: config.recordTTL || 300,
        ...(config.labels && { labels: config.labels }),
        ...(config.providerSpecific && { providerSpecific: config.providerSpecific }),
      }]
    },
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(dnsEndpointReadinessEvaluator);
}
