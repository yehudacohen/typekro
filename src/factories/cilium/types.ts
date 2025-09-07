/**
 * Cilium Ecosystem Type Definitions
 *
 * This module provides comprehensive type definitions for the Cilium ecosystem,
 * including bootstrap composition configuration, CRD factory interfaces,
 * and common types used across Cilium resources.
 */

import { TypeKroError } from '../../core/errors.js';

// =============================================================================
// BOOTSTRAP COMPOSITION TYPES
// =============================================================================

/**
 * Configuration interface for Cilium bootstrap composition
 */
export interface CiliumBootstrapConfig {
  // Basic configuration
  name: string;
  namespace?: string;
  version?: string;
  
  // Cluster configuration
  cluster: {
    name: string;
    id: number;
  };
  
  // Networking configuration
  networking?: {
    ipam?: {
      mode: 'kubernetes' | 'cluster-pool' | 'azure' | 'aws-eni' | 'crd';
      operator?: {
        clusterPoolIPv4PodCIDRList?: string[];
        clusterPoolIPv6PodCIDRList?: string[];
      };
    };
    kubeProxyReplacement?: 'disabled' | 'partial' | 'strict';
    routingMode?: 'tunnel' | 'native';
    tunnelProtocol?: 'vxlan' | 'geneve';
    autoDirectNodeRoutes?: boolean;
    endpointRoutes?: {
      enabled?: boolean;
    };
    hostServices?: {
      enabled?: boolean;
      protocols?: ('tcp' | 'udp')[];
    };
    nodePort?: {
      enabled?: boolean;
      range?: string;
    };
    externalIPs?: {
      enabled?: boolean;
    };
    hostPort?: {
      enabled?: boolean;
    };
    loadBalancer?: {
      algorithm?: 'random' | 'round_robin' | 'maglev';
      mode?: 'snat' | 'dsr' | 'hybrid';
      acceleration?: 'disabled' | 'native' | 'best-effort';
    };
  };
  
  // Security configuration
  security?: {
    encryption?: {
      enabled?: boolean;
      type?: 'wireguard' | 'ipsec';
      nodeEncryption?: boolean;
      wireguard?: {
        userspaceFallback?: boolean;
        persistentKeepalive?: number;
      };
      ipsec?: {
        interface?: string;
        mountPath?: string;
        keyFile?: string;
      };
    };
    authentication?: {
      enabled?: boolean;
      mutual?: {
        spire?: {
          enabled?: boolean;
          install?: boolean;
        };
      };
    };
    policyEnforcement?: 'default' | 'always' | 'never';
    policyAuditMode?: boolean;
  };
  
  // BGP configuration
  bgp?: {
    enabled?: boolean;
    announce?: {
      loadbalancerIP?: boolean;
      podCIDR?: boolean;
    };
  };
  
  // Gateway API configuration
  gatewayAPI?: {
    enabled?: boolean;
    secretsNamespace?: {
      create?: boolean;
      name?: string;
    };
  };
  
  // Observability configuration
  observability?: {
    hubble?: {
      enabled?: boolean;
      metrics?: {
        enabled?: string[];
        enableOpenMetrics?: boolean;
        port?: number;
      };
      relay?: {
        enabled?: boolean;
        replicas?: number;
      };
      ui?: {
        enabled?: boolean;
        replicas?: number;
        ingress?: {
          enabled?: boolean;
          hosts?: string[];
        };
      };
    };
    prometheus?: {
      enabled?: boolean;
      port?: number;
      serviceMonitor?: {
        enabled?: boolean;
      };
    };
  };
  
  // Operator configuration
  operator?: {
    replicas?: number;
    resources?: ResourceRequirements;
  };
  
  // Agent configuration
  agent?: {
    resources?: ResourceRequirements;
  };
  
  // Advanced configuration
  advanced?: {
    bpf?: {
      preallocateMaps?: boolean;
      mapDynamicSizeRatio?: number;
    };
    k8s?: {
      requireIPv4PodCIDR?: boolean;
      requireIPv6PodCIDR?: boolean;
    };
    cni?: {
      binPath?: string;
      confPath?: string;
    };
  };
  
  // Custom Helm values override
  customValues?: Record<string, any>;
  
  // TypeKro specific
  id?: string;
}

/**
 * Status interface for Cilium bootstrap composition
 */
export interface CiliumBootstrapStatus {
  // Overall status
  phase: 'Installing' | 'Ready' | 'Failed' | 'Upgrading';
  ready: boolean;
  version: string;
  
  // Component readiness
  agentReady: boolean;
  operatorReady: boolean;
  hubbleReady: boolean;
  
  // Feature status
  encryptionEnabled: boolean;
  bgpEnabled: boolean;
  gatewayAPIEnabled: boolean;
  clusterMeshReady: boolean;
  
  // Integration endpoints for other systems
  endpoints: {
    health: string;
    metrics: string;
    hubbleMetrics?: string;
    hubbleUI?: string;
  };
  
  // CNI integration points
  cni: {
    configPath: string;
    socketPath: string;
    binPath: string;
  };
  
  // Network configuration status
  networking: {
    ipamMode: string;
    kubeProxyReplacement: string;
    routingMode: string;
    tunnelProtocol?: string;
  };
  
  // Security status
  security: {
    policyEnforcement: string;
    encryptionStatus: string;
    authenticationEnabled: boolean;
  };
  
  // Resource counts and capacity
  resources: {
    totalNodes: number;
    readyNodes: number;
    totalEndpoints: number;
    totalIdentities: number;
  };
}

// =============================================================================
// CRD FACTORY CONFIGURATION INTERFACES
// =============================================================================

/**
 * Configuration interface for CiliumNetworkPolicy
 */
export interface CiliumNetworkPolicyConfig {
  name: string;
  namespace?: string;
  spec: {
    endpointSelector?: LabelSelector;
    ingress?: IngressRule[];
    egress?: EgressRule[];
    labels?: LabelSelector[];
  };
  id?: string;
}

/**
 * Configuration interface for CiliumClusterwideNetworkPolicy
 */
export interface CiliumClusterwideNetworkPolicyConfig {
  name: string;
  spec: {
    endpointSelector?: LabelSelector;
    nodeSelector?: LabelSelector;
    ingress?: IngressRule[];
    egress?: EgressRule[];
  };
  id?: string;
}

/**
 * Configuration interface for CiliumBGPClusterConfig
 */
export interface CiliumBGPClusterConfigConfig {
  name: string;
  spec: {
    nodeSelector?: LabelSelector;
    bgpInstances: BGPInstance[];
  };
  id?: string;
}

/**
 * Configuration interface for CiliumBGPPeeringPolicy (Legacy)
 */
export interface CiliumBGPPeeringPolicyConfig {
  name: string;
  spec: {
    nodeSelector?: LabelSelector;
    virtualRouters: VirtualRouter[];
  };
  id?: string;
}

/**
 * Configuration interface for CiliumBGPAdvertisement
 */
export interface CiliumBGPAdvertisementConfig {
  name: string;
  spec: {
    advertisements: Advertisement[];
  };
  id?: string;
}

/**
 * Configuration interface for CiliumLoadBalancerIPPool
 */
export interface CiliumLoadBalancerIPPoolConfig {
  name: string;
  spec: {
    cidrs: CIDRBlock[];
    serviceSelector?: ServiceSelector;
    disabled?: boolean;
  };
  id?: string;
}

/**
 * Configuration interface for CiliumL2AnnouncementPolicy
 */
export interface CiliumL2AnnouncementPolicyConfig {
  name: string;
  spec: {
    nodeSelector?: LabelSelector;
    serviceSelector?: ServiceSelector;
    loadBalancerIPs?: boolean;
    externalIPs?: boolean;
    interfaces?: string[];
  };
  id?: string;
}

/**
 * Configuration interface for CiliumGatewayClassConfig
 */
export interface CiliumGatewayClassConfigConfig {
  name: string;
  spec: {
    gatewayType?: 'dedicated' | 'shared';
    deployment?: {
      replicas?: number;
      resources?: ResourceRequirements;
    };
  };
  id?: string;
}

/**
 * Configuration interface for CiliumEnvoyConfig
 */
export interface CiliumEnvoyConfigConfig {
  name: string;
  namespace?: string;
  spec: {
    services?: ServiceReference[];
    backendServices?: BackendService[];
    resources: EnvoyResource[];
  };
  id?: string;
}

/**
 * Configuration interface for CiliumClusterwideEnvoyConfig
 */
export interface CiliumClusterwideEnvoyConfigConfig {
  name: string;
  spec: {
    services?: ServiceReference[];
    backendServices?: BackendService[];
    resources: EnvoyResource[];
  };
  id?: string;
}

/**
 * Configuration interface for CiliumEgressGatewayPolicy
 */
export interface CiliumEgressGatewayPolicyConfig {
  name: string;
  spec: {
    selectors: EndpointSelector[];
    destinationCIDRs: string[];
    excludedCIDRs?: string[];
    gatewayConfig: {
      nodeSelector: LabelSelector;
      interface?: string;
    };
  };
  id?: string;
}

/**
 * Configuration interface for CiliumLocalRedirectPolicy
 */
export interface CiliumLocalRedirectPolicyConfig {
  name: string;
  namespace?: string;
  spec: {
    redirectFrontend: LocalRedirectFrontend;
    redirectBackend: LocalRedirectBackend;
    skipRedirectFromBackend?: boolean;
  };
  id?: string;
}

/**
 * Configuration interface for CiliumCIDRGroup
 */
export interface CiliumCIDRGroupConfig {
  name: string;
  spec: {
    cidrs: CIDRBlock[];
  };
  id?: string;
}

// =============================================================================
// COMMON TYPES USED ACROSS CILIUM RESOURCES
// =============================================================================

/**
 * Kubernetes label selector
 */
export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: LabelSelectorRequirement[];
}

/**
 * Label selector requirement
 */
export interface LabelSelectorRequirement {
  key: string;
  operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
  values?: string[];
}

/**
 * Kubernetes resource requirements
 */
export interface ResourceRequirements {
  limits?: {
    cpu?: string;
    memory?: string;
  };
  requests?: {
    cpu?: string;
    memory?: string;
  };
}

/**
 * Endpoint selector for Cilium policies
 */
export interface EndpointSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: LabelSelectorRequirement[];
}

/**
 * Ingress rule for network policies
 */
export interface IngressRule {
  fromEndpoints?: EndpointSelector[];
  fromCIDR?: string[];
  fromCIDRSet?: CIDRRule[];
  fromEntities?: string[];
  fromGroups?: GroupSelector[];
  toPorts?: PortRule[];
  icmps?: ICMPRule[];
  authentication?: AuthenticationMode;
}

/**
 * Egress rule for network policies
 */
export interface EgressRule {
  toEndpoints?: EndpointSelector[];
  toCIDR?: string[];
  toCIDRSet?: CIDRRule[];
  toEntities?: string[];
  toGroups?: GroupSelector[];
  toFQDNs?: FQDNSelector[];
  toPorts?: PortRule[];
  icmps?: ICMPRule[];
  authentication?: AuthenticationMode;
}

/**
 * Port rule for network policies
 */
export interface PortRule {
  ports?: PortProtocol[];
  rules?: L7Rules;
}

/**
 * Port and protocol specification
 */
export interface PortProtocol {
  port?: string;
  protocol?: 'TCP' | 'UDP' | 'SCTP' | 'ANY';
}

/**
 * Layer 7 rules for network policies
 */
export interface L7Rules {
  http?: HTTPRule[];
  kafka?: KafkaRule[];
  dns?: DNSRule[];
  l7proto?: string;
  l7?: PortRuleL7[];
}

/**
 * HTTP rule for L7 policies
 */
export interface HTTPRule {
  method?: string;
  path?: string;
  host?: string;
  headers?: string[];
}

/**
 * Kafka rule for L7 policies
 */
export interface KafkaRule {
  role?: 'produce' | 'consume';
  topic?: string;
  clientID?: string;
}

/**
 * DNS rule for L7 policies
 */
export interface DNSRule {
  matchName?: string;
  matchPattern?: string;
}

/**
 * Generic L7 rule
 */
export interface PortRuleL7 {
  [key: string]: string;
}

/**
 * CIDR rule with optional generated fields
 */
export interface CIDRRule {
  cidr: string;
  except?: string[];
  generated?: boolean;
}

/**
 * Group selector for policies
 */
export interface GroupSelector {
  [key: string]: string;
}

/**
 * FQDN selector for egress policies
 */
export interface FQDNSelector {
  matchName?: string;
  matchPattern?: string;
}

/**
 * ICMP rule for network policies
 */
export interface ICMPRule {
  fields?: ICMPField[];
}

/**
 * ICMP field specification
 */
export interface ICMPField {
  family?: 'IPv4' | 'IPv6';
  type?: number;
  code?: number;
}

/**
 * Authentication mode for policies
 */
export interface AuthenticationMode {
  mode: 'required' | 'always' | 'never';
}

// =============================================================================
// BGP SPECIFIC TYPES
// =============================================================================

/**
 * BGP instance configuration
 */
export interface BGPInstance {
  name: string;
  localASN: number;
  routerID?: string;
  peers?: BGPPeer[];
}

/**
 * BGP peer configuration
 */
export interface BGPPeer {
  name: string;
  peerASN: number;
  peerAddress: string;
  peerPort?: number;
  multihop?: number;
  connectRetryTimeSeconds?: number;
  holdTimeSeconds?: number;
  keepAliveTimeSeconds?: number;
  gracefulRestart?: GracefulRestartConfig;
  families?: AddressFamily[];
}

/**
 * BGP graceful restart configuration
 */
export interface GracefulRestartConfig {
  enabled?: boolean;
  restartTimeSeconds?: number;
  staleRoutesTimeSeconds?: number;
}

/**
 * BGP address family
 */
export interface AddressFamily {
  afi: 'ipv4' | 'ipv6';
  safi: 'unicast' | 'multicast';
  advertisements?: {
    matchLabels?: Record<string, string>;
    matchExpressions?: LabelSelectorRequirement[];
  };
}

/**
 * Virtual router configuration (legacy BGP)
 */
export interface VirtualRouter {
  localASN: number;
  exportPodCIDR?: boolean;
  neighbors: BGPNeighbor[];
  serviceSelector?: ServiceSelector;
  podIPPoolSelector?: LabelSelector;
}

/**
 * BGP neighbor configuration (legacy)
 */
export interface BGPNeighbor {
  peerAddress: string;
  peerASN: number;
  peerPort?: number;
  holdTimeSeconds?: number;
  keepAliveTimeSeconds?: number;
  connectRetryTimeSeconds?: number;
  gracefulRestart?: {
    enabled?: boolean;
    restartTimeSeconds?: number;
  };
  families?: {
    ipv4?: {
      advertisements?: {
        matchLabels?: Record<string, string>;
      };
    };
    ipv6?: {
      advertisements?: {
        matchLabels?: Record<string, string>;
      };
    };
  };
}

/**
 * BGP advertisement configuration
 */
export interface Advertisement {
  advertisementType: 'PodCIDR' | 'CiliumPodIPPool' | 'CiliumLoadBalancerIPPool' | 'Service';
  selector?: LabelSelector;
  service?: {
    addresses?: ('ClusterIP' | 'ExternalIP' | 'LoadBalancerIP')[];
  };
  attributes?: {
    localPreference?: number;
    communities?: {
      standard?: string[];
      large?: string[];
    };
  };
}

// =============================================================================
// LOAD BALANCER TYPES
// =============================================================================

/**
 * CIDR block specification
 */
export interface CIDRBlock {
  cidr: string;
}

/**
 * Service selector for load balancer resources
 */
export interface ServiceSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: LabelSelectorRequirement[];
}

// =============================================================================
// GATEWAY API TYPES
// =============================================================================

/**
 * Service reference for Gateway API
 */
export interface ServiceReference {
  name: string;
  namespace?: string;
}

/**
 * Backend service configuration
 */
export interface BackendService {
  name: string;
  namespace?: string;
  ports?: string[];
}

/**
 * Envoy resource configuration
 */
export interface EnvoyResource {
  '@type': string;
  [key: string]: any;
}

// =============================================================================
// LOCAL REDIRECT POLICY TYPES
// =============================================================================

/**
 * Local redirect frontend configuration
 */
export interface LocalRedirectFrontend {
  addressMatcher: {
    ip: string;
    toPorts?: PortMatcher[];
  };
}

/**
 * Local redirect backend configuration
 */
export interface LocalRedirectBackend {
  localEndpointSelector: EndpointSelector;
  toPorts?: PortMatcher[];
}

/**
 * Port matcher for local redirect policies
 */
export interface PortMatcher {
  port: string;
  protocol?: 'TCP' | 'UDP';
  name?: string;
}

// =============================================================================
// STATUS AND READINESS TYPES
// =============================================================================

/**
 * Generic Cilium resource status
 */
export interface CiliumResourceStatus {
  conditions?: Condition[];
  state?: string;
  message?: string;
}

/**
 * Kubernetes condition
 */
export interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  lastTransitionTime?: string;
  reason?: string;
  message?: string;
}

/**
 * BGP session status
 */
export interface BGPSessionStatus {
  localASN: number;
  peerASN: number;
  peerAddress: string;
  sessionState: 'Idle' | 'Connect' | 'Active' | 'OpenSent' | 'OpenConfirm' | 'Established';
  uptimeNanoseconds?: number;
  keepAliveTimeSeconds?: number;
  opensSent?: number;
  opensReceived?: number;
  notificationsSent?: number;
  notificationsReceived?: number;
  updatesSent?: number;
  updatesReceived?: number;
}

/**
 * Readiness evaluation result
 */
export interface ReadinessResult {
  ready: boolean;
  message: string;
  details?: Record<string, any>;
  lastTransition?: string;
}

// =============================================================================
// HELM INTEGRATION TYPES
// =============================================================================

/**
 * Configuration interface for Cilium HelmRepository
 */
export interface CiliumHelmRepositoryConfig {
  name: string;
  namespace?: string;
  interval?: string;
  timeout?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  secretRef?: {
    name: string;
  };
  id?: string;
}

/**
 * Configuration interface for Cilium HelmRelease
 */
export interface CiliumHelmReleaseConfig {
  name: string;
  namespace?: string;
  version?: string;
  repositoryName: string;
  repositoryNamespace: string;
  interval?: string;
  timeout?: string;
  installTimeout?: string;
  upgradeTimeout?: string;
  replace?: boolean;
  createNamespace?: boolean;
  cleanupOnFail?: boolean;
  values?: Record<string, any>;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  id?: string;
}

/**
 * Cilium Helm values interface
 */
export interface CiliumHelmValues {
  // Cluster configuration
  cluster: {
    name: string;
    id: number;
  };
  
  // IPAM configuration
  ipam?: {
    mode?: 'kubernetes' | 'cluster-pool' | 'azure' | 'aws-eni' | 'crd';
    operator?: {
      clusterPoolIPv4PodCIDRList?: string[];
      clusterPoolIPv6PodCIDRList?: string[];
    };
  };
  
  // Networking configuration
  kubeProxyReplacement?: boolean | 'partial';
  routingMode?: 'tunnel' | 'native';
  tunnelProtocol?: 'vxlan' | 'geneve';
  autoDirectNodeRoutes?: boolean;
  endpointRoutes?: {
    enabled?: boolean;
  };
  hostServices?: {
    enabled?: boolean;
    protocols?: ('tcp' | 'udp')[];
  };
  nodePort?: {
    enabled?: boolean;
    range?: string;
  };
  externalIPs?: {
    enabled?: boolean;
  };
  hostPort?: {
    enabled?: boolean;
  };
  loadBalancer?: {
    algorithm?: 'random' | 'round_robin' | 'maglev';
    mode?: 'snat' | 'dsr' | 'hybrid';
    acceleration?: 'disabled' | 'native' | 'best-effort';
  };
  
  // Security configuration
  encryption?: {
    enabled?: boolean;
    type?: 'wireguard' | 'ipsec';
    nodeEncryption?: boolean;
    wireguard?: {
      userspaceFallback?: boolean;
      persistentKeepalive?: number;
    };
    ipsec?: {
      interface?: string;
      mountPath?: string;
      keyFile?: string;
    };
  };
  authentication?: {
    enabled?: boolean;
    mutual?: {
      spire?: {
        enabled?: boolean;
        install?: boolean;
      };
    };
  };
  policyEnforcement?: 'default' | 'always' | 'never';
  policyAuditMode?: boolean;
  
  // BGP configuration
  bgp?: {
    enabled?: boolean;
    announce?: {
      loadbalancerIP?: boolean;
      podCIDR?: boolean;
    };
  };
  
  // Gateway API configuration
  gatewayAPI?: {
    enabled?: boolean;
    secretsNamespace?: {
      create?: boolean;
      name?: string;
    };
  };
  
  // Observability configuration
  hubble?: {
    enabled?: boolean;
    metrics?: {
      enabled?: string[];
      enableOpenMetrics?: boolean;
      port?: number;
    };
    relay?: {
      enabled?: boolean;
      replicas?: number;
    };
    ui?: {
      enabled?: boolean;
      replicas?: number;
      ingress?: {
        enabled?: boolean;
        hosts?: string[];
      };
    };
  };
  prometheus?: {
    enabled?: boolean;
    port?: number;
    serviceMonitor?: {
      enabled?: boolean;
    };
  };
  
  // Operator configuration
  operator?: {
    replicas?: number;
    resources?: {
      limits?: {
        cpu?: string;
        memory?: string;
      };
      requests?: {
        cpu?: string;
        memory?: string;
      };
    };
  };
  
  // Agent configuration
  agent?: {
    resources?: {
      limits?: {
        cpu?: string;
        memory?: string;
      };
      requests?: {
        cpu?: string;
        memory?: string;
      };
    };
  };
  
  // Advanced configuration
  bpf?: {
    preallocateMaps?: boolean;
    mapDynamicSizeRatio?: number;
  };
  k8s?: {
    requireIPv4PodCIDR?: boolean;
    requireIPv6PodCIDR?: boolean;
  };
  cni?: {
    binPath?: string;
    confPath?: string;
  };
  
  // Allow additional custom values
  [key: string]: any;
}

// =============================================================================
// ERROR TYPES
// =============================================================================

/**
 * Cilium configuration validation error
 */
export class CiliumConfigurationError extends TypeKroError {
  constructor(
    message: string,
    public readonly configPath: string,
    public readonly validationErrors: string[]
  ) {
    super(`Cilium configuration error at ${configPath}: ${message}`, 'CILIUM_CONFIGURATION_ERROR', {
      configPath,
      validationErrors,
    });
    this.name = 'CiliumConfigurationError';
  }
}

/**
 * Cilium resource validation error
 */
export class CiliumResourceValidationError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceType: string,
    public readonly resourceName: string
  ) {
    super(`Cilium ${resourceType} validation error for ${resourceName}: ${message}`, 'CILIUM_RESOURCE_VALIDATION_ERROR', {
      resourceType,
      resourceName,
    });
    this.name = 'CiliumResourceValidationError';
  }
}

/**
 * Cilium deployment error
 */
export class CiliumDeploymentError extends TypeKroError {
  constructor(
    message: string,
    public readonly phase: string,
    public readonly componentErrors: string[]
  ) {
    super(`Cilium deployment error in ${phase}: ${message}`, 'CILIUM_DEPLOYMENT_ERROR', {
      phase,
      componentErrors,
    });
    this.name = 'CiliumDeploymentError';
  }
}

/**
 * Cilium readiness evaluation error
 */
export class CiliumReadinessError extends TypeKroError {
  constructor(
    message: string,
    public readonly component: string,
    public readonly expectedState: string,
    public readonly actualState: string
  ) {
    super(`Cilium ${component} readiness error: expected ${expectedState}, got ${actualState}. ${message}`, 'CILIUM_READINESS_ERROR', {
      component,
      expectedState,
      actualState,
    });
    this.name = 'CiliumReadinessError';
  }
}