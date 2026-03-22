/**
 * CloudNativePG Pooler Factory
 *
 * Creates a CNPG Pooler resource for PgBouncer connection pooling.
 */

import { createConditionBasedReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { PoolerConfig, PoolerStatus } from '../types.js';

/** Condition-based readiness evaluator for Pooler Ready condition. */
const poolerEvaluator = createConditionBasedReadinessEvaluator({ kind: 'Pooler' });

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
  config: PoolerConfig
): Enhanced<PoolerConfig['spec'], PoolerStatus> {
  const fullConfig: PoolerConfig = {
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
    { scope: 'namespaced' }
  ).withReadinessEvaluator(poolerEvaluator) as Enhanced<
    PoolerConfig['spec'],
    PoolerStatus
  >;
}

export const pooler = createPoolerResource;
