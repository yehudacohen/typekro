// Cert-Manager Issuer Resources
import { createConditionBasedReadinessEvaluator } from '../../../core/readiness/evaluator-factories.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { ClusterIssuerConfig, IssuerConfig, IssuerStatus } from '../types.js';

/** Evaluates ClusterIssuer readiness via standard Ready condition check. */
const clusterIssuerReadinessEvaluator = createConditionBasedReadinessEvaluator({
  kind: 'ClusterIssuer',
});

/** Evaluates Issuer readiness via standard Ready condition check. */
const issuerReadinessEvaluator = createConditionBasedReadinessEvaluator({
  kind: 'Issuer',
});

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
