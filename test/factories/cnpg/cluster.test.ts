import { describe, expect, it } from 'bun:test';
import { cluster } from '../../../src/factories/cnpg/resources/cluster.js';

describe('CNPG Cluster Factory', () => {
  describe('resource creation', () => {
    it('should create a Cluster resource with minimal config', () => {
      const db = cluster({
        name: 'test-db',
        spec: {
          instances: 3,
          storage: { size: '10Gi' },
        },
      });

      expect(db).toBeDefined();
      expect(db.kind).toBe('Cluster');
      expect(db.apiVersion).toBe('postgresql.cnpg.io/v1');
      expect(db.metadata.name).toBe('test-db');
      expect(db.spec.instances).toBe(3);
      expect(db.spec.storage.size).toBe('10Gi');
    });

    it('should create a namespaced resource', () => {
      const db = cluster({
        name: 'test-db',
        namespace: 'databases',
        spec: {
          instances: 1,
          storage: { size: '5Gi' },
        },
      });

      expect(db.metadata.namespace).toBe('databases');
    });

    it('should accept an id for composition references', () => {
      const db = cluster({
        name: 'test-db',
        spec: {
          instances: 1,
          storage: { size: '5Gi' },
        },
        id: 'primaryDatabase',
      });

      expect(db).toBeDefined();
    });

    it('should accept comprehensive configuration', () => {
      const db = cluster({
        name: 'prod-db',
        namespace: 'production',
        spec: {
          instances: 3,
          imageName: 'ghcr.io/cloudnative-pg/postgresql:16.2',
          storage: {
            size: '100Gi',
            storageClass: 'gp3',
          },
          postgresql: {
            parameters: {
              shared_buffers: '256MB',
              max_connections: '200',
              work_mem: '8MB',
            },
            pg_hba: [
              'host all all 10.0.0.0/8 md5',
            ],
          },
          bootstrap: {
            initdb: {
              database: 'collector_bills',
              owner: 'app',
              encoding: 'UTF8',
              dataChecksums: true,
            },
          },
          resources: {
            requests: { cpu: '500m', memory: '1Gi' },
            limits: { cpu: '2', memory: '4Gi' },
          },
          affinity: {
            enablePodAntiAffinity: true,
            topologyKey: 'kubernetes.io/hostname',
            podAntiAffinityType: 'required',
          },
          monitoring: {
            enabled: true,
          },
          backup: {
            barmanObjectStore: {
              destinationPath: 's3://backups/prod-db',
              s3Credentials: {
                accessKeyId: { name: 'aws-creds', key: 'ACCESS_KEY_ID' },
                secretAccessKey: { name: 'aws-creds', key: 'SECRET_ACCESS_KEY' },
              },
            },
            retentionPolicy: '30d',
          },
        },
        id: 'prodDatabase',
      });

      expect(db.kind).toBe('Cluster');
      expect(db.spec.instances).toBe(3);
      expect(db.spec.storage.size).toBe('100Gi');
      expect(db.spec.postgresql?.parameters?.shared_buffers).toBe('256MB');
      expect(db.spec.bootstrap?.initdb?.database).toBe('collector_bills');
      expect(db.spec.backup?.retentionPolicy).toBe('30d');
    });

    it('should apply default values', () => {
      const db = cluster({
        name: 'defaults-test',
        spec: {
          instances: 1,
          storage: { size: '10Gi' },
        },
      });

      // instances should be passed through as-is
      expect(db.spec.instances).toBe(1);
    });
  });

  describe('readiness evaluation', () => {
    it('should have a readiness evaluator', () => {
      const db = cluster({
        name: 'readiness-test',
        spec: {
          instances: 1,
          storage: { size: '5Gi' },
        },
      });

      expect(db.readinessEvaluator).toBeDefined();
    });

    it('should report ready when cluster is healthy', () => {
      const db = cluster({
        name: 'healthy-test',
        spec: {
          instances: 1,
          storage: { size: '5Gi' },
        },
      });

      const status = db.readinessEvaluator?.({
        status: {
          phase: 'Cluster in healthy state',
          readyInstances: 1,
          instances: 1,
          conditions: [
            { type: 'Ready', status: 'True', message: 'Cluster is ready' },
          ],
        },
      });

      expect(status?.ready).toBe(true);
    });

    it('should report not ready when setting up primary', () => {
      const db = cluster({
        name: 'setup-test',
        spec: {
          instances: 1,
          storage: { size: '5Gi' },
        },
      });

      const status = db.readinessEvaluator?.({
        status: {
          phase: 'Setting up primary',
          readyInstances: 0,
          instances: 1,
        },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('SettingUpPrimary');
    });

    it('should report not ready when creating replica', () => {
      const db = cluster({
        name: 'replica-test',
        spec: {
          instances: 3,
          storage: { size: '5Gi' },
        },
      });

      const status = db.readinessEvaluator?.({
        status: {
          phase: 'Creating replica',
          readyInstances: 1,
          instances: 3,
        },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('CreatingReplica');
    });

    it('should report not ready during failover', () => {
      const db = cluster({
        name: 'failover-test',
        spec: { instances: 3, storage: { size: '5Gi' } },
      });

      const status = db.readinessEvaluator?.({
        status: {
          phase: 'Failing over',
          readyInstances: 2,
          instances: 3,
        },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('Failover');
    });

    it('should report not ready during switchover', () => {
      const db = cluster({
        name: 'switchover-test',
        spec: { instances: 3, storage: { size: '5Gi' } },
      });

      const status = db.readinessEvaluator?.({
        status: {
          phase: 'Switchover in progress',
          readyInstances: 3,
          instances: 3,
        },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('Failover');
    });

    it('should fall back to condition-based evaluation for unknown phases', () => {
      const db = cluster({
        name: 'unknown-phase-test',
        spec: { instances: 1, storage: { size: '5Gi' } },
      });

      const status = db.readinessEvaluator?.({
        status: {
          phase: 'Some future phase',
          conditions: [
            { type: 'Ready', status: 'True', message: 'All good' },
          ],
        },
      });

      expect(status?.ready).toBe(true);
    });

    it('should handle missing status gracefully', () => {
      const db = cluster({
        name: 'no-status-test',
        spec: {
          instances: 1,
          storage: { size: '5Gi' },
        },
      });

      const status = db.readinessEvaluator?.(null);
      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('StatusMissing');

      const statusUndefined = db.readinessEvaluator?.({});
      expect(statusUndefined?.ready).toBe(false);
      expect(statusUndefined?.reason).toBe('StatusMissing');
    });
  });
});
