/**
 * CloudNativePG Backup Factory
 *
 * Creates a CNPG Backup resource for on-demand PostgreSQL backups.
 */

import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { BackupConfig, BackupStatus } from '../types.js';

/**
 * Backup Readiness Evaluator
 *
 * CNPG Backups use a phase-based status model rather than conditions.
 * Phases: new → started → completed (or failed).
 */
function backupReadinessEvaluator(liveResource: unknown): ResourceStatus {
  const resource = liveResource as { status?: BackupStatus } | null | undefined;
  const status = resource?.status;

  if (!status) {
    return {
      ready: false,
      message: 'Backup has no status yet',
      reason: 'StatusMissing',
    };
  }

  const phase = status.phase;

  if (phase === 'completed') {
    return {
      ready: true,
      message: `Backup completed at ${status.stoppedAt || 'unknown time'}`,
      reason: 'Completed',
    };
  }

  if (phase === 'failed') {
    return {
      ready: false,
      message: `Backup failed: ${status.error || 'unknown error'}`,
      reason: 'Failed',
    };
  }

  if (phase === 'started') {
    return {
      ready: false,
      message: `Backup in progress since ${status.startedAt || 'unknown time'}`,
      reason: 'InProgress',
    };
  }

  return {
    ready: false,
    message: `Backup is pending (phase: ${phase || 'unknown'})`,
    reason: 'Pending',
  };
}

/**
 * CloudNativePG Backup Factory
 *
 * Creates an on-demand backup of a PostgreSQL cluster. Supports both
 * barman object store and volume snapshot methods.
 *
 * @param config - Backup configuration following postgresql.cnpg.io/v1 API
 * @returns Enhanced Backup resource with readiness evaluation
 *
 * @example
 * ```typescript
 * const bk = backup({
 *   name: 'manual-backup-20240115',
 *   namespace: 'databases',
 *   spec: {
 *     cluster: { name: 'my-database' },
 *     method: 'barmanObjectStore',
 *     target: 'prefer-standby',
 *   },
 *   id: 'manualBackup',
 * });
 * ```
 */
function createBackupResource(
  config: BackupConfig
): Enhanced<BackupConfig['spec'], BackupStatus> {
  return createResource(
    {
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'Backup',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
      },
      spec: config.spec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced' }
  ).withReadinessEvaluator(backupReadinessEvaluator) as Enhanced<
    BackupConfig['spec'],
    BackupStatus
  >;
}

export const backup = createBackupResource;
