import { describe, expect, it } from 'bun:test';
import { dump } from 'js-yaml';
import {
  CHI_STATUS,
  clickHouseInstallation,
  DEFAULT_CHI_CLUSTER_NAME,
} from '../../../src/factories/clickhouse/resources/installation.js';

describe('ClickHouseInstallation Factory', () => {
  describe('resource creation', () => {
    it('should create a CHI resource with minimal config', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
      });

      expect(chi).toBeDefined();
      expect(chi.kind).toBe('ClickHouseInstallation');
      expect(chi.apiVersion).toBe('clickhouse.altinity.com/v1');
      expect(chi.metadata.name).toBe('test-ch');
    });

    it('should create a namespaced resource', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        namespace: 'observability',
        version: '25.12.5',
        storage: { size: '10Gi' },
      });

      expect(chi.metadata.namespace).toBe('observability');
    });

    it('should default the cluster name to "cluster" for SigNoz compatibility', () => {
      // SigNoz's ClickHouse migrations hardcode the cluster name `cluster`.
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
      });

      expect(DEFAULT_CHI_CLUSTER_NAME).toBe('cluster');
      expect(chi.spec.configuration?.clusters?.[0]?.name).toBe('cluster');
    });

    it('should allow overriding the cluster name', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        clusterName: 'analytics',
        version: '25.12.5',
        storage: { size: '10Gi' },
      });

      expect(chi.spec.configuration?.clusters?.[0]?.name).toBe('analytics');
    });

    it('should compile the version into the clickhouse-server image', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
      });

      const podTemplate = chi.spec.templates?.podTemplates?.[0];
      const container = (podTemplate?.spec?.containers as { image: string }[])?.[0];
      expect(container?.image).toBe('clickhouse/clickhouse-server:25.12.5');
    });

    it('should honor a full image override', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        image: 'my-registry/clickhouse:custom',
        storage: { size: '10Gi' },
      });

      const podTemplate = chi.spec.templates?.podTemplates?.[0];
      const container = (podTemplate?.spec?.containers as { image: string }[])?.[0];
      expect(container?.image).toBe('my-registry/clickhouse:custom');
    });

    it('should emit a data volume claim with storageClassName from input', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '100Gi', storageClassName: 'gp3-expandable' },
      });

      const claim = chi.spec.templates?.volumeClaimTemplates?.[0];
      expect(claim?.name).toBe('data-volume');
      expect(claim?.spec).toEqual({
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '100Gi' } },
        storageClassName: 'gp3-expandable',
      });
      expect(chi.spec.defaults?.templates?.dataVolumeClaimTemplate).toBe('data-volume');
    });
  });

  describe('plain layout (no zones)', () => {
    it('should emit shardsCount/replicasCount with a shared default pod template', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        shards: 2,
        replicas: 3,
        storage: { size: '10Gi' },
      });

      const layout = chi.spec.configuration?.clusters?.[0]?.layout;
      expect(layout?.shardsCount).toBe(2);
      expect(layout?.replicasCount).toBe(3);
      expect(layout?.replicas).toBeUndefined();
      expect(chi.spec.defaults?.templates?.podTemplate).toBe('clickhouse');
      expect(chi.spec.templates?.podTemplates).toHaveLength(1);
    });

    it('should default shards and replicas to 1', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
      });

      const layout = chi.spec.configuration?.clusters?.[0]?.layout;
      expect(layout?.shardsCount).toBe(1);
      expect(layout?.replicasCount).toBe(1);
    });
  });

  describe('count validation (shared across layout paths)', () => {
    const base = { name: 'test-ch', version: '25.12.5', storage: { size: '10Gi' } };

    it.each([0, -1, 1.5])('rejects invalid replicas %p on the plain-layout path', (replicas) => {
      expect(() => clickHouseInstallation({ ...base, replicas })).toThrow(
        /'replicas' must be a positive integer/
      );
    });

    it.each([0, -2, 2.5])('rejects invalid shards %p on the plain-layout path', (shards) => {
      expect(() => clickHouseInstallation({ ...base, shards })).toThrow(
        /'shards' must be a positive integer/
      );
    });

    it('rejects invalid shards on the zone-pinned path too', () => {
      expect(() =>
        clickHouseInstallation({ ...base, shards: 0, replicas: 2, zones: ['us-east-2a'] })
      ).toThrow(/'shards' must be a positive integer/);
    });

    it('names the entry point and received value in the error', () => {
      expect(() => clickHouseInstallation({ ...base, replicas: 0 })).toThrow(
        /clickHouseInstallation: 'replicas' must be a positive integer \(got 0\)/
      );
    });
  });

  describe('zone-pinned layout', () => {
    it('should emit a per-replica layout with zone-pinned pod templates and NO replicasCount', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        replicas: 2,
        zones: ['us-east-2a', 'us-east-2b'],
        storage: { size: '10Gi' },
      });

      const layout = chi.spec.configuration?.clusters?.[0]?.layout;
      expect(layout?.replicasCount).toBeUndefined();
      expect(layout?.shardsCount).toBe(1);
      expect(layout?.replicas).toHaveLength(2);
      expect(layout?.replicas?.map((r) => r.templates?.podTemplate)).toEqual([
        'clickhouse-us-east-2a',
        'clickhouse-us-east-2b',
      ]);

      // No shared default pod template: each replica pins its own.
      expect(chi.spec.defaults?.templates?.podTemplate).toBeUndefined();

      // The nodeAffinity zone values land in the serialized YAML.
      const yaml = dump({
        apiVersion: chi.apiVersion,
        kind: chi.kind,
        metadata: { name: chi.metadata.name },
        spec: chi.spec,
      });
      expect(yaml).toContain('nodeAffinity');
      expect(yaml).toContain('topology.kubernetes.io/zone');
      expect(yaml).toContain('us-east-2a');
      expect(yaml).toContain('us-east-2b');
      expect(yaml).not.toContain('replicasCount');
    });

    it('should round-robin replicas across zones when replicas exceed zones', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        replicas: 3,
        zones: ['us-east-2a', 'us-east-2b'],
        storage: { size: '10Gi' },
      });

      const layout = chi.spec.configuration?.clusters?.[0]?.layout;
      expect(layout?.replicas?.map((r) => r.templates?.podTemplate)).toEqual([
        'clickhouse-us-east-2a',
        'clickhouse-us-east-2b',
        'clickhouse-us-east-2a',
      ]);
      // Templates stay deduplicated per distinct zone.
      expect(chi.spec.templates?.podTemplates?.map((t) => t.name)).toEqual([
        'clickhouse-us-east-2a',
        'clickhouse-us-east-2b',
      ]);
    });
  });

  describe('keeper and users wiring', () => {
    it('should wire keeper into configuration.zookeeper with the default port', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
        keeper: { host: 'keeper.observability.svc.cluster.local' },
      });

      expect(chi.spec.configuration?.zookeeper).toEqual({
        nodes: [{ host: 'keeper.observability.svc.cluster.local', port: 2181 }],
      });
    });

    it('should honor an explicit keeper port', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
        keeper: { host: 'keeper.svc', port: 9181 },
      });

      expect(chi.spec.configuration?.zookeeper?.nodes?.[0]?.port).toBe(9181);
    });

    it('should omit zookeeper when no keeper is configured', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
      });

      expect(chi.spec.configuration?.zookeeper).toBeUndefined();
    });

    it('should compile the users ARRAY to the operator path-keyed format', () => {
      // Array shape (not a name-keyed map): user names become CHI config path
      // fragments, so they live in a plain value position the factory can
      // validate — a proxy-keyed map would serialize `__typekroSchemaKey/...`.
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
        users: [
          {
            name: 'signoz',
            passwordSha256Hex: 'abc123',
            networksIp: ['::/0'],
          },
        ],
      });

      expect(chi.spec.configuration?.users).toEqual({
        'signoz/password_sha256_hex': 'abc123',
        'signoz/networks/ip': ['::/0'],
      });
    });

    it('should compile a Secret-backed cleartext password without exposing it in the CHI', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
        users: [
          {
            name: 'otelcollector',
            passwordSecretRef: { name: 'clickhouse-credentials', key: 'password' },
          },
        ],
      });

      expect(chi.spec.configuration?.users).toEqual({
        'otelcollector/password': {
          valueFrom: {
            secretKeyRef: { name: 'clickhouse-credentials', key: 'password' },
          },
        },
      });
    });

    it('should reject competing password representations for one user', () => {
      expect(() =>
        clickHouseInstallation({
          name: 'test-ch',
          version: '25.12.5',
          storage: { size: '10Gi' },
          users: [
            {
              name: 'otelcollector',
              passwordSha256Hex: 'abc123',
              passwordSecretRef: { name: 'clickhouse-credentials', key: 'password' },
            },
          ],
        })
      ).toThrow(/only one of passwordSha256Hex or passwordSecretRef/);
    });

    it('should omit user fields that are not provided', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
        users: [{ name: 'readonly' }],
      });

      expect(chi.spec.configuration?.users).toEqual({});
    });

    it('should apply podResources to the clickhouse container', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
        podResources: {
          requests: { cpu: '1', memory: '4Gi' },
          limits: { memory: '8Gi' },
        },
      });

      const container = (
        chi.spec.templates?.podTemplates?.[0]?.spec?.containers as {
          resources?: object;
        }[]
      )?.[0];
      expect(container?.resources).toEqual({
        requests: { cpu: '1', memory: '4Gi' },
        limits: { memory: '8Gi' },
      });
    });
  });

  describe('readiness evaluation', () => {
    it('should have a readiness evaluator', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
      });

      expect(chi.readinessEvaluator).toBeDefined();
    });

    it('should report ready when status.status is Completed', () => {
      // `status.status: "Completed"` is the operator's fully-reconciled state
      // (clickhouse-operator pkg/apis/clickhouse.altinity.com/v1/type_status.go).
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
      });

      const status = chi.readinessEvaluator?.({
        status: { status: CHI_STATUS.COMPLETED, hostsCount: 2, hostsCompletedCount: 2 },
      });

      expect(status?.ready).toBe(true);
      expect(status?.reason).toBe('Completed');
    });

    it('should report not ready while InProgress', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
      });

      const status = chi.readinessEvaluator?.({
        status: { status: CHI_STATUS.IN_PROGRESS, hostsCount: 2, hostsCompletedCount: 1 },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('InProgress');
      expect(status?.message).toContain('1/2');
    });

    it('should report not ready when Aborted, surfacing the first error', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
      });

      const status = chi.readinessEvaluator?.({
        status: { status: CHI_STATUS.ABORTED, errors: ['boom'] },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('Aborted');
      expect(status?.message).toContain('boom');
    });

    it('should report not ready when Terminating', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
      });

      const status = chi.readinessEvaluator?.({
        status: { status: CHI_STATUS.TERMINATING },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('Terminating');
    });

    it('should handle missing status gracefully', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
      });

      expect(chi.readinessEvaluator?.(null)?.reason).toBe('StatusMissing');
      expect(chi.readinessEvaluator?.({})?.reason).toBe('StatusMissing');
      expect(chi.readinessEvaluator?.({ status: {} })?.reason).toBe('StatusMissing');
    });

    it('should not be ready on an unknown status string', () => {
      const chi = clickHouseInstallation({
        name: 'test-ch',
        version: '25.12.5',
        storage: { size: '10Gi' },
      });

      const status = chi.readinessEvaluator?.({ status: { status: 'SomethingNew' } });
      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('UnknownStatus');
    });
  });
});
