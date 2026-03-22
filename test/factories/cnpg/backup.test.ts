import { describe, expect, it } from 'bun:test';
import { backup } from '../../../src/factories/cnpg/resources/backup.js';
import { scheduledBackup } from '../../../src/factories/cnpg/resources/scheduled-backup.js';

describe('CNPG Backup Factory', () => {
  describe('resource creation', () => {
    it('should create a Backup resource', () => {
      const bk = backup({
        name: 'test-backup',
        spec: {
          cluster: { name: 'my-db' },
        },
      });

      expect(bk).toBeDefined();
      expect(bk.kind).toBe('Backup');
      expect(bk.apiVersion).toBe('postgresql.cnpg.io/v1');
      expect(bk.metadata.name).toBe('test-backup');
      expect(bk.spec.cluster.name).toBe('my-db');
    });

    it('should accept method and target options', () => {
      const bk = backup({
        name: 'snapshot-backup',
        namespace: 'databases',
        spec: {
          cluster: { name: 'prod-db' },
          method: 'volumeSnapshot',
          target: 'prefer-standby',
          online: true,
        },
        id: 'snapshotBackup',
      });

      expect(bk.spec.method).toBe('volumeSnapshot');
      expect(bk.spec.target).toBe('prefer-standby');
    });
  });

  describe('readiness evaluation', () => {
    it('should have a readiness evaluator', () => {
      const bk = backup({
        name: 'readiness-test',
        spec: { cluster: { name: 'test-db' } },
      });

      expect(bk.readinessEvaluator).toBeDefined();
    });

    it('should report ready when backup is completed', () => {
      const bk = backup({
        name: 'completed-test',
        spec: { cluster: { name: 'test-db' } },
      });

      const status = bk.readinessEvaluator?.({
        status: {
          phase: 'completed',
          backupId: 'backup-20240115',
          startedAt: '2024-01-15T10:00:00Z',
          stoppedAt: '2024-01-15T10:05:00Z',
        },
      });

      expect(status?.ready).toBe(true);
    });

    it('should report not ready when backup is in progress', () => {
      const bk = backup({
        name: 'progress-test',
        spec: { cluster: { name: 'test-db' } },
      });

      const status = bk.readinessEvaluator?.({
        status: {
          phase: 'started',
          startedAt: '2024-01-15T10:00:00Z',
        },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('InProgress');
    });

    it('should report not ready with error when backup failed', () => {
      const bk = backup({
        name: 'failed-test',
        spec: { cluster: { name: 'test-db' } },
      });

      const status = bk.readinessEvaluator?.({
        status: {
          phase: 'failed',
          error: 'Insufficient storage',
        },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('Failed');
      expect(status?.message).toContain('Insufficient storage');
    });

    it('should report pending for new backup', () => {
      const bk = backup({
        name: 'new-test',
        spec: { cluster: { name: 'test-db' } },
      });

      const status = bk.readinessEvaluator?.({
        status: { phase: 'new' },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('Pending');
    });

    it('should handle missing status', () => {
      const bk = backup({
        name: 'no-status-test',
        spec: { cluster: { name: 'test-db' } },
      });

      const status = bk.readinessEvaluator?.(null);
      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('StatusMissing');
    });
  });
});

describe('CNPG ScheduledBackup Factory', () => {
  describe('resource creation', () => {
    it('should create a ScheduledBackup resource', () => {
      const sb = scheduledBackup({
        name: 'nightly-backup',
        spec: {
          cluster: { name: 'prod-db' },
          schedule: '0 0 2 * * *',
        },
      });

      expect(sb).toBeDefined();
      expect(sb.kind).toBe('ScheduledBackup');
      expect(sb.apiVersion).toBe('postgresql.cnpg.io/v1');
      expect(sb.spec.schedule).toBe('0 0 2 * * *');
    });

    it('should accept comprehensive options', () => {
      const sb = scheduledBackup({
        name: 'full-backup',
        namespace: 'databases',
        spec: {
          cluster: { name: 'prod-db' },
          schedule: '0 0 3 * * 0',
          method: 'volumeSnapshot',
          immediate: true,
          target: 'prefer-standby',
          backupOwnerReference: 'cluster',
        },
        id: 'weeklyBackup',
      });

      expect(sb.spec.immediate).toBe(true);
      expect(sb.spec.backupOwnerReference).toBe('cluster');
    });
  });

  describe('readiness evaluation', () => {
    it('should report ready when Ready condition is present', () => {
      const sb = scheduledBackup({
        name: 'ready-test',
        spec: {
          cluster: { name: 'test-db' },
          schedule: '0 0 * * * *',
        },
      });

      const status = sb.readinessEvaluator?.({
        status: {
          conditions: [
            { type: 'Ready', status: 'True', message: 'Schedule active' },
          ],
          lastScheduleTime: '2024-01-15T02:00:00Z',
          nextScheduleTime: '2024-01-16T02:00:00Z',
        },
      });

      expect(status?.ready).toBe(true);
    });

    it('should report ready when no conditions but schedule has run', () => {
      const sb = scheduledBackup({
        name: 'no-conditions-test',
        spec: {
          cluster: { name: 'test-db' },
          schedule: '0 0 * * * *',
        },
      });

      const status = sb.readinessEvaluator?.({
        status: {
          lastScheduleTime: '2024-01-15T02:00:00Z',
        },
      });

      expect(status?.ready).toBe(true);
      expect(status?.reason).toBe('ScheduleActive');
    });

    it('should report not ready when no conditions and never scheduled', () => {
      const sb = scheduledBackup({
        name: 'never-run-test',
        spec: {
          cluster: { name: 'test-db' },
          schedule: '0 0 * * * *',
        },
      });

      const status = sb.readinessEvaluator?.({
        status: {},
      });

      expect(status?.ready).toBe(false);
    });

    it('should handle missing status', () => {
      const sb = scheduledBackup({
        name: 'no-status-test',
        spec: {
          cluster: { name: 'test-db' },
          schedule: '0 0 * * * *',
        },
      });

      const status = sb.readinessEvaluator?.(null);
      expect(status?.ready).toBe(false);
    });
  });
});
