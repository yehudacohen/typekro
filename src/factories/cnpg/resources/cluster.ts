/**
 * CloudNativePG Cluster Factory
 *
 * Creates a CNPG Cluster resource representing a PostgreSQL cluster
 * managed by the CloudNativePG operator.
 */

import { createConditionBasedReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { ClusterConfig, ClusterStatus } from '../types.js';

/** Base condition-based evaluator for Cluster Ready condition. */
const baseClusterEvaluator = createConditionBasedReadinessEvaluator({ kind: 'Cluster' });

/**
 * Cluster Readiness Evaluator
 *
 * Checks both the standard Ready condition and the CNPG-specific `phase` field.
 * CNPG clusters report phase as a human-readable string rather than a standard
 * Kubernetes condition in some cases.
 */
function clusterReadinessEvaluator(liveResource: unknown): ResourceStatus {
  const resource = liveResource as { status?: ClusterStatus } | null | undefined;
  const status = resource?.status;

  if (!status) {
    return {
      ready: false,
      message: 'Cluster has no status yet',
      reason: 'StatusMissing',
    };
  }

  // Check phase-based readiness (CNPG-specific)
  const phase = status.phase;
  if (phase === 'Cluster in healthy state') {
    return {
      ready: true,
      message: `Cluster is healthy (${status.readyInstances ?? 0}/${status.instances ?? 0} instances ready)`,
      reason: 'Healthy',
    };
  }

  if (phase === 'Setting up primary') {
    return {
      ready: false,
      message: 'Cluster is setting up the primary instance',
      reason: 'SettingUpPrimary',
    };
  }

  if (phase === 'Creating replica') {
    return {
      ready: false,
      message: `Creating replicas (${status.readyInstances ?? 0}/${status.instances ?? 0} ready)`,
      reason: 'CreatingReplica',
    };
  }

  if (phase === 'Failing over' || phase === 'Switchover in progress') {
    return {
      ready: false,
      message: `Cluster is performing failover: ${phase}`,
      reason: 'Failover',
    };
  }

  // Fall back to condition-based evaluation
  return baseClusterEvaluator(liveResource);
}

/**
 * CloudNativePG Cluster Factory
 *
 * Creates a PostgreSQL cluster managed by the CNPG operator. Supports
 * single-instance and multi-replica configurations with full backup,
 * monitoring, and high-availability features.
 *
 * @param config - Cluster configuration following postgresql.cnpg.io/v1 API
 * @returns Enhanced Cluster resource with readiness evaluation
 *
 * @example
 * ```typescript
 * const db = cluster({
 *   name: 'my-database',
 *   namespace: 'databases',
 *   spec: {
 *     instances: 3,
 *     storage: { size: '50Gi', storageClass: 'gp3' },
 *     postgresql: {
 *       parameters: { shared_buffers: '256MB' },
 *     },
 *     bootstrap: {
 *       initdb: { database: 'myapp', owner: 'myapp' },
 *     },
 *   },
 *   id: 'primaryDatabase',
 * });
 * ```
 */
function createClusterResource(
  config: ClusterConfig
): Enhanced<ClusterConfig['spec'], ClusterStatus> {
  const fullConfig: ClusterConfig = {
    ...config,
    spec: {
      ...config.spec,
      instances: config.spec.instances ?? 1,
      storage: {
        ...config.spec.storage,
        size: config.spec.storage?.size || '10Gi',
      },
    },
  };

  return createResource(
    {
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'Cluster',
      metadata: {
        name: fullConfig.name,
        ...(fullConfig.namespace && { namespace: fullConfig.namespace }),
      },
      spec: fullConfig.spec,
      ...(fullConfig.id && { id: fullConfig.id }),
    },
    { scope: 'namespaced' }
  ).withReadinessEvaluator(clusterReadinessEvaluator) as Enhanced<
    ClusterConfig['spec'],
    ClusterStatus
  >;
}

export const cluster = createClusterResource;
