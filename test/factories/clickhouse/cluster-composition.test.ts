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
import { load } from 'js-yaml';
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

  describe('status contract (KRO status CEL vs client-hydrated split)', () => {
    it('serializes the connection contract into KRO status as CEL over the CHI resource', () => {
      const yaml = makeClickHouseCluster({
        zones: ['us-east-2a', 'us-east-2b'],
        replicas: 2,
        users: [{ name: 'signoz' }],
      }).toYaml();

      const rgd = load(yaml) as {
        spec: { schema: { status: Record<string, unknown> } };
      };
      const status = rgd.spec.schema.status as {
        ready: string;
        phase: string;
        installation: Record<string, string>;
        clickhouse: Record<string, string>;
        keeper: Record<string, string>;
      };

      // Resource-derived fields serialize as CEL over the CHI resource.
      expect(status.ready).toBe('${clickhouse.status.status == "Completed"}');
      expect(status.phase).toBe(
        '${clickhouse.status.status == "Completed" ? "Ready" : clickhouse.status.status == "Aborted" ? "Failed" : "Installing"}'
      );
      expect(status.installation.endpoint).toBe('${clickhouse.status.endpoint}');
      // The operator's REAL CHI status fields are `hosts`/`hostsCompleted` (verified
      // live against the installed CRD's OpenAPI schema — see clickhouse-cluster.ts).
      // The public contract keeps the more explicit names; only the CEL source differs.
      expect(status.installation.hostsCount).toBe('${clickhouse.status.hosts}');
      expect(status.installation.hostsCompletedCount).toBe(
        '${clickhouse.status.hostsCompleted}'
      );

      // The CONNECTION CONTRACT is anchored on the OWNED CHI RESOURCE, so it
      // reaches the KRO CR's status (GitOps/KRO consumers see it live) —
      // derived from the operator's verified naming, never schema.spec.*.
      // Built from NATURAL template literals over the resource proxy (typekro
      // >= 0.24.0 / #97): the analyzer emits KRO's mixed-template format with
      // string()-wrapped resource-metadata interpolations and inlined port
      // literals.
      expect(status.clickhouse.host).toBe(
        'clickhouse-${string(clickhouse.metadata.name)}.${string(clickhouse.metadata.namespace)}.svc.cluster.local'
      );
      expect(status.clickhouse.nativeUrl).toBe(
        'clickhouse://clickhouse-${string(clickhouse.metadata.name)}.${string(clickhouse.metadata.namespace)}.svc.cluster.local:9000'
      );
      expect(status.clickhouse.httpUrl).toBe(
        'http://clickhouse-${string(clickhouse.metadata.name)}.${string(clickhouse.metadata.namespace)}.svc.cluster.local:8123'
      );
      expect(status.clickhouse.clusterName).toBe(
        '${clickhouse.spec.configuration.clusters[0].name}'
      );
      // Keeper echo comes from the CHI's own zookeeper section.
      expect(status.keeper.host).toBe(
        '${clickhouse.spec.configuration.zookeeper.nodes[0].host}'
      );
      expect(status.keeper.port).toBe(
        '${clickhouse.spec.configuration.zookeeper.nodes[0].port}'
      );
      // Installation identity from the owned resource too.
      expect(status.installation.name).toBe('${clickhouse.metadata.name}');
      expect(status.installation.namespace).toBe('${clickhouse.metadata.namespace}');

      // KRO status CEL can never reference schema.spec.*.
      expect(JSON.stringify(status)).not.toContain('schema.spec');

      // BARE constants (clickhouse.port/database/user) have no resource
      // anchor, so they stay CLIENT-HYDRATED — absent from KRO status. The
      // native port is still KRO-visible inside nativeUrl above.
      const serializedStatus = JSON.stringify(status);
      expect(serializedStatus).not.toContain('database');
      expect(serializedStatus).not.toContain('user');
      expect(serializedStatus).not.toContain('"port":9000');
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

  describe('topology count validation (at construction time)', () => {
    it.each([0, -1, 1.5])('rejects invalid replicas %p when the composition is constructed', (replicas) => {
      expect(() => makeClickHouseCluster({ replicas })).toThrow(
        /makeClickHouseCluster: 'replicas' must be a positive integer/
      );
    });

    it.each([0, -2, 0.5])('rejects invalid shards %p when the composition is constructed', (shards) => {
      expect(() => makeClickHouseCluster({ shards })).toThrow(
        /makeClickHouseCluster: 'shards' must be a positive integer/
      );
    });

    it('rejects zero counts together (the reviewer repro) without needing toYaml()', () => {
      expect(() => makeClickHouseCluster({ replicas: 0, shards: 0 })).toThrow(
        /must be a positive integer \(got 0\)/
      );
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
