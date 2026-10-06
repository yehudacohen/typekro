/**
 * Production defaults and options of the Traefik bootstrap (no cluster).
 *
 * - Entrypoint shutdown timing and the pod's termination grace period.
 * - The default PodDisruptionBudget and zone/node spread, and how raw values
 *   take those sections over.
 * - Scheduling (nodeSelector, tolerations, priority class), spec over raw values.
 * - `allowEmptyServices`, watched namespaces and `allowCrossNamespace`.
 * - The JSON access-log header policy, including the CrowdSec preset.
 * - Prometheus on the internal `metrics` entrypoint.
 */
import { describe, expect, it } from 'bun:test';
import { loadAll } from 'js-yaml';

import { makeTraefikBootstrap } from '../../../src/factories/traefik/compositions/traefik-bootstrap.js';
import type { TraefikHelmValues } from '../../../src/factories/traefik/types.js';
import {
  TRAEFIK_CROWDSEC_ACCESS_LOG_FIELDS,
  traefikAccessLogFields,
} from '../../../src/factories/traefik/utils/access-log.js';
import {
  mapTraefikConfigToHelmValues,
  validateTraefikHelmValues,
} from '../../../src/factories/traefik/utils/helm-values-mapper.js';

const map = (
  config: Parameters<typeof mapTraefikConfigToHelmValues>[0],
  options?: Parameters<typeof mapTraefikConfigToHelmValues>[1]
): TraefikHelmValues => mapTraefikConfigToHelmValues(config, options);

describe('shutdown timing', () => {
  it('defaults each entrypoint to 10s accept + 30s drain inside a 60s grace period', () => {
    const values = map({ name: 'traefik' });

    for (const name of ['web', 'websecure']) {
      expect(values.ports?.[name]?.transport?.lifeCycle).toEqual({
        requestAcceptGraceTimeout: '10s',
        graceTimeOut: '30s',
      });
    }
    expect(values.deployment?.terminationGracePeriodSeconds).toBe(60);
    expect(validateTraefikHelmValues(values).some((w) => w.includes('shut down'))).toBe(false);
  });

  it('maps overrides and warns when Kubernetes would kill Traefik mid-drain', () => {
    const values = map({
      name: 'traefik',
      terminationGracePeriodSeconds: 45,
      entrypoints: { websecure: { requestAcceptGraceTimeout: '15s', graceTimeOut: '1m' } },
    });

    expect(values.ports?.websecure?.transport?.lifeCycle).toEqual({
      requestAcceptGraceTimeout: '15s',
      graceTimeOut: '1m',
    });
    // The responding timeouts sit beside the lifecycle, untouched.
    expect(values.ports?.websecure?.transport?.respondingTimeouts?.readTimeout).toBe('90s');
    const warnings = validateTraefikHelmValues(values);
    expect(warnings.filter((w) => w.includes('shut down'))).toEqual([
      expect.stringContaining('`websecure` entrypoint needs 75s'),
    ]);
  });

  it('keeps a raw-values termination grace period when the spec is silent', () => {
    const values = map(
      { name: 'traefik' },
      { baseValues: { deployment: { terminationGracePeriodSeconds: 120 } } }
    );
    expect(values.deployment?.terminationGracePeriodSeconds).toBe(120);
  });
});

describe('disruption and placement', () => {
  it('creates a PodDisruptionBudget that never blocks a drain', () => {
    expect(map({ name: 'traefik' }).podDisruptionBudget).toEqual({
      enabled: true,
      maxUnavailable: 1,
    });
    expect(
      map({ name: 'traefik', podDisruptionBudget: { enabled: false } }).podDisruptionBudget
    ).toEqual({ enabled: false, maxUnavailable: 1 });
  });

  it('lets a raw podDisruptionBudget own the section, so min and max never mix', () => {
    const values = map(
      { name: 'traefik' },
      { baseValues: { podDisruptionBudget: { enabled: true, minAvailable: 2 } } }
    );
    expect(values.podDisruptionBudget).toEqual({ enabled: true, minAvailable: 2 });
  });

  it('spreads replicas softly across zones and nodes, selecting exactly this install', () => {
    const constraints = map({
      name: 'edge',
      scheduling: { zoneSpread: 'DoNotSchedule' },
    }).topologySpreadConstraints;
    const selector = {
      matchLabels: { 'app.kubernetes.io/name': 'traefik', 'app.kubernetes.io/instance': 'edge' },
    };

    expect(constraints).toEqual([
      {
        maxSkew: 1,
        topologyKey: 'topology.kubernetes.io/zone',
        whenUnsatisfiable: 'DoNotSchedule',
        labelSelector: selector,
        matchLabelKeys: ['pod-template-hash'],
      },
      {
        maxSkew: 1,
        topologyKey: 'kubernetes.io/hostname',
        whenUnsatisfiable: 'ScheduleAnyway',
        labelSelector: selector,
        matchLabelKeys: ['pod-template-hash'],
      },
    ]);
    const custom = [
      { maxSkew: 2, topologyKey: 'rack', whenUnsatisfiable: 'ScheduleAnyway' as const },
    ];
    expect(
      map({ name: 'edge' }, { baseValues: { topologySpreadConstraints: custom } })
        .topologySpreadConstraints
    ).toEqual(custom);
  });

  it('maps nodeSelector, tolerations and priority class only when set', () => {
    const values = map({
      name: 'traefik',
      scheduling: {
        nodeSelector: { 'node-role/edge': 'true' },
        tolerations: [{ key: 'edge', operator: 'Exists', effect: 'NoSchedule' }],
        priorityClassName: 'system-cluster-critical',
      },
    });
    expect(values.nodeSelector).toEqual({ 'node-role/edge': 'true' });
    expect(values.tolerations).toEqual([{ key: 'edge', operator: 'Exists', effect: 'NoSchedule' }]);
    expect(values.priorityClassName).toBe('system-cluster-critical');

    const bare = map({ name: 'traefik' });
    expect(bare).not.toHaveProperty('nodeSelector');
    expect(bare).not.toHaveProperty('tolerations');
    expect(bare).not.toHaveProperty('priorityClassName');
  });

  it('falls back to raw scheduling values in KRO mode instead of dropping them', () => {
    const bootstrap = makeTraefikBootstrap({
      name: 'traefik-raw-scheduling',
      kind: 'TraefikRawScheduling',
      values: { nodeSelector: { pool: 'edge' } },
    });
    const yaml = bootstrap.toYaml();

    expect(yaml).toContain('schema.spec.scheduling.nodeSelector');
    expect(yaml).toContain('dyn({"pool": "edge"})');
  });
});

describe('providers', () => {
  it('maps allowEmptyServices to both providers, and namespaces and cross-namespace to the CRD one', () => {
    const values = map({
      name: 'traefik',
      providers: {
        kubernetesIngress: true,
        allowEmptyServices: true,
        namespaces: ['edge', 'orders'],
        allowCrossNamespace: true,
      },
    });

    expect(values.providers?.kubernetesCRD).toMatchObject({
      allowEmptyServices: true,
      allowCrossNamespace: true,
      namespaces: ['edge', 'orders'],
    });
    expect(values.providers?.kubernetesIngress).toMatchObject({
      allowEmptyServices: true,
      namespaces: ['edge', 'orders'],
    });
  });

  it('defaults to keeping empty services, as the chart does, and refusing cross-namespace references', () => {
    const values = map({ name: 'traefik' });
    // Chart 41.5.0 defaults both providers to true: a route whose Service has
    // no ready endpoints answers 503 instead of vanishing.
    expect(values.providers?.kubernetesCRD?.allowEmptyServices).toBe(true);
    expect(values.providers?.kubernetesIngress?.allowEmptyServices).toBe(true);
    expect(
      map({ name: 'traefik', providers: { allowEmptyServices: false } }).providers?.kubernetesCRD
        ?.allowEmptyServices
    ).toBe(false);
    expect(values.providers?.kubernetesCRD?.allowCrossNamespace).toBe(false);
    expect(values.providers?.kubernetesCRD).not.toHaveProperty('namespaces');
  });
});

describe('access log policy', () => {
  it('logs JSON with User-Agent kept and credentials always dropped', () => {
    const values = map({ name: 'traefik' });

    expect(values.accessLog?.format).toBe('json');
    expect(values.accessLog?.fields).toEqual({
      defaultMode: 'keep',
      headers: {
        defaultMode: 'drop',
        names: {
          'User-Agent': 'keep',
          Authorization: 'drop',
          'Proxy-Authorization': 'drop',
          Cookie: 'drop',
          'Set-Cookie': 'drop',
        },
      },
    });
  });

  it('refuses to keep a credential header, in any spelling', () => {
    expect(() => traefikAccessLogFields({ headers: { Authorization: 'keep' } })).toThrow(
      /Authorization carries credentials/
    );
    expect(() => traefikAccessLogFields({ headers: { cookie: 'keep' } })).toThrow(
      /header cookie is Cookie/
    );
    expect(() => traefikAccessLogFields({ headers: { 'Set-Cookie': 'keep' } })).toThrow(
      /Set-Cookie carries credentials/
    );
    // Redacting is fine: the header is logged without its value.
    expect(traefikAccessLogFields({ headers: { Cookie: 'redact' } }).headers?.names?.Cookie).toBe(
      'redact'
    );
  });

  it('crowdsec preset pins every field the CrowdSec parser reads', () => {
    const fields = traefikAccessLogFields({ preset: 'crowdsec', headers: { Referer: 'keep' } });

    for (const field of TRAEFIK_CROWDSEC_ACCESS_LOG_FIELDS) {
      expect(fields.names?.[field]).toBe('keep');
    }
    expect(fields.headers?.names).toMatchObject({ 'User-Agent': 'keep', Referer: 'keep' });
    expect(() =>
      traefikAccessLogFields({ preset: 'crowdsec', fields: { ClientHost: 'drop' } })
    ).toThrow(/needs field ClientHost/);
    expect(() =>
      traefikAccessLogFields({ preset: 'crowdsec', headers: { 'User-Agent': 'drop' } })
    ).toThrow(/needs header User-Agent/);
  });

  it('reaches the HelmRelease through the build-time accessLog option', () => {
    const bootstrap = makeTraefikBootstrap({
      name: 'traefik-crowdsec-logs',
      kind: 'TraefikCrowdsecLogs',
      accessLog: { preset: 'crowdsec', queryParameters: 'keep' },
    });
    const yaml = bootstrap.factory('direct', { namespace: 'flux-system' }).toYaml({
      name: 'traefik',
    });
    const release = loadAll(yaml).find(
      (doc): doc is { kind: string; spec: { values: TraefikHelmValues } } =>
        typeof doc === 'object' && doc !== null && (doc as { kind?: string }).kind === 'HelmRelease'
    );

    expect(release?.spec.values.accessLog?.fields?.names?.ClientHost).toBe('keep');
    expect(release?.spec.values.accessLog?.fields?.queryParameters).toEqual({
      defaultMode: 'keep',
    });
  });
});

describe('Prometheus metrics', () => {
  it('serves them on the internal metrics entrypoint, never exposed', () => {
    const values = map({ name: 'traefik' });

    expect(values.metrics?.prometheus).toEqual({ entryPoint: 'metrics' });
    expect(values.ports?.metrics).toEqual({ port: 9100, expose: { default: false } });
  });

  it('keeps raw Prometheus settings but not an attempt to expose the port', () => {
    const values = map(
      { name: 'traefik' },
      {
        baseValues: {
          metrics: { prometheus: { addRoutersLabels: true, entryPoint: 'websecure' } },
          ports: { metrics: { expose: { default: true }, exposedPort: 9101 } },
        },
      }
    );

    // Raw keys beside the pinned entrypoint are not part of the managed type.
    expect(values.metrics?.prometheus as Record<string, unknown>).toEqual({
      addRoutersLabels: true,
      entryPoint: 'metrics',
    });
    expect(values.ports?.metrics).toEqual({
      exposedPort: 9101,
      port: 9100,
      expose: { default: false },
    });
  });
});
