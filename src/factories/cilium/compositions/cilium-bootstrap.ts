/**
 * Cilium Bootstrap Composition
 *
 * This module provides the main bootstrap composition for deploying Cilium
 * via Helm with comprehensive configuration options and status outputs.
 */

import { type } from 'arktype';
import { kubernetesComposition } from '../../../index.js';
import type { CiliumBootstrapConfig } from '../types.js';
import { ciliumHelmRepository, ciliumHelmRelease, mapCiliumConfigToHelmValues } from '../resources/helm.js';

// =============================================================================
// ARKTYPE SCHEMAS
// =============================================================================

/**
 * ArkType schema for Cilium bootstrap configuration
 * Using nested structure compatible with KroCompatibleType
 */
export const CiliumBootstrapSpecSchema = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  cluster: {
    name: 'string',
    id: 'number',
  },
  'networking?': {
    'ipamMode?': '"kubernetes" | "cluster-pool" | "azure" | "aws-eni" | "crd"',
    'kubeProxyReplacement?': '"disabled" | "partial" | "strict"',
    'routingMode?': '"tunnel" | "native"',
    'tunnelProtocol?': '"vxlan" | "geneve"',
    'autoDirectNodeRoutes?': 'boolean',
  },
  'security?': {
    'encryptionEnabled?': 'boolean',
    'encryptionType?': '"wireguard" | "ipsec"',
    'policyEnforcement?': '"default" | "always" | "never"',
  },
  'bgp?': {
    'enabled?': 'boolean',
    'announceLoadBalancerIP?': 'boolean',
    'announcePodCIDR?': 'boolean',
  },
  'gatewayAPI?': {
    'enabled?': 'boolean',
  },
  'observability?': {
    'hubbleEnabled?': 'boolean',
    'hubbleRelayEnabled?': 'boolean',
    'hubbleUIEnabled?': 'boolean',
    'prometheusEnabled?': 'boolean',
  },
  'operator?': {
    'replicas?': 'number',
  },
});

/**
 * ArkType schema for Cilium bootstrap status
 * Using nested structure that's compatible with KroCompatibleType
 */
export const CiliumBootstrapStatusSchema = type({
  phase: '"Installing" | "Ready" | "Failed" | "Upgrading" | "Pending"',
  ready: 'boolean',
  version: 'string',
  agentReady: 'boolean',
  operatorReady: 'boolean',
  hubbleReady: 'boolean',
  encryptionEnabled: 'boolean',
  bgpEnabled: 'boolean',
  gatewayAPIEnabled: 'boolean',
  endpoints: {
    health: 'string',
    metrics: 'string',
    'hubbleMetrics?': 'string',
    'hubbleUI?': 'string',
  },
  cni: {
    configPath: 'string',
    socketPath: 'string',
    binPath: 'string',
  },
  networking: {
    ipamMode: 'string',
    kubeProxyReplacement: 'string',
    routingMode: 'string',
    'tunnelProtocol?': 'string',
  },
  security: {
    policyEnforcement: 'string',
    encryptionStatus: 'string',
    authenticationEnabled: 'boolean',
  },
  resources: {
    totalNodes: 'number',
    readyNodes: 'number',
    totalEndpoints: 'number',
    totalIdentities: 'number',
  },
});

// =============================================================================
// BOOTSTRAP COMPOSITION
// =============================================================================

/**
 * Cilium Bootstrap Composition
 *
 * Creates a complete Cilium deployment using Helm with comprehensive configuration
 * options and status outputs for integration with other systems.
 *
 * This composition deploys:
 * - HelmRepository for the Cilium chart repository
 * - HelmRelease for the Cilium deployment with mapped configuration values
 *
 * The status provides integration points including:
 * - Health and metrics endpoints
 * - CNI configuration paths
 * - Component readiness states
 * - Network and security configuration status
 *
 * @example
 * Basic Cilium deployment:
 * ```typescript
 * const cilium = ciliumBootstrap.deploy({
 *   name: 'cilium',
 *   cluster: { name: 'production', id: 1 },
 *   version: '1.18.1'
 * });
 * ```
 *
 * @example
 * Advanced configuration:
 * ```typescript
 * const cilium = ciliumBootstrap.deploy({
 *   name: 'cilium',
 *   cluster: { name: 'production', id: 1 },
 *   version: '1.18.1',
 *   networking: {
 *     kubeProxyReplacement: 'strict',
 *     routingMode: 'native'
 *   },
 *   security: {
 *     encryption: { enabled: true, type: 'wireguard' }
 *   },
 *   observability: {
 *     hubble: { enabled: true, relay: { enabled: true }, ui: { enabled: true } }
 *   }
 * });
 * ```
 */
/**
 * Cilium Bootstrap Composition
 *
 * Creates a complete Cilium deployment using Helm with comprehensive configuration
 * options and status outputs for integration with other systems.
 */
export const ciliumBootstrap = kubernetesComposition(
  {
    name: 'cilium-bootstrap',
    apiVersion: 'cilium.io/v1alpha1',
    kind: 'CiliumBootstrap',
    spec: CiliumBootstrapSpecSchema,
    status: CiliumBootstrapStatusSchema,
  },
  (spec) => {
    // Convert simplified spec to full CiliumBootstrapConfig structure
    const fullConfig: CiliumBootstrapConfig = {
      name: spec.name,
      cluster: spec.cluster,
      ...(spec.namespace && { namespace: spec.namespace }),
      ...(spec.version && { version: spec.version }),
      ...(spec.networking && {
        networking: {
          ...(spec.networking.ipamMode && { ipam: { mode: spec.networking.ipamMode } }),
          // Include kubeProxyReplacement for mapCiliumConfigToHelmValues to process
          ...(spec.networking.kubeProxyReplacement && { kubeProxyReplacement: spec.networking.kubeProxyReplacement }),
          ...(spec.networking.routingMode && { routingMode: spec.networking.routingMode }),
          ...(spec.networking.tunnelProtocol && { tunnelProtocol: spec.networking.tunnelProtocol }),
          ...(spec.networking.autoDirectNodeRoutes !== undefined && { autoDirectNodeRoutes: spec.networking.autoDirectNodeRoutes }),
        }
      }),
      ...(spec.security && {
        security: {
          ...((spec.security.encryptionEnabled !== undefined || spec.security.encryptionType) && {
            encryption: {
              ...(spec.security.encryptionEnabled !== undefined && { enabled: spec.security.encryptionEnabled }),
              ...(spec.security.encryptionType && { type: spec.security.encryptionType }),
            }
          }),
          ...(spec.security.policyEnforcement && { policyEnforcement: spec.security.policyEnforcement }),
        }
      }),
      ...(spec.bgp && {
        bgp: {
          ...(spec.bgp.enabled !== undefined && { enabled: spec.bgp.enabled }),
          ...((spec.bgp.announceLoadBalancerIP !== undefined || spec.bgp.announcePodCIDR !== undefined) && {
            announce: {
              ...(spec.bgp.announceLoadBalancerIP !== undefined && { loadbalancerIP: spec.bgp.announceLoadBalancerIP }),
              ...(spec.bgp.announcePodCIDR !== undefined && { podCIDR: spec.bgp.announcePodCIDR }),
            }
          }),
        }
      }),
      ...(spec.gatewayAPI && {
        gatewayAPI: {
          ...(spec.gatewayAPI.enabled !== undefined && { enabled: spec.gatewayAPI.enabled }),
        }
      }),
      ...(spec.observability && {
        observability: {
          ...((spec.observability.hubbleEnabled !== undefined || spec.observability.hubbleRelayEnabled !== undefined || spec.observability.hubbleUIEnabled !== undefined) && {
            hubble: {
              ...(spec.observability.hubbleEnabled !== undefined && { enabled: spec.observability.hubbleEnabled }),
              ...(spec.observability.hubbleRelayEnabled !== undefined && { relay: { enabled: spec.observability.hubbleRelayEnabled } }),
              ...(spec.observability.hubbleUIEnabled !== undefined && { ui: { enabled: spec.observability.hubbleUIEnabled } }),
            }
          }),
          ...(spec.observability.prometheusEnabled !== undefined && {
            prometheus: {
              enabled: spec.observability.prometheusEnabled,
            }
          }),
        }
      }),
      ...(spec.operator && {
        operator: {
          ...(spec.operator.replicas !== undefined && { replicas: spec.operator.replicas }),
        }
      }),
    };

    // Map configuration to Helm values
    const helmValues = mapCiliumConfigToHelmValues(fullConfig);

    // Create HelmRepository for Cilium charts
    const _helmRepository = ciliumHelmRepository({
      name: 'cilium-repo', // Use static name to avoid schema proxy issues
      namespace: spec.namespace || 'flux-system',
      id: 'helmRepository',
    });

    // Create HelmRelease for Cilium deployment
    const helmRelease = ciliumHelmRelease({
      name: spec.name,
      namespace: spec.namespace || 'kube-system',
      version: spec.version || '1.18.1',
      values: helmValues,
      repositoryName: 'cilium-repo', // Match the repository name
      repositoryNamespace: spec.namespace || 'flux-system',
      id: 'helmRelease',
    });

    // Return nested status matching the schema structure
    // Use direct resource references to generate CEL expressions
    return {
      // Overall status derived from HelmRelease - these will become CEL expressions
      phase: helmRelease.status.phase,
      ready: helmRelease.status.phase as any, // Cast to satisfy TypeScript, will become CEL expression
      version: spec.version || '1.18.1',

      // Component readiness based on HelmRelease status - these will become CEL expressions
      agentReady: helmRelease.status.phase as any, // Cast to satisfy TypeScript, will become CEL expression
      operatorReady: helmRelease.status.phase as any, // Cast to satisfy TypeScript, will become CEL expression
      hubbleReady: helmRelease.status.phase as any, // Cast to satisfy TypeScript, will become CEL expression

      // Feature status based on configuration and deployment state
      encryptionEnabled: spec.security?.encryptionEnabled || false,
      bgpEnabled: spec.bgp?.enabled || false,
      gatewayAPIEnabled: spec.gatewayAPI?.enabled || false,

      // Integration endpoints
      endpoints: {
        health: `http://cilium-agent.${spec.namespace || 'kube-system'}.svc.cluster.local:9879/healthz`,
        metrics: `http://cilium-agent.${spec.namespace || 'kube-system'}.svc.cluster.local:9962/metrics`,
        hubbleMetrics: spec.observability?.hubbleEnabled ? `http://hubble-metrics.${spec.namespace || 'kube-system'}.svc.cluster.local:9965/metrics` : undefined,
        hubbleUI: spec.observability?.hubbleUIEnabled ? `http://hubble-ui.${spec.namespace || 'kube-system'}.svc.cluster.local:12000` : undefined,
      },

      // CNI integration points
      cni: {
        configPath: '/etc/cni/net.d/05-cilium.conflist',
        socketPath: '/var/run/cilium/cilium.sock',
        binPath: '/opt/cni/bin',
      },

      // Network configuration status
      networking: {
        ipamMode: spec.networking?.ipamMode || 'kubernetes',
        kubeProxyReplacement: spec.networking?.kubeProxyReplacement || 'disabled',
        routingMode: spec.networking?.routingMode || 'tunnel',
        tunnelProtocol: spec.networking?.tunnelProtocol,
      },

      // Security status
      security: {
        policyEnforcement: spec.security?.policyEnforcement || 'default',
        encryptionStatus: spec.security?.encryptionType || 'none',
        authenticationEnabled: false,
      },

      // Resource counts (placeholders for runtime hydration)
      resources: {
        totalNodes: 0,
        readyNodes: 0,
        totalEndpoints: 0,
        totalIdentities: 0,
      },
    };
  }
);

