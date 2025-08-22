import type { V1CertificateSigningRequest } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1CertificateSigningRequestSpec = NonNullable<V1CertificateSigningRequest['spec']>;
export type V1CertificateSigningRequestStatus = NonNullable<V1CertificateSigningRequest['status']>;

export function certificateSigningRequest(
  resource: V1CertificateSigningRequest
): Enhanced<V1CertificateSigningRequestSpec, V1CertificateSigningRequestStatus> {
  return createResource({
    ...resource,
    apiVersion: 'certificates.k8s.io/v1',
    kind: 'CertificateSigningRequest',
    metadata: resource.metadata ?? { name: 'unnamed-csr' },
  }).withReadinessEvaluator((liveResource: V1CertificateSigningRequest) => {
    const status = liveResource.status;

    if (!status) {
      return {
        ready: false,
        reason: 'StatusMissing',
        message: 'CertificateSigningRequest status not available yet',
      };
    }

    const conditions = status.conditions || [];
    const approved = conditions.find((c) => c.type === 'Approved');
    const denied = conditions.find((c) => c.type === 'Denied');
    const certificate = status.certificate;

    if (denied?.status === 'True') {
      return {
        ready: false,
        reason: 'Denied',
        message: `CertificateSigningRequest was denied: ${denied.message || 'No reason provided'}`,
      };
    }

    if (approved?.status === 'True' && certificate) {
      return {
        ready: true,
        message: 'CertificateSigningRequest is approved and certificate is issued',
      };
    }

    if (approved?.status === 'True' && !certificate) {
      return {
        ready: false,
        reason: 'CertificatePending',
        message: 'CertificateSigningRequest is approved but certificate not yet issued',
      };
    }

    return {
      ready: false,
      reason: 'PendingApproval',
      message: 'CertificateSigningRequest is pending approval',
    };
  });
}
