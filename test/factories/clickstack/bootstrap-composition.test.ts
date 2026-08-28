/**
 * ClickStack bootstrap composition — serialization tests (no cluster).
 *
 * Runs under TYPEKRO_STRICT_CEL=1: the strict gate must accept every status
 * CEL this composition emits (the loud-diagnostic contract).
 *
 * Covers the #93-review rules as applied here:
 *  - build-time vs runtime split (`makeClickstackBootstrap` variants; loud
 *    ref rejection on build-time options),
 *  - the hard pins beating any values passthrough IN THE SERIALIZED OUTPUT
 *    (`clickhouse.enabled: false`, `mongodb.enabled: false`),
 *  - the Mongo mode variants shaping WHICH resources exist,
 *  - the typed status service contract (ui/gateway/app endpoints).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { load } from 'js-yaml';

import {
  clickstackBootstrap,
  makeClickstackBootstrap,
} from '../../../src/factories/clickstack/compositions/clickstack-bootstrap.js';
import { ClickStackBootstrapStatusSchema } from '../../../src/factories/clickstack/types.js';
import { KUBERNETES_REF_BRAND } from '../../../src/shared/brands.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
});

afterAll(() => {
  if (ORIGINAL_STRICT_ENV === undefined) delete process.env.TYPEKRO_STRICT_CEL;
  else process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT_ENV;
});

/** A fake schema-proxy ref, shaped like the analyzer's KubernetesRef marker. */
function fakeRef(path: string): unknown {
  return { [KUBERNETES_REF_BRAND]: true, resourceId: '__schema__', fieldPath: path };
}

describe('clickstackBootstrap (internal-Mongo default)', () => {
  it('serializes an RGD wrapping the official clickstack chart under strict CEL', () => {
    const yaml = clickstackBootstrap.toYaml();

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('kind: HelmRelease');
    // The official chart, by name — never hdx-oss-v2 / the archived repo.
    expect(yaml).toContain('chart: clickstack');
    expect(yaml).not.toContain('hdx-oss-v2');
    // The internal Mongo variant carries its StatefulSet + Service.
    expect(yaml).toContain('kind: StatefulSet');
    expect(yaml).toContain('mongo:7');
  });

  it('hard-pins the bundled clickhouse + mongodb OFF in the serialized values', () => {
    const yaml = clickstackBootstrap.toYaml();
    // The pins live under values.clickhouse.enabled / values.mongodb.enabled.
    // Serialized YAML nests them; assert the pinned `enabled: false` blocks exist
    // and no `enabled: true` appears for either subchart key.
    expect(yaml).toMatch(/clickhouse:\s*\n\s+enabled: false/);
    expect(yaml).toMatch(/mongodb:\s*\n\s+enabled: false/);
  });

  it('the pins beat a build-time values passthrough trying to re-enable the subcharts', () => {
    const subverted = makeClickstackBootstrap({
      values: { clickhouse: { enabled: true }, mongodb: { enabled: true } },
      name: 'clickstack-subverted',
      kind: 'ClickstackSubverted',
    });
    const yaml = subverted.toYaml();
    expect(yaml).toMatch(/clickhouse:\s*\n\s+enabled: false/);
    expect(yaml).toMatch(/mongodb:\s*\n\s+enabled: false/);
    expect(yaml).not.toMatch(/clickhouse:\s*\n\s+enabled: true/);
    expect(yaml).not.toMatch(/mongodb:\s*\n\s+enabled: true/);
  });

  it('serializes the connection contract into KRO status as CEL over the owned HelmRelease', () => {
    const yaml = clickstackBootstrap.toYaml();
    const documents = yaml
      .split(/^---$/m)
      .map((document) => document.trim())
      .filter(Boolean)
      .map((document) => load(document) as Record<string, unknown>);
    const root = documents.find((document) => {
      const spec = document.spec as { schema?: { kind?: string } } | undefined;
      return (
        document.kind === 'ResourceGraphDefinition' && spec?.schema?.kind === 'ClickStackBootstrap'
      );
    }) as { spec: { schema: { status: Record<string, unknown> } } };
    const status = root.spec.schema.status as {
      ui: { url: string };
      gateway: { otlpHttpEndpoint: string; otlpGrpcEndpoint: string };
      app: { host: string };
    };
    // Resource-derived fields serialize as KRO CEL off the owned HelmRelease...
    expect(yaml).toMatch(/ready: \$\{clickstackHelmRelease\.status\.conditions\.exists/);
    expect(yaml).toContain('phase:');
    // ...and so does the CONNECTION CONTRACT (ui/gateway/app): it is anchored
    // on the HelmRelease resource (raw CEL over clickstackHelmRelease.metadata,
    // fullnameOverride-pinned naming, chart-default ports inside the URL
    // strings), so GitOps/KRO consumers see it on the live KRO CR's status.
    // (Same reachability class as the PR #93 review finding — a spec-derived
    // or metadata-proxy derivation would be client-hydrated and dropped.)
    expect(status.ui.url).toBe(
      'http://${string(clickstackHelmRelease.metadata.name)}.${string(clickstackHelmRelease.metadata.namespace)}.svc.cluster.local:3000'
    );
    expect(status.gateway.otlpHttpEndpoint).toBe(
      'http://${string(clickstackHelmRelease.metadata.name)}-otel-collector.${string(clickstackHelmRelease.metadata.namespace)}.svc.cluster.local:4318'
    );
    expect(status.gateway.otlpGrpcEndpoint).toBe(
      'http://${string(clickstackHelmRelease.metadata.name)}-otel-collector.${string(clickstackHelmRelease.metadata.namespace)}.svc.cluster.local:4317'
    );
    expect(status.app.host).toBe(
      '${string(clickstackHelmRelease.metadata.name)}.${string(clickstackHelmRelease.metadata.namespace)}.svc.cluster.local'
    );
    // KRO status CEL can never reference schema.spec.*.
    expect(JSON.stringify(status)).not.toContain('schema.spec');
    // BARE constants (app.appPort/apiPort, version) have no resource anchor
    // and stay CLIENT-HYDRATED — absent from KRO status; the ports remain
    // KRO-visible inside the URL fields above.
    expect(JSON.stringify(status)).not.toContain('appPort');
    expect(JSON.stringify(status)).not.toContain('apiPort');

    // The typed contract itself is declared on the status schema (client-hydrated fields included).
    const valid = ClickStackBootstrapStatusSchema({
      ready: true,
      phase: 'Ready',
      ui: { url: 'http://clickstack.clickstack.svc.cluster.local:3000' },
      gateway: {
        otlpHttpEndpoint: 'http://clickstack-otel-collector.clickstack.svc.cluster.local:4318',
        otlpGrpcEndpoint: 'http://clickstack-otel-collector.clickstack.svc.cluster.local:4317',
      },
      app: { host: 'clickstack.clickstack.svc.cluster.local', appPort: 3000, apiPort: 8000 },
    });
    expect(valid).not.toBeInstanceOf(Error);
    // A contract missing the gateway block is rejected.
    const invalid = ClickStackBootstrapStatusSchema({ ready: true, phase: 'Ready' } as never);
    expect(String(invalid)).toContain('gateway');
  });
});

describe('makeClickstackBootstrap (build-time variants)', () => {
  it('owns the default target namespace when namespace is omitted', () => {
    const bootstrap = makeClickstackBootstrap({
      name: 'clickstack-owned-namespace',
      kind: 'ClickstackOwnedNamespace',
    });
    const spec = {
      name: 'clickstack',
      clickhouse: { host: 'clickhouse.example' },
    };

    expect(bootstrap.factory('direct').toYaml(spec)).toContain('kind: Namespace');
    expect(bootstrap.factory('kro').toYaml(spec)).toContain('kind: Namespace');
  });

  it('treats an explicitly supplied target namespace as externally owned', () => {
    const bootstrap = makeClickstackBootstrap({
      name: 'clickstack-external-namespace',
      kind: 'ClickstackExternalNamespace',
    });
    const spec = {
      name: 'clickstack',
      namespace: 'observability',
      clickhouse: { host: 'clickhouse.example' },
    };

    expect(bootstrap.factory('direct').toYaml(spec)).not.toContain('kind: Namespace');
    expect(bootstrap.factory('kro').toYaml(spec)).not.toContain('kind: Namespace');
  });

  it('external-Mongo variant drops the internal Mongo resources and requires mongoUri in the spec schema', () => {
    const external = makeClickstackBootstrap({
      mongo: { mode: 'external' },
      name: 'clickstack-external-mongo',
      kind: 'ClickstackExternalMongo',
    });
    const yaml = external.toYaml();
    expect(yaml).not.toContain('kind: StatefulSet');
    expect(yaml).not.toContain('mongo:7');
    // The variant's spec schema requires the URI (topology shapes the schema).
    expect(yaml).toContain('mongoUri');
  });

  it('loads credential Helm values from a required Secret in direct and KRO modes', () => {
    const bootstrap = makeClickstackBootstrap({
      credentials: { source: 'secretValues' },
      name: 'clickstack-secret-values',
      kind: 'ClickstackSecretValues',
    });
    const spec = {
      name: 'clickstack',
      namespace: 'observability',
      clickhouse: { host: 'clickhouse.example', username: 'otelcollector' },
      credentialsSecret: { name: 'clickstack-credentials', valuesKey: 'private-values.yaml' },
    };

    const directYaml = bootstrap.factory('direct').toYaml(spec);
    expect(directYaml).toContain('valuesFrom:');
    expect(directYaml).toContain('name: clickstack-credentials');
    expect(directYaml).toContain('valuesKey: private-values.yaml');
    expect(directYaml).not.toContain('CLICKHOUSE_PASSWORD');
    expect(directYaml).not.toContain('CLICKHOUSE_APP_PASSWORD');
    expect(directYaml).not.toContain('HYPERDX_API_KEY');

    const kroYaml = bootstrap.toYaml();
    expect(kroYaml).toContain('credentialsSecret');
    expect(kroYaml).toContain('name: ${schema.spec.credentialsSecret.name}');
    expect(kroYaml).toContain('schema.spec.credentialsSecret.valuesKey');
    expect(kroYaml).not.toContain('schema.spec.clickhouse.password');
    expect(kroYaml).not.toContain('schema.spec.clickhouse.appPassword');
    expect(kroYaml).not.toContain('schema.spec.apiKey');
  });

  it('keeps the existing inline-credential contract as the default variant', () => {
    const yaml = makeClickstackBootstrap({
      name: 'clickstack-inline-values',
      kind: 'ClickstackInlineValues',
    }).toYaml();

    expect(yaml).toContain('password: string');
    expect(yaml).toContain('apiKey: string');
    expect(yaml).not.toContain('credentialsSecret');
    expect(yaml).not.toContain('valuesFrom:');
  });

  it('rejects schema refs in build-time options with an actionable error', () => {
    expect(() =>
      makeClickstackBootstrap({
        // Build-time raw values must be concrete — a ref here can never serialize.
        values: { hyperdx: { replicas: fakeRef('spec.replicas') } } as never,
        name: 'clickstack-ref-values',
        kind: 'ClickstackRefValues',
      })
    ).toThrow(/build-time|concrete|constructor/i);
  });
});
