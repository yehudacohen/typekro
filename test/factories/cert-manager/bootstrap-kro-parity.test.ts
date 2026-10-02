/**
 * `certManagerBootstrap` renders the same chart values in KRO mode as in direct
 * mode.
 *
 * The KRO side is evaluated the way KRO would: every `${...}` in the RGD's
 * HelmRelease template is evaluated with `schema.spec` bound to the instance
 * spec, and `omit()` drops the field. Empty objects are pruned on both sides
 * before comparing, because Helm merges `{}` over a chart default as a no-op.
 *
 * The templates only use a small CEL subset: `has()` guards joined by `&&`,
 * `dyn()`, `!= null`, ternaries, field paths and string/number/bool literals.
 * cel-js (the direct-mode evaluator) does not absorb an error on the right of a
 * false `&&` the way KRO's cel-go does, so `has(a) && has(a.b)` throws on a
 * missing `a` there. The subset is therefore evaluated as JavaScript, whose
 * `&&` and `?:` short-circuit like cel-go's. Anything outside the subset fails
 * the test rather than being evaluated loosely.
 */

import { describe, expect, it } from 'bun:test';
import { load, loadAll } from 'js-yaml';
import {
  certManagerBootstrap,
  certManagerHelmRelease,
} from '../../../src/factories/cert-manager/index.js';
import type { CertManagerBootstrapConfig } from '../../../src/factories/cert-manager/types.js';
import { mapCertManagerConfigToHelmValues } from '../../../src/factories/cert-manager/utils/helm-values-mapper.js';

interface HelmReleaseDocument {
  kind: string;
  metadata: { name: string; namespace?: string };
  spec: { chart: { spec: { version?: string } }; values?: Record<string, unknown> };
}

const OMIT = Symbol('omit');
const CEL_SUBSET =
  /^(?:has\(|dyn\(|int\(|omit\(\)|\.matches\(|schema\.spec(?:\.[A-Za-z_][A-Za-z0-9_]*)*|&&|!=|null|true|false|\?|:|\(|\)|\{|\}|,|"[^"\\]*"|-?\d+|\s+)+$/;

function lookup(spec: unknown, path: string): unknown {
  let node: unknown = { schema: { spec } };
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function evaluateCel(expression: string, spec: CertManagerBootstrapConfig): unknown {
  expect(expression).toMatch(CEL_SUBSET);
  const js = expression
    .replace(/has\((schema\.spec[.\w]*)\)/g, (_m, path: string) =>
      String(lookup(spec, path) !== undefined)
    )
    .replace(/(schema\.spec[.\w]*)\.matches\(("[^"]*")\)/g, '__matches($1, $2)');
  const fn = new Function('schema', 'dyn', 'omit', 'int', '__matches', `return (${js});`);
  return fn(
    { spec },
    (value: unknown) => value,
    () => OMIT,
    (value: string) => Number.parseInt(value, 10),
    (value: string, pattern: string) => new RegExp(pattern).test(value)
  );
}

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const next = normalize(child);
      if (next === OMIT || next === undefined) continue;
      if (
        next &&
        typeof next === 'object' &&
        !Array.isArray(next) &&
        Object.keys(next).length === 0
      ) {
        continue;
      }
      out[key] = next;
    }
    return out;
  }
  return value;
}

/** Evaluate a KRO template value the way KRO does for one instance. */
function instantiate(template: unknown, spec: CertManagerBootstrapConfig): unknown {
  if (typeof template === 'string') {
    const whole = /^\$\{([\s\S]*)\}$/.exec(template);
    if (whole?.[1]) return evaluateCel(whole[1], spec);
    expect(template).not.toContain('${');
    return template;
  }
  if (Array.isArray(template)) return template.map((item) => instantiate(item, spec));
  if (template && typeof template === 'object') {
    return Object.fromEntries(
      Object.entries(template).map(([key, child]) => [key, instantiate(child, spec)])
    );
  }
  return template;
}

function directRelease(spec: CertManagerBootstrapConfig): HelmReleaseDocument {
  const yaml = certManagerBootstrap.factory('direct', { namespace: 'default' }).toYaml(spec);
  const release = (loadAll(yaml) as HelmReleaseDocument[]).find(
    (doc) => doc?.kind === 'HelmRelease'
  );
  if (!release) throw new Error('direct render has no HelmRelease');
  return release;
}

function kroRelease(spec: CertManagerBootstrapConfig): HelmReleaseDocument {
  const rgd = load(certManagerBootstrap.toYaml()) as {
    spec: { resources: { id: string; template: unknown }[] };
  };
  const template = rgd.spec.resources.find((r) => r.id === 'certManagerHelmRelease')?.template;
  if (!template) throw new Error('RGD has no certManagerHelmRelease');
  return instantiate(template, spec) as HelmReleaseDocument;
}

const spread = (component: string) => [
  {
    maxSkew: 1,
    topologyKey: 'topology.kubernetes.io/zone',
    whenUnsatisfiable: 'ScheduleAnyway' as const,
    labelSelector: { matchLabels: { 'app.kubernetes.io/component': component } },
  },
];

const SPECS: Record<string, CertManagerBootstrapConfig> = {
  minimal: { name: 'cert-manager' },
  namespaceOnly: { name: 'cert-manager', namespace: 'certs' },
  legacyInstallCRDs: { name: 'cert-manager', installCRDs: false },
  percentageStrategy: {
    name: 'cert-manager',
    strategy: { rollingUpdate: { maxSurge: '25%', maxUnavailable: '0' } },
  },
  recreate: { name: 'cert-manager', strategy: { type: 'Recreate' } },
  highlyAvailable: {
    name: 'cert-manager',
    namespace: 'certs',
    version: '1.19.2',
    replicaCount: 3,
    crds: { enabled: true, keep: false },
    global: { leaderElection: { namespace: 'leases' }, logLevel: 4 },
    strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '1', maxUnavailable: '0' } },
    controller: {
      extraArgs: ['--dns01-recursive-nameservers-only'],
      resources: { requests: { cpu: '50m' }, limits: { memory: '256Mi' } },
      serviceAccount: { annotations: { 'example.com/role': 'cert-manager' } },
      podDisruptionBudget: { enabled: true, minAvailable: '2' },
      topologySpreadConstraints: spread('controller'),
    },
    webhook: {
      replicaCount: 3,
      podDisruptionBudget: { enabled: true, maxUnavailable: '1' },
      topologySpreadConstraints: spread('webhook'),
    },
    cainjector: {
      replicaCount: 2,
      podDisruptionBudget: { enabled: true, minAvailable: '50%' },
      topologySpreadConstraints: spread('cainjector'),
    },
    startupapicheck: { timeout: '10m' },
    prometheus: { enabled: true, servicemonitor: { enabled: true } },
  },
};

describe('certManagerBootstrap KRO / direct parity', () => {
  for (const [name, spec] of Object.entries(SPECS)) {
    it(`${name}: KRO renders the same HelmRelease as direct mode`, () => {
      const direct = directRelease(spec);
      const kro = kroRelease(spec);
      expect(normalize(kro.spec.values)).toEqual(normalize(direct.spec.values));
      expect(kro.metadata.namespace ?? '').toBe(direct.metadata.namespace ?? '');
      expect(String(kro.spec.chart.spec.version)).toBe(String(direct.spec.chart.spec.version));
      expect(Object.keys(kro.spec.values ?? {})).not.toContain('installCRDs');
      expect(Object.keys(direct.spec.values ?? {})).not.toContain('installCRDs');
    });
  }

  it('keeps replicas, the lease namespace, PDBs and spread constraints in KRO mode', () => {
    const values = normalize(
      kroRelease(SPECS.highlyAvailable as CertManagerBootstrapConfig).spec.values
    ) as Record<string, unknown>;
    expect(values.replicaCount).toBe(3);
    expect(values.global).toMatchObject({ leaderElection: { namespace: 'leases' } });
    expect(values.podDisruptionBudget).toEqual({ enabled: true, minAvailable: '2' });
    expect(values.topologySpreadConstraints).toEqual(spread('controller'));
    expect(values.webhook).toMatchObject({
      replicaCount: 3,
      podDisruptionBudget: { enabled: true, maxUnavailable: '1' },
      topologySpreadConstraints: spread('webhook'),
    });
    expect(values.cainjector).toMatchObject({
      replicaCount: 2,
      podDisruptionBudget: { enabled: true, minAvailable: '50%' },
    });
    expect(values.crds).toEqual({ enabled: true, keep: false });
    // Digit-only strings reach the Deployment as integers; '1' as a string is rejected.
    expect(values.strategy).toEqual({
      type: 'RollingUpdate',
      rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
    });
    expect(values.resources).toEqual({
      requests: { cpu: '50m', memory: '32Mi' },
      limits: { cpu: '100m', memory: '256Mi' },
    });
  });

  it('keeps percentages as strings and renders no rollingUpdate next to Recreate', () => {
    for (const release of [kroRelease, directRelease]) {
      const pct = normalize(
        release(SPECS.percentageStrategy as CertManagerBootstrapConfig).spec.values
      ) as Record<string, unknown>;
      expect(pct.strategy).toEqual({ rollingUpdate: { maxSurge: '25%', maxUnavailable: 0 } });
      const recreate = normalize(
        release(SPECS.recreate as CertManagerBootstrapConfig).spec.values
      ) as Record<string, unknown>;
      expect(recreate.strategy).toEqual({ type: 'Recreate' });
    }
  });

  it('defaults the lease to the install namespace, not kube-system', () => {
    const values = normalize(
      kroRelease(SPECS.namespaceOnly as CertManagerBootstrapConfig).spec.values
    ) as Record<string, unknown>;
    expect(values.global).toEqual({ leaderElection: { namespace: 'certs' } });
  });

  it('installs and keeps the CRDs by default, and honours the deprecated installCRDs', () => {
    const defaults = normalize(kroRelease({ name: 'cert-manager' }).spec.values) as Record<
      string,
      unknown
    >;
    expect(defaults.crds).toEqual({ enabled: true, keep: true });
    const legacy = normalize(
      kroRelease(SPECS.legacyInstallCRDs as CertManagerBootstrapConfig).spec.values
    ) as Record<string, unknown>;
    expect(legacy.crds).toEqual({ enabled: false, keep: true });
  });
});

describe('certManagerHelmRelease values defaults', () => {
  it('defaults to crds.enabled / crds.keep instead of the deprecated installCRDs', () => {
    const release = certManagerHelmRelease({ name: 'cert-manager' });
    expect(release.spec.values).toEqual({
      crds: { enabled: true, keep: true },
      startupapicheck: { enabled: true, timeout: '5m' },
    });
  });

  it('adds no crds default when the caller still sets installCRDs (the chart refuses both)', () => {
    const release = certManagerHelmRelease({ name: 'cert-manager', values: { installCRDs: true } });
    expect(release.spec.values).toEqual({
      installCRDs: true,
      startupapicheck: { enabled: true, timeout: '5m' },
    });
  });

  it('lets caller values replace the defaults', () => {
    const release = certManagerHelmRelease({
      name: 'cert-manager',
      values: { crds: { enabled: false }, replicaCount: 2 },
    });
    expect(release.spec.values).toMatchObject({ crds: { enabled: false }, replicaCount: 2 });
  });
});

describe('mapCertManagerConfigToHelmValues customValues and installCRDs', () => {
  it('lets direct-mode customValues that set installCRDs own the CRD setting', () => {
    const values = mapCertManagerConfigToHelmValues({
      name: 'cert-manager',
      customValues: { installCRDs: true },
    });
    expect(values.installCRDs).toBe(true);
    expect(Object.keys(values)).not.toContain('crds');
  });

  it('keeps crds when customValues set both', () => {
    const values = mapCertManagerConfigToHelmValues({
      name: 'cert-manager',
      customValues: { installCRDs: false, crds: { enabled: true } },
    });
    expect(values.crds).toEqual({ enabled: true });
  });
});
