/**
 * ClickStack k8s telemetry composition — serialization tests (no cluster).
 *
 * The documented ClickStack Kubernetes ingestion pattern: TWO instances of the
 * STOCK opentelemetry-collector chart (a daemonset for node/pod logs+metrics,
 * a deployment for cluster events/metrics), both exporting otlphttp to the
 * ClickStack gateway with HYPERDX_API_KEY header auth via env expansion (the
 * key value never lands in Helm values). Runs under TYPEKRO_STRICT_CEL=1.
 */
import { beforeAll, describe, expect, it } from 'bun:test';

import {
  clickstackK8sTelemetry,
  makeClickstackK8sTelemetry,
} from '../../../src/factories/clickstack/compositions/k8s-telemetry.js';
import {
  DEFAULT_CLICKSTACK_GATEWAY_ENDPOINT,
  mapK8sTelemetryConfigToHelmValues,
} from '../../../src/factories/clickstack/utils/helm-values-mapper.js';
import { KUBERNETES_REF_BRAND } from '../../../src/shared/brands.js';

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
});

describe('clickstackK8sTelemetry', () => {
  it('serializes BOTH stock-chart instances with the documented preset split', () => {
    const yaml = clickstackK8sTelemetry.toYaml();

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    // Two HelmReleases over the STOCK chart.
    expect(yaml.match(/chart: opentelemetry-collector/g)?.length).toBe(2);
    expect(yaml).toContain('mode: daemonset');
    expect(yaml).toContain('mode: deployment');
    // Daemonset presets (node/pod telemetry)...
    for (const preset of ['logsCollection', 'hostMetrics', 'kubeletMetrics', 'kubernetesAttributes']) {
      expect(yaml).toContain(preset);
    }
    // ...deployment presets (cluster-level).
    for (const preset of ['kubernetesEvents', 'clusterMetrics']) {
      expect(yaml).toContain(preset);
    }
  });

  it('wires the api key via secretKeyRef + env expansion — the key value never lands in values', () => {
    const yaml = clickstackK8sTelemetry.toYaml();
    expect(yaml).toContain('secretKeyRef');
    expect(yaml).toContain('HYPERDX_API_KEY');
  });

  it('defaults the exporter endpoint to the canonical in-cluster gateway; spec overrides it', () => {
    const concrete = mapK8sTelemetryConfigToHelmValues({
      name: 'telemetry',
      apiKeySecret: { name: 'clickstack-api-key' },
    });
    expect(JSON.stringify(concrete.daemonset)).toContain(DEFAULT_CLICKSTACK_GATEWAY_ENDPOINT);

    const overridden = mapK8sTelemetryConfigToHelmValues({
      name: 'telemetry',
      endpoint: 'http://custom-gateway.obs.svc.cluster.local:4318',
      apiKeySecret: { name: 'clickstack-api-key' },
    });
    const text = JSON.stringify(overridden);
    expect(text).toContain('http://custom-gateway.obs.svc.cluster.local:4318');
    expect(text).not.toContain(DEFAULT_CLICKSTACK_GATEWAY_ENDPOINT);
  });

  it('rejects schema refs in build-time options with an actionable error', () => {
    const ref = { [KUBERNETES_REF_BRAND]: true, resourceId: '__schema__', fieldPath: 'spec.mode' };
    expect(() =>
      makeClickstackK8sTelemetry({
        daemonset: { values: { mode: ref } } as never,
        name: 'telemetry-ref',
        kind: 'TelemetryRef',
      }),
    ).toThrow(/build-time|concrete|runtime spec/i);
  });
});
