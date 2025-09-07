/**
 * Cilium Bootstrap Composition
 *
 * This module provides the main bootstrap composition for deploying Cilium
 * via Helm with comprehensive configuration options and status outputs.
 */

import { type } from 'arktype';
// TODO: Import Cilium Helm wrappers once implemented in task 2.1 and 2.2
// import { kubernetesComposition } from '../../../core/composition/imperative.js';
// import { Cel } from '../../../core/references/cel.js';
// import type { CiliumBootstrapConfig, CiliumBootstrapStatus } from '../types.js';
// TODO: Import Cilium Helm wrappers once implemented in task 2.1 and 2.2
// import { ciliumHelmRepository, ciliumHelmRelease, mapCiliumConfigToHelmValues } from '../resources/helm.js';

// =============================================================================
// ARKTYPE SCHEMAS
// =============================================================================

/**
 * ArkType schema for Cilium bootstrap configuration
 */
const _CiliumBootstrapSpecSchema = type({
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
const _CiliumBootstrapStatusSchema = type({
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
// TODO: Implement ciliumBootstrap composition once Helm wrappers are completed in tasks 2.1-2.3
/*
export const ciliumBootstrap = kubernetesComposition(
  {
    name: 'cilium-bootstrap',
    apiVersion: 'cilium.io/v1alpha1',
    kind: 'CiliumBootstrap',
    spec: CiliumBootstrapSpecSchema,
    status: CiliumBootstrapStatusSchema,
  },
  (spec) => {
    // Create HelmRepository for Cilium charts
    const helmRepository = ciliumHelmRepository({
      name: `${spec.name}-repo`,
      namespace: spec.namespace || 'flux-system',
      id: 'helmRepository',
    });

    // Map configuration to Helm values
    const helmValues = mapCiliumConfigToHelmValues(spec as CiliumBootstrapConfig);

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

    // Return comprehensive status with CEL expressions for integration
    return {
      // Overall status derived from HelmRelease with sophisticated CEL expressions
      phase: Cel.conditional(
        Cel.expr(helmRelease.status.phase, ' == "Ready"'),
        'Ready',
        Cel.conditional(
          Cel.expr(helmRelease.status.phase, ' == "Installing"'),
          'Installing',
          Cel.conditional(
            Cel.expr(helmRelease.status.phase, ' == "Upgrading"'),
            'Upgrading',
            Cel.conditional(
              Cel.expr(helmRelease.status.phase, ' == "Failed"'),
              'Failed',
              'Installing'
            )
          )
        )
      ),
      
      ready: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),
      version: spec.version || '1.18.1',

      // Component readiness with CEL expressions for actual Cilium components
      agentReady: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),
      operatorReady: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),
      hubbleReady: spec.observability?.hubble?.enabled === true ? 
        Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"') : true,

      // Feature status based on configuration
      encryptionEnabled: spec.security?.encryption?.enabled === true,
      bgpEnabled: spec.bgp?.enabled === true,
      gatewayAPIEnabled: spec.gatewayAPI?.enabled === true,
      clusterMeshReady: Cel.expr<boolean>(helmRelease.status.phase, ' == "Ready"'),

      // Integration endpoints for other systems with dynamic namespace support
      endpoints: {
        health: Cel.template('http://cilium-agent.%s.svc.cluster.local:9879/healthz', 
          spec.namespace || 'kube-system'),
        metrics: Cel.template('http://cilium-agent.%s.svc.cluster.local:9962/metrics',
          spec.namespace || 'kube-system'),
        hubbleMetrics: spec.observability?.hubble?.enabled === true ? 
          Cel.template('http://hubble-metrics.%s.svc.cluster.local:9965/metrics',
            spec.namespace || 'kube-system') : undefined,
        hubbleUI: spec.observability?.hubble?.ui?.enabled === true ?
          Cel.template('http://hubble-ui.%s.svc.cluster.local:12000',
            spec.namespace || 'kube-system') : undefined,
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
        tunnelProtocol: spec.networking?.tunnelProtocol,
      },

      // Security status with dynamic encryption status
      security: {
        policyEnforcement: spec.security?.policyEnforcement || 'default',
        encryptionStatus: spec.security?.encryption?.enabled === true ? 
          (spec.security.encryption.type || 'wireguard') : 'disabled',
        authenticationEnabled: spec.security?.authentication?.enabled === true,
      },

      // Resource counts (these would be populated by actual cluster state in real deployment)
      // In a real implementation, these would use CEL expressions to query actual Cilium status
      resources: {
        totalNodes: 0, // Would be: Cel.expr<number>('cilium_nodes_total')
        readyNodes: 0, // Would be: Cel.expr<number>('cilium_nodes_ready')
        totalEndpoints: 0, // Would be: Cel.expr<number>('cilium_endpoints_total')
        totalIdentities: 0, // Would be: Cel.expr<number>('cilium_identities_total')
      },
    };
  }
);
*/

// Placeholder export until implementation is complete
export const __ciliumBootstrapPlaceholder = true;