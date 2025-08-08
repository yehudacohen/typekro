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
  });
}