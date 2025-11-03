// Cert-Manager Challenge and Order Resources
import { createResource } from '../../shared.js';
import type { Enhanced } from '../../../core/types/index.js';
import type { ChallengeConfig, OrderConfig, ChallengeStatus, OrderStatus } from '../types.js';

/**
 * Challenge Readiness Evaluator
 * 
 * Evaluates the readiness of a cert-manager Challenge resource based on its status.
 * A Challenge is considered ready when it has been successfully completed (state: 'valid').
 * 
 * @param liveResource - The entire Challenge resource from Kubernetes
 * @returns ResourceStatus indicating if the challenge is ready
 */
function challengeReadinessEvaluator(liveResource: any): { ready: boolean; message: string; reason?: string } {
  // Extract status from the live resource
  const status = liveResource?.status as ChallengeStatus | undefined;

  // Check if status exists
  if (!status) {
    return {
      ready: false,
      message: 'Challenge status not available',
      reason: 'StatusMissing'
    };
  }

  // Check challenge state
  const state = status.state;
  
  if (state === 'valid') {
    return {
      ready: true,
      message: 'Challenge completed successfully',
      reason: 'ChallengeCompleted'
    };
  }

  if (state === 'invalid' || state === 'errored') {
    return {
      ready: false,
      message: `Challenge failed: ${status.reason || 'Unknown error'}`,
      reason: 'ChallengeFailed'
    };
  }

  if (state === 'processing' || status.processing) {
    return {
      ready: false,
      message: 'Challenge is being processed',
      reason: 'Processing'
    };
  }

  if (state === 'pending' || state === 'ready') {
    return {
      ready: false,
      message: `Challenge is ${state}: waiting for completion`,
      reason: 'Pending'
    };
  }

  // Default case for unknown states
  return {
    ready: false,
    message: `Challenge state: ${state || 'unknown'}`,
    reason: 'Unknown'
  };
}

/**
 * Challenge Factory Function
 * 
 * Creates a cert-manager Challenge resource for ACME challenge processing.
 * Supports both HTTP01 and DNS01 challenge types with comprehensive solver configuration.
 * 
 * Features:
 * - Full acme.cert-manager.io/v1 API support
 * - Embedded readiness evaluator for challenge lifecycle tracking
 * - Support for HTTP01 and DNS01 challenge types
 * - Comprehensive DNS provider configuration for DNS01 challenges
 * - ACME challenge completion tracking
 * 
 * @param config - Challenge configuration following acme.cert-manager.io/v1 API
 * @returns Enhanced Challenge resource with readiness evaluation
 * 
 * @example
 * ```typescript
 * // HTTP01 Challenge
 * const httpChallenge = challenge({
 *   name: 'http-challenge',
 *   namespace: 'default',
 *   spec: {
 *     url: 'https://acme-v02.api.letsencrypt.org/acme/chall-v3/12345',
 *     authorizationURL: 'https://acme-v02.api.letsencrypt.org/acme/authz-v3/12345',
 *     dnsName: 'example.com',
 *     type: 'HTTP-01',
 *     token: 'challenge-token',
 *     key: 'challenge-key',
 *     solver: {
 *       http01: {
 *         ingress: { class: 'nginx' }
 *       }
 *     },
 *     issuerRef: {
 *       name: 'letsencrypt-prod',
 *       kind: 'ClusterIssuer'
 *     }
 *   },
 *   id: 'httpChallenge'
 * });
 * 
 * // DNS01 Challenge
 * const dnsChallenge = challenge({
 *   name: 'dns-challenge',
 *   namespace: 'default',
 *   spec: {
 *     url: 'https://acme-v02.api.letsencrypt.org/acme/chall-v3/67890',
 *     authorizationURL: 'https://acme-v02.api.letsencrypt.org/acme/authz-v3/67890',
 *     dnsName: '*.example.com',
 *     wildcard: true,
 *     type: 'DNS-01',
 *     token: 'dns-challenge-token',
 *     key: 'dns-challenge-key',
 *     solver: {
 *       dns01: {
 *         cloudflare: {
 *           apiTokenSecretRef: {
 *             name: 'cloudflare-api-token',
 *             key: 'api-token'
 *           }
 *         }
 *       }
 *     },
 *     issuerRef: {
 *       name: 'letsencrypt-prod',
 *       kind: 'ClusterIssuer'
 *     }
 *   },
 *   id: 'dnsChallenge'
 * });
 * ```
 */
export function challenge(config: ChallengeConfig): Enhanced<ChallengeConfig['spec'], ChallengeStatus> {
  // Apply defaults
  const fullConfig: ChallengeConfig = {
    ...config,
    spec: {
      ...config.spec,
      // Set default issuer group if not specified
      issuerRef: {
        group: 'cert-manager.io',
        ...config.spec.issuerRef,
      },
    },
  };

  return createResource({
    apiVersion: 'acme.cert-manager.io/v1',
    kind: 'Challenge',
    metadata: {
      name: fullConfig.name,
      ...(fullConfig.namespace && { namespace: fullConfig.namespace }),
    },
    spec: fullConfig.spec,
    ...(fullConfig.id && { id: fullConfig.id }),
  }).withReadinessEvaluator(challengeReadinessEvaluator) as Enhanced<ChallengeConfig['spec'], ChallengeStatus>;
}

/**
 * Order Readiness Evaluator
 * 
 * Evaluates the readiness of a cert-manager Order resource based on its status.
 * An Order is considered ready when it has been successfully completed (state: 'valid') and has a certificate.
 * 
 * @param liveResource - The entire Order resource from Kubernetes
 * @returns ResourceStatus indicating if the order is ready
 */
function orderReadinessEvaluator(liveResource: any): { ready: boolean; message: string; reason?: string } {
  // Extract status from the live resource
  const status = liveResource?.status as OrderStatus | undefined;

  // Check if status exists
  if (!status) {
    return {
      ready: false,
      message: 'Order status not available',
      reason: 'StatusMissing'
    };
  }

  // Check order state
  const state = status.state;
  
  if (state === 'valid' && status.certificate) {
    return {
      ready: true,
      message: 'Order completed successfully and certificate issued',
      reason: 'OrderCompleted'
    };
  }

  if (state === 'valid' && !status.certificate) {
    return {
      ready: false,
      message: 'Order is valid but certificate not yet available',
      reason: 'CertificatePending'
    };
  }

  if (state === 'invalid' || state === 'errored') {
    return {
      ready: false,
      message: `Order failed: ${status.reason || 'Unknown error'}`,
      reason: 'OrderFailed'
    };
  }

  if (state === 'processing') {
    const authCount = status.authorizations?.length || 0;
    return {
      ready: false,
      message: `Order is being processed (${authCount} authorizations)`,
      reason: 'Processing'
    };
  }

  if (state === 'pending' || state === 'ready') {
    return {
      ready: false,
      message: `Order is ${state}: waiting for completion`,
      reason: 'Pending'
    };
  }

  // Default case for unknown states
  return {
    ready: false,
    message: `Order state: ${state || 'unknown'}`,
    reason: 'Unknown'
  };
}

/**
 * Order Factory Function
 * 
 * Creates a cert-manager Order resource for ACME order processing.
 * Orders represent ACME certificate requests and manage the lifecycle of certificate issuance.
 * 
 * Features:
 * - Full acme.cert-manager.io/v1 API support
 * - Embedded readiness evaluator for order lifecycle tracking
 * - Support for ACME order fulfillment and certificate issuance
 * - Authorization and challenge management
 * - Certificate delivery tracking
 * 
 * @param config - Order configuration following acme.cert-manager.io/v1 API
 * @returns Enhanced Order resource with readiness evaluation
 * 
 * @example
 * ```typescript
 * const acmeOrder = order({
 *   name: 'certificate-order',
 *   namespace: 'default',
 *   spec: {
 *     request: 'LS0tLS1CRUdJTi...', // Base64 encoded CSR
 *     issuerRef: {
 *       name: 'letsencrypt-prod',
 *       kind: 'ClusterIssuer'
 *     },
 *     commonName: 'example.com',
 *     dnsNames: ['example.com', 'www.example.com'],
 *     duration: '2160h' // 90 days
 *   },
 *   id: 'acmeOrder'
 * });
 * ```
 */
export function order(config: OrderConfig): Enhanced<OrderConfig['spec'], OrderStatus> {
  // Apply defaults
  const fullConfig: OrderConfig = {
    ...config,
    spec: {
      ...config.spec,
      // Set default issuer group if not specified
      issuerRef: {
        group: 'cert-manager.io',
        ...config.spec.issuerRef,
      },
    },
  };

  return createResource({
    apiVersion: 'acme.cert-manager.io/v1',
    kind: 'Order',
    metadata: {
      name: fullConfig.name,
      ...(fullConfig.namespace && { namespace: fullConfig.namespace }),
    },
    spec: fullConfig.spec,
    ...(fullConfig.id && { id: fullConfig.id }),
  }).withReadinessEvaluator(orderReadinessEvaluator) as Enhanced<OrderConfig['spec'], OrderStatus>;
}