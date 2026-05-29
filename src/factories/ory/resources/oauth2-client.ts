import type { Enhanced, KubernetesCondition } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type {
  OAuth2ClientConfig,
  OAuth2ClientSpec,
  OAuth2ClientStatus,
  OryOAuth2ClientFactory,
} from '../types.js';

export const oauth2Client: OryOAuth2ClientFactory = (
  config
): Enhanced<OAuth2ClientSpec, OAuth2ClientStatus> =>
  createResource<OAuth2ClientSpec, OAuth2ClientStatus>({
    ...(config.id && { id: config.id }),
    apiVersion: 'hydra.ory.sh/v1alpha1',
    kind: 'OAuth2Client',
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
    },
    spec: Object.fromEntries(
      Object.entries(config.spec).filter(([, value]) => value !== undefined)
    ) as OAuth2ClientSpec,
  }).withReadinessEvaluator((resource: unknown) => {
    const status = (resource as { status?: OAuth2ClientStatus }).status;
    const ready = status?.conditions?.some(
      (condition: KubernetesCondition) => condition.type === 'Ready' && condition.status === 'True'
    );
    const error = status?.reconciliationError?.description;

    return {
      ready: !!ready && !error,
      message: error ?? (ready ? 'OAuth2Client is ready' : 'OAuth2Client is not ready'),
    };
  });

export type { OAuth2ClientConfig, OAuth2ClientSpec, OAuth2ClientStatus };
