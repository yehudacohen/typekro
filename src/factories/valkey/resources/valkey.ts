/**
 * Hyperspike Valkey Cluster Factory
 *
 * Creates a Valkey CRD resource representing a Valkey cluster
 * managed by the Hyperspike operator.
 */

import { createConditionBasedReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { ValkeyConfig, ValkeyStatus } from '../types.js';

/** Base condition-based evaluator for Valkey Ready condition. */
const baseValkeyEvaluator = createConditionBasedReadinessEvaluator({ kind: 'Valkey' });

/**
 * Valkey Readiness Evaluator
 *
 * Checks the standard Ready condition first. If status has a top-level
 * `ready` boolean (Hyperspike pattern), uses that as a fast path.
 * Falls back to condition-based evaluation for detailed state.
 */
function valkeyReadinessEvaluator(liveResource: unknown): ResourceStatus {
  const resource = liveResource as { status?: ValkeyStatus } | null | undefined;
  const status = resource?.status;

  if (!status) {
    return {
      ready: false,
      message: 'Valkey cluster has no status yet',
      reason: 'StatusMissing',
    };
  }

  // Fast path: Hyperspike reports a top-level ready boolean
  if (status.ready === true) {
    return {
      ready: true,
      message: 'Valkey cluster is ready',
      reason: 'Ready',
    };
  }

  if (status.ready === false) {
    // Check conditions for a more specific reason
    const readyCondition = status.conditions?.find((c) => c.type === 'Ready');
    if (readyCondition) {
      return {
        ready: false,
        message: readyCondition.message || 'Valkey cluster is not ready',
        reason: readyCondition.reason || 'NotReady',
      };
    }
    return {
      ready: false,
      message: 'Valkey cluster is not ready',
      reason: 'NotReady',
    };
  }

  // Fall back to condition-based evaluation
  return baseValkeyEvaluator(liveResource);
}

/**
 * Hyperspike Valkey Cluster Factory
 *
 * Creates a Valkey cluster managed by the Hyperspike operator. Supports
 * sharded clusters with optional replication, TLS, external access via
 * Envoy proxy or LoadBalancer, and Prometheus monitoring.
 *
 * @param config - Valkey cluster configuration following hyperspike.io/v1 API
 * @returns Enhanced Valkey resource with readiness evaluation
 *
 * @example
 * ```typescript
 * const cache = valkey({
 *   name: 'app-cache',
 *   namespace: 'default',
 *   spec: {
 *     shards: 3,
 *     replicas: 1,
 *     storage: {
 *       storageClassName: 'gp3',
 *       resources: { requests: { storage: '10Gi' } },
 *     },
 *     resources: {
 *       requests: { cpu: '250m', memory: '512Mi' },
 *       limits: { cpu: '1', memory: '2Gi' },
 *     },
 *     prometheus: true,
 *   },
 *   id: 'appCache',
 * });
 * ```
 */
function createValkeyResource(
  config: ValkeyConfig
): Enhanced<ValkeyConfig['spec'], ValkeyStatus> {
  return createResource(
    {
      apiVersion: 'hyperspike.io/v1',
      kind: 'Valkey',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
      },
      spec: config.spec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced' }
  ).withReadinessEvaluator(valkeyReadinessEvaluator) as Enhanced<
    ValkeyConfig['spec'],
    ValkeyStatus
  >;
}

export const valkey = createValkeyResource;
