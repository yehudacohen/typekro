/**
 * CloudNativePG Pooler Factory
 *
 * Creates a CNPG Pooler resource for PgBouncer connection pooling.
 */

import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { PoolerConfig, PoolerStatus } from '../types.js';

/**
 * Pooler Readiness Evaluator
 *
 * CNPG Pooler status varies by version. Some report `status.instances` and
 * `status.conditions`, others only report `status.secrets` once configured.
 * We check multiple signals:
 *   1. `status.ready === true` (if available)
 *   2. `status.instances >= 1` (if available)
 *   3. `status.secrets` populated (PgBouncer configured and connected to cluster)
 *   4. Condition-based fallback
 */
function poolerReadinessEvaluator(liveResource: unknown): ResourceStatus {
  const resource = liveResource as { status?: PoolerStatus & { secrets?: unknown } } | null | undefined;
  const status = resource?.status;

  if (!status) {
    return { ready: false, message: 'Pooler has no status yet', reason: 'StatusMissing' };
  }

  // Explicit ready field
  if (status.ready === true) {
    return { ready: true, message: 'Pooler is ready', reason: 'Ready' };
  }

  // Instance count check
  if (typeof status.instances === 'number' && status.instances >= 1) {
    return { ready: true, message: `Pooler has ${status.instances} instance(s)`, reason: 'Ready' };
  }

  // Secrets populated = PgBouncer is configured and connected
  if (status.secrets && typeof status.secrets === 'object' && Object.keys(status.secrets).length > 0) {
    return { ready: true, message: 'Pooler secrets configured', reason: 'Ready' };
  }

  // Condition-based fallback
  const readyCondition = status.conditions?.find((c) => c.type === 'Ready');
  if (readyCondition?.status === 'True') {
    return { ready: true, message: readyCondition.message || 'Pooler is ready', reason: 'Ready' };
  }
  if (readyCondition) {
    return { ready: false, message: readyCondition.message || 'Pooler is not ready', reason: readyCondition.reason || 'NotReady' };
  }

  return { ready: false, message: 'Pooler status incomplete', reason: 'Unknown' };
}

/**
 * CloudNativePG Pooler Factory
 *
 * Creates a PgBouncer connection pooler for a PostgreSQL cluster.
 * Supports session and transaction pooling modes.
 *
 * @param config - Pooler configuration following postgresql.cnpg.io/v1 API
 * @returns Enhanced Pooler resource with readiness evaluation
 *
 * @example
 * ```typescript
 * const pool = pooler({
 *   name: 'my-db-pooler',
 *   namespace: 'databases',
 *   spec: {
 *     cluster: { name: 'my-database' },
 *     type: 'rw',
 *     instances: 2,
 *     pgbouncer: {
 *       poolMode: 'transaction',
 *       parameters: { default_pool_size: '25' },
 *     },
 *   },
 *   id: 'dbPooler',
 * });
 * ```
 */
function createPoolerResource(
  config: Composable<PoolerConfig>
): Enhanced<PoolerConfig['spec'], PoolerStatus> {
  const fullConfig = {
    ...config,
    spec: {
      ...config.spec,
      instances: config.spec.instances ?? 1,
      pgbouncer: {
        poolMode: 'session',
        ...config.spec.pgbouncer,
      },
    },
  };

  return createResource(
    {
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'Pooler',
      metadata: {
        name: fullConfig.name,
        ...(fullConfig.namespace && { namespace: fullConfig.namespace }),
      },
      spec: fullConfig.spec,
      ...(fullConfig.id && { id: fullConfig.id }),
    },
    { scope: 'namespaced', dnsAddressable: true }
  ).withReadinessEvaluator(poolerReadinessEvaluator) as Enhanced<
    PoolerConfig['spec'],
    PoolerStatus
  >;
}

export const pooler = createPoolerResource;
