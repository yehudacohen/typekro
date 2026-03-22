import { describe, expect, it } from 'bun:test';
import { pooler } from '../../../src/factories/cnpg/resources/pooler.js';

describe('CNPG Pooler Factory', () => {
  describe('resource creation', () => {
    it('should create a Pooler resource with minimal config', () => {
      const p = pooler({
        name: 'test-pooler',
        spec: {
          cluster: { name: 'my-db' },
          pgbouncer: {},
        },
      });

      expect(p).toBeDefined();
      expect(p.kind).toBe('Pooler');
      expect(p.apiVersion).toBe('postgresql.cnpg.io/v1');
      expect(p.metadata.name).toBe('test-pooler');
      expect(p.spec.cluster.name).toBe('my-db');
    });

    it('should apply default pool mode', () => {
      const p = pooler({
        name: 'defaults-test',
        spec: {
          cluster: { name: 'my-db' },
          pgbouncer: {},
        },
      });

      expect(p.spec.pgbouncer.poolMode).toBe('session');
    });

    it('should accept full configuration', () => {
      const p = pooler({
        name: 'prod-pooler',
        namespace: 'databases',
        spec: {
          cluster: { name: 'prod-db' },
          type: 'rw',
          instances: 3,
          pgbouncer: {
            poolMode: 'transaction',
            parameters: {
              default_pool_size: '20',
              max_client_conn: '200',
            },
            pg_hba: [
              'host all all 10.0.0.0/8 md5',
            ],
          },
        },
        id: 'prodPooler',
      });

      expect(p.spec.type).toBe('rw');
      expect(p.spec.instances).toBe(3);
      expect(p.spec.pgbouncer.poolMode).toBe('transaction');
      expect(p.spec.pgbouncer.parameters?.default_pool_size).toBe('20');
    });
  });

  describe('readiness evaluation', () => {
    it('should have a readiness evaluator', () => {
      const p = pooler({
        name: 'readiness-test',
        spec: {
          cluster: { name: 'test-db' },
          pgbouncer: {},
        },
      });

      expect(p.readinessEvaluator).toBeDefined();
    });

    it('should report ready with Ready condition', () => {
      const p = pooler({
        name: 'ready-test',
        spec: {
          cluster: { name: 'test-db' },
          pgbouncer: {},
        },
      });

      const status = p.readinessEvaluator?.({
        status: {
          instances: 1,
          conditions: [
            { type: 'Ready', status: 'True', message: 'Pooler is ready' },
          ],
        },
      });

      expect(status?.ready).toBe(true);
    });

    it('should handle missing status', () => {
      const p = pooler({
        name: 'no-status-pooler',
        spec: { cluster: { name: 'test-db' }, pgbouncer: {} },
      });

      const status = p.readinessEvaluator?.(null);
      expect(status?.ready).toBe(false);

      const statusEmpty = p.readinessEvaluator?.({});
      expect(statusEmpty?.ready).toBe(false);
    });
  });
});
