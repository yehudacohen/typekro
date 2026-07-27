/**
 * ClickStack factory-mode coverage — the release-readiness bar from the PR #95
 * review: BOTH factory surfaces exercised explicitly for both compositions.
 *
 * - DIRECT: `factory('direct', ...).toYaml(spec)` with fully CONCRETE specs,
 *   asserting the emitted manifests (HelmRelease values, namespace wiring,
 *   singleton/sourceRef behavior, required secretKeyRef) carry no unresolved
 *   schema refs.
 * - KRO: `factory('kro', ...).toYaml(instance)` asserting the instance bundle
 *   includes the singleton owner instance(s) PLUS the CR, and
 *   `factory('kro', ...).toYaml()` asserting the RGD bundle preserves the
 *   status/endpoint contract and the secret wiring.
 *
 * Singleton emission facts (verified empirically, documented wart):
 * - DIRECT-mode `toYaml(spec)` OMITS singleton-owned resources — the shared
 *   HelmRepository never appears as a document; the HelmRelease references it
 *   by sourceRef (name/namespace/kind). Assertions here target what IS
 *   emitted.
 * - KRO-mode `toYaml(instance)` DOES include the singleton owner
 *   declarations: the owner CR instance (in `typekro-singletons`, carrying a
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
import { loadAll } from 'js-yaml';

import { clickstackBootstrap } from '../../../src/factories/clickstack/compositions/clickstack-bootstrap.js';
import { clickstackK8sTelemetry } from '../../../src/factories/clickstack/compositions/k8s-telemetry.js';
import {
  DEFAULT_CLICKSTACK_REPO_NAME,
  DEFAULT_CLICKSTACK_REPO_URL,
  DEFAULT_CLICKSTACK_VERSION,
  DEFAULT_OTEL_COLLECTOR_VERSION,
  DEFAULT_OTEL_REPO_NAME,
  DEFAULT_OTEL_REPO_URL,
} from '../../../src/factories/clickstack/resources/helm.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;
const ORIGINAL_KUBECONFIG = process.env.KUBECONFIG;
let kubeconfigDir: string | undefined;

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';

  // Hermetic minimal kubeconfig: serialization must never depend on (or be
  // broken by) the host's kubeconfig state (run-plan precedent, inlined).
  kubeconfigDir = mkdtempSync(join(tmpdir(), 'typekro-clickstack-factory-modes-'));
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

function findSecretKeyRefs(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap(findSecretKeyRefs);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const object = value as Record<string, unknown>;
  const own =
    object.secretKeyRef && typeof object.secretKeyRef === 'object'
      ? [object.secretKeyRef as Record<string, unknown>]
      : [];
  return own.concat(Object.values(object).flatMap(findSecretKeyRefs));
}

const BOOTSTRAP_SPEC = {
  name: 'clickstack',
  namespace: 'clickstack',
  clickhouse: {
    host: 'clickhouse-observability.clickhouse.svc.cluster.local',
    username: 'otelcollector',
    password: 'collector-pw',
  },
  apiKey: 'test-ingestion-api-key',
} as const;

const TELEMETRY_SPEC = {
  name: 'telemetry',
  namespace: 'clickstack-telemetry',
  endpoint: 'http://clickstack-otel-collector.clickstack.svc.cluster.local:4318',
  apiKeySecret: { name: 'hyperdx-api-key' },
} as const;

describe('clickstackBootstrap factory modes', () => {
  describe("direct: factory('direct').toYaml(spec) — concrete manifests", () => {
    it('emits the internal-Mongo resource set with correct namespace wiring and NO singleton document', () => {
      const factory = clickstackBootstrap.factory('direct', { namespace: 'clickstack' });
      const yaml = factory.toYaml(BOOTSTRAP_SPEC as never);
      const docs = splitDocs(yaml);
      const kinds = docs.map(docKind);

      // Internal-Mongo default: Namespace + Mongo StatefulSet/Service + HelmRelease.
      expect(kinds).toContain('Namespace');
      expect(kinds).toContain('StatefulSet');
      expect(kinds).toContain('Service');
      expect(kinds).toContain('HelmRelease');
      expect(yaml).toContain('image: mongo:7');
      expect(yaml).toContain('name: clickstack-mongodb');

      // DOCUMENTED WART: direct-mode toYaml() omits singleton-owned resources.
      // The shared HelmRepository is NOT a document here — only the HelmRelease
      // sourceRef points at it (asserted below).
      expect(kinds).not.toContain('HelmRepository');

      // Namespace wiring: every namespaced document targets the spec namespace.
      for (const doc of docs) {
        if (docKind(doc) === 'Namespace') continue;
        expect(doc).toContain('namespace: clickstack');
      }
    });

    it('renders the HelmRelease with the expected chart values, pins, and singleton sourceRef', () => {
      const factory = clickstackBootstrap.factory('direct', { namespace: 'clickstack' });
      const yaml = factory.toYaml(BOOTSTRAP_SPEC as never);
      const release = splitDocs(yaml).find((doc) => docKind(doc) === 'HelmRelease');
      expect(release).toBeDefined();

      // Official chart coordinates.
      expect(release).toContain('chart: clickstack');
      expect(release).toContain(`version: ${DEFAULT_CLICKSTACK_VERSION}`);

      // Singleton behavior in direct mode: sourceRef points at the shared
      // repository singleton BY NAME (the repository object itself is deployed
      // by the singleton owner, not emitted in this bundle).
      expect(release).toMatch(
        new RegExp(
          `sourceRef:\\s*\\n\\s+kind: HelmRepository\\s*\\n\\s+name: ${DEFAULT_CLICKSTACK_REPO_NAME}\\s*\\n\\s+namespace: flux-system`
        )
      );

      // External-only build-around pins survive into the concrete values.
      expect(release).toMatch(/clickhouse:\s*\n\s+enabled: false/);
      expect(release).toMatch(/mongodb:\s*\n\s+enabled: false/);
      // The status contract's naming anchor.
      expect(release).toContain('fullnameOverride: clickstack');

      // External-ClickHouse wiring is fully concrete.
      expect(release).toContain(
        'CLICKHOUSE_ENDPOINT: tcp://clickhouse-observability.clickhouse.svc.cluster.local:9000?dial_timeout=10s'
      );
      expect(release).toContain(
        'CLICKHOUSE_SERVER_ENDPOINT: clickhouse-observability.clickhouse.svc.cluster.local:9000'
      );
      expect(release).toContain('CLICKHOUSE_USER: otelcollector');
      expect(release).toContain('HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE: default');
      expect(release).toContain('CLICKHOUSE_PASSWORD: collector-pw');
      expect(release).toContain('HYPERDX_API_KEY: test-ingestion-api-key');

      // Internal Mongo URI derived from the concrete name/namespace.
      expect(release).toContain(
        'MONGO_URI: mongodb://clickstack-mongodb.clickstack.svc.cluster.local:27017/hyperdx'
      );

      // HyperDX UI connection/sources are concrete JSON (http port default 8123).
      expect(release).toContain(
        '"host":"http://clickhouse-observability.clickhouse.svc.cluster.local:8123"'
      );
      expect(release).toContain('"username":"otelcollector"');
      expect(release).toContain('"tableName":"otel_logs"');
    });

    it('resolves every schema ref — no unresolved CEL/schema markers anywhere', () => {
      const factory = clickstackBootstrap.factory('direct', { namespace: 'clickstack' });
      const yaml = factory.toYaml(BOOTSTRAP_SPEC as never);

      expect(yaml).not.toContain('${schema.');
      expect(yaml).not.toContain('schema.spec');
      expect(yaml).not.toContain('__typekroSchemaKey');
      expect(yaml).not.toContain('__KUBERNETES_REF__');
      expect(yaml).not.toContain('[object Object]');
      expect(yaml).not.toContain('undefined');
    });
  });

  describe("kro: factory('kro').toYaml(...) — instance bundle + RGD contract", () => {
    it('toYaml(instance) bundles the singleton owner instance BEFORE the ClickStackBootstrap CR', () => {
      // `clickstackBootstrap` owns its workload namespace, so pin the instance CR
      // to an explicit control-plane namespace (decoupled from the `clickstack`
      // workload namespace the graph creates).
      const factory = clickstackBootstrap.factory('kro', { instanceNamespace: 'typekro-system' });
      const yaml = factory.toYaml(BOOTSTRAP_SPEC as never);
      const docs = splitDocs(yaml);
      const kinds = docs.map(docKind);

      // KRO instance emission INCLUDES the singleton owner declaration.
      expect(kinds).toContain('ClickStackHelmRepository');
      expect(kinds).toContain('ClickStackBootstrap');
      expect(kinds.indexOf('ClickStackHelmRepository')).toBeLessThan(
        kinds.indexOf('ClickStackBootstrap')
      );

      const owner = docs.find((doc) => docKind(doc) === 'ClickStackHelmRepository');
      expect(owner).toContain('namespace: typekro-singletons');
      expect(owner).toContain('typekro.io/singleton-spec-fingerprint');
      expect(owner).toContain(`name: ${DEFAULT_CLICKSTACK_REPO_NAME}`);
      expect(owner).toContain(`url: ${DEFAULT_CLICKSTACK_REPO_URL}`);

      // The CR carries the runtime spec verbatim (incl. the secret wiring).
      const cr = docs.find((doc) => docKind(doc) === 'ClickStackBootstrap');
      expect(cr).toContain('name: clickstack');
      expect(cr).toContain('namespace: typekro-system');
      expect(cr).toContain('host: clickhouse-observability.clickhouse.svc.cluster.local');
      expect(cr).toContain('apiKey: test-ingestion-api-key');
    });

    it('toYaml() emits the owner RGD + bootstrap RGD preserving the status/endpoint contract', () => {
      const factory = clickstackBootstrap.factory('kro', { namespace: 'typekro-system' });
      const yaml = factory.toYaml();
      const docs = splitDocs(yaml);

      // Owner RGD first (deps-first apply order), then the bootstrap RGD.
      expect(docs).toHaveLength(2);
      expect(docs.every((doc) => docKind(doc) === 'ResourceGraphDefinition')).toBe(true);
      expect(yaml.indexOf('name: clickstack-helm-repository')).toBeLessThan(
        yaml.indexOf('name: clickstack-bootstrap')
      );

      // The status/endpoint contract survives factory serialization: KRO CEL
      // anchored on the owned HelmRelease (never schema.spec.*).
      expect(yaml).toMatch(/ready: \$\{clickstackHelmRelease\.status\.conditions\.exists/);
      expect(yaml).toContain(
        'url: http://${string(clickstackHelmRelease.metadata.name)}.${string(clickstackHelmRelease.metadata.namespace)}.svc.cluster.local:3000'
      );
      expect(yaml).toContain(
        'otlpHttpEndpoint: http://${string(clickstackHelmRelease.metadata.name)}-otel-collector.${string(clickstackHelmRelease.metadata.namespace)}.svc.cluster.local:4318'
      );
      expect(yaml).toContain(
        'otlpGrpcEndpoint: http://${string(clickstackHelmRelease.metadata.name)}-otel-collector.${string(clickstackHelmRelease.metadata.namespace)}.svc.cluster.local:4317'
      );

      // Secret wiring reaches the RGD values as guarded schema CEL.
      expect(JSON.stringify(loadAll(yaml))).toContain(
        '${has(schema.spec.apiKey) ? dyn(schema.spec.apiKey) : omit()}'
      );
    });
  });
});

describe('clickstackK8sTelemetry factory modes', () => {
  describe("direct: factory('direct').toYaml(spec) — concrete manifests", () => {
    it('emits BOTH stock-chart HelmReleases with the documented preset split and namespace wiring', () => {
      const factory = clickstackK8sTelemetry.factory('direct', {
        namespace: 'clickstack-telemetry',
      });
      const yaml = factory.toYaml(TELEMETRY_SPEC as never);
      const docs = splitDocs(yaml);
      const releases = docs.filter((doc) => docKind(doc) === 'HelmRelease');

      expect(releases).toHaveLength(2);
      const daemonset = releases.find((doc) => doc.includes('name: telemetry-daemonset'));
      const deployment = releases.find((doc) => doc.includes('name: telemetry-deployment'));
      expect(daemonset).toBeDefined();
      expect(deployment).toBeDefined();

      // Stock chart + the singleton OTel repository via sourceRef (the
      // repository document itself is singleton-owned and NOT emitted here).
      expect(docs.map(docKind)).not.toContain('HelmRepository');
      for (const release of [daemonset!, deployment!]) {
        expect(release).toContain('chart: opentelemetry-collector');
        expect(release).toContain(`version: ${DEFAULT_OTEL_COLLECTOR_VERSION}`);
        expect(release).toMatch(
          new RegExp(
            `sourceRef:\\s*\\n\\s+kind: HelmRepository\\s*\\n\\s+name: ${DEFAULT_OTEL_REPO_NAME}\\s*\\n\\s+namespace: flux-system`
          )
        );
        expect(release).toContain('namespace: clickstack-telemetry');
      }

      // Preset split per the documented ClickStack k8s ingestion pattern.
      expect(daemonset).toContain('mode: daemonset');
      for (const preset of [
        'logsCollection',
        'hostMetrics',
        'kubeletMetrics',
        'kubernetesAttributes',
      ]) {
        expect(daemonset).toContain(preset);
      }
      expect(deployment).toContain('mode: deployment');
      for (const preset of ['kubernetesAttributes', 'kubernetesEvents', 'clusterMetrics']) {
        expect(deployment).toContain(preset);
      }
      expect(deployment).not.toContain('logsCollection');
    });

    it('wires the otlphttp exporter at the concrete endpoint with env-expanded auth in both instances', () => {
      const factory = clickstackK8sTelemetry.factory('direct', {
        namespace: 'clickstack-telemetry',
      });
      const yaml = factory.toYaml(TELEMETRY_SPEC as never);

      expect(
        yaml.match(
          /endpoint: http:\/\/clickstack-otel-collector\.clickstack\.svc\.cluster\.local:4318/g
        )?.length
      ).toBe(2);
      // Direct mode emits the OTel env expansion LITERALLY (not KRO CEL).
      expect(yaml.match(/authorization: \$\{env:HYPERDX_API_KEY\}/g)?.length).toBe(2);
      expect(yaml.match(/compression: gzip/g)?.length).toBe(2);
    });

    it('renders the api-key secretKeyRef as REQUIRED (optional: false) in both instances', () => {
      const factory = clickstackK8sTelemetry.factory('direct', {
        namespace: 'clickstack-telemetry',
      });
      const yaml = factory.toYaml(TELEMETRY_SPEC as never);

      const secretRefs = findSecretKeyRefs(loadAll(yaml)).filter(
        (ref) => ref.name === 'hyperdx-api-key' && ref.key === 'HYPERDX_API_KEY'
      );
      expect(secretRefs).toHaveLength(2);
      expect(secretRefs.every((ref) => ref.optional === false)).toBe(true);
      expect(yaml).not.toContain('optional: true');
    });

    it('resolves every schema ref — no unresolved CEL/schema markers anywhere', () => {
      const factory = clickstackK8sTelemetry.factory('direct', {
        namespace: 'clickstack-telemetry',
      });
      const yaml = factory.toYaml(TELEMETRY_SPEC as never);

      expect(yaml).not.toContain('${schema.');
      expect(yaml).not.toContain('schema.spec');
      expect(yaml).not.toContain('__typekroSchemaKey');
      expect(yaml).not.toContain('__KUBERNETES_REF__');
      expect(yaml).not.toContain('[object Object]');
      expect(yaml).not.toContain('undefined');
    });
  });

  describe("kro: factory('kro').toYaml(...) — instance bundle + RGD contract", () => {
    it('toYaml(instance) bundles the OTel singleton owner instance BEFORE the telemetry CR', () => {
      const factory = clickstackK8sTelemetry.factory('kro', {
        namespace: 'typekro-system',
      });
      const yaml = factory.toYaml(TELEMETRY_SPEC as never);
      const docs = splitDocs(yaml);
      const kinds = docs.map(docKind);

      expect(kinds).toContain('OpenTelemetryHelmRepository');
      expect(kinds).toContain('ClickStackK8sTelemetry');
      expect(kinds.indexOf('OpenTelemetryHelmRepository')).toBeLessThan(
        kinds.indexOf('ClickStackK8sTelemetry')
      );

      const owner = docs.find((doc) => docKind(doc) === 'OpenTelemetryHelmRepository');
      expect(owner).toContain('namespace: typekro-singletons');
      expect(owner).toContain('typekro.io/singleton-spec-fingerprint');
      expect(owner).toContain(`name: ${DEFAULT_OTEL_REPO_NAME}`);
      expect(owner).toContain(`url: ${DEFAULT_OTEL_REPO_URL}`);

      // The CR carries the secret coordinates + endpoint wiring verbatim.
      const cr = docs.find((doc) => docKind(doc) === 'ClickStackK8sTelemetry');
      expect(cr).toContain('name: hyperdx-api-key');
      expect(cr).toContain(
        'endpoint: http://clickstack-otel-collector.clickstack.svc.cluster.local:4318'
      );
    });

    it('toYaml() emits owner RGD + telemetry RGD preserving the required secret wiring and status contract', () => {
      const factory = clickstackK8sTelemetry.factory('kro', {
        namespace: 'typekro-system',
      });
      const yaml = factory.toYaml();
      const docs = splitDocs(yaml);

      expect(docs).toHaveLength(2);
      expect(docs.every((doc) => docKind(doc) === 'ResourceGraphDefinition')).toBe(true);
      expect(yaml.indexOf('name: opentelemetry-helm-repository')).toBeLessThan(
        yaml.indexOf('name: clickstack-k8s-telemetry')
      );

      // REQUIRED secretKeyRef preserved as schema CEL with the key default —
      // and still optional: false (a missing Secret fails the pod loudly).
      const secretRefs = findSecretKeyRefs(loadAll(yaml)).filter(
        (ref) => ref.name === '${schema.spec.apiKeySecret.name}'
      );
      expect(secretRefs).toHaveLength(2);
      expect(secretRefs.every((ref) => ref.optional === false)).toBe(true);
      expect(secretRefs.map((ref) => ref.key)).toEqual([
        '${has(schema.spec.apiKeySecret) && has(schema.spec.apiKeySecret.key) && schema.spec.apiKeySecret.key != null ? schema.spec.apiKeySecret.key : "HYPERDX_API_KEY"}',
        '${has(schema.spec.apiKeySecret) && has(schema.spec.apiKeySecret.key) && schema.spec.apiKeySecret.key != null ? schema.spec.apiKeySecret.key : "HYPERDX_API_KEY"}',
      ]);

      // Status contract: ready/phase over BOTH owned HelmReleases.
      expect(yaml).toContain(
        "ready: '${(has(clickstackTelemetryDaemonset.status.observedGeneration)"
      );
      expect(yaml).toContain('has(clickstackTelemetryDeployment.status.observedGeneration)');
      expect(yaml).toContain('phase:');

      // KRO mode emits the env expansion as CEL concat (a literal ${env:…}
      // would be parsed as a KRO template) — it must NOT appear literally.
      expect(yaml).toContain('{env:HYPERDX_API_KEY}');
      expect(yaml).not.toContain('authorization: ${env:HYPERDX_API_KEY}');
    });
  });
});
