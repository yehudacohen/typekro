import type { V1MutatingWebhookConfiguration } from '@kubernetes/client-node';

import { createResource } from '../../shared.js';

export type V1MutatingWebhookConfigurationWebhooks = NonNullable<
  V1MutatingWebhookConfiguration['webhooks']
>;

export function mutatingWebhookConfiguration(resource: V1MutatingWebhookConfiguration) {
  return createResource({
    ...resource,
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'MutatingWebhookConfiguration',
    metadata: resource.metadata ?? { name: 'unnamed-mutatingwebhook' },
  }).withReadinessEvaluator(() => ({
    ready: true,
    message: 'MutatingWebhookConfiguration is ready (immediately ready resource)',
  }));
}
