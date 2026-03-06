// Cert-Manager Certificate Resources
import { createConditionBasedReadinessEvaluator } from '../../../core/readiness/evaluator-factories.js';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { CertificateConfig, CertificateStatus } from '../types.js';

/** Base condition-based evaluator for Certificate Ready condition. */
const baseCertificateEvaluator = createConditionBasedReadinessEvaluator({ kind: 'Certificate' });

/**
 * Certificate Readiness Evaluator
 *
 * Delegates to the standard condition-based evaluator, but when the Ready
 * condition is missing, checks for an "Issuing" condition to provide a
 * more informative intermediate-state message.
 */
function certificateReadinessEvaluator(liveResource: unknown): ResourceStatus {
  const result = baseCertificateEvaluator(liveResource);

  // When Ready condition is missing, check for Issuing condition
  if (!result.ready && result.reason === 'ReadyConditionMissing') {
    const resource = liveResource as { status?: CertificateStatus } | null | undefined;
    const issuingCondition = resource?.status?.conditions?.find((c) => c.type === 'Issuing');
    if (issuingCondition && issuingCondition.status === 'True') {
      return {
        ready: false,
        message: `Certificate is being issued: ${issuingCondition.message || 'Certificate issuance in progress'}`,
        reason: 'Issuing',
      };
    }
  }

  return result;
}

/**
 * Certificate Factory Function
 *
 * Creates a cert-manager Certificate resource with comprehensive configuration options.
 * Supports all certificate types including TLS, client authentication, and code signing certificates.
 *
 * Features:
 * - Full cert-manager.io/v1 API support
 * - Embedded readiness evaluator for certificate lifecycle tracking
 * - Support for ACME, CA, Vault, and other issuer types
 * - Advanced certificate configuration (SAN, key usage, keystores)
 * - Certificate renewal and lifecycle management
 *
 * @param config - Certificate configuration following cert-manager.io/v1 API
 * @returns Enhanced Certificate resource with readiness evaluation
 *
 * @example
 * ```typescript
 * const tlsCert = certificate({
 *   name: 'my-tls-cert',
 *   namespace: 'default',
 *   spec: {
 *     secretName: 'my-tls-secret',
 *     dnsNames: ['example.com', 'www.example.com'],
 *     issuerRef: {
 *       name: 'letsencrypt-prod',
 *       kind: 'ClusterIssuer'
 *     }
 *   },
 *   id: 'tlsCertificate'
 * });
 * ```
 */
function createCertificateResource(
  config: CertificateConfig
): Enhanced<CertificateConfig['spec'], CertificateStatus> {
  // Apply defaults
  const fullConfig: CertificateConfig = {
    ...config,
    spec: {
      ...config.spec,
      // Set default issuer group if not specified
      issuerRef: {
        group: 'cert-manager.io',
        ...config.spec.issuerRef,
      },
      // Set default private key algorithm if not specified
      privateKey: {
        algorithm: 'RSA',
        size: 2048,
        ...config.spec.privateKey,
      },
      // Set default duration if not specified (90 days)
      duration: config.spec.duration || '2160h',
      // Set default renewBefore if not specified (30 days)
      renewBefore: config.spec.renewBefore || '720h',
    },
  };

  return createResource(
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: {
        name: fullConfig.name,
        ...(fullConfig.namespace && { namespace: fullConfig.namespace }),
      },
      spec: fullConfig.spec,
      ...(fullConfig.id && { id: fullConfig.id }),
    },
    { scope: 'namespaced' }
  ).withReadinessEvaluator(certificateReadinessEvaluator) as Enhanced<
    CertificateConfig['spec'],
    CertificateStatus
  >;
}

export const certificate = createCertificateResource;
