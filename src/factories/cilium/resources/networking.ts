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

import { ValidationError } from '../../../core/errors.js';
import type { Enhanced, ReadinessEvaluator, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

import type {
  CiliumClusterwideNetworkPolicy,
  CiliumClusterwideNetworkPolicyConfig,
  CiliumClusterwideNetworkPolicySpec,
  CiliumClusterwideNetworkPolicyStatus,
  CiliumNetworkPolicy,
  CiliumNetworkPolicyConfig,
  CiliumNetworkPolicySpec,
  CiliumNetworkPolicyStatus,
  CiliumResourceStatus,
} from '../types.js';

// =============================================================================
// CILIUM POLICY READINESS EVALUATOR FACTORY
// =============================================================================

/**
 * Grace period (in seconds) before a Cilium policy without status is considered ready.
 * Cilium policies don't always populate status immediately — if the resource has existed
 * for longer than this threshold without errors, it is treated as successfully applied.
 */
const CILIUM_STATUS_GRACE_PERIOD_SECONDS = 5;

/** Options for creating a Cilium policy readiness evaluator. */
interface CiliumPolicyEvaluatorOptions {
  /** Resource kind name for messages (e.g., 'CiliumNetworkPolicy') */
  kind: string;
  /**
   * Optional suffix appended to certain messages to indicate scope.
   * For example, ' cluster-wide' for CiliumClusterwideNetworkPolicy.
   */
  scopeSuffix?: string;
}

/**
 * Creates a readiness evaluator for Cilium policy resources.
 *
 * Evaluates readiness through a multi-level check:
 * 1. **No status** — falls back to age-based readiness after a grace period
 * 2. **Conditions** — checks Ready and Valid conditions (standard Cilium pattern)
 * 3. **State field** — falls back to `status.state` string comparison
 *
 * Both CiliumNetworkPolicy and CiliumClusterwideNetworkPolicy share this
 * exact readiness logic, differing only in their message labels.
 *
 * @param options - Configuration for the evaluator
 * @returns A ReadinessEvaluator for the specified Cilium policy kind
 */
function createCiliumPolicyReadinessEvaluator(
  options: CiliumPolicyEvaluatorOptions
): ReadinessEvaluator<unknown> {
  const { kind, scopeSuffix = '' } = options;

  return (resource: unknown): ResourceStatus => {
    const res = resource as {
      metadata?: { creationTimestamp?: string };
      status?: CiliumResourceStatus;
    };
    const status = res.status;

    // 1. No status — fall back to age-based readiness
    if (!status) {
      if (res.metadata?.creationTimestamp) {
        const createdTime = new Date(res.metadata.creationTimestamp);
        const now = new Date();
        const ageInSeconds = (now.getTime() - createdTime.getTime()) / 1000;

        if (ageInSeconds > CILIUM_STATUS_GRACE_PERIOD_SECONDS) {
          return {
            ready: true,
            message: `${kind} applied successfully (no status reported)`,
            details: {
              phase: 'applied',
              ageInSeconds: Math.round(ageInSeconds),
            },
          };
        }
      }

      return {
        ready: false,
        message: `${kind} status not available`,
        details: { phase: 'pending' },
      };
    }

    // 2. Condition-based checks
    if (status.conditions) {
      // Check for Ready condition (standard Kubernetes pattern)
      const readyCondition = status.conditions.find((c) => c.type === 'Ready');

      if (readyCondition) {
        if (readyCondition.status === 'True') {
          return {
            ready: true,
            message: `${kind} is ready and applied${scopeSuffix}`,
            details: {
              lastTransition: readyCondition.lastTransitionTime,
            },
          };
        }

        // Not-ready: prefer message over reason for detail
        let message = `${kind} not ready`;
        if (readyCondition.message) {
          message = `${kind} not ready: ${readyCondition.message}`;
        } else if (readyCondition.reason === 'InvalidEndpointSelector') {
          message = `${kind} not ready: Invalid endpoint selector`;
        } else if (readyCondition.reason) {
          message = `${kind} not ready: ${readyCondition.reason}`;
        }

        return {
          ready: false,
          message,
          details: { condition: readyCondition },
        };
      }

      // Check for validation errors (Cilium uses 'Valid' condition)
      const invalidCondition = status.conditions.find(
        (c) => c.type === 'Valid' && c.status === 'False'
      );

      if (invalidCondition) {
        return {
          ready: false,
          message: `${kind} validation failed: ${invalidCondition.message || invalidCondition.reason || 'Unknown error'}`,
          details: {
            condition: invalidCondition,
            state: status.state,
          },
        };
      }

      // Check for valid condition (Cilium uses 'Valid' instead of 'Ready')
      const validCondition = status.conditions.find(
        (c) => c.type === 'Valid' && c.status === 'True'
      );

      if (validCondition) {
        return {
          ready: true,
          message: `${kind} is valid and applied${scopeSuffix}`,
          details: {
            condition: validCondition,
            state: status.state,
            lastTransition: validCondition.lastTransitionTime,
          },
        };
      }
    }

    // 3. State field fallback
    if (status.state) {
      switch (status.state.toLowerCase()) {
        case 'ready':
        case 'applied':
          return {
            ready: true,
            message: `${kind} is ready`,
            details: { state: status.state },
          };
        case 'error':
        case 'failed':
          return {
            ready: false,
            message: `${kind} failed: ${status.message || 'Unknown error'}`,
            details: { state: status.state },
          };
        case 'pending':
        case 'applying':
          return {
            ready: false,
            message: `${kind} is being applied${scopeSuffix}`,
            details: { state: status.state },
          };
        default:
          return {
            ready: false,
            message: `${kind} in unknown state: ${status.state}`,
            details: { state: status.state },
          };
      }
    }

    // Default to not ready
    return {
      ready: false,
      message: `${kind} status unclear`,
      details: { status },
    };
  };
}

// =============================================================================
// CILIUM NETWORK POLICY FACTORY
// =============================================================================

/**
 * Readiness evaluator for CiliumNetworkPolicy.
 *
 * Evaluates policy readiness based on conditions (Ready/Valid),
 * state field, and age-based fallback for resources without status.
 */
export const ciliumNetworkPolicyReadinessEvaluator: ReadinessEvaluator<unknown> =
  createCiliumPolicyReadinessEvaluator({ kind: 'CiliumNetworkPolicy' });

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
    throw new ValidationError(
      'CiliumNetworkPolicy name is required',
      'CiliumNetworkPolicy',
      'unknown',
      'metadata.name'
    );
  }

  if (!resource.spec) {
    throw new ValidationError(
      'CiliumNetworkPolicy spec is required',
      'CiliumNetworkPolicy',
      String(name),
      'spec'
    );
  }

  // Validate endpoint selector if provided (empty object {} is valid for selecting all endpoints)
  if (resource.spec.endpointSelector && Object.keys(resource.spec.endpointSelector).length > 0) {
    if (
      !resource.spec.endpointSelector.matchLabels &&
      !resource.spec.endpointSelector.matchExpressions
    ) {
      throw new ValidationError(
        'CiliumNetworkPolicy endpointSelector must have matchLabels or matchExpressions',
        'CiliumNetworkPolicy',
        String(name),
        'spec.endpointSelector'
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
        throw new ValidationError(
          `CiliumNetworkPolicy ingress rule ${index} must specify at least one source`,
          'CiliumNetworkPolicy',
          String(name),
          `spec.ingress[${index}]`
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
        throw new ValidationError(
          `CiliumNetworkPolicy egress rule ${index} must specify at least one destination`,
          'CiliumNetworkPolicy',
          String(name),
          `spec.egress[${index}]`
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
 * Readiness evaluator for CiliumClusterwideNetworkPolicy.
 *
 * Uses the same multi-level readiness logic as CiliumNetworkPolicy
 * with "cluster-wide" scope messaging.
 */
export const ciliumClusterwideNetworkPolicyReadinessEvaluator: ReadinessEvaluator<unknown> =
  createCiliumPolicyReadinessEvaluator({
    kind: 'CiliumClusterwideNetworkPolicy',
    scopeSuffix: ' cluster-wide',
  });

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
    throw new ValidationError(
      'CiliumClusterwideNetworkPolicy name is required',
      'CiliumClusterwideNetworkPolicy',
      'unknown',
      'metadata.name'
    );
  }

  if (!resource.spec) {
    throw new ValidationError(
      'CiliumClusterwideNetworkPolicy spec is required',
      'CiliumClusterwideNetworkPolicy',
      String(name),
      'spec'
    );
  }

  // Validate endpoint selector if provided (empty object {} is valid for selecting all endpoints)
  if (resource.spec.endpointSelector && Object.keys(resource.spec.endpointSelector).length > 0) {
    if (
      !resource.spec.endpointSelector.matchLabels &&
      !resource.spec.endpointSelector.matchExpressions
    ) {
      throw new ValidationError(
        'CiliumClusterwideNetworkPolicy endpointSelector must have matchLabels or matchExpressions',
        'CiliumClusterwideNetworkPolicy',
        String(name),
        'spec.endpointSelector'
      );
    }
  }

  // Validate node selector if provided
  if (resource.spec.nodeSelector) {
    if (!resource.spec.nodeSelector.matchLabels && !resource.spec.nodeSelector.matchExpressions) {
      throw new ValidationError(
        'CiliumClusterwideNetworkPolicy nodeSelector must have matchLabels or matchExpressions',
        'CiliumClusterwideNetworkPolicy',
        String(name),
        'spec.nodeSelector'
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
        throw new ValidationError(
          `CiliumClusterwideNetworkPolicy ingress rule ${index} must specify at least one source`,
          'CiliumClusterwideNetworkPolicy',
          String(name),
          `spec.ingress[${index}]`
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
        throw new ValidationError(
          `CiliumClusterwideNetworkPolicy egress rule ${index} must specify at least one destination`,
          'CiliumClusterwideNetworkPolicy',
          String(name),
          `spec.egress[${index}]`
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
