/**
 * Cilium Helm Integration Resources
 *
 * This module provides wrapper functions for creating Helm resources specifically
 * configured for Cilium deployments. These functions wrap the generic Helm factories
 * from src/factories/helm/ and provide Cilium-specific configuration interfaces
 * while reusing existing readiness evaluators.
 */


import { createResource } from '../../shared.js';
import { helmReleaseReadinessEvaluator } from '../../helm/readiness-evaluators.js';
import type {
  CiliumBootstrapConfig,
  CiliumHelmRepositoryConfig,
  CiliumHelmReleaseConfig,
  CiliumHelmValues,
} from '../types.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import type { HelmRepositorySpec, HelmRepositoryStatus } from '../../helm/helm-repository.js';

// =============================================================================
// CILIUM HELM REPOSITORY WRAPPER
// =============================================================================

/**
 * Wrapper function for creating Cilium HelmRepository resources
 *
 * This function wraps the generic `helmRepository` factory and provides
 * Cilium-specific configuration with proper defaults and validation.
 * It reuses the existing Helm readiness evaluator.
 *
 * @param config - Cilium HelmRepository configuration
 * @returns Enhanced HelmRepository resource with Cilium-specific settings
 *
 * @example
 * Basic Cilium repository:
 * ```typescript
 * const repo = ciliumHelmRepository({
 *   name: 'cilium',
 *   namespace: 'flux-system'
 * });
 * ```
 *
 * @example
 * Repository with custom settings:
 * ```typescript
 * const repo = ciliumHelmRepository({
 *   name: 'cilium-repo',
 *   namespace: 'flux-system',
 *   interval: '10m',
 *   timeout: '5m'
 * });
 * ```
 */
/**
 * Simple readiness evaluator for HelmRepository resources
 * HelmRepository is ready when it has a Ready condition with status True
 */
function ciliumHelmRepositoryReadinessEvaluator(resource: any) {
  const conditions = resource.status?.conditions || [];
  const readyCondition = conditions.find((c: any) => c.type === 'Ready');
  const isReady = readyCondition?.status === 'True';

  return {
    ready: isReady,
    message: isReady ? 'HelmRepository is ready' : 'HelmRepository is not ready',
  };
}

export function ciliumHelmRepository(config: CiliumHelmRepositoryConfig) {
  // For Kro deployments, we need to avoid status expectations that conflict with actual Flux status
  // Create the resource directly without status template to avoid Kro controller conflicts
  return createResource<HelmRepositorySpec, HelmRepositoryStatus>({
    ...(config.id && { id: config.id }),
    apiVersion: 'source.toolkit.fluxcd.io/v1',
    kind: 'HelmRepository',
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
    },
    spec: {
      url: 'https://helm.cilium.io/',
      interval: config.interval || '5m',
      type: 'default',
    },
    // Omit status template to avoid conflicts with Kro controller
  }).withReadinessEvaluator(ciliumHelmRepositoryReadinessEvaluator);
}

// =============================================================================
// CILIUM HELM RELEASE WRAPPER
// =============================================================================

/**
 * Wrapper function for creating Cilium HelmRelease resources
 *
 * This function wraps the generic `helmRelease` factory and provides
 * Cilium-specific configuration with proper chart reference and values mapping.
 * It reuses the existing Helm readiness evaluator.
 *
 * @param config - Cilium HelmRelease configuration
 * @returns Enhanced HelmRelease resource with Cilium-specific configuration
 *
 * @example
 * Basic Cilium release:
 * ```typescript
 * const release = ciliumHelmRelease({
 *   name: 'cilium',
 *   namespace: 'kube-system',
 *   version: '1.18.1',
 *   repositoryName: 'cilium',
 *   repositoryNamespace: 'flux-system'
 * });
 * ```
 *
 * @example
 * Release with custom values:
 * ```typescript
 * const release = ciliumHelmRelease({
 *   name: 'cilium',
 *   namespace: 'kube-system',
 *   version: '1.18.1',
 *   repositoryName: 'cilium',
 *   repositoryNamespace: 'flux-system',
 *   values: {
 *     cluster: { name: 'production', id: 1 },
 *     kubeProxyReplacement: 'strict'
 *   }
 * });
 * ```
 */
export function ciliumHelmRelease(config: CiliumHelmReleaseConfig) {
  // Create a HelmRelease that properly references the HelmRepository by name
  // We need to use createResource directly to have full control over the sourceRef
  return createResource<HelmReleaseSpec, HelmReleaseStatus>({
    ...(config.id && { id: config.id }),
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      ...(config.labels && { labels: config.labels }),
      ...(config.annotations && { annotations: config.annotations }),
    },
    spec: {
      interval: config.interval || '5m',
      chart: {
        spec: {
          chart: 'cilium',
          ...(config.version && { version: config.version }),
          sourceRef: {
            kind: 'HelmRepository' as const,
            name: config.repositoryName,
            namespace: config.repositoryNamespace,
          },
        },
      },
      ...(config.values && { values: config.values }),
    },
  }).withReadinessEvaluator(helmReleaseReadinessEvaluator);
}

// =============================================================================
// HELM VALUES MAPPING SYSTEM
// =============================================================================

/**
 * Maps Cilium bootstrap configuration to Helm values
 *
 * This function converts the TypeKro CiliumBootstrapConfig interface
 * to the Helm values format expected by the Cilium chart.
 *
 * @param config - Cilium bootstrap configuration
 * @returns Helm values object for Cilium chart
 *
 * @example
 * ```typescript
 * const config: CiliumBootstrapConfig = {
 *   cluster: { name: 'production', id: 1 },
 *   networking: { kubeProxyReplacement: 'strict' }
 * };
 * const helmValues = mapCiliumConfigToHelmValues(config);
 * ```
 */
export function mapCiliumConfigToHelmValues(config: CiliumBootstrapConfig): CiliumHelmValues {
  const values: CiliumHelmValues = {
    // Cluster configuration
    cluster: {
      name: config.cluster.name,
      id: config.cluster.id,
    },
  };

  // Networking configuration
  if (config.networking) {
    const networking = config.networking;
    
    if (networking.ipam) {
      values.ipam = {
        mode: networking.ipam.mode || 'kubernetes',
      };
      
      if (networking.ipam.operator) {
        values.ipam.operator = {};
        if (networking.ipam.operator.clusterPoolIPv4PodCIDRList) {
          values.ipam.operator.clusterPoolIPv4PodCIDRList = networking.ipam.operator.clusterPoolIPv4PodCIDRList;
        }
        if (networking.ipam.operator.clusterPoolIPv6PodCIDRList) {
          values.ipam.operator.clusterPoolIPv6PodCIDRList = networking.ipam.operator.clusterPoolIPv6PodCIDRList;
        }
      }
    }
    
    if (networking.kubeProxyReplacement) {
      // Convert string values to boolean/string format expected by Cilium Helm chart
      switch (networking.kubeProxyReplacement) {
        case 'disabled':
          values.kubeProxyReplacement = false;
          break;
        case 'partial':
          values.kubeProxyReplacement = 'partial';
          break;
        case 'strict':
          values.kubeProxyReplacement = true;
          break;
        default:
          values.kubeProxyReplacement = networking.kubeProxyReplacement;
      }
    }
    
    if (networking.routingMode) {
      values.routingMode = networking.routingMode;
    }
    
    if (networking.tunnelProtocol) {
      values.tunnelProtocol = networking.tunnelProtocol;
    }
    
    if (networking.autoDirectNodeRoutes !== undefined) {
      values.autoDirectNodeRoutes = networking.autoDirectNodeRoutes;
    }
    
    if (networking.endpointRoutes) {
      values.endpointRoutes = networking.endpointRoutes;
    }
    
    if (networking.hostServices) {
      values.hostServices = networking.hostServices;
    }
    
    if (networking.nodePort) {
      values.nodePort = networking.nodePort;
    }
    
    if (networking.externalIPs) {
      values.externalIPs = networking.externalIPs;
    }
    
    if (networking.hostPort) {
      values.hostPort = networking.hostPort;
    }
    
    if (networking.loadBalancer) {
      values.loadBalancer = networking.loadBalancer;
    }
  }

  // Security configuration
  if (config.security) {
    const security = config.security;
    
    if (security.encryption) {
      values.encryption = security.encryption;
    }
    
    if (security.authentication) {
      values.authentication = security.authentication;
    }
    
    if (security.policyEnforcement) {
      values.policyEnforcement = security.policyEnforcement;
    }
    
    if (security.policyAuditMode !== undefined) {
      values.policyAuditMode = security.policyAuditMode;
    }
  }

  // BGP configuration
  if (config.bgp) {
    values.bgp = config.bgp;
  }

  // Gateway API configuration
  if (config.gatewayAPI) {
    values.gatewayAPI = config.gatewayAPI;
  }

  // Observability configuration
  if (config.observability) {
    const observability = config.observability;
    
    if (observability.hubble) {
      values.hubble = observability.hubble;
    }
    
    if (observability.prometheus) {
      values.prometheus = observability.prometheus;
    }
  }

  // Operator configuration
  if (config.operator) {
    values.operator = config.operator;
  }

  // Agent configuration
  if (config.agent) {
    values.agent = config.agent;
  }

  // Advanced configuration
  if (config.advanced) {
    const advanced = config.advanced;
    
    if (advanced.bpf) {
      values.bpf = advanced.bpf;
    }
    
    if (advanced.k8s) {
      values.k8s = advanced.k8s;
    }
    
    if (advanced.cni) {
      values.cni = advanced.cni;
    }
  }

  // Custom values (merge last to allow overrides)
  if (config.customValues) {
    Object.assign(values, config.customValues);
  }

  return values;
}

/**
 * Validates Cilium Helm values configuration
 *
 * This function validates that the generated Helm values are compatible
 * with the Cilium chart and contain all required fields.
 *
 * @param values - Helm values to validate
 * @returns Validation result with any errors
 *
 * @example
 * ```typescript
 * const values = mapCiliumConfigToHelmValues(config);
 * const validation = validateCiliumHelmValues(values);
 * if (!validation.valid) {
 *   console.error('Validation errors:', validation.errors);
 * }
 * ```
 */
export function validateCiliumHelmValues(values: CiliumHelmValues): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Validate required cluster configuration
  if (!values.cluster) {
    errors.push('cluster configuration is required');
  } else {
    if (!values.cluster.name) {
      errors.push('cluster.name is required');
    }
    if (typeof values.cluster.id !== 'number' || values.cluster.id < 0 || values.cluster.id > 255) {
      errors.push('cluster.id must be a number between 0 and 255');
    }
  }

  // Validate IPAM configuration if present
  if (values.ipam) {
    const validIpamModes = ['kubernetes', 'cluster-pool', 'azure', 'aws-eni', 'crd'];
    if (values.ipam.mode && !validIpamModes.includes(values.ipam.mode)) {
      errors.push(`ipam.mode must be one of: ${validIpamModes.join(', ')}`);
    }
  }

  // Validate kube-proxy replacement if present
  if (values.kubeProxyReplacement !== undefined) {
    const validModes = [true, false, 'partial'];
    if (!validModes.includes(values.kubeProxyReplacement)) {
      errors.push(`kubeProxyReplacement must be one of: true, false, 'partial'`);
    }
  }

  // Validate routing mode if present
  if (values.routingMode) {
    const validModes = ['tunnel', 'native'];
    if (!validModes.includes(values.routingMode)) {
      errors.push(`routingMode must be one of: ${validModes.join(', ')}`);
    }
  }

  // Validate tunnel protocol if present
  if (values.tunnelProtocol) {
    const validProtocols = ['vxlan', 'geneve'];
    if (!validProtocols.includes(values.tunnelProtocol)) {
      errors.push(`tunnelProtocol must be one of: ${validProtocols.join(', ')}`);
    }
  }

  // Validate policy enforcement if present
  if (values.policyEnforcement) {
    const validModes = ['default', 'always', 'never'];
    if (!validModes.includes(values.policyEnforcement)) {
      errors.push(`policyEnforcement must be one of: ${validModes.join(', ')}`);
    }
  }

  // Validate encryption configuration if present
  if (values.encryption?.enabled && values.encryption.type) {
    const validTypes = ['wireguard', 'ipsec'];
    if (!validTypes.includes(values.encryption.type)) {
      errors.push(`encryption.type must be one of: ${validTypes.join(', ')}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}