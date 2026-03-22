/**
 * CloudNativePG ScheduledBackup Factory
 *
 * Creates a CNPG ScheduledBackup resource for cron-based automated backups.
 */

import { createConditionBasedReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { ScheduledBackupConfig, ScheduledBackupStatus } from '../types.js';

/** Base condition-based evaluator. */
const baseEvaluator = createConditionBasedReadinessEvaluator({ kind: 'ScheduledBackup' });

/**
 * ScheduledBackup Readiness Evaluator
 *
 * Checks standard Ready condition. If no conditions exist, checks whether
 * the schedule has been evaluated (lastScheduleTime) as a proxy for readiness.
 */
function scheduledBackupReadinessEvaluator(liveResource: unknown): ResourceStatus {
  const result = baseEvaluator(liveResource);

  // If conditions are missing but the schedule is running, consider it ready
  if (!result.ready && result.reason === 'ConditionsMissing') {
    const resource = liveResource as { status?: ScheduledBackupStatus } | null | undefined;
    if (resource?.status?.lastScheduleTime) {
      return {
        ready: true,
        message: `Schedule is active, last run: ${resource.status.lastScheduleTime}`,
        reason: 'ScheduleActive',
      };
    }
  }

  return result;
}

/**
 * CloudNativePG ScheduledBackup Factory
 *
 * Creates a cron-scheduled backup for a PostgreSQL cluster.
 * Uses robfig/cron format with seconds: 'second minute hour day month day-of-week'.
 *
 * @param config - ScheduledBackup configuration following postgresql.cnpg.io/v1 API
 * @returns Enhanced ScheduledBackup resource with readiness evaluation
 *
 * @example
 * ```typescript
 * const nightlyBackup = scheduledBackup({
 *   name: 'nightly-backup',
 *   namespace: 'databases',
 *   spec: {
 *     cluster: { name: 'my-database' },
 *     schedule: '0 0 2 * * *',
 *     immediate: true,
 *     backupOwnerReference: 'cluster',
 *   },
 *   id: 'nightlyBackup',
 * });
 * ```
 */
function createScheduledBackupResource(
  config: ScheduledBackupConfig
): Enhanced<ScheduledBackupConfig['spec'], ScheduledBackupStatus> {
  return createResource(
    {
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'ScheduledBackup',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
      },
      spec: config.spec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced' }
  ).withReadinessEvaluator(scheduledBackupReadinessEvaluator) as Enhanced<
    ScheduledBackupConfig['spec'],
    ScheduledBackupStatus
  >;
}

export const scheduledBackup = createScheduledBackupResource;
