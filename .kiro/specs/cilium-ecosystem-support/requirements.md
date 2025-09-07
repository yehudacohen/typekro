# Cilium Ecosystem Support Requirements

## Introduction

This feature will add comprehensive support for the Cilium ecosystem to TypeKro, providing type-safe factory functions for Cilium resources, bootstrap compositions for common deployment patterns, and integration with Cilium's Helm chart. This spec is designed as a template for future ecosystem integrations (ArgoCD, Ory, Ray, External DNS, etc.) with consistent structure and patterns.

## Requirements

### Requirement 1: Cilium Helm Chart Bootstrap Composition

**User Story:** As a platform engineer, I want a type-safe bootstrap composition for deploying Cilium via Helm using kubernetesComposition, so that I can easily configure and deploy Cilium with sensible defaults and expose integration points for other systems.

#### Acceptance Criteria

1. WHEN I use the Cilium bootstrap composition THEN I SHALL get a HelmRelease and HelmRepository configured for Cilium
2. WHEN I specify configuration options THEN they SHALL be validated against Cilium's Helm chart schema
3. WHEN I omit configuration options THEN sensible defaults SHALL be applied matching Cilium's chart defaults
4. WHEN I use TypeKro schema references THEN they SHALL work correctly in Cilium Helm values
5. WHEN I deploy the composition THEN it SHALL create a functional Cilium installation
6. WHEN I access the composition status THEN I SHALL get CEL-based status expressions for integration points
7. WHEN other systems need to integrate with Cilium THEN they SHALL have access to typed outputs like health endpoints, metrics endpoints, socket paths, and readiness states

### Requirement 2: Cilium CRD Factory Functions

**User Story:** As a developer, I want type-safe factory functions for all Cilium Custom Resource Definitions, so that I can create and manage Cilium resources with full TypeScript support.

#### Acceptance Criteria

1. WHEN I use Cilium CRD factories THEN I SHALL get Enhanced resources with proper typing
2. WHEN I create CiliumNetworkPolicy THEN it SHALL have proper spec validation and status typing
3. WHEN I create CiliumClusterwideNetworkPolicy THEN it SHALL support all Cilium policy features
4. WHEN I create CiliumBGPPeeringPolicy THEN it SHALL validate BGP configuration
5. WHEN I create CiliumLoadBalancerIPPool THEN it SHALL validate IP pool configuration
6. WHEN I create CiliumL2AnnouncementPolicy THEN it SHALL validate L2 announcement settings
7. WHEN I create CiliumEgressGatewayPolicy THEN it SHALL validate egress gateway configuration
8. WHEN I create CiliumEnvoyConfig THEN it SHALL validate Envoy configuration
9. WHEN I create CiliumClusterwideEnvoyConfig THEN it SHALL validate cluster-wide Envoy settings
10. WHEN I create CiliumGatewayClassConfig THEN it SHALL validate Gateway API configuration
11. WHEN I create CiliumLocalRedirectPolicy THEN it SHALL validate local redirect settings
12. WHEN I create CiliumCIDRGroup THEN it SHALL validate CIDR group configuration

### Requirement 3: Cilium Resource Readiness Evaluation

**User Story:** As a developer, I want Cilium resources to have proper readiness evaluation, so that I can reliably wait for resources to be ready before proceeding with dependent operations.

#### Acceptance Criteria

1. WHEN I deploy Cilium resources THEN they SHALL have appropriate readiness evaluators
2. WHEN CiliumNetworkPolicy is applied THEN readiness SHALL check policy enforcement status
3. WHEN CiliumBGPPeeringPolicy is applied THEN readiness SHALL check BGP session establishment
4. WHEN CiliumLoadBalancerIPPool is applied THEN readiness SHALL check IP pool availability
5. WHEN CiliumEnvoyConfig is applied THEN readiness SHALL check Envoy configuration acceptance
6. WHEN I use waitForReady THEN it SHALL properly wait for Cilium resource readiness
7. WHEN readiness evaluation fails THEN I SHALL get clear error messages about what's not ready

### Requirement 4: Ecosystem Organization Structure

**User Story:** As a maintainer, I want Cilium support organized in a consistent ecosystem structure, so that future ecosystem integrations can follow the same pattern.

#### Acceptance Criteria

1. WHEN I look at the codebase THEN Cilium support SHALL be organized under `src/factories/cilium/`
2. WHEN I examine the structure THEN it SHALL follow the established factory organization patterns
3. WHEN I look at exports THEN they SHALL be properly organized in index files
4. WHEN I examine types THEN they SHALL be centralized in types files
5. WHEN I look at compositions THEN they SHALL be in a dedicated compositions directory
6. WHEN I examine readiness evaluators THEN they SHALL be in a dedicated readiness-evaluators file
7. WHEN I look at the structure THEN it SHALL serve as a template for future ecosystems

### Requirement 5: Type Safety and Developer Experience

**User Story:** As a developer, I want full TypeScript support for Cilium resources, so that I get autocomplete, type checking, and refactoring support.

#### Acceptance Criteria

1. WHEN I use Cilium factories THEN TypeScript SHALL provide full autocomplete
2. WHEN I make configuration errors THEN TypeScript SHALL show compile-time errors
3. WHEN I access resource properties THEN they SHALL be properly typed
4. WHEN I use cross-resource references THEN they SHALL work with Cilium resources
5. WHEN I use CEL expressions THEN they SHALL work with Cilium resource fields
6. WHEN I refactor code THEN TypeScript SHALL catch breaking changes
7. WHEN I use IDE features THEN they SHALL work seamlessly with Cilium resources

### Requirement 6: Bootstrap Composition Configuration Schema

**User Story:** As a platform engineer, I want a comprehensive configuration schema for the Cilium bootstrap composition, so that I can configure all aspects of Cilium deployment with type safety.

#### Acceptance Criteria

1. WHEN I configure Cilium THEN I SHALL have typed options for all major Helm chart values
2. WHEN I set cluster configuration THEN it SHALL validate cluster-specific settings
3. WHEN I configure networking THEN it SHALL validate network configuration options
4. WHEN I set security options THEN it SHALL validate security-related settings
5. WHEN I configure observability THEN it SHALL validate monitoring and logging options
6. WHEN I set operator options THEN it SHALL validate Cilium operator configuration
7. WHEN I configure IPAM THEN it SHALL validate IP address management settings
8. WHEN I set BGP options THEN it SHALL validate BGP configuration
9. WHEN I configure Gateway API THEN it SHALL validate Gateway API settings
10. WHEN I set encryption options THEN it SHALL validate encryption configuration

### Requirement 7: Integration with Existing TypeKro Features

**User Story:** As a developer, I want Cilium resources to work seamlessly with all existing TypeKro features, so that I can leverage the full power of the TypeKro ecosystem.

#### Acceptance Criteria

1. WHEN I use Cilium resources in compositions THEN they SHALL work with kubernetesComposition
2. WHEN I create resource graphs THEN Cilium resources SHALL serialize properly to YAML
3. WHEN I use direct deployment THEN Cilium resources SHALL deploy correctly
4. WHEN I use Kro deployment THEN Cilium resources SHALL work with ResourceGraphDefinitions
5. WHEN I use dependency resolution THEN Cilium resources SHALL participate correctly
6. WHEN I use status expressions THEN they SHALL work with Cilium resource status fields and generate proper CEL expressions
7. WHEN I use the factory pattern THEN Cilium compositions SHALL work as factories
8. WHEN I use toResourceGraph THEN Cilium resources SHALL work with the declarative API pattern as well

### Requirement 8: Documentation and Examples

**User Story:** As a developer, I want clear documentation and practical examples for Cilium support, so that I can quickly get started with Cilium in TypeKro.

#### Acceptance Criteria

1. WHEN I look for Cilium documentation THEN I SHALL find clear usage examples for the bootstrap composition
2. WHEN I need CRD examples THEN I SHALL find examples for common Cilium resources like NetworkPolicy and BGP configuration
3. WHEN I look at API documentation THEN all Cilium functions SHALL have proper JSDoc documentation
4. WHEN I need integration examples THEN I SHALL find examples showing how to use Cilium status outputs in other compositions

## Success Criteria

- Complete type-safe support for Cilium ecosystem deployment and management
- Bootstrap composition that handles common Cilium deployment scenarios
- Factory functions for all major Cilium CRDs with proper typing and validation
- Seamless integration with existing TypeKro features and patterns
- Comprehensive documentation and examples for all Cilium functionality
- Structure that serves as a template for future ecosystem integrations
- Performance suitable for production Cilium deployments

## Example Usage

**Note:** The following examples use simplified schemas and configurations for illustration purposes. Comprehensive schemas, configuration options, and status fields will be fully defined in the design phase based on Cilium's complete Helm chart values and CRD specifications.

### Bootstrap Composition with kubernetesComposition
```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { ciliumBootstrap } from 'typekro/cilium';

// NOTE: These are illustrative schemas - comprehensive schemas will be designed in the design phase
const CiliumStackSpec = type({
  clusterName: 'string',
  clusterId: 'number',
  enableEncryption: 'boolean',
  enableHubble: 'boolean',
  version: 'string'
  // ... many more configuration options will be defined in design phase
});

const CiliumStackStatus = type({
  phase: 'string',
  ready: 'boolean',
  agentReady: 'boolean',
  operatorReady: 'boolean',
  hubbleReady: 'boolean',
  version: 'string',
  clusterMeshReady: 'boolean',
  encryptionEnabled: 'boolean',
  // Integration outputs for other systems
  cniConfigPath: 'string',
  socketPath: 'string',
  healthEndpoint: 'string',
  metricsEndpoint: 'string'
  // ... comprehensive status fields will be defined in design phase
});

const ciliumStack = kubernetesComposition(
  {
    name: 'cilium-stack',
    apiVersion: 'platform.example.com/v1alpha1',
    kind: 'CiliumStack',
    spec: CiliumStackSpec,
    status: CiliumStackStatus,
  },
  (spec) => {
    const cilium = ciliumBootstrap({
      name: 'cilium',
      namespace: 'kube-system',
      version: spec.version,
      cluster: {
        name: spec.clusterName,
        id: spec.clusterId
      },
      security: {
        encryption: {
          enabled: spec.enableEncryption,
          type: 'wireguard'
        }
      },
      observability: {
        hubble: {
          enabled: spec.enableHubble,
          relay: { enabled: spec.enableHubble },
          ui: { enabled: spec.enableHubble }
        }
      },
      id: 'cilium' // Required for schema references
    });

    // Return status with CEL expressions for integration
    return {
      phase: cilium.helmRelease.status.phase === 'Ready' ? 'Ready' : 'Installing',
      ready: cilium.helmRelease.status.phase === 'Ready',
      agentReady: cilium.agentDaemonSet.status.numberReady > 0,
      operatorReady: cilium.operatorDeployment.status.readyReplicas > 0,
      hubbleReady: spec.enableHubble ? cilium.hubbleRelay.status.readyReplicas > 0 : true,
      version: spec.version,
      clusterMeshReady: cilium.clusterMeshStatus.ready,
      encryptionEnabled: spec.enableEncryption,
      // Integration outputs for other systems to consume
      cniConfigPath: '/etc/cni/net.d/05-cilium.conflist',
      socketPath: '/var/run/cilium/cilium.sock',
      healthEndpoint: `http://${cilium.agentService.spec.clusterIP}:9879/healthz`,
      metricsEndpoint: `http://${cilium.agentService.spec.clusterIP}:9962/metrics`
    };
  }
);
```

### CRD Factory Usage
```typescript
import { ciliumNetworkPolicy, ciliumBGPPeeringPolicy } from 'typekro/cilium';

const networkPolicy = ciliumNetworkPolicy({
  name: 'allow-frontend-to-backend',
  namespace: 'production',
  spec: {
    endpointSelector: {
      matchLabels: { app: 'backend' }
    },
    ingress: [{
      fromEndpoints: [{
        matchLabels: { app: 'frontend' }
      }],
      toPorts: [{
        ports: [{ port: '8080', protocol: 'TCP' }]
      }]
    }]
  }
});

const bgpPolicy = ciliumBGPPeeringPolicy({
  name: 'bgp-peering',
  spec: {
    nodeSelector: {
      matchLabels: { 'node-role.kubernetes.io/worker': '' }
    },
    virtualRouters: [{
      localASN: 65001,
      exportPodCIDR: true,
      neighbors: [{
        peerAddress: '192.168.1.1/32',
        peerASN: 65000
      }]
    }]
  }
});
```

### Integration with Other Systems
```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { ciliumStack } from './cilium-stack';
import { Deployment, Service } from 'typekro/simple';

// NOTE: These are simplified example schemas - real schemas will be comprehensive
const AppWithCiliumSpec = type({
  appName: 'string',
  appImage: 'string',
  ciliumClusterName: 'string'
  // ... additional app configuration options
});

const AppWithCiliumStatus = type({
  ready: 'boolean',
  ciliumIntegrated: 'boolean',
  networkPolicyApplied: 'boolean',
  metricsEndpoint: 'string'
  // ... comprehensive status reporting
});

const appWithCilium = kubernetesComposition(
  {
    name: 'app-with-cilium',
    apiVersion: 'example.com/v1alpha1',
    kind: 'AppWithCilium',
    spec: AppWithCiliumSpec,
    status: AppWithCiliumStatus,
  },
  (spec) => {
    // Deploy Cilium first
    const cilium = ciliumStack.deploy({
      clusterName: spec.ciliumClusterName,
      clusterId: 1,
      enableEncryption: true,
      enableHubble: true,
      version: '1.18.1'
    });

    // Deploy app that integrates with Cilium
    const app = Deployment({
      name: spec.appName,
      image: spec.appImage,
      env: {
        // Use Cilium's health endpoint for CNI health checks
        CILIUM_HEALTH_ENDPOINT: cilium.healthEndpoint,
        // Use Cilium's metrics for observability
        CILIUM_METRICS_ENDPOINT: cilium.metricsEndpoint
      },
      id: 'app'
    });

    const appService = Service({
      name: `${spec.appName}-service`,
      selector: { app: spec.appName },
      ports: [{ port: 80, targetPort: 8080 }],
      id: 'appService'
    });

    // Create network policy using Cilium
    const networkPolicy = ciliumNetworkPolicy({
      name: `${spec.appName}-policy`,
      namespace: 'default',
      spec: {
        endpointSelector: {
          matchLabels: { app: spec.appName }
        },
        ingress: [{
          fromEndpoints: [{}], // Allow all for demo
          toPorts: [{
            ports: [{ port: '8080', protocol: 'TCP' }]
          }]
        }]
      },
      id: 'networkPolicy'
    });

    return {
      ready: app.status.readyReplicas > 0 && cilium.ready,
      ciliumIntegrated: cilium.ready,
      networkPolicyApplied: networkPolicy.status.ok,
      metricsEndpoint: cilium.metricsEndpoint
    };
  }
);
```

## Non-Functional Requirements

- **Performance**: Bootstrap composition should deploy Cilium within typical timeframes (2-5 minutes)
- **Type Safety**: Full TypeScript type checking for all Cilium resources and configurations
- **Usability**: API should feel natural and consistent with existing TypeKro patterns
- **Compatibility**: Must work with all existing TypeKro deployment strategies (direct, Kro)
- **Reliability**: Readiness evaluation should accurately reflect Cilium resource states
- **Maintainability**: Code structure should be easy to extend and maintain
- **Documentation**: Comprehensive documentation with practical examples
- **Template Quality**: Structure should serve as a high-quality template for future ecosystems

## Future Ecosystem Template Structure

This spec establishes the following structure for ecosystem support:

```
src/factories/{ecosystem}/
├── index.ts                    # Main exports
├── types.ts                    # Type definitions
├── readiness-evaluators.ts     # Readiness evaluation functions
├── compositions/               # Bootstrap compositions
│   ├── index.ts
│   └── {ecosystem}-bootstrap.ts
└── resources/                  # CRD factory functions
    ├── index.ts
    ├── {resource-category-1}.ts
    ├── {resource-category-2}.ts
    └── ...
```

This structure should be followed for future ecosystem integrations including:
- ArgoCD (GitOps and application delivery)
- Ory (Identity and access management)
- Ray (Distributed computing)
- External DNS (DNS management)
- Istio (Service mesh)
- Prometheus (Monitoring)
- And others