import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { ensureNamespaceExists, deleteNamespaceAndWait } from '../shared-kubeconfig.js';
import { cluster } from '../../../src/factories/cnpg/resources/cluster.js';
import { backup } from '../../../src/factories/cnpg/resources/backup.js';
import { scheduledBackup } from '../../../src/factories/cnpg/resources/scheduled-backup.js';
import { pooler } from '../../../src/factories/cnpg/resources/pooler.js';

describe('CNPG Cluster Resource Integration Tests', () => {
  let kubeConfig: any;
  const testNs = 'cnpg-resource-test';

  beforeAll(async () => {
    console.log('Setting up CNPG cluster resource tests...');

    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      console.log('✅ Cluster connection established');
      await ensureNamespaceExists(testNs, kubeConfig);
    } catch (error) {
      console.error('❌ Failed to connect to cluster:', error);
      throw error;
    }
  });

  afterAll(async () => {
    console.log('Cleaning up CNPG cluster resource tests...');
    await deleteNamespaceAndWait(testNs, kubeConfig).catch(() => {});
  });

  // ── Cluster Factory ─────────────────────────────────────────────────

  describe('Cluster', () => {
    it('should create typed resource with correct apiVersion and kind', () => {
      const db = cluster({
        name: 'test-pg',
        namespace: testNs,
        spec: {
          instances: 3,
          storage: { size: '50Gi', storageClass: 'gp3' },
          postgresql: {
            parameters: { shared_buffers: '256MB', max_connections: '200' },
          },
          bootstrap: {
            initdb: { database: 'collector_bills', owner: 'app', encoding: 'UTF8' },
          },
        },
        id: 'testDatabase',
      });

      expect(db.kind).toBe('Cluster');
      expect(db.apiVersion).toBe('postgresql.cnpg.io/v1');
      expect(db.metadata.name).toBe('test-pg');
      expect(db.metadata.namespace).toBe(testNs);

      // Typed spec access
      expect(db.spec.instances).toBe(3);
      expect(db.spec.storage.size).toBe('50Gi');
      expect(db.spec.storage.storageClass).toBe('gp3');
      expect(db.spec.postgresql?.parameters?.shared_buffers).toBe('256MB');
      expect(db.spec.bootstrap?.initdb?.database).toBe('collector_bills');
      expect(db.spec.bootstrap?.initdb?.owner).toBe('app');
    });

    it('should apply default instances when not specified', () => {
      const db = cluster({
        name: 'defaults-pg',
        spec: { storage: { size: '5Gi' } },
      });

      // instances defaults to 1 when omitted
      expect(db.spec.instances).toBe(1);
    });

    it('should evaluate readiness for healthy cluster', () => {
      const db = cluster({
        name: 'healthy-pg',
        spec: { instances: 3, storage: { size: '10Gi' } },
      });

      const status = db.readinessEvaluator?.({
        status: {
          phase: 'Cluster in healthy state',
          instances: 3,
          readyInstances: 3,
          currentPrimary: 'healthy-pg-1',
        },
      });

      expect(status?.ready).toBe(true);
      expect(status?.reason).toBe('Healthy');
    });

    it('should evaluate readiness for cluster setting up primary', () => {
      const db = cluster({
        name: 'setup-pg',
        spec: { instances: 1, storage: { size: '10Gi' } },
      });

      const status = db.readinessEvaluator?.({
        status: {
          phase: 'Setting up primary',
          instances: 1,
          readyInstances: 0,
        },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('SettingUpPrimary');
    });

    it('should evaluate readiness for cluster creating replicas', () => {
      const db = cluster({
        name: 'replica-pg',
        spec: { instances: 3, storage: { size: '10Gi' } },
      });

      const status = db.readinessEvaluator?.({
        status: {
          phase: 'Creating replica',
          instances: 3,
          readyInstances: 1,
        },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('CreatingReplica');
    });

    it('should handle missing status gracefully', () => {
      const db = cluster({
        name: 'no-status-pg',
        spec: { instances: 1, storage: { size: '10Gi' } },
      });

      expect(db.readinessEvaluator?.(null)?.ready).toBe(false);
      expect(db.readinessEvaluator?.({})?.ready).toBe(false);
    });
  });

  // ── Backup Factory ──────────────────────────────────────────────────

  describe('Backup', () => {
    it('should create typed resource', () => {
      const bk = backup({
        name: 'manual-backup',
        namespace: testNs,
        spec: {
          cluster: { name: 'test-pg' },
          method: 'barmanObjectStore',
          target: 'prefer-standby',
        },
        id: 'manualBackup',
      });

      expect(bk.kind).toBe('Backup');
      expect(bk.apiVersion).toBe('postgresql.cnpg.io/v1');
      expect(bk.spec.cluster.name).toBe('test-pg');
      expect(bk.spec.method).toBe('barmanObjectStore');
      expect(bk.spec.target).toBe('prefer-standby');
    });

    it('should evaluate completed backup as ready', () => {
      const bk = backup({
        name: 'done-backup',
        spec: { cluster: { name: 'test-pg' } },
      });

      const status = bk.readinessEvaluator?.({
        status: { phase: 'completed', stoppedAt: '2024-01-15T10:05:00Z' },
      });

      expect(status?.ready).toBe(true);
      expect(status?.reason).toBe('Completed');
    });

    it('should evaluate failed backup as not ready', () => {
      const bk = backup({
        name: 'fail-backup',
        spec: { cluster: { name: 'test-pg' } },
      });

      const status = bk.readinessEvaluator?.({
        status: { phase: 'failed', error: 'Disk full' },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('Failed');
    });

    it('should evaluate in-progress backup', () => {
      const bk = backup({
        name: 'running-backup',
        spec: { cluster: { name: 'test-pg' } },
      });

      const status = bk.readinessEvaluator?.({
        status: { phase: 'started', startedAt: '2024-01-15T10:00:00Z' },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('InProgress');
    });
  });

  // ── ScheduledBackup Factory ─────────────────────────────────────────

  describe('ScheduledBackup', () => {
    it('should create typed resource with cron schedule', () => {
      const sb = scheduledBackup({
        name: 'nightly',
        namespace: testNs,
        spec: {
          cluster: { name: 'test-pg' },
          schedule: '0 0 2 * * *',
          immediate: true,
          backupOwnerReference: 'cluster',
        },
        id: 'nightlyBackup',
      });

      expect(sb.kind).toBe('ScheduledBackup');
      expect(sb.apiVersion).toBe('postgresql.cnpg.io/v1');
      expect(sb.spec.schedule).toBe('0 0 2 * * *');
      expect(sb.spec.immediate).toBe(true);
      expect(sb.spec.backupOwnerReference).toBe('cluster');
    });
  });

  // ── Pooler Factory ──────────────────────────────────────────────────

  describe('Pooler', () => {
    it('should create typed resource with defaults', () => {
      const pool = pooler({
        name: 'app-pooler',
        namespace: testNs,
        spec: {
          cluster: { name: 'test-pg' },
          type: 'rw',
          pgbouncer: {
            parameters: { default_pool_size: '25', max_client_conn: '200' },
          },
        },
        id: 'appPooler',
      });

      expect(pool.kind).toBe('Pooler');
      expect(pool.apiVersion).toBe('postgresql.cnpg.io/v1');
      expect(pool.spec.cluster.name).toBe('test-pg');
      expect(pool.spec.type).toBe('rw');

      // Defaults applied
      expect(pool.spec.instances).toBe(1);
      expect(pool.spec.pgbouncer.poolMode).toBe('session');

      // User config preserved
      expect(pool.spec.pgbouncer.parameters?.default_pool_size).toBe('25');
    });

    it('should allow overriding defaults', () => {
      const pool = pooler({
        name: 'custom-pooler',
        spec: {
          cluster: { name: 'test-pg' },
          instances: 3,
          pgbouncer: { poolMode: 'transaction' },
        },
      });

      expect(pool.spec.instances).toBe(3);
      expect(pool.spec.pgbouncer.poolMode).toBe('transaction');
    });

    it('should evaluate readiness via conditions', () => {
      const pool = pooler({
        name: 'ready-pooler',
        spec: { cluster: { name: 'test-pg' }, pgbouncer: {} },
      });

      const status = pool.readinessEvaluator?.({
        status: {
          instances: 1,
          conditions: [
            { type: 'Ready', status: 'True', message: 'Pooler is ready' },
          ],
        },
      });

      expect(status?.ready).toBe(true);
    });
  });
});
