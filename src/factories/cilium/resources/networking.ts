/**
 * Cilium Networking CRD Factory Functions
 *
 * This module provides factory functions for Cilium networking resources:
 * - CiliumNetworkPolicy
 * - CiliumClusterwideNetworkPolicy
 *
 * Each factory function includes embedded readiness evaluators for proper
 * lifecycle management and status monitoring.
 */

import { createResource } from '../../shared.js';
import type { Enhanced, ReadinessEvaluator, ResourceStatus } from '../../../core/types/index.js';

import type {
  CiliumNetworkPolicy,
  CiliumClusterwideNetworkPolicy,
  CiliumNetworkPolicyConfig,
  CiliumClusterwideNetworkPolicyConfig,
  CiliumNetworkPolicySpec,
  CiliumNetworkPolicyStatus,
  CiliumClusterwideNetworkPolicySpec,
  CiliumClusterwideNetworkPolicyStatus,
  CiliumResourceStatus,
} from '../types.js';

// =============================================================================
// CILIUM NETWORK POLICY FACTORY
// =============================================================================

/**
 * Embedded readiness evaluator for CiliumNetworkPolicy
 *
 * Evaluates policy readiness based on:
 * - Policy acceptance by Cilium agent
 * - Endpoint selection and rule application
 * - Error conditions and validation status
 */
export const ciliumNetworkPolicyReadinessEvaluator: ReadinessEvaluator = (
  resource: any
): ResourceStatus => {
  const status = resource.status as CiliumResourceStatus | undefined;

  // Check if status exists - for CiliumNetworkPolicy, no status often means it's been accepted
  // but not yet processed by the Cilium agent. We'll consider this ready after a brief period.
  if (!status) {
    // If the resource exists and has been applied, consider it ready
    // CiliumNetworkPolicy doesn't always populate status immediately
    if (resource.metadata?.creationTimestamp) {
      const createdTime = new Date(resource.metadata.creationTimestamp);
      const now = new Date();
      const ageInSeconds = (now.getTime() - createdTime.getTime()) / 1000;

      // If the policy has existed for more than 5 seconds without errors, consider it ready
      if (ageInSeconds > 5) {
        return {
          ready: true,
          message: 'CiliumNetworkPolicy applied successfully (no status reported)',
          details: {
            phase: 'applied',
            ageInSeconds: Math.round(ageInSeconds),
          },
        };
      }
    }

    return {
      ready: false,
      message: 'CiliumNetworkPolicy status not available',
      details: { phase: 'pending' },
    };
  }

  // Check for error conditions
  if (status.conditions) {
    // Check for Ready condition first (standard Kubernetes pattern)
    const readyCondition = status.conditions.find((c) => c.type === 'Ready');

    if (readyCondition) {
      if (readyCondition.status === 'True') {
        return {
          ready: true,
          message: 'CiliumNetworkPolicy is ready and applied',
          details: {
            lastTransition: (readyCondition as any).lastTransitionTime,
          },
        };
      } else {
        // Handle specific error reasons, prefer message over reason
        let message = 'CiliumNetworkPolicy not ready';
        if (readyCondition.message) {
          message = `CiliumNetworkPolicy not ready: ${readyCondition.message}`;
        } else if (readyCondition.reason === 'InvalidEndpointSelector') {
          message = 'CiliumNetworkPolicy not ready: Invalid endpoint selector';
        } else if (readyCondition.reason) {
          message = `CiliumNetworkPolicy not ready: ${readyCondition.reason}`;
        }

        return {
          ready: false,
          message,
          details: {
            condition: readyCondition,
          },
        };
      }
    }

    // Check for validation errors (Cilium-specific)
    const invalidCondition = status.conditions.find(
      (c) => c.type === 'Valid' && c.status === 'False'
    );

    if (invalidCondition) {
      return {
        ready: false,
        message: `CiliumNetworkPolicy validation failed: ${invalidCondition.message || invalidCondition.reason || 'Unknown error'}`,
        details: {
          condition: invalidCondition,
          state: status.state,
        },
      };
    }

    // Check for valid condition (Cilium uses 'Valid' instead of 'Ready')
    const validCondition = status.conditions.find((c) => c.type === 'Valid' && c.status === 'True');

    if (validCondition) {
      return {
        ready: true,
        message: 'CiliumNetworkPolicy is valid and applied',
        details: {
          condition: validCondition,
          state: status.state,
          lastTransition: (validCondition as any).lastTransitionTime,
        },
      };
    }

    if (readyCondition) {
      return {
        ready: true,
        message: 'CiliumNetworkPolicy is ready and applied',
        details: {
          condition: readyCondition,
          state: status.state,
          lastTransition: (readyCondition as any).lastTransitionTime,
        },
      };
    }
  }

  // Check state field as fallback
  if (status.state) {
    switch (status.state.toLowerCase()) {
      case 'ready':
      case 'applied':
        return {
          ready: true,
          message: 'CiliumNetworkPolicy is ready',
          details: { state: status.state },
        };
      case 'error':
      case 'failed':
        return {
          ready: false,
          message: `CiliumNetworkPolicy failed: ${status.message || 'Unknown error'}`,
          details: { state: status.state },
        };
      case 'pending':
      case 'applying':
        return {
          ready: false,
          message: 'CiliumNetworkPolicy is being applied',
          details: { state: status.state },
        };
      default:
        return {
          ready: false,
          message: `CiliumNetworkPolicy in unknown state: ${status.state}`,
          details: { state: status.state },
        };
    }
  }

  // Default to not ready if we can't determine status
  return {
    ready: false,
    message: 'CiliumNetworkPolicy status unclear',
    details: { status },
  };
};

/**
 * Factory function for CiliumNetworkPolicy
 *
 * Creates a Cilium network policy resource with comprehensive configuration
 * options for ingress and egress rules, endpoint selection, and L7 policies.
 *
 * @param resource - CiliumNetworkPolicy resource definition
 * @returns Enhanced CiliumNetworkPolicy resource with embedded readiness evaluator
 *
 * @example
 * Basic network policy:
 * ```typescript
 * const policy = ciliumNetworkPolicy({
 *   apiVersion: 'cilium.io/v2',
 *   kind: 'CiliumNetworkPolicy',
 *   metadata: {
 *     name: 'allow-frontend',
 *     namespace: 'default'
 *   },
 *   spec: {
 *     endpointSelector: {
 *       matchLabels: { app: 'frontend' }
 *     },
 *     ingress: [{
 *       fromEndpoints: [{
 *         matchLabels: { app: 'backend' }
 *       }],
 *       toPorts: [{
 *         ports: [{ port: '8080', protocol: 'TCP' }]
 *       }]
 *     }]
 *   }
 * });
 * ```
 *
 * @example
 * L7 HTTP policy:
 * ```typescript
 * const httpPolicy = ciliumNetworkPolicy({
 *   apiVersion: 'cilium.io/v2',
 *   kind: 'CiliumNetworkPolicy',
 *   metadata: {
 *     name: 'api-access',
 *     namespace: 'default'
 *   },
 *   spec: {
 *     endpointSelector: {
 *       matchLabels: { app: 'api' }
 *     },
 *     ingress: [{
 *       fromEndpoints: [{
 *         matchLabels: { app: 'frontend' }
 *       }],
 *       toPorts: [{
 *         ports: [{ port: '8080', protocol: 'TCP' }],
 *         rules: {
 *           http: [{
 *             method: 'GET',
 *             path: '/api/v1/.*'
 *           }]
 *         }
 *       }]
 *     }]
 *   }
 * });
 * ```
 */
export function ciliumNetworkPolicy(
  resource: CiliumNetworkPolicy
): Enhanced<CiliumNetworkPolicySpec, CiliumNetworkPolicyStatus> {
  // Validate required fields - allow CEL expressions, KubernetesRef objects, and JavaScript expression results
  const name = resource.metadata?.name;
  if (name === undefined || name === null) {
    throw new Error('CiliumNetworkPolicy name is required');
  }

  if (!resource.spec) {
    throw new Error('CiliumNetworkPolicy spec is required');
  }

  // Validate endpoint selector if provided (empty object {} is valid for selecting all endpoints)
  if (resource.spec.endpointSelector && Object.keys(resource.spec.endpointSelector).length > 0) {
    if (
      !resource.spec.endpointSelector.matchLabels &&
      !resource.spec.endpointSelector.matchExpressions
    ) {
      throw new Error(
        'CiliumNetworkPolicy endpointSelector must have matchLabels or matchExpressions'
      );
    }
  }

  // Validate ingress rules if provided
  if (resource.spec.ingress) {
    resource.spec.ingress.forEach((rule, index) => {
      if (
        !rule.fromEndpoints &&
        !rule.fromCIDR &&
        !rule.fromCIDRSet &&
        !rule.fromEntities &&
        !rule.fromGroups
      ) {
        throw new Error(
          `CiliumNetworkPolicy ingress rule ${index} must specify at least one source`
        );
      }
    });
  }

  // Validate egress rules if provided
  if (resource.spec.egress) {
    resource.spec.egress.forEach((rule, index) => {
      if (
        !rule.toEndpoints &&
        !rule.toCIDR &&
        !rule.toCIDRSet &&
        !rule.toEntities &&
        !rule.toGroups &&
        !rule.toFQDNs
      ) {
        throw new Error(
          `CiliumNetworkPolicy egress rule ${index} must specify at least one destination`
        );
      }
    });
  }

  return createResource({
    ...resource,
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      ...resource.metadata,
      namespace: resource.metadata?.namespace || 'default',
    },
  }).withReadinessEvaluator(ciliumNetworkPolicyReadinessEvaluator);
}

// =============================================================================
// CILIUM CLUSTERWIDE NETWORK POLICY FACTORY
// =============================================================================

/**
 * Embedded readiness evaluator for CiliumClusterwideNetworkPolicy
 *
 * Evaluates cluster-wide policy readiness based on:
 * - Policy acceptance across all nodes
 * - Node selector validation
 * - Cluster-wide rule application status
 */
export const ciliumClusterwideNetworkPolicyReadinessEvaluator: ReadinessEvaluator = (
  resource: any
): ResourceStatus => {
  const status = resource.status as CiliumResourceStatus | undefined;

  // Check if status exists - for CiliumClusterwideNetworkPolicy, no status often means it's been accepted
  // but not yet processed by the Cilium agent. We'll consider this ready after a brief period.
  if (!status) {
    // If the resource exists and has been applied, consider it ready
    // CiliumClusterwideNetworkPolicy doesn't always populate status immediately
    if (resource.metadata?.creationTimestamp) {
      const createdTime = new Date(resource.metadata.creationTimestamp);
      const now = new Date();
      const ageInSeconds = (now.getTime() - createdTime.getTime()) / 1000;

      // If the policy has existed for more than 5 seconds without errors, consider it ready
      if (ageInSeconds > 5) {
        return {
          ready: true,
          message: 'CiliumClusterwideNetworkPolicy applied successfully (no status reported)',
          details: {
            phase: 'applied',
            ageInSeconds: Math.round(ageInSeconds),
          },
        };
      }
    }

    return {
      ready: false,
      message: 'CiliumClusterwideNetworkPolicy status not available',
      details: { phase: 'pending' },
    };
  }

  // Check for error conditions
  if (status.conditions) {
    // Check for validation errors first
    const invalidCondition = status.conditions.find(
      (c) => c.type === 'Valid' && c.status === 'False'
    );

    if (invalidCondition) {
      return {
        ready: false,
        message: `CiliumClusterwideNetworkPolicy validation failed: ${invalidCondition.message || invalidCondition.reason || 'Unknown error'}`,
        details: {
          condition: invalidCondition,
          state: status.state,
        },
      };
    }

    // Check for valid condition (Cilium uses 'Valid' instead of 'Ready')
    const validCondition = status.conditions.find((c) => c.type === 'Valid' && c.status === 'True');

    if (validCondition) {
      return {
        ready: true,
        message: 'CiliumClusterwideNetworkPolicy is valid and applied cluster-wide',
        details: {
          condition: validCondition,
          state: status.state,
          lastTransition: (validCondition as any).lastTransitionTime,
        },
      };
    }

    // Also check for Ready condition as fallback
    const readyCondition = status.conditions.find((c) => c.type === 'Ready' && c.status === 'True');

    if (readyCondition) {
      return {
        ready: true,
        message: 'CiliumClusterwideNetworkPolicy is ready and applied cluster-wide',
        details: {
          condition: readyCondition,
          state: status.state,
          lastTransition: (readyCondition as any).lastTransitionTime,
        },
      };
    }
  }

  // Check state field as fallback
  if (status.state) {
    switch (status.state.toLowerCase()) {
      case 'ready':
      case 'applied':
        return {
          ready: true,
          message: 'CiliumClusterwideNetworkPolicy is ready',
          details: { state: status.state },
        };
      case 'error':
      case 'failed':
        return {
          ready: false,
          message: `CiliumClusterwideNetworkPolicy failed: ${status.message || 'Unknown error'}`,
          details: { state: status.state },
        };
      case 'pending':
      case 'applying':
        return {
          ready: false,
          message: 'CiliumClusterwideNetworkPolicy is being applied cluster-wide',
          details: { state: status.state },
        };
      default:
        return {
          ready: false,
          message: `CiliumClusterwideNetworkPolicy in unknown state: ${status.state}`,
          details: { state: status.state },
        };
    }
  }

  // Default to not ready if we can't determine status
  return {
    ready: false,
    message: 'CiliumClusterwideNetworkPolicy status unclear',
    details: { status },
  };
};

/**
 * Factory function for CiliumClusterwideNetworkPolicy
 *
 * Creates a cluster-wide Cilium network policy resource that applies across
 * all nodes in the cluster. Supports node selection and cluster-wide rules.
 *
 * @param resource - CiliumClusterwideNetworkPolicy resource definition
 * @returns Enhanced CiliumClusterwideNetworkPolicy resource with embedded readiness evaluator
 *
 * @example
 * Cluster-wide deny-all policy:
 * ```typescript
 * const denyAll = ciliumClusterwideNetworkPolicy({
 *   apiVersion: 'cilium.io/v2',
 *   kind: 'CiliumClusterwideNetworkPolicy',
 *   metadata: {
 *     name: 'deny-all-ingress'
 *   },
 *   spec: {
 *     endpointSelector: {}, // Selects all endpoints
 *     ingress: [], // Empty ingress rules = deny all
 *     egress: []   // Empty egress rules = deny all
 *   }
 * });
 * ```
 *
 * @example
 * Node-specific cluster policy:
 * ```typescript
 * const nodePolicy = ciliumClusterwideNetworkPolicy({
 *   apiVersion: 'cilium.io/v2',
 *   kind: 'CiliumClusterwideNetworkPolicy',
 *   metadata: {
 *     name: 'worker-node-policy'
 *   },
 *   spec: {
 *     nodeSelector: {
 *       matchLabels: { 'node-role.kubernetes.io/worker': '' }
 *     },
 *     ingress: [{
 *       fromEntities: ['host'],
 *       toPorts: [{
 *         ports: [{ port: '9100', protocol: 'TCP' }]
 *       }]
 *     }]
 *   }
 * });
 * ```
 */
export function ciliumClusterwideNetworkPolicy(
  resource: CiliumClusterwideNetworkPolicy
): Enhanced<CiliumClusterwideNetworkPolicySpec, CiliumClusterwideNetworkPolicyStatus> {
  // Validate required fields - allow CEL expressions, KubernetesRef objects, and JavaScript expression results
  const name = resource.metadata?.name;
  if (name === undefined || name === null) {
    throw new Error('CiliumClusterwideNetworkPolicy name is required');
  }

  if (!resource.spec) {
    throw new Error('CiliumClusterwideNetworkPolicy spec is required');
  }

  // Validate endpoint selector if provided (empty object {} is valid for selecting all endpoints)
  if (resource.spec.endpointSelector && Object.keys(resource.spec.endpointSelector).length > 0) {
    if (
      !resource.spec.endpointSelector.matchLabels &&
      !resource.spec.endpointSelector.matchExpressions
    ) {
      throw new Error(
        'CiliumClusterwideNetworkPolicy endpointSelector must have matchLabels or matchExpressions'
      );
    }
  }

  // Validate node selector if provided
  if (resource.spec.nodeSelector) {
    if (!resource.spec.nodeSelector.matchLabels && !resource.spec.nodeSelector.matchExpressions) {
      throw new Error(
        'CiliumClusterwideNetworkPolicy nodeSelector must have matchLabels or matchExpressions'
      );
    }
  }

  // Validate ingress rules if provided
  if (resource.spec.ingress) {
    resource.spec.ingress.forEach((rule, index) => {
      if (
        !rule.fromEndpoints &&
        !rule.fromCIDR &&
        !rule.fromCIDRSet &&
        !rule.fromEntities &&
        !rule.fromGroups
      ) {
        throw new Error(
          `CiliumClusterwideNetworkPolicy ingress rule ${index} must specify at least one source`
        );
      }
    });
  }

  // Validate egress rules if provided
  if (resource.spec.egress) {
    resource.spec.egress.forEach((rule, index) => {
      if (
        !rule.toEndpoints &&
        !rule.toCIDR &&
        !rule.toCIDRSet &&
        !rule.toEntities &&
        !rule.toGroups &&
        !rule.toFQDNs
      ) {
        throw new Error(
          `CiliumClusterwideNetworkPolicy egress rule ${index} must specify at least one destination`
        );
      }
    });
  }

  return createResource(
    {
      ...resource,
      apiVersion: 'cilium.io/v2',
      kind: 'CiliumClusterwideNetworkPolicy',
      metadata: resource.metadata ?? { name: 'unnamed-cilium-clusterwide-network-policy' },
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(ciliumClusterwideNetworkPolicyReadinessEvaluator);
}

// =============================================================================
// SIMPLE FACTORY FUNCTIONS
// =============================================================================

/**
 * Simple factory function for CiliumNetworkPolicy
 *
 * Creates a CiliumNetworkPolicy with simplified configuration and sensible defaults.
 *
 * @param config - Simplified CiliumNetworkPolicy configuration
 * @returns Enhanced CiliumNetworkPolicy resource with embedded readiness evaluator
 *
 * @example
 * ```typescript
 * const policy = NetworkPolicy({
 *   name: 'allow-frontend',
 *   namespace: 'default',
 *   spec: {
 *     endpointSelector: {
 *       matchLabels: { app: 'frontend' }
 *     },
 *     ingress: [{
 *       fromEndpoints: [{
 *         matchLabels: { app: 'backend' }
 *       }],
 *       toPorts: [{
 *         ports: [{ port: '8080', protocol: 'TCP' }]
 *       }]
 *     }]
 *   },
 *   id: 'frontendPolicy'
 * });
 * ```
 */
export function NetworkPolicy(
  config: CiliumNetworkPolicyConfig
): Enhanced<CiliumNetworkPolicySpec, CiliumNetworkPolicyStatus> {
  return ciliumNetworkPolicy({
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
    },
    spec: config.spec,
    ...(config.id && { id: config.id }),
  });
}

/**
 * Simple factory function for CiliumClusterwideNetworkPolicy
 *
 * Creates a CiliumClusterwideNetworkPolicy with simplified configuration and sensible defaults.
 *
 * @param config - Simplified CiliumClusterwideNetworkPolicy configuration
 * @returns Enhanced CiliumClusterwideNetworkPolicy resource with embedded readiness evaluator
 *
 * @example
 * ```typescript
 * const denyAll = ClusterwideNetworkPolicy({
 *   name: 'deny-all-ingress',
 *   spec: {
 *     endpointSelector: {}, // Selects all endpoints
 *     ingress: [], // Empty ingress rules = deny all
 *     egress: []   // Empty egress rules = deny all
 *   },
 *   id: 'denyAllPolicy'
 * });
 * ```
 */
export function ClusterwideNetworkPolicy(
  config: CiliumClusterwideNetworkPolicyConfig
): Enhanced<CiliumClusterwideNetworkPolicySpec, CiliumClusterwideNetworkPolicyStatus> {
  return ciliumClusterwideNetworkPolicy({
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumClusterwideNetworkPolicy',
    metadata: {
      name: config.name,
    },
    spec: config.spec,
    ...(config.id && { id: config.id }),
  });
}
