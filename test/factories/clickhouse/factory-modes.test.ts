/**
 * ClickHouse factory-mode coverage — the release-readiness bar set in the
 * PR #95 review, applied retroactively to the clickhouse family (#93): BOTH
 * factory surfaces exercised explicitly for the operator bootstrap and the
 * makeClickHouseCluster variants.
 *
 * - DIRECT: `factory('direct', ...).toYaml(spec)` with fully CONCRETE specs,
 *   asserting the emitted manifests (HelmRelease values incl. a customValues
 *   merge, singleton/sourceRef behavior, per-variant CHI topology) carry no
 *   unresolved schema refs.
 * - KRO: `factory('kro', ...).toYaml(instance)` asserting the instance
 *   bundle shape (singleton owner instance + CR for the bootstrap; CR-only
 *   for the cluster composition, which owns no singleton), and
 *   `factory('kro', ...).toYaml()` asserting the RGD preserves the reworked
 *   #93 status contract (host/nativeUrl/httpUrl/clusterName as CEL over the
 *   chi resource).
 *
 * Singleton emission facts (verified empirically, documented wart):
 * - DIRECT-mode `toYaml(spec)` OMITS singleton-owned resources — the shared
 *   Altinity HelmRepository never appears as a document; the HelmRelease
 *   references it by sourceRef (name/namespace/kind).
 * - KRO-mode `toYaml(instance)` DOES include the singleton owner
 *   declaration: the owner CR instance (in `typekro-singletons`, carrying a
 *   spec fingerprint annotation) precedes the composition CR.
 *
 * Runs under TYPEKRO_STRICT_CEL=1 with a hermetic kubeconfig (some
 * serialization paths resolve the active kubeconfig; a dangling context on
 * the host would otherwise fail with "No active cluster").
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clickhouseOperatorBootstrap,
  DEFAULT_CLICKHOUSE_OPERATOR_VERSION,
  DEFAULT_CLICKHOUSE_REPO_NAME,
  DEFAULT_CLICKHOUSE_REPO_URL,
  makeClickHouseCluster,
} from '../../../src/factories/clickhouse/index.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;
const ORIGINAL_KUBECONFIG = process.env.KUBECONFIG;
let kubeconfigDir: string | undefined;

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';

  // Hermetic minimal kubeconfig: serialization must never depend on (or be
  // broken by) the host's kubeconfig state (run-plan precedent, inlined).
  kubeconfigDir = mkdtempSync(join(tmpdir(), 'typekro-clickhouse-factory-modes-'));
  const kubeconfigPath = join(kubeconfigDir, 'kubeconfig');
  writeFileSync(
    kubeconfigPath,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- cluster: { server: "https://127.0.0.1:1" }',
      '  name: hermetic',
      'contexts:',
      '- context: { cluster: hermetic, user: hermetic }',
      '  name: hermetic',
      'current-context: hermetic',
      'users:',
      '- name: hermetic',
      '  user: {}',
      '',
    ].join('\n')
  );
  process.env.KUBECONFIG = kubeconfigPath;
});

afterAll(() => {
  if (ORIGINAL_STRICT_ENV === undefined) {
    delete process.env.TYPEKRO_STRICT_CEL;
  } else {
    process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT_ENV;
  }
  if (ORIGINAL_KUBECONFIG === undefined) {
    delete process.env.KUBECONFIG;
  } else {
    process.env.KUBECONFIG = ORIGINAL_KUBECONFIG;
  }
  if (kubeconfigDir) {
    rmSync(kubeconfigDir, { recursive: true, force: true });
  }
});

/** Split a multi-document YAML string into trimmed documents. */
function splitDocs(yaml: string): string[] {
  return yaml
    .split(/^---$/m)
    .map((doc) => doc.trim())
    .filter((doc) => doc.length > 0);
}

/** Top-level `kind:` of a single YAML document. */
function docKind(doc: string): string | undefined {
  return doc.match(/^kind: (.+)$/m)?.[1];
}

/** Assert a direct-mode YAML string carries no unresolved refs or markers. */
function expectFullyConcrete(yaml: string): void {
  expect(yaml).not.toContain('${schema.');
  expect(yaml).not.toContain('schema.spec');
  expect(yaml).not.toContain('__typekroSchemaKey');
  expect(yaml).not.toContain('__KUBERNETES_REF__');
  expect(yaml).not.toContain('[object Object]');
  expect(yaml).not.toContain('undefined');
}

describe('clickhouseOperatorBootstrap factory modes', () => {
  const OPERATOR_SPEC = {
    name: 'clickhouse-operator',
    namespace: 'clickhouse-system',
    version: DEFAULT_CLICKHOUSE_OPERATOR_VERSION,
    metrics: { enabled: true },
    crdHook: { enabled: true },
    resources: { requests: { cpu: '100m', memory: '128Mi' } },
    customValues: { nodeSelector: { 'kubernetes.io/os': 'linux' } },
  } as const;

  describe("direct: factory('direct').toYaml(spec) — concrete manifests", () => {
    it('emits the Namespace + HelmRelease with official chart coordinates and NO singleton document', () => {
      const factory = clickhouseOperatorBootstrap.factory('direct', {
        namespace: 'clickhouse-system',
      });
      const yaml = factory.toYaml(OPERATOR_SPEC as never);
      const docs = splitDocs(yaml);
      const kinds = docs.map(docKind);

      expect(kinds).toContain('Namespace');
      expect(kinds).toContain('HelmRelease');
      // DOCUMENTED WART: direct-mode toYaml() omits singleton-owned resources.
      // The shared Altinity HelmRepository is NOT a document here — only the
      // HelmRelease sourceRef points at it (asserted below).
      expect(kinds).not.toContain('HelmRepository');

      const release = docs.find((doc) => docKind(doc) === 'HelmRelease');
      expect(release).toBeDefined();
      expect(release).toContain('chart: altinity-clickhouse-operator');
      expect(release).toContain(`version: ${DEFAULT_CLICKHOUSE_OPERATOR_VERSION}`);
      expect(release).toContain('namespace: clickhouse-system');
      expect(release).toContain('driftDetection:');
      expect(release).toContain('mode: enabled');

      // Singleton behavior in direct mode: sourceRef points at the shared
      // repository singleton BY NAME (the repository object itself is
      // deployed by the singleton owner, not emitted in this bundle).
      expect(release).toMatch(
        new RegExp(
          `sourceRef:\\s*\\n\\s+kind: HelmRepository\\s*\\n\\s+name: ${DEFAULT_CLICKHOUSE_REPO_NAME}\\s*\\n\\s+namespace: flux-system`
        )
      );
    });

    it('renders the typed values AND merges concrete customValues into the HelmRelease', () => {
      const factory = clickhouseOperatorBootstrap.factory('direct', {
        namespace: 'clickhouse-system',
      });
      const yaml = factory.toYaml(OPERATOR_SPEC as never);
      const release = splitDocs(yaml).find((doc) => docKind(doc) === 'HelmRelease');

      // Typed mapped fields render concretely...
      expect(release).toMatch(/metrics:\s*\n\s+enabled: true/);
      expect(release).toMatch(/crdHook:\s*\n\s+enabled: true/);
      expect(release).toMatch(/operator:\s*\n\s+resources:\s*\n\s+requests:\s*\n\s+cpu: 100m/);
      // ...and the per-instance customValues map lands in the same values
      // tree (the graph-mode leak class the #93 review flagged — asserted
      // here on the DIRECT surface with a concrete merge).
      expect(release).toMatch(/nodeSelector:\s*\n\s+kubernetes\.io\/os: linux/);
    });

    it('resolves every schema ref — no unresolved CEL/schema markers anywhere', () => {
      const factory = clickhouseOperatorBootstrap.factory('direct', {
        namespace: 'clickhouse-system',
      });
      expectFullyConcrete(factory.toYaml(OPERATOR_SPEC as never));
    });
  });

  describe("kro: factory('kro').toYaml(...) — instance bundle + RGD contract", () => {
    it('toYaml(instance) bundles the singleton owner instance BEFORE the operator CR', () => {
      const factory = clickhouseOperatorBootstrap.factory('kro', {
        namespace: 'typekro-system',
      });
      const yaml = factory.toYaml({
        name: 'clickhouse-operator',
        namespace: 'clickhouse-system',
      } as never);
      const docs = splitDocs(yaml);
      const kinds = docs.map(docKind);

      // KRO instance emission INCLUDES the singleton owner declaration.
      expect(kinds).toContain('ClickHouseHelmRepository');
      expect(kinds).toContain('ClickHouseOperatorBootstrap');
      expect(kinds.indexOf('ClickHouseHelmRepository')).toBeLessThan(
        kinds.indexOf('ClickHouseOperatorBootstrap')
      );

      const owner = docs.find((doc) => docKind(doc) === 'ClickHouseHelmRepository');
      expect(owner).toContain('namespace: typekro-singletons');
      expect(owner).toContain('typekro.io/singleton-spec-fingerprint');
      expect(owner).toContain(`name: ${DEFAULT_CLICKHOUSE_REPO_NAME}`);
      expect(owner).toContain(`url: ${DEFAULT_CLICKHOUSE_REPO_URL}`);

      const cr = docs.find((doc) => docKind(doc) === 'ClickHouseOperatorBootstrap');
      expect(cr).toContain('name: clickhouse-operator');
      expect(cr).toContain('namespace: typekro-system');
    });

    it('toYaml() emits the owner RGD + bootstrap RGD preserving the HelmRelease-derived status', () => {
      const factory = clickhouseOperatorBootstrap.factory('kro', {
        namespace: 'typekro-system',
      });
      const yaml = factory.toYaml();
      const docs = splitDocs(yaml);

      // Owner RGD first (deps-first apply order), then the bootstrap RGD.
      expect(docs).toHaveLength(2);
      expect(docs.every((doc) => docKind(doc) === 'ResourceGraphDefinition')).toBe(true);
      expect(yaml.indexOf('name: clickhouse-helm-repository')).toBeLessThan(
        yaml.indexOf('name: clickhouse-operator-bootstrap')
      );

      expect(yaml).toContain('ready: ${clickhouseOperatorHelmRelease.status.conditions');
      expect(yaml).toContain('.exists(c, c.type == "Ready"');
      expect(yaml).toContain('Installing');
    });
  });
});

describe('makeClickHouseCluster factory modes', () => {
  describe("direct: factory('direct').toYaml(spec) — concrete CHI topology", () => {
    it('renders the plain 1x1 default as a concrete count-based layout', () => {
      const factory = makeClickHouseCluster().factory('direct', { namespace: 'observability' });
      const yaml = factory.toYaml({
        name: 'ch',
        namespace: 'observability',
        version: '25.7',
        storage: { size: '10Gi' },
      } as never);
      const docs = splitDocs(yaml);

      // The cluster composition owns exactly one resource: the CHI.
      expect(docs).toHaveLength(1);
      expect(docKind(docs[0]!)).toBe('ClickHouseInstallation');

      expect(yaml).toContain('name: ch');
      expect(yaml).toContain('namespace: observability');
      expect(yaml).toContain('shardsCount: 1');
      expect(yaml).toContain('replicasCount: 1');
      expect(yaml).toContain('image: clickhouse/clickhouse-server:25.7');
      expect(yaml).toContain('storage: 10Gi');
      // Single-node default: no keeper, no users.
      expect(yaml).not.toContain('zookeeper');
      expect(yaml).not.toContain('users');
      expectFullyConcrete(yaml);
    });

    it('renders the zone-pinned topology with per-replica layout + concrete zone nodeAffinity, keeper, and users', () => {
      const factory = makeClickHouseCluster({
        zones: ['us-east-2a', 'us-east-2b'],
        replicas: 2,
        shards: 1,
        users: [{ name: 'signoz', networksIp: ['10.0.0.0/8'] }],
      }).factory('direct', { namespace: 'observability' });

      const yaml = factory.toYaml({
        name: 'zch',
        namespace: 'observability',
        version: '25.7',
        storage: { size: '50Gi', storageClassName: 'gp3' },
        keeper: { host: 'keeper.observability.svc.cluster.local' },
        users: { signoz: { passwordSha256Hex: 'abc123' } },
      } as never);

      // Zone-pinned layout: per-replica podTemplates instead of a count.
      expect(yaml).not.toContain('replicasCount');
      expect(yaml).toMatch(
        /replicas:\s*\n\s+- templates:\s*\n\s+podTemplate: clickhouse-us-east-2a\s*\n\s+- templates:\s*\n\s+podTemplate: clickhouse-us-east-2b/
      );

      // The nodeAffinity pinning is CONCRETE in the emitted CHI — one
      // podTemplate per zone.
      for (const zone of ['us-east-2a', 'us-east-2b']) {
        expect(yaml).toMatch(
          new RegExp(
            `name: clickhouse-${zone}[\\s\\S]*?nodeAffinity:[\\s\\S]*?requiredDuringSchedulingIgnoredDuringExecution:[\\s\\S]*?key: topology\\.kubernetes\\.io/zone[\\s\\S]*?operator: In[\\s\\S]*?- ${zone}`
          )
        );
      }

      // Keeper wiring: multi-replica topology gets the zookeeper section with
      // the runtime host and the operator's default client port.
      expect(yaml).toMatch(
        /zookeeper:\s*\n\s+nodes:\s*\n\s+- host: keeper\.observability\.svc\.cluster\.local\s*\n\s+port: 2181/
      );

      // Users render as operator settings paths: concrete password hash +
      // network restrictions.
      expect(yaml).toContain('signoz/password_sha256_hex: abc123');
      expect(yaml).toMatch(/signoz\/networks\/ip:\s*\n\s+- 10\.0\.0\.0\/8/);

      // Storage from the runtime spec.
      expect(yaml).toContain('storage: 50Gi');
      expect(yaml).toContain('storageClassName: gp3');

      expectFullyConcrete(yaml);
    });
  });

  describe("kro: factory('kro').toYaml(...) — instance bundle + RGD contract", () => {
    const CLUSTER_SPEC = {
      name: 'zch',
      namespace: 'observability',
      version: '25.7',
      storage: { size: '50Gi', storageClassName: 'gp3' },
      keeper: { host: 'keeper.observability.svc.cluster.local' },
      users: { signoz: { passwordSha256Hex: 'abc123' } },
    } as const;

    function zonedKroFactory() {
      return makeClickHouseCluster({
        zones: ['us-east-2a', 'us-east-2b'],
        replicas: 2,
        shards: 1,
        users: [{ name: 'signoz' }],
      }).factory('kro', { namespace: 'observability' });
    }

    it('toYaml(instance) emits the ClickHouseCluster CR carrying the runtime spec (no singleton — none owned)', () => {
      const yaml = zonedKroFactory().toYaml(CLUSTER_SPEC as never);
      const docs = splitDocs(yaml);

      // Unlike the bootstrap, this composition owns no singleton, so the
      // instance bundle is exactly the CR.
      expect(docs).toHaveLength(1);
      const cr = docs[0]!;
      expect(docKind(cr)).toBe('ClickHouseCluster');
      expect(cr).toContain('name: zch');
      expect(cr).toContain('namespace: observability');
      expect(cr).toContain('size: 50Gi');
      expect(cr).toContain('host: keeper.observability.svc.cluster.local');
      expect(cr).toMatch(/users:\s*\n\s+signoz:\s*\n\s+passwordSha256Hex: abc123/);
    });

    it('toYaml() emits the RGD preserving the #93 connection contract as CEL over the chi resource', () => {
      const yaml = zonedKroFactory().toYaml();
      const docs = splitDocs(yaml);

      expect(docs).toHaveLength(1);
      expect(docKind(docs[0]!)).toBe('ResourceGraphDefinition');

      // The reworked #93 status contract: host/nativeUrl/httpUrl/clusterName
      // anchored on the OWNED CHI resource (never schema.spec.*), so they
      // land on the live KRO CR's status.
      const statusSection = yaml.slice(yaml.indexOf('status:'), yaml.indexOf('\n  resources:'));
      expect(statusSection).toContain(
        'host: clickhouse-${string(clickhouse.metadata.name)}.${string(clickhouse.metadata.namespace)}.svc.cluster.local'
      );
      expect(statusSection).toContain(
        'nativeUrl: clickhouse://clickhouse-${string(clickhouse.metadata.name)}.${string(clickhouse.metadata.namespace)}.svc.cluster.local:9000'
      );
      expect(statusSection).toContain(
        'httpUrl: http://clickhouse-${string(clickhouse.metadata.name)}.${string(clickhouse.metadata.namespace)}.svc.cluster.local:8123'
      );
      expect(statusSection).toContain(
        'clusterName: ${clickhouse.spec.configuration.clusters[0].name}'
      );
      expect(statusSection).toContain('ready: ${clickhouse.status.status == "Completed"}');
      // KRO status CEL can never reference schema.spec.*.
      expect(statusSection).not.toContain('schema.spec');

      // Zone-pinned build-time topology compiled concrete into the RGD.
      expect(yaml).toContain('podTemplate: clickhouse-us-east-2a');
      expect(yaml).toContain('topology.kubernetes.io/zone');
    });
  });
});
