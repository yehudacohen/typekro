/**
 * Cilium Bootstrap Composition
 *
 * This module provides the main bootstrap composition for deploying Cilium
 * via Helm with comprehensive configuration options and status outputs.
 */

import { type } from 'arktype';
import { kubernetesComposition } from '../../../index.js';
import type { CiliumBootstrapConfig, CiliumBootstrapStatus } from '../types.js';
import { ciliumHelmRepository, ciliumHelmRelease, mapCiliumConfigToHelmValues } from '../resources/helm.js';

// =============================================================================
// ARKTYPE SCHEMAS
// =============================================================================

/**
 * ArkType schema for Cilium bootstrap configuration
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
    'ipam?': {
      'mode?': '"kubernetes" | "cluster-pool" | "azure" | "aws-eni" | "crd"',
      'operator?': {
        'clusterPoolIPv4PodCIDRList?': 'string[]',
        'clusterPoolIPv6PodCIDRList?': 'string[]',
      },
    },
    'kubeProxyReplacement?': '"disabled" | "partial" | "strict"',
    'routingMode?': '"tunnel" | "native"',
    'tunnelProtocol?': '"vxlan" | "geneve"',
    'autoDirectNodeRoutes?': 'boolean',
    'endpointRoutes?': {
      'enabled?': 'boolean',
    },
    'hostServices?': {
      'enabled?': 'boolean',
      'protocols?': '("tcp" | "udp")[]',
    },
    'nodePort?': {
      'enabled?': 'boolean',
      'range?': 'string',
    },
    'externalIPs?': {
      'enabled?': 'boolean',
    },
    'hostPort?': {
      'enabled?': 'boolean',
    },
    'loadBalancer?': {
      'algorithm?': '"random" | "round_robin" | "maglev"',
      'mode?': '"snat" | "dsr" | "hybrid"',
      'acceleration?': '"disabled" | "native" | "best-effort"',
    },
  },
  'security?': {
    'encryption?': {
      'enabled?': 'boolean',
      'type?': '"wireguard" | "ipsec"',
      'nodeEncryption?': 'boolean',
      'wireguard?': {
        'userspaceFallback?': 'boolean',
        'persistentKeepalive?': 'number',
      },
      'ipsec?': {
        'interface?': 'string',
        'mountPath?': 'string',
        'keyFile?': 'string',
      },
    },
    'authentication?': {
      'enabled?': 'boolean',
      'mutual?': {
        'spire?': {
          'enabled?': 'boolean',
          'install?': 'boolean',
        },
      },
    },
    'policyEnforcement?': '"default" | "always" | "never"',
    'policyAuditMode?': 'boolean',
  },
  'bgp?': {
    'enabled?': 'boolean',
    'announce?': {
      'loadbalancerIP?': 'boolean',
      'podCIDR?': 'boolean',
    },
  },
  'gatewayAPI?': {
    'enabled?': 'boolean',
    'secretsNamespace?': {
      'create?': 'boolean',
      'name?': 'string',
    },
  },
  'observability?': {
    'hubble?': {
      'enabled?': 'boolean',
      'metrics?': {
        'enabled?': 'string[]',
        'enableOpenMetrics?': 'boolean',
        'port?': 'number',
      },
      'relay?': {
        'enabled?': 'boolean',
        'replicas?': 'number',
      },
      'ui?': {
        'enabled?': 'boolean',
        'replicas?': 'number',
        'ingress?': {
          'enabled?': 'boolean',
          'hosts?': 'string[]',
        },
      },
    },
    'prometheus?': {
      'enabled?': 'boolean',
      'port?': 'number',
      'serviceMonitor?': {
        'enabled?': 'boolean',
      },
    },
  },
  'operator?': {
    'replicas?': 'number',
    'resources?': {
      'limits?': {
        'cpu?': 'string',
        'memory?': 'string',
      },
      'requests?': {
        'cpu?': 'string',
        'memory?': 'string',
      },
    },
  },
  'agent?': {
    'resources?': {
      'limits?': {
        'cpu?': 'string',
        'memory?': 'string',
      },
      'requests?': {
        'cpu?': 'string',
        'memory?': 'string',
      },
    },
  },
  'advanced?': {
    'bpf?': {
      'preallocateMaps?': 'boolean',
      'mapDynamicSizeRatio?': 'number',
    },
    'k8s?': {
      'requireIPv4PodCIDR?': 'boolean',
      'requireIPv6PodCIDR?': 'boolean',
    },
    'cni?': {
      'binPath?': 'string',
      'confPath?': 'string',
    },
  },
  'customValues?': 'Record<string, unknown>',
});

/**
 * ArkType schema for Cilium bootstrap status
 */
export const CiliumBootstrapStatusSchema = type({
  phase: '"Installing" | "Ready" | "Failed" | "Upgrading"',
  ready: 'boolean',
  version: 'string',
  agentReady: 'boolean',
  operatorReady: 'boolean',
  hubbleReady: 'boolean',
  encryptionEnabled: 'boolean',
  bgpEnabled: 'boolean',
  gatewayAPIEnabled: 'boolean',
  clusterMeshReady: 'boolean',
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
    // Map configuration to Helm values
    const helmValues = mapCiliumConfigToHelmValues(spec as CiliumBootstrapConfig);

    // Create HelmRepository for Cilium charts
    const helmRepository = ciliumHelmRepository({
      name: `${spec.name}-repo`,
      namespace: spec.namespace || 'flux-system',
      id: 'helmRepository',
    });

    // Create HelmRelease for Cilium deployment
    const helmRelease = ciliumHelmRelease({
      name: spec.name,
      namespace: spec.namespace || 'kube-system',
      version: spec.version || '1.18.1',
      values: helmValues,
      repositoryName: `${spec.name}-repo`,
      repositoryNamespace: spec.namespace || 'flux-system',
      id: 'helmRelease',
    });

    // Return comprehensive status with natural JavaScript expressions
    // These will be automatically converted to CEL expressions
    return {
      // Overall status derived from HelmRelease
      phase: helmRelease.status.phase === 'Ready' ? 'Ready' : 
             helmRelease.status.phase === 'Installing' ? 'Installing' :
             helmRelease.status.phase === 'Upgrading' ? 'Upgrading' :
             helmRelease.status.phase === 'Failed' ? 'Failed' : 'Installing',
      
      ready: helmRelease.status.phase === 'Ready',
      version: spec.version || '1.18.1',

      // Component readiness based on HelmRelease status
      agentReady: helmRelease.status.phase === 'Ready',
      operatorReady: helmRelease.status.phase === 'Ready',
      hubbleReady: spec.observability?.hubble?.enabled === true ? 
        helmRelease.status.phase === 'Ready' : true,

      // Feature status based on configuration
      encryptionEnabled: spec.security?.encryption?.enabled === true,
      bgpEnabled: spec.bgp?.enabled === true,
      gatewayAPIEnabled: spec.gatewayAPI?.enabled === true,
      clusterMeshReady: helmRelease.status.phase === 'Ready',

      // Integration endpoints for other systems
      endpoints: {
        health: `http://cilium-agent.${spec.namespace || 'kube-system'}.svc.cluster.local:9879/healthz`,
        metrics: `http://cilium-agent.${spec.namespace || 'kube-system'}.svc.cluster.local:9962/metrics`,
        hubbleMetrics: spec.observability?.hubble?.enabled === true ? 
          `http://hubble-metrics.${spec.namespace || 'kube-system'}.svc.cluster.local:9965/metrics` : 
          'disabled',
        hubbleUI: spec.observability?.hubble?.ui?.enabled === true ?
          `http://hubble-ui.${spec.namespace || 'kube-system'}.svc.cluster.local:12000` :
          'disabled',
      },

      // CNI integration points with configurable paths
      cni: {
        configPath: spec.advanced?.cni?.confPath || '/etc/cni/net.d/05-cilium.conflist',
        socketPath: '/var/run/cilium/cilium.sock',
        binPath: spec.advanced?.cni?.binPath || '/opt/cni/bin',
      },

      // Network configuration status reflecting actual configuration
      networking: {
        ipamMode: spec.networking?.ipam?.mode || 'kubernetes',
        kubeProxyReplacement: spec.networking?.kubeProxyReplacement || 'disabled',
        routingMode: spec.networking?.routingMode || 'tunnel',
        tunnelProtocol: spec.networking?.tunnelProtocol || 'vxlan',
      },

      // Security status with dynamic encryption status
      security: {
        policyEnforcement: spec.security?.policyEnforcement || 'default',
        encryptionStatus: spec.security?.encryption?.enabled === true ? 
          (spec.security.encryption.type || 'wireguard') : 'disabled',
        authenticationEnabled: spec.security?.authentication?.enabled === true,
      },

      // Resource counts (static values that would be hydrated by readiness evaluators)
      resources: {
        totalNodes: 0,
        readyNodes: 0,
        totalEndpoints: 0,
        totalIdentities: 0,
      },
    };
  }
);

