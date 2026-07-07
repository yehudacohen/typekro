import { describe, expect, it } from 'bun:test';
import { CHI_STATUS } from '../../../src/factories/clickhouse/resources/installation.js';
import { clickHouseKeeperInstallation } from '../../../src/factories/clickhouse/resources/keeper.js';

describe('ClickHouseKeeperInstallation Factory', () => {
  describe('resource creation', () => {
    it('should create a CHK resource with minimal config', () => {
      const chk = clickHouseKeeperInstallation({ name: 'keeper' });

      expect(chk).toBeDefined();
      expect(chk.kind).toBe('ClickHouseKeeperInstallation');
      expect(chk.apiVersion).toBe('clickhouse-keeper.altinity.com/v1');
      expect(chk.metadata.name).toBe('keeper');
      expect(chk.spec.configuration?.clusters?.[0]).toEqual({
        name: 'keeper',
        layout: { replicasCount: 1 },
      });
    });

    it('should create a namespaced resource with explicit replicas', () => {
      const chk = clickHouseKeeperInstallation({
        name: 'keeper',
        namespace: 'observability',
        replicas: 3,
      });

      expect(chk.metadata.namespace).toBe('observability');
      expect(chk.spec.configuration?.clusters?.[0]?.layout?.replicasCount).toBe(3);
    });

    it.each([0, -3, 1.5])('rejects invalid keeper replicas %p', (replicas) => {
      expect(() => clickHouseKeeperInstallation({ name: 'keeper', replicas })).toThrow(
        /clickHouseKeeperInstallation: 'replicas' must be a positive integer/
      );
    });

    it('should omit storage templates when no storage is configured', () => {
      const chk = clickHouseKeeperInstallation({ name: 'keeper' });

      // The Enhanced proxy materializes accessed fields, so absence is
      // asserted via the spec's own keys rather than `toBeUndefined()`.
      expect(Object.keys(chk.spec)).not.toContain('templates');
      expect(Object.keys(chk.spec)).not.toContain('defaults');
    });

    it('should emit a data volume claim when storage is configured', () => {
      const chk = clickHouseKeeperInstallation({
        name: 'keeper',
        replicas: 3,
        storage: { size: '10Gi', storageClassName: 'gp3-expandable' },
      });

      expect(chk.spec.defaults?.templates?.dataVolumeClaimTemplate).toBe('data-volume');
      expect(chk.spec.templates?.volumeClaimTemplates?.[0]).toEqual({
        name: 'data-volume',
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '10Gi' } },
          storageClassName: 'gp3-expandable',
        },
      });
    });

    it('should accept an id for composition references', () => {
      const chk = clickHouseKeeperInstallation({ name: 'keeper', id: 'chKeeper' });
      expect(chk).toBeDefined();
    });
  });

  describe('readiness evaluation', () => {
    it('should share the CHI status-state readiness semantics', () => {
      // CHK reports the same status.status state machine as CHI
      // (shared operator status code).
      const chk = clickHouseKeeperInstallation({ name: 'keeper' });

      expect(chk.readinessEvaluator).toBeDefined();
      expect(
        chk.readinessEvaluator?.({ status: { status: CHI_STATUS.COMPLETED } })?.ready
      ).toBe(true);
      expect(
        chk.readinessEvaluator?.({ status: { status: CHI_STATUS.IN_PROGRESS } })?.ready
      ).toBe(false);
      expect(chk.readinessEvaluator?.(null)?.reason).toBe('StatusMissing');
    });
  });
});
