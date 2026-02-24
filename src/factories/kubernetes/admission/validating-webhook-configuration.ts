import type { V1ValidatingWebhookConfiguration } from '@kubernetes/client-node';

import { createResource } from '../../shared.js';

export type V1ValidatingWebhookConfigurationWebhooks = NonNullable<
  V1ValidatingWebhookConfiguration['webhooks']
>;

export function validatingWebhookConfiguration(resource: V1ValidatingWebhookConfiguration) {
  return createResource({
    ...resource,
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingWebhookConfiguration',
    metadata: resource.metadata ?? { name: 'unnamed-validatingwebhook' },
  }).withReadinessEvaluator(() => ({
    ready: true,
    message: 'ValidatingWebhookConfiguration is ready (immediately ready resource)',
  }));
}
