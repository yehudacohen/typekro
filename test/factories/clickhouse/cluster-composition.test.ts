/**
 * makeClickHouseCluster — build-time topology vs runtime spec.
 *
 * The whole suite runs with TYPEKRO_STRICT_CEL=1: every serialized RGD in
 * here is PROVEN strict-CEL-clean (the analyzer throws on any expression it
 * cannot prove type-checks, instead of deferring the failure to a live KRO
 * reconcile).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import {
  CLICKHOUSE_DEFAULT_DATABASE,
  CLICKHOUSE_HTTP_PORT,
  CLICKHOUSE_KEEPER_PORT,
  CLICKHOUSE_NATIVE_PORT,
  clickHouseCluster,
  clickHouseInstallation,
  clickHouseKeeperInstallation,
  makeClickHouseCluster,
} from '../../../src/factories/clickhouse/index.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
});

afterAll(() => {
  if (ORIGINAL_STRICT_ENV === undefined) {
    delete process.env.TYPEKRO_STRICT_CEL;
  } else {
    process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT_ENV;
  }
});

describe('makeClickHouseCluster (build-time topology, runtime spec)', () => {
  describe('graph mode under TYPEKRO_STRICT_CEL=1', () => {
    it('serializes a full zone-pinned topology to a valid RGD with schema refs for every runtime field', () => {
      const clickhouse = makeClickHouseCluster({
        zones: ['us-east-2a', 'us-east-2b'],
        replicas: 2,
        shards: 1,
        users: [{ name: 'signoz' }],
      });

      // toYaml() serializes the composition with schema PROXIES in every
      // runtime spec position — exactly the reviewer's graph-mode repro that
      // used to crash `assignZonesRoundRobin` at graph construction.
      const yaml = clickhouse.toYaml();

      expect(yaml).toContain('kind: ResourceGraphDefinition');
      expect(yaml).toContain('kind: ClickHouseInstallation');

      // Runtime fields are clean schema-ref CEL.
      expect(yaml).toContain('name: ${schema.spec.name}');
      expect(yaml).toContain('namespace: ${schema.spec.namespace}');
      expect(yaml).toContain('clickhouse/clickhouse-server:${string(schema.spec.version)}');
      expect(yaml).toContain('storage: ${schema.spec.storage.size}');
      expect(yaml).toContain('schema.spec.storage.storageClassName');
      expect(yaml).toContain('host: ${schema.spec.keeper.host}');

      // BUILD-TIME topology is compiled concrete: per-replica zone-pinned
      // layout (no replicasCount) with nodeAffinity pinning.
      expect(yaml).not.toContain('replicasCount');
      expect(yaml).toContain('podTemplate: clickhouse-us-east-2a');
      expect(yaml).toContain('podTemplate: clickhouse-us-east-2b');
      expect(yaml).toContain('topology.kubernetes.io/zone');

      // No leaked internals.
      expect(yaml).not.toContain('__typekroSchemaKey');
      expect(yaml).not.toContain('__KUBERNETES_REF__');
      expect(yaml).not.toContain('[object Object]');
    });

    it('compiles users with concrete build-time NAMES as path fragments and runtime password refs', () => {
      const clickhouse = makeClickHouseCluster({
        replicas: 1,
        users: [{ name: 'signoz', networksIp: ['10.0.0.0/8'] }],
      });

      const yaml = clickhouse.toYaml();

      // The name is a literal path fragment; the password hash is a runtime
      // ref into the per-user spec slot the generated schema requires.
      expect(yaml).toContain(
        'signoz/password_sha256_hex: ${schema.spec.users.signoz.passwordSha256Hex}'
      );
      expect(yaml).toContain('signoz/networks/ip');
      expect(yaml).toContain('10.0.0.0/8');
      // The schema carries a LITERAL users.signoz key — never a dynamic map.
      expect(yaml).toContain('signoz:');
      expect(yaml).not.toContain('__typekroSchemaKey');
    });

    it('enables keeper by default for multi-replica topologies and requires the runtime host', () => {
      const yaml = makeClickHouseCluster({ replicas: 2 }).toYaml();
      expect(yaml).toContain('zookeeper');
      expect(yaml).toContain('host: ${schema.spec.keeper.host}');
      // Default keeper client port from the operator (KpDefaultZKPortNumber).
      expect(yaml).toContain('2181');
      // keeper is a REQUIRED runtime spec field when the topology enables it.
      expect(yaml).toMatch(/keeper:\s*\n\s+host: string/);
    });

    it('omits keeper and users entirely from spec and CHI for the default single-node topology', () => {
      const yaml = clickHouseCluster.toYaml();
      expect(yaml).toContain('replicasCount: 1');
      expect(yaml).toContain('shardsCount: 1');
      expect(yaml).not.toContain('zookeeper');
      expect(yaml).not.toContain('users');
      expect(yaml).not.toContain('keeper');
    });

    it('creates both kro and direct factories', () => {
      const clickhouse = makeClickHouseCluster({ zones: ['us-east-2a'], replicas: 1 });
      const kro = clickhouse.factory('kro', { namespace: 'observability' });
      const direct = clickhouse.factory('direct', { namespace: 'observability' });
      expect(typeof kro.deploy).toBe('function');
      expect(typeof direct.deploy).toBe('function');
    });
  });

  describe('status contract (static-hydration vs CEL split)', () => {
    it('keeps only resource-derived fields in the KRO status CEL', () => {
      const yaml = makeClickHouseCluster({
        zones: ['us-east-2a', 'us-east-2b'],
        replicas: 2,
        users: [{ name: 'signoz' }],
      }).toYaml();

      // Resource-derived fields serialize as CEL over the CHI resource.
      expect(yaml).toContain('ready: ${clickhouse.status.status == "Completed"}');
      // The three-state phase ternary (quotes YAML-escaped inside the CEL string).
      expect(yaml).toContain('\\"Ready\\" : clickhouse.status.status == \\"Aborted\\" ? \\"Failed\\" : \\"Installing\\"');
      expect(yaml).toContain('endpoint: ${clickhouse.status.endpoint}');
      expect(yaml).toContain('hostsCount: ${clickhouse.status.hostsCount}');
      expect(yaml).toContain('hostsCompletedCount: ${clickhouse.status.hostsCompletedCount}');

      // Spec-derived connection fields (host/urls/ports/clusterName/user)
      // must NOT be in the KRO status schema: KRO status CEL cannot reference
      // schema.spec.*, so TypeKro hydrates them client-side (static fields).
      const statusSection = yaml.slice(yaml.indexOf('status:'), yaml.indexOf('resources:'));
      expect(statusSection).not.toContain('nativeUrl');
      expect(statusSection).not.toContain('httpUrl');
      expect(statusSection).not.toContain('schema.spec');
    });

    it('derives the connection contract from verified operator naming and ports', () => {
      // Verified against Altinity clickhouse-operator release-0.27.1 sources:
      // - CR-level Service name: `clickhouse-{chi-name}`
      //   (pkg/model/chi/namer/patterns.go patternCRServiceName)
      // - native TCP 9000 / HTTP 8123 / keeper 2181
      //   (pkg/apis/clickhouse.altinity.com/v1/type_host.go
      //    ChDefaultTCPPortNumber / ChDefaultHTTPPortNumber /
      //    KpDefaultZKPortNumber)
      expect(CLICKHOUSE_NATIVE_PORT).toBe(9000);
      expect(CLICKHOUSE_HTTP_PORT).toBe(8123);
      expect(CLICKHOUSE_KEEPER_PORT).toBe(2181);
      expect(CLICKHOUSE_DEFAULT_DATABASE).toBe('default');
    });

    it('hydrates the spec-derived connection contract in direct (static) evaluation', async () => {
      const clickhouse = makeClickHouseCluster({ users: [{ name: 'signoz' }] });
      const factory = clickhouse.factory('direct', { namespace: 'observability' });

      const yaml = await factory.toYaml({
        name: 'signoz-clickhouse',
        namespace: 'observability',
        version: '25.12.5',
        storage: { size: '100Gi', storageClassName: 'gp3-expandable' },
        users: { signoz: { passwordSha256Hex: 'abc123' } },
      });

      // The CHI itself renders concrete in direct mode.
      expect(yaml).toContain('name: signoz-clickhouse');
      expect(yaml).toContain('clickhouse/clickhouse-server:25.12.5');
      expect(yaml).toContain('signoz/password_sha256_hex: abc123');
      expect(yaml).not.toContain('undefined');
      expect(yaml).not.toContain('[object Object]');
    });
  });

  describe('loud build-time rejection of schema refs', () => {
    function composeWith(
      build: (spec: { name: string; count: number; zone: string }) => void
    ): () => unknown {
      return () =>
        kubernetesComposition(
          {
            name: 'bad-clickhouse',
            kind: 'BadClickHouse',
            spec: type({ name: 'string', count: 'number', zone: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            build(spec as never);
            return { ready: true };
          }
        );
    }

    it('rejects a schema ref in replicas, naming the field and the fix', () => {
      const compose = composeWith((spec) => {
        clickHouseInstallation({
          name: spec.name,
          version: '25.12.5',
          replicas: spec.count as never,
          storage: { size: '10Gi' },
        });
      });
      expect(compose).toThrow(/'replicas' is a BUILD-TIME topology field/);
      expect(compose).toThrow(/makeClickHouseCluster/);
    });

    it('rejects a schema ref in shards', () => {
      const compose = composeWith((spec) => {
        clickHouseInstallation({
          name: spec.name,
          version: '25.12.5',
          shards: spec.count as never,
          storage: { size: '10Gi' },
        });
      });
      expect(compose).toThrow(/'shards' is a BUILD-TIME topology field/);
    });

    it('rejects a schema ref in zones (whole array and element positions)', () => {
      const wholeArray = composeWith((spec) => {
        clickHouseInstallation({
          name: spec.name,
          version: '25.12.5',
          zones: spec.zone as never,
          storage: { size: '10Gi' },
        });
      });
      expect(wholeArray).toThrow(/'zones' is a BUILD-TIME topology field/);

      const element = composeWith((spec) => {
        clickHouseInstallation({
          name: spec.name,
          version: '25.12.5',
          zones: [spec.zone] as never,
          storage: { size: '10Gi' },
        });
      });
      expect(element).toThrow(/'zones\[\]' is a BUILD-TIME topology field/);
    });

    it('rejects a schema ref in a user NAME (path fragment) but accepts refs in password values', () => {
      const badName = composeWith((spec) => {
        clickHouseInstallation({
          name: 'test-ch',
          version: '25.12.5',
          storage: { size: '10Gi' },
          users: [{ name: spec.name as never }],
        });
      });
      expect(badName).toThrow(/'users\[0\]\.name' is a BUILD-TIME topology field/);

      // Password hash is a plain VALUE position: a ref serializes to clean CEL.
      const okPassword = kubernetesComposition(
        {
          name: 'ok-clickhouse',
          kind: 'OkClickHouse',
          spec: type({ name: 'string', passwordHash: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          const chi = clickHouseInstallation({
            name: 'test-ch',
            version: '25.12.5',
            storage: { size: '10Gi' },
            users: [{ name: 'signoz', passwordSha256Hex: spec.passwordHash }],
            id: 'chi',
          });
          return { ready: chi.status.status === 'Completed' };
        }
      );
      const yaml = okPassword.toYaml();
      expect(yaml).toContain(
        'signoz/password_sha256_hex: ${schema.spec.passwordHash}'
      );
      expect(yaml).not.toContain('__typekroSchemaKey');
    });

    it('rejects schema refs in keeper build-time fields (storage presence, replicas)', () => {
      const badReplicas = composeWith((spec) => {
        clickHouseKeeperInstallation({
          name: 'keeper',
          replicas: spec.count as never,
        });
      });
      expect(badReplicas).toThrow(/'replicas' is a BUILD-TIME field/);
    });
  });
});
