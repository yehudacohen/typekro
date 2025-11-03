// Cert-Manager Certificate Resources
import { createResource } from '../../shared.js';
import type { Enhanced } from '../../../core/types/index.js';
import type { CertificateConfig, CertificateStatus } from '../types.js';

/**
 * Certificate Readiness Evaluator
 *
 * Evaluates the readiness of a cert-manager Certificate resource based on its status conditions.
 * A Certificate is considered ready when it has a "Ready" condition with status "True".
 *
 * @param liveResource - The entire Certificate resource from Kubernetes
 * @returns ResourceStatus indicating if the certificate is ready
 */
function certificateReadinessEvaluator(liveResource: any): {
  ready: boolean;
  message: string;
  reason?: string;
} {
  // Extract status from the live resource
  const status = liveResource?.status as CertificateStatus | undefined;

  // Check if status exists
  if (!status) {
    return {
      ready: false,
      message: 'Certificate status not available',
      reason: 'StatusMissing',
    };
  }

  // Check if conditions exist
  if (!status.conditions || status.conditions.length === 0) {
    return {
      ready: false,
      message: 'Certificate conditions not available',
      reason: 'ConditionsMissing',
    };
  }

  // Look for Ready condition
  const readyCondition = status.conditions.find((condition) => condition.type === 'Ready');

  if (!readyCondition) {
    // Check for Issuing condition if Ready is not present
    const issuingCondition = status.conditions.find((condition) => condition.type === 'Issuing');
    if (issuingCondition && issuingCondition.status === 'True') {
      return {
        ready: false,
        message: `Certificate is being issued: ${issuingCondition.message || 'Certificate issuance in progress'}`,
        reason: 'Issuing',
      };
    }

    return {
      ready: false,
      message: 'Certificate Ready condition not found',
      reason: 'ReadyConditionMissing',
    };
  }

  // Check Ready condition status
  if (readyCondition.status === 'True') {
    return {
      ready: true,
      message: `Certificate is ready: ${readyCondition.message || 'Certificate is up to date and has not expired'}`,
      reason: 'Ready',
    };
  }

  // Certificate is not ready
  return {
    ready: false,
    message: `Certificate is not ready: ${readyCondition.message || readyCondition.reason || 'Unknown reason'}`,
    reason: readyCondition.reason || 'NotReady',
  };
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
