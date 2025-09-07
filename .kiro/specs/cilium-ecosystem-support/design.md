# Cilium Ecosystem Support Design

## Overview

This design document outlines the implementation of comprehensive Cilium ecosystem support for TypeKro. The implementation follows the established factory ecosystem pattern and provides type-safe bootstrap compositions, CRD factory functions, and integration points for other systems. 

**IMPORTANT**: This design serves as a template for future ecosystem integrations (ArgoCD, Ory, Ray, External DNS, etc.). All patterns, quality gates, and testing requirements established here should be followed by future ecosystem implementations to ensure consistency and quality across the TypeKro ecosystem.

**NOTE**: This design document contains the ideal specification. Current implementation status and any deviations from this specification are documented separately in `current-implementation-status.md`. This separation ensures that the core specification remains clean and serves as an effective template for future implementations.

## Architecture

### Directory Structure

Following the established ecosystem pattern, Cilium support will be organized as:

```
src/factories/cilium/
├── index.ts                           # Main exports
├── types.ts                          # Type definitions
├── compositions/                     # Bootstrap compositions
│   ├── index.ts
│   └── cilium-bootstrap.ts          # Main bootstrap composition
└── resources/                       # CRD factory functions with embedded readiness evaluators
    ├── index.ts
    ├── helm.ts                     # Cilium-specific wrappers around existing Helm factories
    ├── networking.ts               # CiliumNetworkPolicy, CiliumClusterwideNetworkPolicy
    ├── bgp.ts                      # BGP-related CRDs
    ├── load-balancer.ts            # LoadBalancer IP pools and L2 announcements
    ├── gateway.ts                  # Gateway API and Envoy configuration
    ├── security.ts                # Security policies and configurations
    └── observability.ts            # Hubble and monitoring resources
```

**Key Design Principles:**
- **Reuse existing TypeKro factories** - wrap existing `helmRepository`, `helmRelease`, etc. with Cilium-specific configurations
- **Reuse existing readiness evaluators** - don't duplicate readiness logic that already exists in other factories
- **Provide typed wrappers** - add Cilium-specific type safety and configuration validation on top of existing factories
- **Bootstrap compositions rely on resource readiness** - they don't need separate readiness evaluators
- **End-to-end testing is integrated** throughout the implementation process

### Core Components

#### 1. Bootstrap Composition (`cilium-bootstrap.ts`)

The main bootstrap composition that deploys Cilium via Helm with comprehensive configuration options and status outputs for integration.

#### 2. CRD Factory Functions

Type-safe factory functions for all major Cilium CRDs, organized by functional area:

- **Networking**: Network policies and cluster-wide policies
- **BGP**: BGP peering, cluster config, node config, advertisements
- **Load Balancer**: IP pools, L2 announcements, egress gateways
- **Gateway**: Gateway API configuration, Envoy configs
- **Security**: Authentication, encryption, mutual TLS
- **Observability**: Hubble configuration and monitoring

#### 3. Helm Integration Wrappers

Cilium-specific wrappers around existing TypeKro Helm factories that provide:
- Cilium-specific default configurations (repository URL, chart name, etc.)
- Type-safe configuration interfaces for Cilium Helm values
- Validation specific to Cilium deployment requirements
- Reuse of existing Helm readiness evaluators

#### 4. Integration Status Outputs

CEL-based status expressions that expose Cilium's integration points for other systems to consume.

## Components and Interfaces

### Bootstrap Composition Interface

```typescript
interface CiliumBootstrapConfig {
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

interface CiliumBootstrapStatus {
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
```

### CRD Factory Interfaces

#### Networking Resources

```typescript
// CiliumNetworkPolicy
interface CiliumNetworkPolicyConfig {
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

// CiliumClusterwideNetworkPolicy
interface CiliumClusterwideNetworkPolicyConfig {
  name: string;
  spec: {
    endpointSelector?: LabelSelector;
    nodeSelector?: LabelSelector;
    ingress?: IngressRule[];
    egress?: EgressRule[];
  };
  id?: string;
}
```

#### BGP Resources

```typescript
// CiliumBGPClusterConfig
interface CiliumBGPClusterConfigConfig {
  name: string;
  spec: {
    nodeSelector?: LabelSelector;
    bgpInstances: BGPInstance[];
  };
  id?: string;
}

// CiliumBGPPeeringPolicy (Legacy)
interface CiliumBGPPeeringPolicyConfig {
  name: string;
  spec: {
    nodeSelector?: LabelSelector;
    virtualRouters: VirtualRouter[];
  };
  id?: string;
}

// CiliumBGPAdvertisement
interface CiliumBGPAdvertisementConfig {
  name: string;
  spec: {
    advertisements: Advertisement[];
  };
  id?: string;
}
```

#### Load Balancer Resources

```typescript
// CiliumLoadBalancerIPPool
interface CiliumLoadBalancerIPPoolConfig {
  name: string;
  spec: {
    cidrs: CIDRBlock[];
    serviceSelector?: ServiceSelector;
    disabled?: boolean;
  };
  id?: string;
}

// CiliumL2AnnouncementPolicy
interface CiliumL2AnnouncementPolicyConfig {
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
```

#### Gateway API Resources

```typescript
// CiliumGatewayClassConfig
interface CiliumGatewayClassConfigConfig {
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

// CiliumEnvoyConfig
interface CiliumEnvoyConfigConfig {
  name: string;
  namespace?: string;
  spec: {
    services?: ServiceReference[];
    backendServices?: BackendService[];
    resources: EnvoyResource[];
  };
  id?: string;
}
```

## Data Models

### Core Type Definitions

```typescript
// Common types used across Cilium resources
interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: LabelSelectorRequirement[];
}

interface LabelSelectorRequirement {
  key: string;
  operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
  values?: string[];
}

interface IngressRule {
  fromEndpoints?: EndpointSelector[];
  fromCIDR?: string[];
  fromCIDRSet?: CIDRRule[];
  fromEntities?: string[];
  fromGroups?: GroupSelector[];
  toPorts?: PortRule[];
  icmps?: ICMPRule[];
  authentication?: AuthenticationMode;
}

interface EgressRule {
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

interface PortRule {
  ports?: PortProtocol[];
  rules?: L7Rules;
}

interface PortProtocol {
  port?: string;
  protocol?: 'TCP' | 'UDP' | 'SCTP' | 'ANY';
}

// BGP specific types
interface BGPInstance {
  name: string;
  localASN: number;
  routerID?: string;
  peers?: BGPPeer[];
}

interface BGPPeer {
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

interface VirtualRouter {
  localASN: number;
  exportPodCIDR?: boolean;
  neighbors: BGPNeighbor[];
  serviceSelector?: ServiceSelector;
  podIPPoolSelector?: LabelSelector;
}

// Load balancer types
interface CIDRBlock {
  cidr: string;
}

interface ServiceSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: LabelSelectorRequirement[];
}

// Gateway API types
interface ServiceReference {
  name: string;
  namespace?: string;
}

interface BackendService {
  name: string;
  namespace?: string;
  ports?: string[];
}

interface EnvoyResource {
  '@type': string;
  [key: string]: any;
}
```

### Status Data Models

```typescript
// Status types for readiness evaluation
interface CiliumResourceStatus {
  conditions?: Condition[];
  state?: string;
  message?: string;
}

interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  lastTransitionTime?: string;
  reason?: string;
  message?: string;
}

interface BGPSessionStatus {
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
```

## Error Handling

### Validation Errors

```typescript
class CiliumConfigurationError extends TypeKroError {
  constructor(message: string, public configPath: string, public validationErrors: string[]) {
    super(`Cilium configuration error at ${configPath}: ${message}`);
  }
}

class CiliumResourceValidationError extends TypeKroError {
  constructor(message: string, public resourceType: string, public resourceName: string) {
    super(`Cilium ${resourceType} validation error for ${resourceName}: ${message}`);
  }
}
```

### Runtime Errors

```typescript
class CiliumDeploymentError extends TypeKroError {
  constructor(message: string, public phase: string, public componentErrors: string[]) {
    super(`Cilium deployment error in ${phase}: ${message}`);
  }
}

class CiliumReadinessError extends TypeKroError {
  constructor(message: string, public component: string, public expectedState: string, public actualState: string) {
    super(`Cilium ${component} readiness error: expected ${expectedState}, got ${actualState}. ${message}`);
  }
}
```

## Testing Strategy

### Quality Gates and Standards

**CRITICAL REQUIREMENTS**: Every task must meet these quality gates before being marked complete:

1. **TypeScript Compilation**: `bun run typecheck` must pass without errors
2. **Unit Tests**: All unit tests must pass with `bun test`
3. **Integration Tests**: All integration tests must pass with `bun run test:integration`
4. **Test Coverage**: New code must have comprehensive test coverage

### Test-Driven Development Approach

**Core Principle:** Every implementation task includes comprehensive testing as part of the task itself, not as a separate phase. Tests are written alongside implementation to ensure functionality works end-to-end.

### Unit Tests (Integrated with Implementation)

**Location**: `test/factories/cilium/` directory

1. **Factory Function Tests**
   - Test each factory function as it's implemented
   - Validate resource creation with various configurations
   - Test TypeScript type safety and compilation
   - Test wrapper functions properly delegate to generic factories
   - Validate configuration schema and default values

2. **Configuration Validation Tests**
   - Test schema validation for each configuration interface
   - Test error handling for invalid configurations
   - Test default value application and override behavior
   - Test TypeScript type checking and IDE experience

3. **Status Expression Tests**
   - Test CEL expression generation for each status field
   - Test status field mapping and serialization
   - Test integration endpoint exposure and accessibility
   - Validate cross-resource reference resolution

### Integration Tests (Per Implementation Task)

**Location**: `test/integration/cilium/` directory (NOT in unit test directories)
**Setup**: Use `scripts/e2e-setup.sh` for test cluster setup
**Execution**: Use `bun run test:integration` command

1. **Resource Integration Tests**
   - Test each resource with actual Kubernetes API calls
   - Test BOTH `kro` and `direct` factory patterns
   - **CRITICAL**: Use `.deploy()` method to actually deploy resources (not just factory creation)
   - Validate resource creation, update, and deletion
   - Test readiness evaluation with real resource states
   - Test cross-resource dependencies and references

2. **Composition Integration Tests**
   - Test bootstrap composition with real Helm deployments using `.deploy()` method
   - Validate complete Cilium installation and configuration
   - Test status reporting accuracy with live resources
   - Test factory pattern integration and reusability
   - **CRITICAL**: Test with `waitForReady: true` (no shortcuts)

3. **TypeKro Feature Integration Tests**
   - Test kubernetesComposition integration with each resource
   - Test toResourceGraph integration and serialization
   - Test direct deployment and Kro deployment strategies using `.deploy()` method
   - Test dependency resolution and resource ordering

### End-to-End Tests (Continuous Validation)

**Location**: `test/integration/cilium/` directory
**Setup**: Use `scripts/e2e-setup.sh` for test environment

1. **Live Cluster Tests**
   - Deploy actual Cilium installations in test clusters using `.deploy()` method
   - Validate network functionality and policy enforcement
   - Test BGP integration and load balancer functionality
   - Test Gateway API integration and traffic routing

2. **Application Integration Tests**
   - Deploy applications that use Cilium features
   - Test network policies with real traffic
   - Test service mesh and observability features
   - Validate monitoring and metrics collection

3. **Upgrade and Migration Tests**
   - Test Cilium version upgrades and rollbacks
   - Test configuration changes and updates
   - Test migration between different deployment modes
   - Validate backward compatibility and breaking changes

### Testing Anti-Patterns to Avoid

**NEVER**:
- Mark tasks complete without running integration tests
- Use `waitForReady: false` to make tests pass (fix the underlying issue)
- Create factories without testing actual deployment via `.deploy()` method
- Put integration tests in unit test directories
- Skip TypeScript compilation checks
- Test only factory creation without actual resource deployment

### Testing Infrastructure Requirements

1. **Test Cluster Management**
   - Use `scripts/e2e-setup.sh` for automated cluster setup
   - Automated test cluster provisioning and cleanup
   - Support for multiple Kubernetes versions
   - Isolated test environments for parallel testing
   - Resource cleanup and state management

2. **Test Data and Fixtures**
   - Comprehensive test configuration sets
   - Real-world scenario test cases
   - Error condition and edge case scenarios

3. **Continuous Integration**
   - Automated test execution on every change
   - Test result reporting and failure analysis
   - Functional validation with real deployments

## Implementation Phases

### Phase 1: Foundation with End-to-End Testing
- Set up directory structure and core types
- Implement Helm integration with embedded readiness evaluators
- Create comprehensive test infrastructure
- Validate basic deployment end-to-end

### Phase 2: Bootstrap Composition with Live Testing
- Implement complete bootstrap composition using kubernetesComposition
- Add comprehensive configuration schema and Helm values mapping
- Implement CEL-based status expressions for integration points
- Test with real Cilium deployments in test clusters

### Phase 3: Core CRD Factories with Integrated Testing
- Implement networking CRDs with embedded readiness evaluators
- Test each CRD with real Kubernetes API interactions
- Validate policy enforcement and network functionality
- Ensure seamless integration with existing TypeKro features

### Phase 4: Advanced CRD Factories with Application Testing
- Implement BGP, load balancer, and Gateway API CRDs
- Test with real BGP sessions and load balancer configurations
- Validate Gateway API integration with actual traffic routing
- Test security and observability features end-to-end

### Phase 5: Documentation and Template Finalization
- Complete comprehensive documentation with real examples
- Finalize template structure for future ecosystem integrations
- Create migration guides and best practices documentation

**Key Principle:** Each phase includes complete functional testing validation before proceeding to the next phase. No implementation is considered complete without working end-to-end tests with real Kubernetes clusters.

## Performance Considerations

### Resource Creation Optimization
- Lazy evaluation of complex configurations
- Efficient CEL expression generation
- Minimal resource overhead

### Status Evaluation Optimization
- Efficient readiness checking
- Batched status queries
- Caching of frequently accessed status

### Memory Usage
- Efficient type definitions
- Minimal runtime overhead
- Proper resource cleanup

## Security Considerations

### Configuration Security
- Validate all user inputs
- Sanitize configuration values
- Prevent injection attacks

### Resource Security
- Follow Kubernetes RBAC best practices
- Validate resource permissions
- Secure secret handling

### Network Security
- Validate network configurations
- Prevent privilege escalation
- Secure communication channels

## Monitoring and Observability

### Metrics Exposure
- Expose Cilium metrics through status
- Provide health check endpoints
- Monitor deployment progress

### Logging Integration
- Structured logging for all operations
- Error tracking and reporting
- Debug information for troubleshooting

### Alerting Integration
- Status-based alerting
- Component health monitoring
- Performance threshold alerts

## Future Extensibility

### Template Pattern
This implementation serves as a template for future ecosystem integrations:

1. **Directory Structure**: Consistent organization pattern without separate readiness files
2. **Configuration Schema**: Comprehensive type-safe configuration with ArkType integration
3. **Status Outputs**: CEL-based integration points using kubernetesComposition
4. **Embedded Readiness Logic**: Readiness evaluators co-located with factory functions
5. **Error Handling**: Structured error types and messages with clear troubleshooting
6. **Test-Driven Development**: End-to-end testing integrated with every implementation task
7. **Documentation**: Clear API documentation with working examples and real deployments

**Key Template Principles:**
- **Co-location**: Readiness evaluators live with their corresponding factory functions
- **Composition-based**: Bootstrap compositions rely on resource readiness, not separate evaluators
- **Test-driven**: Every task includes comprehensive testing as part of implementation
- **Real-world validation**: All examples and tests use actual deployments, not mocks

### Ecosystem Roadmap
Following this pattern, future ecosystems can be implemented:

- **ArgoCD**: GitOps and application delivery
- **Ory**: Identity and access management  
- **Ray**: Distributed computing and ML
- **External DNS**: DNS management
- **Istio**: Service mesh
- **Prometheus**: Monitoring and alerting
- **Vault**: Secret management

Each ecosystem will follow the same structural patterns while providing ecosystem-specific functionality and integration points.