import type { V1MutatingWebhookConfiguration } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1MutatingWebhookConfigurationWebhooks = NonNullable<
  V1MutatingWebhookConfiguration['webhooks']
>;

export function mutatingWebhookConfiguration(
  resource: V1MutatingWebhookConfiguration
): Enhanced<V1MutatingWebhookConfigurationWebhooks, unknown> {
  return createResource({
    ...resource,
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'MutatingAdmissionWebhook',
    metadata: resource.metadata ?? { name: 'unnamed-mutatingwebhook' },
  });
}
