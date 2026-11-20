/**
 * CloudNativePG ScheduledBackup Factory
 *
 * Creates a CNPG ScheduledBackup resource for cron-based automated backups.
 */

import {
  createConditionBasedReadinessEvaluator,
  registerPortableReadinessEvaluator,
} from '../../../core/readiness/index.js';
import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { ScheduledBackupConfig, ScheduledBackupStatus } from '../types.js';
import { assertPluginBackupConfigured } from '../utils/barman-cloud.js';

/** Base condition-based evaluator. */
const baseEvaluator = createConditionBasedReadinessEvaluator({ kind: 'ScheduledBackup' });

/**
 * ScheduledBackup readiness: ready once the operator has registered the schedule, not once it
 * has run.
 *
 * The CloudNativePG operator writes no conditions on a ScheduledBackup. On its first reconcile
 * of a schedule it sets `status.lastCheckTime` and waits for the first slot (with `immediate`
 * it also takes a backup and sets `lastScheduleTime` and `nextScheduleTime`), so
 * `lastCheckTime` is the signal that the schedule is registered. A nightly schedule is ready
 * minutes after it is created, not the next night. `status.error` (an admission validation
 * error) is not ready. A suspended schedule is never reconciled; it is reported ready with
 * reason `Suspended`, because the operator skips it on purpose. A `Ready` condition, if some
 * operator writes one, is honoured.
 *
 * @see https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.2/internal/controller/scheduledbackup_controller.go
 */
function scheduledBackupReadinessEvaluator(liveResource: unknown): ResourceStatus {
  const resource = liveResource as
    | { spec?: { suspend?: boolean }; status?: ScheduledBackupStatus & { error?: string } }
    | null
    | undefined;
  const status = resource?.status;
  if (status?.error) {
    return { ready: false, reason: 'ScheduleError', message: status.error };
  }
  if (resource?.spec?.suspend === true) {
    return {
      ready: true,
      reason: 'Suspended',
      message: 'Schedule is suspended; the operator takes no backups for it',
    };
  }
  const result = baseEvaluator(liveResource);
  if (result.ready || result.reason !== 'ConditionsMissing') return result;
  if (status?.lastCheckTime) {
    return {
      ready: true,
      reason: 'ScheduleRegistered',
      message: status.lastScheduleTime
        ? `Schedule is registered; last backup ${status.lastScheduleTime}`
        : `Schedule is registered (checked ${status.lastCheckTime}); no backup has run yet`,
    };
  }
  return {
    ready: false,
    reason: 'AwaitingOperator',
    message: 'The operator has not registered the schedule yet',
  };
}

registerPortableReadinessEvaluator(
  'typekro.readiness.cnpg.scheduled-backup',
  '1',
  scheduledBackupReadinessEvaluator
);

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
  config: Composable<ScheduledBackupConfig>
): Enhanced<ScheduledBackupConfig['spec'], ScheduledBackupStatus> {
  assertPluginBackupConfigured(config.spec, 'ScheduledBackup');
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
