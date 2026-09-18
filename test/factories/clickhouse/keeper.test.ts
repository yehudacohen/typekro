import { describe, expect, it } from 'bun:test';
import {
  CHI_STATUS,
  clickHouseInstallation,
  DEFAULT_CHI_CLUSTER_NAME,
} from '../../../src/factories/clickhouse/resources/installation.js';
import {
  clickHouseKeeperInstallation,
  DEFAULT_CHK_CLUSTER_NAME,
} from '../../../src/factories/clickhouse/resources/keeper.js';

/**
 * The Altinity CRD's own cap on `spec.configuration.clusters[].name`
 * (`maxLength: 15`, `See namePartClusterMaxLen const`) — identical on the CHI
 * and the CHK, while `metadata.name` is uncapped on both.
 */
const CLUSTER_NAME_MAX_BYTES = 15;

describe('ClickHouseKeeperInstallation Factory', () => {
  describe('resource creation', () => {
    it('should create a CHK resource with minimal config', () => {
      const chk = clickHouseKeeperInstallation({ name: 'keeper' });

      expect(chk).toBeDefined();
      expect(chk.kind).toBe('ClickHouseKeeperInstallation');
      expect(chk.apiVersion).toBe('clickhouse-keeper.altinity.com/v1');
      expect(chk.metadata.name).toBe('keeper');
      expect(chk.spec.configuration?.clusters?.[0]).toEqual({
        name: DEFAULT_CHK_CLUSTER_NAME,
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

  /**
   * LIVE FAILURE THIS COVERS. The CHK used to copy the installation name into
   * `spec.configuration.clusters[0].name`. The CRD caps that field at 15 bytes
   * while `metadata.name` is uncapped, so the first apply of any keeper with a
   * longer release name was rejected by the API server:
   *
   *   ClickHouseKeeperInstallation … is invalid:
   *   spec.configuration.clusters[0].name: Too long: may not be more than 15 bytes
   *
   * The cluster name is now a short constant, independent of the installation
   * name, and an over-long override fails at BUILD time instead.
   */
  describe('cluster name (Altinity 15-byte cap)', () => {
    it('defaults to a short constant, NOT the installation name', () => {
      const chk = clickHouseKeeperInstallation({ name: 'keeper' });

      expect(DEFAULT_CHK_CLUSTER_NAME.length).toBeLessThanOrEqual(CLUSTER_NAME_MAX_BYTES);
      expect(chk.spec.configuration?.clusters?.[0]?.name).toBe(DEFAULT_CHK_CLUSTER_NAME);
    });

    it('keeps the cluster name within the cap for an over-long installation name', () => {
      // The exact shape of the live failure: a 23-byte release name.
      const installationName = 'observability-clickstack';
      expect(installationName.length).toBeGreaterThan(CLUSTER_NAME_MAX_BYTES);

      const chk = clickHouseKeeperInstallation({ name: installationName, replicas: 3 });

      expect(chk.metadata.name).toBe(installationName);
      const clusterName = chk.spec.configuration?.clusters?.[0]?.name ?? '';
      expect(clusterName).toBe(DEFAULT_CHK_CLUSTER_NAME);
      expect(Buffer.byteLength(clusterName, 'utf8')).toBeLessThanOrEqual(CLUSTER_NAME_MAX_BYTES);
    });

    it('honours an explicit clusterName override', () => {
      const chk = clickHouseKeeperInstallation({
        name: 'observability-clickstack',
        clusterName: 'coordination',
      });

      expect(chk.spec.configuration?.clusters?.[0]?.name).toBe('coordination');
    });

    it('accepts a cluster name AT the 15-byte cap', () => {
      const atCap = 'abcdefghijklmno';
      expect(Buffer.byteLength(atCap, 'utf8')).toBe(CLUSTER_NAME_MAX_BYTES);

      const chk = clickHouseKeeperInstallation({ name: 'keeper', clusterName: atCap });

      expect(chk.spec.configuration?.clusters?.[0]?.name).toBe(atCap);
    });

    it('rejects a cluster name ONE byte past the cap, at build time', () => {
      const pastCap = 'abcdefghijklmnop';
      expect(Buffer.byteLength(pastCap, 'utf8')).toBe(CLUSTER_NAME_MAX_BYTES + 1);

      expect(() => clickHouseKeeperInstallation({ name: 'keeper', clusterName: pastCap })).toThrow(
        /clickHouseKeeperInstallation: 'clusterName' must match/
      );
    });

    it('applies the SAME rule and the same boundary as the CHI', () => {
      const atCap = 'abcdefghijklmno';
      const pastCap = 'abcdefghijklmnop';
      const chiConfig = { name: 'observability-clickstack', version: '25.12.5' as const };
      const storage = { size: '10Gi' };

      // Both defaults are short constants derived from NEITHER installation name.
      expect(
        clickHouseInstallation({ ...chiConfig, storage }).spec.configuration?.clusters?.[0]?.name
      ).toBe(DEFAULT_CHI_CLUSTER_NAME);
      expect(
        clickHouseKeeperInstallation({ name: chiConfig.name }).spec.configuration?.clusters?.[0]
          ?.name
      ).toBe(DEFAULT_CHK_CLUSTER_NAME);

      // Both accept the cap and reject one byte past it.
      expect(() =>
        clickHouseInstallation({ ...chiConfig, storage, clusterName: atCap })
      ).not.toThrow();
      expect(() =>
        clickHouseKeeperInstallation({ name: chiConfig.name, clusterName: atCap })
      ).not.toThrow();
      expect(() => clickHouseInstallation({ ...chiConfig, storage, clusterName: pastCap })).toThrow(
        /'clusterName' must match/
      );
      expect(() =>
        clickHouseKeeperInstallation({ name: chiConfig.name, clusterName: pastCap })
      ).toThrow(/'clusterName' must match/);
    });

    it.each([
      ['space', 'my cluster'],
      ['underscore (the CRD pattern forbids it)', 'my_cluster'],
      ['leading digit', '9keeper'],
      ['trailing dash', 'keeper-'],
      ['empty', ''],
    ])('rejects a keeper cluster name with a %s', (_label, clusterName) => {
      expect(() => clickHouseKeeperInstallation({ name: 'keeper', clusterName })).toThrow(
        /clickHouseKeeperInstallation: 'clusterName' must match/
      );
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
