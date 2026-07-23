import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced, KubernetesCondition } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type {
  OAuth2ClientConfig,
  OAuth2ClientSpec,
  OAuth2ClientStatus,
  OryOAuth2ClientFactory,
} from '../types.js';

function oauth2ClientReadinessEvaluator(resource: unknown) {
  const status = (resource as { status?: OAuth2ClientStatus }).status;
  const ready = status?.conditions?.some(
    (condition: KubernetesCondition) => condition.type === 'Ready' && condition.status === 'True'
  );
  const error = status?.reconciliationError?.description;

  return {
    ready: !!ready && !error,
    message: error ?? (ready ? 'OAuth2Client is ready' : 'OAuth2Client is not ready'),
  };
}

registerPortableReadinessEvaluator(
  'typekro.readiness.ory.oauth2-client',
  '1',
  oauth2ClientReadinessEvaluator
);

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
  }).withReadinessEvaluator(oauth2ClientReadinessEvaluator);

export type { OAuth2ClientConfig, OAuth2ClientSpec, OAuth2ClientStatus };
