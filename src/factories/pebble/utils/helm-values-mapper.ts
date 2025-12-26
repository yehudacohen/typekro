/**
 * Pebble Helm Values Mapper
 * 
 * Maps TypeKro Pebble configuration to Helm chart values format.
 * This ensures compatibility with the JupyterHub Pebble Helm chart structure.
 */

import type { PebbleBootstrapConfig, PebbleHelmValues } from '../types.js';

/**
 * Maps PebbleBootstrapConfig to Helm chart values format
 * 
 * @param config - TypeKro Pebble configuration
 * @returns Helm chart values compatible with JupyterHub Pebble chart
 */
export function mapPebbleConfigToHelmValues(config: PebbleBootstrapConfig): PebbleHelmValues {
  const values: PebbleHelmValues = {};

  // Map Pebble server configuration
  if (config.pebble) {
    values.pebble = {
      ...(config.pebble.image && { image: config.pebble.image }),
      ...(config.pebble.resources && { resources: config.pebble.resources }),
      ...(config.pebble.nodeSelector && { nodeSelector: config.pebble.nodeSelector }),
      ...(config.pebble.tolerations && { tolerations: config.pebble.tolerations }),
      ...(config.pebble.env && { env: config.pebble.env }),
      ...(config.pebble.config && { config: config.pebble.config }),
    };
  }

  // Map CoreDNS configuration
  if (config.coredns) {
    values.coredns = {
      ...(config.coredns.image && { image: config.coredns.image }),
      ...(config.coredns.resources && { resources: config.coredns.resources }),
      ...(config.coredns.nodeSelector && { nodeSelector: config.coredns.nodeSelector }),
      ...(config.coredns.tolerations && { tolerations: config.coredns.tolerations }),
      ...(config.coredns.corefileSegment && { corefileSegment: config.coredns.corefileSegment }),
    };
  }

  // Map service configuration
  if (config.service) {
    values.service = {
      ...(config.service.type && { type: config.service.type }),
      ...(config.service.port && { port: config.service.port }),
      ...(config.service.managementPort && { managementPort: config.service.managementPort }),
    };
  }

  // Map security configuration
  if (config.security?.rbac) {
    values.rbac = {
      ...(config.security.rbac.create !== undefined && { create: config.security.rbac.create }),
    };
  }

  if (config.security?.serviceAccount) {
    values.serviceAccount = {
      ...(config.security.serviceAccount.create !== undefined && { create: config.security.serviceAccount.create }),
      ...(config.security.serviceAccount.name && { name: config.security.serviceAccount.name }),
      ...(config.security.serviceAccount.annotations && { annotations: config.security.serviceAccount.annotations }),
    };
  }

  return values;
}

/**
 * Creates default Pebble configuration optimized for testing
 * 
 * @returns Default Pebble Helm values for fast testing
 */
export function createDefaultPebbleTestingValues(): PebbleHelmValues {
  return {
    pebble: {
      env: [
        // Speed up testing by disabling sleep between validation attempts
        { name: 'PEBBLE_VA_NOSLEEP', value: '1' },
        // Disable nonce rejection to avoid anti-replay errors in testing
        { name: 'PEBBLE_WFE_NONCEREJECT', value: '0' },
        // Allow authorization reuse for faster testing
        { name: 'PEBBLE_AUTHZREUSE', value: '100' },
      ],
      config: {
        pebble: {
          // Use standard ports for HTTP-01 and TLS-ALPN-01 challenges
          httpPort: 80,
          tlsPort: 443,
        },
      },
    },
    service: {
      type: 'ClusterIP',
      port: 443,        // HTTPS ACME API
      managementPort: 15000, // Management API
    },
    rbac: {
      create: true,
    },
    serviceAccount: {
      create: true,
    },
  };
}