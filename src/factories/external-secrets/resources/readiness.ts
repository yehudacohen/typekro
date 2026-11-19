// Readiness for ESO resources: each reports a `Ready` condition.

import {
  createConditionBasedReadinessEvaluator,
  registerPortableReadinessEvaluator,
} from '../../../core/readiness/index.js';

/** A store is Ready once ESO validated it against the provider (reason `Valid`). */
export const secretStoreReadinessEvaluator = registerPortableReadinessEvaluator(
  'typekro.readiness.external-secrets.secret-store',
  '1',
  createConditionBasedReadinessEvaluator({ kind: 'SecretStore' })
);

export const clusterSecretStoreReadinessEvaluator = registerPortableReadinessEvaluator(
  'typekro.readiness.external-secrets.cluster-secret-store',
  '1',
  createConditionBasedReadinessEvaluator({ kind: 'ClusterSecretStore' })
);

/** An ExternalSecret is Ready once its target Secret is synced (reason `SecretSynced`). */
export const externalSecretReadinessEvaluator = registerPortableReadinessEvaluator(
  'typekro.readiness.external-secrets.external-secret',
  '1',
  createConditionBasedReadinessEvaluator({ kind: 'ExternalSecret' })
);
