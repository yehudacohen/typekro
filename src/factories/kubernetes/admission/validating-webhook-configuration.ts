import type { V1ValidatingWebhookConfiguration } from '@kubernetes/client-node';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import { createResource } from '../../shared.js';

export type V1ValidatingWebhookConfigurationWebhooks = NonNullable<
  V1ValidatingWebhookConfiguration['webhooks']
>;

export function validatingWebhookConfiguration(
  resource: V1ValidatingWebhookConfiguration & { id?: string }
) {
  return createResource({
    ...resource,
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingWebhookConfiguration',
    metadata: resource.metadata ?? { name: 'unnamed-validatingwebhook' },
  }).withReadinessEvaluator(createAlwaysReadyEvaluator('ValidatingWebhookConfiguration'));
}
