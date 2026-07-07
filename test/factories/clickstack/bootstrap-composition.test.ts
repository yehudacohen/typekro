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
import { beforeAll, describe, expect, it } from 'bun:test';

import {
  clickstackBootstrap,
  makeClickstackBootstrap,
} from '../../../src/factories/clickstack/compositions/clickstack-bootstrap.js';
import { ClickStackBootstrapStatusSchema } from '../../../src/factories/clickstack/types.js';
import { KUBERNETES_REF_BRAND } from '../../../src/shared/brands.js';

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
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
    // Resource-derived fields serialize as KRO CEL off the owned HelmRelease...
    expect(yaml).toMatch(/ready: \$\{clickstackHelmRelease\.status\.conditions\.exists/);
    expect(yaml).toContain('phase:');
    // ...and so does the CONNECTION CONTRACT (ui/gateway/app): it is anchored
    // on the HelmRelease resource (raw CEL over clickstackHelmRelease.metadata,
    // fullnameOverride-pinned naming, chart-default ports inside the URL
    // strings), so GitOps/KRO consumers see it on the live KRO CR's status.
    // (Same reachability class as the PR #93 review finding — a spec-derived
    // or metadata-proxy derivation would be client-hydrated and dropped.)
    const bootstrapDoc = yaml.slice(yaml.indexOf('kind: ClickStackBootstrap'));
    // Slice the RGD's schema.status block: from the top-level `status:` key to
    // the top-level `resources:` AFTER it (the runtime spec schema contains
    // nested `resources` keys of its own before the status block).
    const statusStart = bootstrapDoc.indexOf('status:');
    const statusSection = bootstrapDoc.slice(
      statusStart,
      bootstrapDoc.indexOf('\n  resources:', statusStart)
    );
    expect(statusSection).toContain(
      'url: ${"http://" + clickstackHelmRelease.metadata.name + "." + clickstackHelmRelease.metadata.namespace + ".svc.cluster.local" + ":3000"}'
    );
    expect(statusSection).toContain(
      'otlpHttpEndpoint: ${"http://" + clickstackHelmRelease.metadata.name + "-otel-collector." + clickstackHelmRelease.metadata.namespace + ".svc.cluster.local" + ":4318"}'
    );
    expect(statusSection).toContain(
      'otlpGrpcEndpoint: ${"http://" + clickstackHelmRelease.metadata.name + "-otel-collector." + clickstackHelmRelease.metadata.namespace + ".svc.cluster.local" + ":4317"}'
    );
    expect(statusSection).toContain(
      'host: ${clickstackHelmRelease.metadata.name + "." + clickstackHelmRelease.metadata.namespace + ".svc.cluster.local"}'
    );
    // KRO status CEL can never reference schema.spec.*.
    expect(statusSection).not.toContain('schema.spec');
    // BARE constants (app.appPort/apiPort, version) have no resource anchor
    // and stay CLIENT-HYDRATED — absent from KRO status; the ports remain
    // KRO-visible inside the URL fields above.
    expect(statusSection).not.toContain('appPort');
    expect(statusSection).not.toContain('apiPort');

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

  it('rejects schema refs in build-time options with an actionable error', () => {
    expect(() =>
      makeClickstackBootstrap({
        // Build-time raw values must be concrete — a ref here can never serialize.
        values: { hyperdx: { replicas: fakeRef('spec.replicas') } } as never,
        name: 'clickstack-ref-values',
        kind: 'ClickstackRefValues',
      }),
    ).toThrow(/build-time|concrete|constructor/i);
  });
});
