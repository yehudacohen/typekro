import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type {
  OathkeeperRuleConfig,
  OathkeeperRuleSpec,
  OathkeeperRuleStatus,
  OryOathkeeperRuleFactory,
} from '../types.js';

export const oathkeeperRule: OryOathkeeperRuleFactory = (
  config
): Enhanced<OathkeeperRuleSpec, OathkeeperRuleStatus> =>
  createResource<OathkeeperRuleSpec, OathkeeperRuleStatus>({
    ...(config.id && { id: config.id }),
    apiVersion: 'oathkeeper.ory.sh/v1alpha1',
    kind: 'Rule',
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
    },
    spec: Object.fromEntries(
      Object.entries(config.spec).filter(([, value]) => value !== undefined)
    ) as OathkeeperRuleSpec,
  }).withReadinessEvaluator((resource: unknown) => {
    const validation = (resource as { status?: OathkeeperRuleStatus }).status?.validation;

    return {
      ready: validation?.valid === true,
      message:
        validation?.validationError ??
        (validation?.valid === true ? 'Oathkeeper Rule is valid' : 'Oathkeeper Rule is not valid'),
    };
  });

export type { OathkeeperRuleConfig, OathkeeperRuleSpec, OathkeeperRuleStatus };
