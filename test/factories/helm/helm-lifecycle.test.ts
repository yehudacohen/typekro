/**
 * Flux lifecycle options (install / upgrade / remediation / CRD policy / drift
 * detection) on every TypeKro HelmRelease factory.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { load, loadAll } from 'js-yaml';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import {
  KUBERNETES_REF_BRAND,
  SCHEMA_REFERENCE_OPTIONAL_BRAND,
} from '../../../src/core/constants/brands.js';
import { evaluateSchemaCelExpression } from '../../../src/core/deployment/schema-cel-evaluator.js';
import { ValidationError } from '../../../src/core/errors.js';
import { createSchemaProxy } from '../../../src/core/references/schema-proxy.js';
import { toResourceGraph } from '../../../src/core/serialization/index.js';
import type { KroCompatibleType } from '../../../src/core/types/serialization.js';
import { checkCelDialectCompatibility } from '../../../src/core/validation/cel-dialect.js';
import { apisixHelmRelease } from '../../../src/factories/apisix/index.js';
import { certManagerHelmRelease } from '../../../src/factories/cert-manager/index.js';
import { ciliumHelmRelease } from '../../../src/factories/cilium/index.js';
import { clickhouseOperatorHelmRelease } from '../../../src/factories/clickhouse/index.js';
import {
  clickstackHelmRelease,
  otelCollectorHelmRelease,
} from '../../../src/factories/clickstack/index.js';
import { cnpgHelmRelease } from '../../../src/factories/cnpg/index.js';
import { dagsterHelmRelease } from '../../../src/factories/dagster/index.js';
import {
  envoyAIGatewayControllerHelmRelease,
  envoyAIGatewayCrdsHelmRelease,
  envoyGatewayHelmRelease,
} from '../../../src/factories/envoy-ai-gateway/index.js';
import { externalDnsHelmRelease } from '../../../src/factories/external-dns/index.js';
import { harborHelmRelease } from '../../../src/factories/harbor/index.js';
import { hatchetHelmRelease } from '../../../src/factories/hatchet/index.js';
import {
  type HelmReleaseLifecycleOptions,
  type HelmReleaseSpec,
  helmRelease,
  helmReleaseLifecycle,
} from '../../../src/factories/helm/index.js';
import { inngestHelmRelease } from '../../../src/factories/inngest/index.js';
import { natsHelmRelease } from '../../../src/factories/nats/index.js';
import { openSearchOperatorHelmRelease } from '../../../src/factories/opensearch/index.js';
import {
  hydraHelmRelease,
  ketoHelmRelease,
  kratosHelmRelease,
  oathkeeperHelmRelease,
} from '../../../src/factories/ory/index.js';
import { pebbleHelmRelease } from '../../../src/factories/pebble/index.js';
import {
  rookCephClusterHelmRelease,
  rookCephOperatorHelmRelease,
} from '../../../src/factories/rook/index.js';
import { traefikHelmRelease } from '../../../src/factories/traefik/index.js';
import { valkeyHelmRelease } from '../../../src/factories/valkey/index.js';
import { isCelExpression, isKubernetesRef } from '../../../src/utils/type-guards.js';

interface RenderedRelease {
  spec: Pick<HelmReleaseSpec, 'install' | 'upgrade' | 'driftDetection' | 'timeout'>;
}

const LIFECYCLE: HelmReleaseLifecycleOptions = {
  install: {
    timeout: '30m',
    crds: 'CreateReplace',
    remediation: { retries: 7, remediateLastFailure: true },
  },
  upgrade: {
    timeout: '25m',
    crds: 'CreateReplace',
    remediation: { retries: 5, remediateLastFailure: true, strategy: 'uninstall' },
  },
  driftDetection: { mode: 'warn' },
};

const envoy = {
  name: 'envoy',
  namespace: 'envoy-gateway-system',
  version: 'v1.0.0',
  repositoryName: 'envoy',
  repositoryNamespace: 'flux-system',
  values: {},
};

/** One factory per HelmRelease the integrations ship, each with minimal config. */
const FACTORIES: Record<string, (options: HelmReleaseLifecycleOptions) => RenderedRelease> = {
  helmRelease: (o) =>
    helmRelease({
      name: 'app',
      chart: { repository: 'https://charts.example.com', name: 'app' },
      ...o,
    }),
  apisix: (o) => apisixHelmRelease({ name: 'apisix', ...o }),
  certManager: (o) => certManagerHelmRelease({ name: 'cert-manager', ...o }),
  cilium: (o) =>
    ciliumHelmRelease({
      name: 'cilium',
      repositoryName: 'cilium',
      repositoryNamespace: 'flux-system',
      ...o,
    }),
  clickhouse: (o) => clickhouseOperatorHelmRelease({ name: 'clickhouse-operator', ...o }),
  clickstack: (o) => clickstackHelmRelease({ name: 'clickstack', ...o }),
  otelCollector: (o) => otelCollectorHelmRelease({ name: 'otel', ...o }),
  cnpg: (o) => cnpgHelmRelease({ name: 'cnpg', ...o }),
  dagster: (o) => dagsterHelmRelease({ name: 'dagster', ...o }),
  envoyGateway: (o) => envoyGatewayHelmRelease({ ...envoy, ...o }),
  envoyAIGatewayCrds: (o) => envoyAIGatewayCrdsHelmRelease({ ...envoy, ...o }),
  envoyAIGatewayController: (o) => envoyAIGatewayControllerHelmRelease({ ...envoy, ...o }),
  externalDns: (o) =>
    externalDnsHelmRelease({ name: 'external-dns', repositoryName: 'edns', ...o }),
  harbor: (o) => harborHelmRelease({ name: 'harbor', ...o }),
  hatchet: (o) => hatchetHelmRelease({ name: 'hatchet', ...o }),
  inngest: (o) => inngestHelmRelease({ name: 'inngest', ...o }),
  nats: (o) =>
    natsHelmRelease({
      name: 'nats',
      namespace: 'nats',
      chart: 'nats',
      version: '1.0.0',
      values: {},
      ...o,
    }),
  openSearch: (o) =>
    openSearchOperatorHelmRelease({
      name: 'opensearch-operator',
      namespace: 'opensearch',
      version: '2.0.0',
      repositoryName: 'opensearch',
      repositoryNamespace: 'flux-system',
      ...o,
    }),
  hydra: (o) => hydraHelmRelease({ name: 'hydra', ...o }),
  kratos: (o) => kratosHelmRelease({ name: 'kratos', ...o }),
  keto: (o) => ketoHelmRelease({ name: 'keto', ...o }),
  oathkeeper: (o) => oathkeeperHelmRelease({ name: 'oathkeeper', ...o }),
  pebble: (o) => pebbleHelmRelease({ name: 'pebble', ...o }),
  rookOperator: (o) => rookCephOperatorHelmRelease({ name: 'rook-ceph', ...o }),
  rookCluster: (o) => rookCephClusterHelmRelease({ name: 'rook-ceph-cluster', ...o }),
  traefik: (o) => traefikHelmRelease({ name: 'traefik', ...o }),
  valkey: (o) => valkeyHelmRelease({ name: 'valkey-operator', ...o }),
};

describe('helmReleaseLifecycle', () => {
  it('defaults to the generic 10m / 3-retry policy', () => {
    expect(helmReleaseLifecycle(undefined)).toEqual({
      install: { timeout: '10m', remediation: { retries: 3 } },
      upgrade: { timeout: '10m', remediation: { retries: 3 } },
    });
  });

  it('merges caller fields over the defaults, remediation field by field', () => {
    expect(
      helmReleaseLifecycle({
        install: { crds: 'CreateReplace', remediation: { remediateLastFailure: true } },
        upgrade: { timeout: '20m', remediation: { retries: 0 } },
      })
    ).toEqual({
      install: {
        timeout: '10m',
        remediation: { retries: 3, remediateLastFailure: true },
        crds: 'CreateReplace',
      },
      upgrade: { timeout: '20m', remediation: { retries: 0 } },
    });
  });

  it('replaces drift detection as a whole and honours factory defaults', () => {
    expect(
      helmReleaseLifecycle(
        { driftDetection: { mode: 'disabled' } },
        { driftDetection: { mode: 'enabled', ignore: [{ paths: ['/spec/replicas'] }] } }
      )
    ).toEqual({ driftDetection: { mode: 'disabled' } });
  });

  it('renders nothing when a factory has no defaults and the caller sets nothing', () => {
    expect(helmReleaseLifecycle({}, {})).toEqual({});
  });
});

describe('every integration HelmRelease factory accepts the lifecycle options', () => {
  for (const [name, factory] of Object.entries(FACTORIES)) {
    it(`${name} renders install, upgrade, CRD policy and drift detection`, () => {
      const { spec } = factory(LIFECYCLE);
      expect(spec.install).toMatchObject(LIFECYCLE.install ?? {});
      expect(spec.upgrade).toMatchObject(LIFECYCLE.upgrade ?? {});
      expect(spec.driftDetection).toEqual({ mode: 'warn' });
    });

    it(`${name} always renders a bounded install and upgrade policy`, () => {
      const { spec } = factory({});
      expect(spec.install?.remediation?.retries).toBeNumber();
      expect(spec.upgrade?.remediation?.retries).toBeNumber();
      // An action without its own timeout falls back to spec.timeout; one of
      // the two must be set, or Flux would use its 5m default.
      expect(spec.install?.timeout ?? spec.timeout).toBeString();
      expect(spec.upgrade?.timeout ?? spec.timeout).toBeString();
    });
  }
});

describe('factory-specific lifecycle defaults', () => {
  it('generic helmRelease passes install.crds and upgrade.crds through (previously dropped)', () => {
    const { spec } = FACTORIES.helmRelease?.({
      install: { crds: 'Create' },
      upgrade: { crds: 'CreateReplace' },
    }) as RenderedRelease;
    expect(spec.install).toEqual({ timeout: '10m', remediation: { retries: 3 }, crds: 'Create' });
    expect(spec.upgrade).toEqual({
      timeout: '10m',
      remediation: { retries: 3 },
      crds: 'CreateReplace',
    });
  });

  it.each([['certManager'], ['externalDns'], ['pebble']])(
    '%s adopts the generic 10m / 3-retry defaults',
    (name) => {
      const { spec } = FACTORIES[name]?.({}) as RenderedRelease;
      expect(spec.install).toEqual({ timeout: '10m', remediation: { retries: 3 } });
      expect(spec.upgrade).toEqual({ timeout: '10m', remediation: { retries: 3 } });
      expect(Object.keys(spec)).not.toContain('driftDetection');
    }
  );

  it('renders a caller CRD policy on a release that had no lifecycle policy (cert-manager)', () => {
    const release = certManagerHelmRelease({
      name: 'cert-manager',
      install: { crds: 'CreateReplace' },
      upgrade: { crds: 'CreateReplace' },
    });
    expect(release.spec.install?.crds).toBe('CreateReplace');
    expect(release.spec.upgrade?.crds).toBe('CreateReplace');
  });

  it('cilium renders its legacy timeout fields instead of ignoring them', () => {
    const flat = ciliumHelmRelease({
      name: 'cilium',
      repositoryName: 'cilium',
      repositoryNamespace: 'flux-system',
      timeout: '15m',
      upgradeTimeout: '20m',
      createNamespace: true,
    });
    expect(flat.spec.timeout).toBe('15m');
    // An action without its own timeout takes the release-wide one, never 10m.
    expect(flat.spec.install).toEqual({
      timeout: '15m',
      remediation: { retries: 3 },
      createNamespace: true,
    });
    expect(flat.spec.upgrade).toEqual({ timeout: '20m', remediation: { retries: 3 } });
    const bare = ciliumHelmRelease({
      name: 'cilium',
      repositoryName: 'cilium',
      repositoryNamespace: 'flux-system',
    });
    expect(bare.spec.install?.timeout).toBe('10m');
    expect(bare.spec.upgrade?.timeout).toBe('10m');
  });

  it('apisix keeps namespace creation and leaves timeouts to spec.timeout', () => {
    const { spec } = apisixHelmRelease({ name: 'apisix', timeout: '20m' });
    expect(spec.timeout).toBe('20m');
    expect(spec.install).toEqual({ remediation: { retries: 3 }, createNamespace: true });
    expect(spec.upgrade).toEqual({ remediation: { retries: 3 } });
  });

  it('traefik keeps its shared CRD policy and lets install/upgrade split it', () => {
    const shared = traefikHelmRelease({ name: 'traefik' });
    expect(shared.spec.install?.crds).toBe('CreateReplace');
    expect(shared.spec.upgrade).toEqual({
      remediation: { retries: 3, remediateLastFailure: true, strategy: 'rollback' },
      crds: 'CreateReplace',
    });
    const split = traefikHelmRelease({
      name: 'traefik',
      crds: 'Create',
      upgrade: { crds: 'Skip' },
    });
    expect(split.spec.install?.crds).toBe('Create');
    expect(split.spec.upgrade?.crds).toBe('Skip');
  });

  it('hatchet and harbor keep no-rollback upgrades unless the caller overrides them', () => {
    for (const release of [
      hatchetHelmRelease({ name: 'hatchet', install: { timeout: '40m' } }),
      harborHelmRelease({ name: 'harbor', install: { timeout: '40m' } }),
    ]) {
      expect(release.spec.install?.timeout).toBe('40m');
      expect(release.spec.upgrade).toEqual({
        timeout: '20m',
        remediation: { retries: 0, remediateLastFailure: false },
      });
      expect(release.spec.driftDetection).toEqual({ mode: 'enabled' });
    }
    const opted = hatchetHelmRelease({ name: 'hatchet', upgrade: { remediation: { retries: 2 } } });
    expect(opted.spec.upgrade?.remediation).toEqual({ retries: 2, remediateLastFailure: false });
  });

  it('operators that enable drift detection still let the caller change it', () => {
    expect(cnpgHelmRelease({ name: 'cnpg' }).spec.driftDetection).toEqual({ mode: 'enabled' });
    expect(
      cnpgHelmRelease({ name: 'cnpg', driftDetection: { mode: 'disabled' } }).spec.driftDetection
    ).toEqual({ mode: 'disabled' });
  });
});

describe('lifecycle options in KRO mode', () => {
  it('serializes schema references in lifecycle fields as CEL', () => {
    const graph = toResourceGraph(
      {
        name: 'lifecycle-refs',
        apiVersion: 'example.com/v1alpha1',
        kind: 'LifecycleRefs',
        spec: type({ installTimeout: 'string', retries: 'number.integer' }),
        status: type({ ready: 'boolean' }),
      },
      (schema) => ({
        certManager: certManagerHelmRelease({
          name: 'cert-manager',
          install: {
            timeout: schema.spec.installTimeout,
            crds: 'CreateReplace',
            remediation: { retries: schema.spec.retries },
          },
          id: 'certManager',
        }),
      }),
      () => ({ ready: true })
    );
    const yaml = graph.toYaml();
    expect(yaml).toContain('timeout: ${schema.spec.installTimeout}');
    expect(yaml).toContain('retries: ${schema.spec.retries}');
    expect(yaml).toContain('crds: CreateReplace');
  });
});

// An instance schema that takes the whole lifecycle objects, each optional and
// each declaring only some of the fields Flux accepts.
const WholeLifecycleSpec = type({
  name: 'string',
  'install?': {
    'timeout?': 'string',
    'crds?': "'Skip' | 'Create' | 'CreateReplace'",
    'remediation?': { 'retries?': 'number.integer', 'remediateLastFailure?': 'boolean' },
  },
  'upgrade?': {
    'timeout?': 'string',
    'remediation?': { 'retries?': 'number.integer', 'strategy?': "'rollback' | 'uninstall'" },
  },
  'driftDetection?': { mode: "'enabled' | 'warn' | 'disabled'" },
});
type WholeLifecycle = typeof WholeLifecycleSpec.infer;

/** `Cel.default(<leaf>, <fallback>)` as it renders into an RGD template. */
function celDefault(path: string, fallback: string): string {
  const segments = path.split('.');
  const guard = segments
    .map((_, index) => `has(schema.spec.${segments.slice(0, index + 1).join('.')})`)
    .join(' && ');
  return `\${${guard} && dyn(schema.spec.${path}) != null ? schema.spec.${path} : ${fallback}}`;
}

/** A schema field that has no default renders omitted when the instance leaves it unset. */
function omittedUnlessSet(path: string): string {
  const segments = path.split('.');
  const guard = segments
    .map((_, index) => `has(schema.spec.${segments.slice(0, index + 1).join('.')})`)
    .join(' && ');
  return `\${${guard} ? schema.spec.${path} : omit()}`;
}

// Resolve a KRO-mode lifecycle against one instance the way KRO would: CEL
// is evaluated, a bare reference reads the instance, and `omit()` drops it.
function resolveForInstance(value: unknown, instance: KroCompatibleType): unknown {
  if (isCelExpression(value)) return evaluateSchemaCelExpression(value, instance);
  if (isKubernetesRef(value)) {
    return value.fieldPath
      .replace(/^spec\./, '')
      .split('.')
      .reduce<unknown>(
        (node, key) => (node as Record<string, unknown> | undefined)?.[key],
        instance
      );
  }
  if (value && typeof value === 'object') {
    const resolved = Object.entries(value)
      .map(([key, child]) => [key, resolveForInstance(child, instance)] as const)
      .filter(([, child]) => child !== undefined);
    return resolved.length > 0 ? Object.fromEntries(resolved) : undefined;
  }
  return value;
}

const wholeLifecycleGraph = kubernetesComposition(
  {
    name: 'whole-lifecycle',
    apiVersion: 'example.com/v1alpha1',
    kind: 'WholeLifecycle',
    spec: WholeLifecycleSpec,
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    helmRelease({
      id: 'app',
      name: spec.name,
      chart: { repository: 'https://charts.example.com', name: 'app' },
      install: spec.install,
      upgrade: spec.upgrade,
      driftDetection: spec.driftDetection,
    });
    cnpgHelmRelease({
      id: 'operator',
      name: 'cnpg',
      install: spec.install,
      upgrade: spec.upgrade,
      driftDetection: spec.driftDetection,
    });
    return { ready: true };
  }
);

interface RgdResource {
  id: string;
  template: { spec: Record<string, unknown> };
}

function rgdReleaseSpec(id: string): Record<string, unknown> {
  const rgd = load(wholeLifecycleGraph.factory('kro').toYaml()) as {
    spec: { resources: RgdResource[] };
  };
  const resource = rgd.spec.resources.find((candidate) => candidate.id === id);
  if (!resource) throw new Error(`no resource ${id} in the RGD`);
  return resource.template.spec;
}

function directReleaseSpec(instance: WholeLifecycle, name: string): Record<string, unknown> {
  const docs = loadAll(wholeLifecycleGraph.factory('direct').toYaml(instance)) as {
    kind?: string;
    metadata?: { name?: string };
    spec: Record<string, unknown>;
  }[];
  const release = docs.find((doc) => doc?.kind === 'HelmRelease' && doc.metadata?.name === name);
  if (!release) throw new Error(`no HelmRelease ${name} in the direct-mode YAML`);
  return release.spec;
}

describe('lifecycle defaults when an override is a whole schema reference', () => {
  it('emits the default as a CEL fallback on every leaf the instance may leave unset', () => {
    const spec = rgdReleaseSpec('app');
    expect(spec.install).toEqual({
      timeout: celDefault('install.timeout', '"10m"'),
      remediation: {
        retries: celDefault('install.remediation.retries', '3'),
        remediateLastFailure: omittedUnlessSet('install.remediation.remediateLastFailure'),
      },
      crds: omittedUnlessSet('install.crds'),
    });
    expect(spec.upgrade).toEqual({
      timeout: celDefault('upgrade.timeout', '"10m"'),
      remediation: {
        retries: celDefault('upgrade.remediation.retries', '3'),
        strategy: omittedUnlessSet('upgrade.remediation.strategy'),
      },
    });
    // No default on the generic factory, so an unset field is simply omitted.
    expect(spec.driftDetection).toBe(omittedUnlessSet('driftDetection'));
  });

  it('applies factory-specific defaults, including a whole drift-detection object', () => {
    const spec = rgdReleaseSpec('operator');
    expect(spec.install).toMatchObject({
      timeout: celDefault('install.timeout', '"10m"'),
      remediation: { retries: celDefault('install.remediation.retries', '3') },
    });
    expect(spec.driftDetection).toBe(
      '${has(schema.spec.driftDetection) && dyn(schema.spec.driftDetection) != null ? ' +
        'dyn(schema.spec.driftDetection) : dyn({"mode": "enabled"})}'
    );
  });

  it('never selects a field the instance schema does not declare', () => {
    const yaml = wholeLifecycleGraph.factory('kro').toYaml();
    for (const undeclared of [
      'install.createNamespace',
      'install.remediation.ignoreTestFailures',
      'upgrade.crds',
      'upgrade.remediation.remediateLastFailure',
    ]) {
      expect(yaml).not.toContain(`schema.spec.${undeclared}`);
    }
  });

  it('renders the same values in direct mode', () => {
    expect(directReleaseSpec({ name: 'unset' }, 'unset')).toMatchObject({
      install: { timeout: '10m', remediation: { retries: 3 } },
      upgrade: { timeout: '10m', remediation: { retries: 3 } },
    });
    const set = directReleaseSpec(
      {
        name: 'set',
        install: { crds: 'CreateReplace', remediation: { retries: 0 } },
        upgrade: { timeout: '30m', remediation: { strategy: 'uninstall' } },
        driftDetection: { mode: 'warn' },
      },
      'set'
    );
    expect(set.install).toEqual({
      timeout: '10m',
      remediation: { retries: 0 },
      crds: 'CreateReplace',
    });
    expect(set.upgrade).toEqual({
      timeout: '30m',
      remediation: { retries: 3, strategy: 'uninstall' },
    });
    expect(set.driftDetection).toEqual({ mode: 'warn' });
  });

  it.each<[string, WholeLifecycle]>([
    ['nothing set', { name: 'a' }],
    ['empty objects', { name: 'a', install: {}, upgrade: { remediation: {} } }],
    [
      'some fields set',
      {
        name: 'a',
        install: { timeout: '45m', remediation: { remediateLastFailure: true } },
        upgrade: { remediation: { retries: 0 } },
      },
    ],
    [
      'every declared field set',
      {
        name: 'a',
        install: {
          timeout: '1h',
          crds: 'Create',
          remediation: { retries: 9, remediateLastFailure: false },
        },
        upgrade: { timeout: '2h', remediation: { retries: 1, strategy: 'rollback' } },
        driftDetection: { mode: 'disabled' },
      },
    ],
  ])('KRO and direct mode agree per instance: %s', (_, instance) => {
    const defaults = { driftDetection: { mode: 'enabled' as const } };
    const schema = createSchemaProxy<WholeLifecycle, { ready: boolean }>(WholeLifecycleSpec.json);
    const kro = helmReleaseLifecycle(
      {
        install: schema.spec.install,
        upgrade: schema.spec.upgrade,
        driftDetection: schema.spec.driftDetection,
      },
      { ...helmReleaseLifecycle(undefined), ...defaults }
    );
    const direct = helmReleaseLifecycle(instance, {
      ...helmReleaseLifecycle(undefined),
      ...defaults,
    });
    expect(resolveForInstance(kro, instance)).toEqual(direct);
  });

  it('leaves a required schema field as a plain reference', () => {
    const schema = createSchemaProxy<{ timeout: string }, { ready: boolean }>(
      type({ timeout: 'string' }).json
    );
    const { install } = helmReleaseLifecycle({ install: { timeout: schema.spec.timeout } });
    expect(isKubernetesRef(install?.timeout)).toBe(true);
  });
});

describe('lifecycle defaults in KRO mode: typing, references and Cilium', () => {
  it('rejects a retries schema field declared as a float (`number`), required or optional', () => {
    const Float = type({
      retries: 'number',
      'install?': { 'remediation?': { 'retries?': 'number' } },
    });
    const schema = createSchemaProxy<typeof Float.infer, { ready: boolean }>(Float.json);
    // KRO types `'number'` as a float, which the CRD's integer field rejects;
    // nothing may coerce it, so the build fails with the declaration to use.
    expect(() =>
      helmReleaseLifecycle({ upgrade: { remediation: { retries: schema.spec.retries } } })
    ).toThrow(/spec\.upgrade\.remediation\.retries .*declare it as 'number\.integer'/);
    expect(() => helmReleaseLifecycle({ install: schema.spec.install })).toThrow(ValidationError);
  });

  it('renders an integer-declared retries field as a plain reference or an int default', () => {
    const Int = type({
      retries: 'number.integer >= 0',
      'install?': { 'remediation?': { 'retries?': 'number.integer' } },
    });
    const schema = createSchemaProxy<typeof Int.infer, { ready: boolean }>(Int.json);
    const required = helmReleaseLifecycle({
      upgrade: { remediation: { retries: schema.spec.retries } },
    }).upgrade?.remediation?.retries;
    expect(isKubernetesRef(required)).toBe(true);
    const { install } = helmReleaseLifecycle({ install: schema.spec.install });
    const retries = install?.remediation?.retries;
    if (!isCelExpression(retries)) throw new Error('expected a CEL default for retries');
    // int field : int literal, which KRO's type checker accepts. No int().
    expect(`\${${retries.expression}}`).toBe(celDefault('install.remediation.retries', '3'));
    expect(checkCelDialectCompatibility(retries.expression, 'retries')).toEqual([]);
    expect(evaluateSchemaCelExpression(retries, {})).toBe(3);
    expect(evaluateSchemaCelExpression(retries, { install: { remediation: { retries: 0 } } })).toBe(
      0
    );
  });

  it('passes a retries reference of unknown type through unchanged for KRO to check', () => {
    const Union = type({ retries: 'number | string' });
    const schema = createSchemaProxy<typeof Union.infer, { ready: boolean }>(Union.json);
    const retries = helmReleaseLifecycle({
      install: { remediation: { retries: schema.spec.retries as number } },
    }).install?.remediation?.retries;
    expect(isKubernetesRef(retries)).toBe(true);
  });

  it('rejects a fractional retries value in direct mode too', () => {
    expect(() => helmReleaseLifecycle({ install: { remediation: { retries: 2.7 } } })).toThrow(
      'HelmRelease spec.install.remediation.retries must be a whole number; got 2.7.'
    );
    expect(() =>
      certManagerHelmRelease({ name: 'cert-manager', upgrade: { remediation: { retries: 1.5 } } })
    ).toThrow(ValidationError);
    expect(
      helmReleaseLifecycle({ install: { remediation: { retries: 0 } } }).install?.remediation
    ).toEqual({ retries: 0 });
  });

  it('keeps a reference to another resource as a plain reference, so KRO waits for it', () => {
    // As a resource proxy hands it over, e.g. `settings.data.timeout`.
    const resourceField = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: 'settings',
      fieldPath: 'data.timeout',
    } as unknown as string;
    const { install } = helmReleaseLifecycle({
      install: {
        timeout: resourceField,
        remediation: { retries: resourceField as unknown as number },
      },
    });
    expect(install?.timeout).toBe(resourceField);
    expect(install?.remediation?.retries).toBe(resourceField as unknown as number);
  });

  it('gives a non-schema reference no fallback even if it carries the optional brand', () => {
    // Only schema fields can be unset on an instance; any other reference keeps
    // KRO's wait-for-the-field behaviour.
    const brandedResourceField = {
      [KUBERNETES_REF_BRAND]: true,
      [SCHEMA_REFERENCE_OPTIONAL_BRAND]: true,
      resourceId: 'settings',
      fieldPath: 'data.timeout',
    } as unknown as string;
    const { install } = helmReleaseLifecycle({ install: { timeout: brandedResourceField } });
    expect(install?.timeout).toBe(brandedResourceField);
  });

  it('leaves an optional integer field with no default as a plain reference', () => {
    const OptionalRetries = type({
      'install?': { 'remediation?': { 'retries?': 'number.integer' } },
    });
    const schema = createSchemaProxy<typeof OptionalRetries.infer, { ready: boolean }>(
      OptionalRetries.json
    );
    // The serializer omits it when the instance leaves it unset.
    const { install } = helmReleaseLifecycle({ install: schema.spec.install }, {});
    expect(isKubernetesRef(install?.remediation?.retries)).toBe(true);
  });

  it('guards a fallback that is itself an optional schema field (Cilium createNamespace)', () => {
    const CiliumNs = type({
      'createNamespace?': 'boolean',
      'install?': { 'createNamespace?': 'boolean' },
    });
    type CiliumNsInstance = typeof CiliumNs.infer;
    const schema = createSchemaProxy<CiliumNsInstance, { ready: boolean }>(CiliumNs.json);
    const base = { name: 'cilium', repositoryName: 'cilium', repositoryNamespace: 'flux-system' };
    const kro = ciliumHelmRelease({
      ...base,
      createNamespace: schema.spec.createNamespace as boolean,
      install: schema.spec.install,
    });
    const createNamespace = kro.spec.install?.createNamespace;
    if (!isCelExpression(createNamespace)) throw new Error('expected a CEL choice');
    // A bare `schema.spec.createNamespace` in the fallback branch fails with
    // "no such key" when the instance sets neither field.
    expect(createNamespace.expression).toContain(
      'has(schema.spec.createNamespace) && dyn(schema.spec.createNamespace) != null ? ' +
        'schema.spec.createNamespace : (omit())'
    );
    for (const instance of [
      {},
      { createNamespace: true },
      { install: { createNamespace: false }, createNamespace: true },
      { install: {} },
    ] satisfies CiliumNsInstance[]) {
      const direct = ciliumHelmRelease({ ...base, ...instance });
      expect(resolveForInstance(createNamespace, instance)).toBe(
        direct.spec.install?.createNamespace
      );
    }
  });

  describe('Cilium per-action timeouts follow the release-wide timeout per instance', () => {
    const CiliumSpec = type({
      'timeout?': 'string',
      'installTimeout?': 'string',
      'upgradeTimeout?': 'string',
    });
    type CiliumInstance = typeof CiliumSpec.infer;
    const base = { name: 'cilium', repositoryName: 'cilium', repositoryNamespace: 'flux-system' };

    it('renders the fallback chain as CEL rather than deciding it at build time', () => {
      const schema = createSchemaProxy<CiliumInstance, { ready: boolean }>(CiliumSpec.json);
      const { spec } = ciliumHelmRelease({ ...base, timeout: schema.spec.timeout as string });
      const timeout = spec.install?.timeout;
      if (!isCelExpression(timeout)) throw new Error('expected a CEL default for the timeout');
      expect(timeout.expression).toBe(
        'has(schema.spec.timeout) && dyn(schema.spec.timeout) != null ? schema.spec.timeout : "10m"'
      );
    });

    it.each<[string, CiliumInstance]>([
      ['nothing set', {}],
      ['release-wide timeout', { timeout: '15m' }],
      ['per-action timeouts', { installTimeout: '30m', upgradeTimeout: '40m' }],
      ['both', { timeout: '15m', upgradeTimeout: '40m' }],
    ])('KRO and direct mode agree: %s', (_, instance) => {
      const schema = createSchemaProxy<CiliumInstance, { ready: boolean }>(CiliumSpec.json);
      const kro = ciliumHelmRelease({
        ...base,
        // The legacy fields are typed as plain strings; in KRO mode they carry
        // the instance's (optional) fields.
        timeout: schema.spec.timeout as string,
        installTimeout: schema.spec.installTimeout as string,
        upgradeTimeout: schema.spec.upgradeTimeout as string,
      });
      const direct = ciliumHelmRelease({ ...base, ...instance });
      expect(resolveForInstance(kro.spec.install, instance)).toEqual(direct.spec.install);
      expect(resolveForInstance(kro.spec.upgrade, instance)).toEqual(direct.spec.upgrade);
    });
  });
});
