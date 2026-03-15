import type { V1MutatingWebhookConfiguration } from '@kubernetes/client-node';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import { createResource } from '../../shared.js';

export type V1MutatingWebhookConfigurationWebhooks = NonNullable<
  V1MutatingWebhookConfiguration['webhooks']
>;

export function mutatingWebhookConfiguration(
  resource: V1MutatingWebhookConfiguration & { id?: string }
) {
  return createResource({
    ...resource,
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'MutatingWebhookConfiguration',
    metadata: resource.metadata ?? { name: 'unnamed-mutatingwebhook' },
  }).withReadinessEvaluator(createAlwaysReadyEvaluator('MutatingWebhookConfiguration'));
}
