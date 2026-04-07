/**
 * CloudNativePG Cluster Factory
 *
 * Creates a CNPG Cluster resource representing a PostgreSQL cluster
 * managed by the CloudNativePG operator.
 */

import { createConditionBasedReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { ClusterConfig, ClusterStatus } from '../types.js';

/**
 * Known CNPG cluster phase strings.
 *
 * These are human-readable strings from the CNPG operator status.phase field.
 * Extracted as constants for maintainability — if CNPG changes these strings
 * in a future operator release, updates are centralized here.
 */
export const CNPG_CLUSTER_PHASES = {
  HEALTHY: 'Cluster in healthy state',
  SETTING_UP_PRIMARY: 'Setting up primary',
  CREATING_REPLICA: 'Creating replica',
  FAILING_OVER: 'Failing over',
  SWITCHOVER: 'Switchover in progress',
} as const;

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

  const phase = status.phase;

  if (phase === CNPG_CLUSTER_PHASES.HEALTHY) {
    return {
      ready: true,
      message: `Cluster is healthy (${status.readyInstances ?? 0}/${status.instances ?? 0} instances ready)`,
      reason: 'Healthy',
    };
  }

  if (phase === CNPG_CLUSTER_PHASES.SETTING_UP_PRIMARY) {
    return {
      ready: false,
      message: 'Cluster is setting up the primary instance',
      reason: 'SettingUpPrimary',
    };
  }

  if (phase === CNPG_CLUSTER_PHASES.CREATING_REPLICA) {
    return {
      ready: false,
      message: `Creating replicas (${status.readyInstances ?? 0}/${status.instances ?? 0} ready)`,
      reason: 'CreatingReplica',
    };
  }

  if (phase === CNPG_CLUSTER_PHASES.FAILING_OVER || phase === CNPG_CLUSTER_PHASES.SWITCHOVER) {
    return {
      ready: false,
      message: `Cluster is performing failover: ${phase}`,
      reason: 'Failover',
    };
  }

  // Fall back to condition-based evaluation for unknown phases
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
  config: Composable<ClusterConfig>
): Enhanced<ClusterConfig['spec'], ClusterStatus> {
  const fullConfig = {
    ...config,
    spec: {
      ...config.spec,
      instances: config.spec.instances ?? 1,
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
    { scope: 'namespaced', dnsAddressable: true }
  ).withReadinessEvaluator(clusterReadinessEvaluator) as Enhanced<
    ClusterConfig['spec'],
    ClusterStatus
  >;
}

export const cluster = createClusterResource;
