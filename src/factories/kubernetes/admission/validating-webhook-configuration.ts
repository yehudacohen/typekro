import type { V1ValidatingWebhookConfiguration } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1ValidatingWebhookConfigurationWebhooks = NonNullable<
  V1ValidatingWebhookConfiguration['webhooks']
>;

export function validatingWebhookConfiguration(
  resource: V1ValidatingWebhookConfiguration
): Enhanced<V1ValidatingWebhookConfigurationWebhooks, unknown> {
  return createResource({
    ...resource,
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionWebhook',
    metadata: resource.metadata ?? { name: 'unnamed-validatingwebhook' },
  });
}
