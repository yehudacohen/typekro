/** ESO ExternalSecret factory: syncs remote values into a Kubernetes Secret. */

import type { Composable, Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import { EXTERNAL_SECRETS_API_VERSION } from '../constants.js';
import type { ExternalSecretConfig, ExternalSecretSpec, ExternalSecretStatus } from '../types.js';
import { externalSecretReadinessEvaluator } from './readiness.js';

/**
 * Create an ExternalSecret.
 *
 * @example
 * ```typescript
 * const secret = externalSecret({
 *   name: 'database',
 *   namespace: 'app',
 *   spec: {
 *     secretStoreRef: { kind: 'ClusterSecretStore', name: 'aws-secrets-manager' },
 *     refreshInterval: '1h',
 *     target: { name: 'database' },
 *     data: [{ secretKey: 'password', remoteRef: { key: 'app/database', property: 'password' } }],
 *   },
 * });
 * ```
 */
export function externalSecret(
  config: Composable<ExternalSecretConfig>
): Enhanced<ExternalSecretSpec, ExternalSecretStatus> {
  return createResource(
    {
      apiVersion: EXTERNAL_SECRETS_API_VERSION,
      kind: 'ExternalSecret',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
      },
      spec: config.spec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced' }
  ).withReadinessEvaluator(externalSecretReadinessEvaluator) as Enhanced<
    ExternalSecretSpec,
    ExternalSecretStatus
  >;
}
