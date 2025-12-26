// Cert-Manager Issuer Resources
import { createResource } from '../../shared.js';
import type { Enhanced } from '../../../core/types/index.js';
import type { ClusterIssuerConfig, IssuerConfig, IssuerStatus } from '../types.js';

/**
 * ClusterIssuer Readiness Evaluator
 *
 * Evaluates the readiness of a cert-manager ClusterIssuer resource based on its status conditions.
 * A ClusterIssuer is considered ready when it has a "Ready" condition with status "True".
 *
 * @param liveResource - The entire ClusterIssuer resource from Kubernetes
 * @returns ResourceStatus indicating if the issuer is ready
 */
function clusterIssuerReadinessEvaluator(liveResource: any): {
  ready: boolean;
  message: string;
  reason?: string;
} {
  // Extract status from the live resource
  const status = liveResource?.status as IssuerStatus | undefined;

  // Check if status exists
  if (!status) {
    return {
      ready: false,
      message: 'ClusterIssuer status not available',
      reason: 'StatusMissing',
    };
  }

  // Check if conditions exist
  if (!status.conditions || status.conditions.length === 0) {
    return {
      ready: false,
      message: 'ClusterIssuer conditions not available',
      reason: 'ConditionsMissing',
    };
  }

  // Look for Ready condition
  const readyCondition = status.conditions.find((condition) => condition.type === 'Ready');

  if (!readyCondition) {
    return {
      ready: false,
      message: 'ClusterIssuer Ready condition not found',
      reason: 'ReadyConditionMissing',
    };
  }

  // Check Ready condition status
  if (readyCondition.status === 'True') {
    return {
      ready: true,
      message: `ClusterIssuer is ready: ${readyCondition.message || 'Issuer is ready to issue certificates'}`,
      reason: 'Ready',
    };
  }

  // ClusterIssuer is not ready
  return {
    ready: false,
    message: `ClusterIssuer is not ready: ${readyCondition.message || readyCondition.reason || 'Unknown reason'}`,
    reason: readyCondition.reason || 'NotReady',
  };
}

/**
 * Issuer Readiness Evaluator
 *
 * Evaluates the readiness of a cert-manager Issuer resource based on its status conditions.
 * An Issuer is considered ready when it has a "Ready" condition with status "True".
 *
 * @param liveResource - The entire Issuer resource from Kubernetes
 * @returns ResourceStatus indicating if the issuer is ready
 */
function issuerReadinessEvaluator(liveResource: any): {
  ready: boolean;
  message: string;
  reason?: string;
} {
  // Extract status from the live resource
  const status = liveResource?.status as IssuerStatus | undefined;

  // Check if status exists
  if (!status) {
    return {
      ready: false,
      message: 'Issuer status not available',
      reason: 'StatusMissing',
    };
  }

  // Check if conditions exist
  if (!status.conditions || status.conditions.length === 0) {
    return {
      ready: false,
      message: 'Issuer conditions not available',
      reason: 'ConditionsMissing',
    };
  }

  // Look for Ready condition
  const readyCondition = status.conditions.find((condition) => condition.type === 'Ready');

  if (!readyCondition) {
    return {
      ready: false,
      message: 'Issuer Ready condition not found',
      reason: 'ReadyConditionMissing',
    };
  }

  // Check Ready condition status
  if (readyCondition.status === 'True') {
    return {
      ready: true,
      message: `Issuer is ready: ${readyCondition.message || 'Issuer is ready to issue certificates'}`,
      reason: 'Ready',
    };
  }

  // Issuer is not ready
  return {
    ready: false,
    message: `Issuer is not ready: ${readyCondition.message || readyCondition.reason || 'Unknown reason'}`,
    reason: readyCondition.reason || 'NotReady',
  };
}

/**
 * ClusterIssuer Factory Function
 *
 * Creates a cert-manager ClusterIssuer resource with comprehensive configuration options.
 * Supports all issuer types including ACME, CA, Vault, Venafi, and self-signed issuers.
 *
 * Features:
 * - Full cert-manager.io/v1 API support
 * - Embedded readiness evaluator for issuer lifecycle tracking
 * - Support for all major certificate authorities and ACME providers
 * - Comprehensive DNS01 and HTTP01 challenge solver configuration
 * - Cluster-wide certificate issuance capabilities
 *
 * @param config - ClusterIssuer configuration following cert-manager.io/v1 API
 * @returns Enhanced ClusterIssuer resource with readiness evaluation
 *
 * @example
 * ```typescript
 * // Self-signed issuer
 * const selfSigned = clusterIssuer({
 *   name: 'selfsigned-issuer',
 *   spec: {
 *     selfSigned: {}
 *   }
 * });
 *
 * // Let's Encrypt with HTTP01 challenge
 * const letsEncrypt = clusterIssuer({
 *   name: 'letsencrypt-prod',
 *   spec: {
 *     acme: {
 *       server: 'https://acme-v02.api.letsencrypt.org/directory',
 *       email: 'admin@example.com',
 *       privateKeySecretRef: { name: 'letsencrypt-prod' },
 *       solvers: [{
 *         http01: {
 *           ingress: { class: 'nginx' }
 *         }
 *       }]
 *     }
 *   }
 * });
 * ```
 */
export function clusterIssuer(
  config: ClusterIssuerConfig
): Enhanced<ClusterIssuerConfig['spec'], IssuerStatus> {
  return createResource(
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'ClusterIssuer',
      metadata: {
        name: config.name,
      },
      spec: config.spec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(clusterIssuerReadinessEvaluator) as Enhanced<
    ClusterIssuerConfig['spec'],
    IssuerStatus
  >;
}

/**
 * Issuer Factory Function
 *
 * Creates a cert-manager Issuer resource with comprehensive configuration options.
 * Supports all issuer types including ACME, CA, Vault, Venafi, and self-signed issuers.
 *
 * Features:
 * - Full cert-manager.io/v1 API support
 * - Embedded readiness evaluator for issuer lifecycle tracking
 * - Support for all major certificate authorities and ACME providers
 * - Comprehensive DNS01 and HTTP01 challenge solver configuration
 * - Namespace-scoped certificate issuance capabilities
 *
 * @param config - Issuer configuration following cert-manager.io/v1 API
 * @returns Enhanced Issuer resource with readiness evaluation
 *
 * @example
 * ```typescript
 * // Namespace-scoped CA issuer
 * const caIssuer = issuer({
 *   name: 'ca-issuer',
 *   namespace: 'default',
 *   spec: {
 *     ca: {
 *       secretName: 'ca-key-pair'
 *     }
 *   }
 * });
 * ```
 */
export function issuer(config: IssuerConfig): Enhanced<IssuerConfig['spec'], IssuerStatus> {
  return createResource({
    apiVersion: 'cert-manager.io/v1',
    kind: 'Issuer',
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
    },
    spec: config.spec,
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(issuerReadinessEvaluator) as Enhanced<
    IssuerConfig['spec'],
    IssuerStatus
  >;
}
