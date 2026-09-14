/**
 * `traefikBootstrap` — serialization tests (no cluster).
 *
 * Runs under TYPEKRO_STRICT_CEL=1: the strict gate must accept every status
 * CEL this composition emits (the loud-diagnostic contract), including the
 * hand-written load-balancer address expressions.
 *
 * Covers:
 *  - the build-time vs runtime split (`makeTraefikBootstrap` variants deciding
 *    WHICH resources exist),
 *  - the singleton-owned HelmRepository and the release's sourceRef,
 *  - the pinned chart and the CRD-carrying single release,
 *  - the CRD policy applied to install AND upgrade,
 *  - the status contract, including the OWNED entrypoint Service, and the
 *    absence of any external reference to a Kubernetes API object.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { loadAll } from 'js-yaml';

import {
  DEFAULT_TRAEFIK_CHART_VERSION,
  DEFAULT_TRAEFIK_REPOSITORY_NAME,
  DEFAULT_TRAEFIK_REPOSITORY_URL,
} from '../../../src/factories/traefik/constants.js';
import {
  makeTraefikBootstrap,
  traefikBootstrap,
} from '../../../src/factories/traefik/compositions/traefik-bootstrap.js';
import { TraefikBootstrapStatusSchema } from '../../../src/factories/traefik/types.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
});

afterAll(() => {
  if (ORIGINAL_STRICT_ENV === undefined) delete process.env.TYPEKRO_STRICT_CEL;
  else process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT_ENV;
});

interface YamlDocument {
  kind?: string;
  spec?: {
    schema?: { kind?: string };
    resources?: {
      id?: string;
      externalRef?: { apiVersion?: string; kind?: string; metadata?: Record<string, unknown> };
      template?: {
        kind?: string;
        metadata?: Record<string, unknown>;
        spec?: Record<string, unknown>;
      };
    }[];
  };
}

function documents(yaml: string): YamlDocument[] {
  return loadAll(yaml).filter(
    (document): document is YamlDocument =>
      document !== null && typeof document === 'object' && !Array.isArray(document)
  );
}

function rgd(yaml: string, schemaKind: string): YamlDocument {
  const found = documents(yaml).find(
    (document) =>
      document.kind === 'ResourceGraphDefinition' && document.spec?.schema?.kind === schemaKind
  );
  if (!found) throw new Error(`Missing ResourceGraphDefinition for kind ${schemaKind}`);
  return found;
}

function resource(document: YamlDocument, id: string) {
  const found = document.spec?.resources?.find((entry) => entry.id === id);
  if (!found) throw new Error(`Missing resource ${id}`);
  return found;
}

describe('traefikBootstrap (defaults)', () => {
  it('serializes an RGD wrapping the official chart under strict CEL', () => {
    const yaml = traefikBootstrap.toYaml();

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('kind: HelmRelease');
    expect(yaml).toContain('chart: traefik');
    expect(yaml).toContain(DEFAULT_TRAEFIK_CHART_VERSION);
    expect(yaml).not.toContain('[object Object]');
  });

  it('installs the CRDs with the proxy from one release', () => {
    // Chart 41.5.0 carries the traefik.io CRDs in crds/, so there must be no
    // second `traefik-crds` release to keep in version lockstep.
    const yaml = traefikBootstrap.toYaml();
    expect(yaml).not.toContain('traefik-crds');
    const releases = documents(yaml).flatMap(
      (document) =>
        document.spec?.resources?.filter((entry) => entry.template?.kind === 'HelmRelease') ?? []
    );
    expect(releases).toHaveLength(1);
  });

  it('wires the release to a separately owned HelmRepository singleton', () => {
    const yaml = traefikBootstrap.toYaml();
    const owner = rgd(yaml, 'TraefikHelmRepository');
    const consumer = rgd(yaml, 'TraefikBootstrap');

    const repository = owner.spec?.resources?.find(
      (entry) => entry.template?.kind === 'HelmRepository'
    );
    expect(repository?.template?.spec).toMatchObject({ url: '${schema.spec.url}' });

    const singletonRef = consumer.spec?.resources?.find(
      (entry) => entry.externalRef?.kind === 'TraefikHelmRepository'
    );
    expect(singletonRef?.externalRef?.metadata).toMatchObject({
      name: 'traefik-helm-repository',
      namespace: 'typekro-singletons',
    });

    // The consumer never owns the shared repository itself.
    expect(
      consumer.spec?.resources?.some((entry) => entry.template?.kind === 'HelmRepository')
    ).toBe(false);

    const release = resource(consumer, 'traefikHelmRelease');
    const chart = release.template?.spec?.chart as
      | { spec?: { sourceRef?: Record<string, unknown> } }
      | undefined;
    expect(chart?.spec?.sourceRef).toEqual({
      kind: 'HelmRepository',
      name: DEFAULT_TRAEFIK_REPOSITORY_NAME,
      namespace: 'flux-system',
    });
  });

  it('pins the release name to the same schema reference as `fullnameOverride`', () => {
    const consumer = rgd(traefikBootstrap.toYaml(), 'TraefikBootstrap');
    const release = resource(consumer, 'traefikHelmRelease');
    const spec = release.template?.spec as Record<string, unknown>;
    const values = spec.values as Record<string, unknown>;

    // Unset, Flux's GetReleaseName() would compose `<targetNamespace>-<name>`
    // whenever `targetNamespace` is set — which this composition always sets —
    // and the install namespace would eat into Helm's 53-character
    // release-name budget, which is what bounds `name`.
    expect(spec.targetNamespace).toBeDefined();
    expect(spec.releaseName).toBe('${schema.spec.name}');
    expect(spec.releaseName).toBe(values.fullnameOverride);
  });

  it('points the singleton at the official repository URL', () => {
    const yaml = traefikBootstrap.factory('kro', { namespace: 'traefik' }).toYaml({
      name: 'traefik',
      namespace: 'traefik',
    });
    expect(yaml).toContain(DEFAULT_TRAEFIK_REPOSITORY_URL);
  });

  it('owns the entrypoint Service instead of observing the chart\'s', () => {
    const consumer = rgd(traefikBootstrap.toYaml(), 'TraefikBootstrap');
    const release = resource(consumer, 'traefikHelmRelease');
    const values = release.template?.spec?.values as Record<string, unknown>;

    // The chart's resource-name anchor still decides the pod/ServiceAccount
    // names, so it stays pinned — but the Service itself is disabled.
    expect(values.fullnameOverride).toBe('${schema.spec.name}');
    expect((values.service as { enabled?: boolean }).enabled).toBe(false);
    expect(values.nameOverride).toBe('traefik');
    expect(values.instanceLabelOverride).toBe('${schema.spec.name}');

    const owned = resource(consumer, 'traefikService');
    expect(owned.externalRef).toBeUndefined();
    expect(owned.template?.kind).toBe('Service');
    expect(owned.template?.metadata).toMatchObject({ name: '${schema.spec.name}' });

    const spec = owned.template?.spec as {
      type?: string;
      selector?: Record<string, string>;
      ports?: { name?: string; targetPort?: string }[];
    };
    expect(spec.selector).toEqual({
      'app.kubernetes.io/name': 'traefik',
      'app.kubernetes.io/instance': '${schema.spec.name}',
    });
    // `targetPort` is the container port NAME, so it survives a change of the
    // chart's container ports.
    expect((spec.ports ?? []).map((port) => [port.name, port.targetPort])).toEqual([
      ['web', 'web'],
      ['websecure', 'websecure'],
    ]);
  });

  it('references no Kubernetes API object it does not own', () => {
    // The regression this guards: the direct engine resolves every external
    // reference BEFORE it applies anything, and a failed read is fatal — so an
    // externalRef to a resource the graph itself creates makes a FRESH
    // deployment impossible, and `dependsOn` cannot reorder it.
    const consumer = rgd(traefikBootstrap.toYaml(), 'TraefikBootstrap');
    const externals = (consumer.spec?.resources ?? []).filter((entry) => entry.externalRef);

    // The only reference left is the singleton composition that owns the
    // shared chart HelmRepository. That one is a KRO instance, seeded into the
    // resolution context by the singleton machinery rather than read from the
    // API, so it is not subject to the pre-apply read at all.
    expect(externals.map((entry) => entry.externalRef?.apiVersion)).toEqual(['kro.run/v1alpha1']);
    expect(externals[0]?.externalRef?.kind).toBe('TraefikHelmRepository');
  });

  it('plans every Kubernetes resource as created, not required-existing', () => {
    // Same guarantee as the assertion above, on the direct-mode plan: only the
    // singleton owner may be `require-existing`.
    const plan = traefikBootstrap.plan?.(
      { name: 'traefik', namespace: 'traefik' },
      { strict: true }
    ) as
      | {
          nodes?: {
            id: string;
            lifecycle?: { creation?: string };
            identity?: { apiVersion?: string };
          }[];
        }
      | undefined;
    const requiredExisting = (plan?.nodes ?? []).filter(
      (node) => node.lifecycle?.creation === 'require-existing'
    );

    expect(requiredExisting.map((node) => node.identity?.apiVersion)).toEqual(['kro.run/v1alpha1']);
  });

  it('replaces the chart CRDs on install AND on upgrade', () => {
    // Flux defaults `upgrade.crds` to Skip, so a chart bump would otherwise
    // leave the traefik.io CRDs at the version first installed.
    const consumer = rgd(traefikBootstrap.toYaml(), 'TraefikBootstrap');
    const release = resource(consumer, 'traefikHelmRelease').template?.spec as {
      install?: { crds?: string };
      upgrade?: { crds?: string };
    };

    expect(release.install?.crds).toBe('CreateReplace');
    expect(release.upgrade?.crds).toBe('CreateReplace');
  });

  it('redirects web to websecure by default', () => {
    const consumer = rgd(traefikBootstrap.toYaml(), 'TraefikBootstrap');
    const values = resource(consumer, 'traefikHelmRelease').template?.spec?.values as {
      ports?: { web?: { http?: { redirections?: { entryPoint?: Record<string, unknown> } } } };
    };

    expect(values.ports?.web?.http?.redirections?.entryPoint).toEqual({
      to: 'websecure',
      scheme: 'https',
      permanent: true,
    });
  });

  it('never publishes the internal traefik entrypoint through the Service', () => {
    const consumer = rgd(traefikBootstrap.toYaml(), 'TraefikBootstrap');
    const values = resource(consumer, 'traefikHelmRelease').template?.spec?.values as {
      ports?: Record<string, { expose?: { default?: unknown } }>;
    };

    expect(values.ports?.traefik?.expose?.default).toBe(false);
  });

  it('serializes a status contract derived from the release and the Service', () => {
    const yaml = traefikBootstrap.toYaml();
    const consumer = rgd(yaml, 'TraefikBootstrap');
    const status = (consumer.spec as { schema?: { status?: Record<string, unknown> } }).schema
      ?.status;

    expect(status?.ready).toContain('traefikHelmRelease.status.conditions');
    expect(status?.phase).toContain('"Ready"');
    expect(status?.serviceName).toBe('${traefikService.metadata.name}');

    const loadBalancer = status?.loadBalancer as Record<string, string> | undefined;
    // Every hop is guarded: a ClusterIP Service and an unprovisioned
    // LoadBalancer both resolve to the empty string rather than erroring.
    expect(loadBalancer?.hostname).toContain('has(traefikService.status.loadBalancer)');
    expect(loadBalancer?.hostname).toContain('filter(entry, has(entry.hostname))');
    expect(loadBalancer?.ip).toContain('filter(entry, has(entry.ip))');
    // The guards must be LAZY. `size()` on an absent `ingress` is an
    // evaluation error, and direct mode's cel-js evaluates BOTH operands of
    // `&&` and propagates it — which took the whole status object down to
    // unresolved, `ready` and `phase` included. A ternary is lazy in both
    // engines.
    expect(loadBalancer?.hostname).toContain(
      'has(traefikService.status.loadBalancer.ingress) ? (size('
    );
    // Neither engine-specific dead end may come back: cel-js rejects a `has()`
    // whose operand is an index expression, and KRO rejects `in` on an ingress
    // entry because it types the entry as a message rather than a map.
    expect(loadBalancer?.hostname).not.toContain('has(traefikService.status.loadBalancer.ingress[');
    expect(loadBalancer?.hostname).not.toContain('"hostname" in ');
  });

  it('projects version from the release Flux actually installed', () => {
    const status = (
      rgd(traefikBootstrap.toYaml(), 'TraefikBootstrap').spec as {
        schema?: { status?: Record<string, unknown> };
      }
    ).schema?.status;
    const version = String(status?.version);

    // A RESOURCE projection, not a literal and not an echo of the request: KRO
    // drops literal status fields (#188), and `spec.chartVersion` is what was
    // ASKED for rather than what is running.
    expect(version).toContain('traefikHelmRelease.status.history');
    expect(version).toContain('filter(entry, has(entry.chartVersion))');
    expect(version).not.toContain('schema.spec.chartVersion');
    expect(version).not.toContain(DEFAULT_TRAEFIK_CHART_VERSION);
    // Same laziness contract as the load-balancer projection, for the same
    // cel-js/cel-go reasons.
    expect(version).toContain('has(traefikHelmRelease.status.history) ? (size(');
    expect(version).not.toContain('has(traefikHelmRelease.status.history[');
  });

  it('accepts the declared status contract shape', () => {
    const result = TraefikBootstrapStatusSchema({
      ready: true,
      failed: false,
      phase: 'Ready',
      loadBalancer: { hostname: 'edge.example.test', ip: '' },
      serviceName: 'traefik',
      version: '41.5.0',
    });

    expect(result).toHaveProperty('phase');
    if ('phase' in result) {
      expect(result.phase).toBe('Ready');
      expect(result.serviceName).toBe('traefik');
      expect(result.version).toBe('41.5.0');
    }
  });

  it('declares no status field KRO would drop', () => {
    // KRO leaves LITERAL status fields unset, so a declared field that is not a
    // projection of a graph resource would be required by the schema and never
    // carried by the instance. Every field here must therefore reference a
    // resource id.
    const consumer = rgd(traefikBootstrap.toYaml(), 'TraefikBootstrap');
    const status = (consumer.spec as { schema?: { status?: Record<string, unknown> } }).schema
      ?.status as Record<string, unknown>;
    const leaves = (value: unknown): string[] =>
      typeof value === 'string'
        ? [value]
        : value !== null && typeof value === 'object'
          ? Object.values(value).flatMap(leaves)
          : [String(value)];

    expect(leaves(status).length).toBeGreaterThan(0);
    for (const leaf of leaves(status)) {
      expect(leaf).toMatch(/traefikHelmRelease|traefikService/);
    }
  });

  it('reports the owned resources in a direct plan', () => {
    const plan = traefikBootstrap.plan?.(
      { name: 'traefik', namespace: 'traefik' },
      { strict: true }
    );
    const serialized = JSON.stringify(plan);

    expect(serialized).not.toContain('[object Object]');
    // The owned namespace exists as a graph resource in direct mode.
    expect(serialized).toContain('"Namespace"');
    expect(serialized).toContain('"HelmRelease"');
    expect(serialized).toContain('"Service"');
    expect(serialized).toContain('websecure');
  });

  it('creates no default TLS resources unless asked', () => {
    const yaml = traefikBootstrap.toYaml();
    expect(yaml).not.toContain('kind: TLSOption');
    expect(yaml).not.toContain('kind: TLSStore');
  });
});

describe('makeTraefikBootstrap build-time variants', () => {
  it('owns a default TLSOption and TLSStore when configured', () => {
    const bootstrap = makeTraefikBootstrap({
      name: 'traefik-tls-bootstrap',
      kind: 'TraefikTlsBootstrap',
      defaultTlsOption: { minVersion: 'VersionTLS13' },
      defaultTlsStore: { defaultCertificateSecretName: 'edge-wildcard-tls' },
    });
    const yaml = bootstrap.toYaml();
    const consumer = rgd(yaml, 'TraefikTlsBootstrap');

    const option = resource(consumer, 'traefikDefaultTlsOption');
    expect(option.template?.kind).toBe('TLSOption');
    expect(option.template?.spec).toMatchObject({ minVersion: 'VersionTLS13', sniStrict: true });

    const store = resource(consumer, 'traefikDefaultTlsStore');
    expect(store.template?.kind).toBe('TLSStore');
    expect(store.template?.spec).toMatchObject({
      defaultCertificate: { secretName: 'edge-wildcard-tls' },
    });
  });

  it('omits the owned namespace and lets Flux create it when external', () => {
    const bootstrap = makeTraefikBootstrap({
      name: 'traefik-external-ns',
      kind: 'TraefikExternalNs',
      namespaceOwnership: 'external',
    });
    const plan = bootstrap.plan?.({ name: 'traefik', namespace: 'edge' }, { strict: true });
    const serialized = JSON.stringify(plan);

    expect(serialized).not.toContain('"Namespace"');

    const consumer = rgd(bootstrap.toYaml(), 'TraefikExternalNs');
    const install = resource(consumer, 'traefikHelmRelease').template?.spec?.install as
      | { createNamespace?: boolean }
      | undefined;
    expect(install?.createNamespace).toBe(true);
  });

  it('can disable the web to websecure redirect', () => {
    const bootstrap = makeTraefikBootstrap({
      name: 'traefik-no-redirect',
      kind: 'TraefikNoRedirect',
      redirectWebToWebsecure: false,
    });
    const consumer = rgd(bootstrap.toYaml(), 'TraefikNoRedirect');
    const values = resource(consumer, 'traefikHelmRelease').template?.spec?.values as {
      ports?: { web?: { http?: unknown } };
    };

    expect(values.ports?.web?.http).toBeUndefined();
  });

  it('merges a build-time values passthrough beneath the mapped values', () => {
    const bootstrap = makeTraefikBootstrap({
      name: 'traefik-extra-values',
      kind: 'TraefikExtraValues',
      values: {
        additionalArguments: ['--serversTransport.insecureSkipVerify=false'],
        podDisruptionBudget: { enabled: true, minAvailable: 1 },
      },
    });
    const consumer = rgd(bootstrap.toYaml(), 'TraefikExtraValues');
    const values = resource(consumer, 'traefikHelmRelease').template?.spec?.values as Record<
      string,
      unknown
    >;

    expect(values.additionalArguments).toEqual(['--serversTransport.insecureSkipVerify=false']);
    expect(values.podDisruptionBudget).toEqual({ enabled: true, minAvailable: 1 });
    // The mapped values still win where they overlap.
    // The ownership pins still win where they overlap.
    expect((values.service as { enabled?: boolean }).enabled).toBe(false);
  });

  it('survives a whole-map values merge with the graph-aware siblings intact', () => {
    // The guide's whole-map graph-aware values regression. A raw passthrough
    // section that OVERLAPS a mapped one must not replace the mapped section's
    // graph-aware siblings. `metrics` and `tracing` are the sharp cases: the
    // mapper fills their `otlp` subtree from schema references, while
    // `metrics.prometheus` and `tracing.capturedRequestHeaders` are chart
    // surface this factory does not model.
    const bootstrap = makeTraefikBootstrap({
      name: 'traefik-whole-map',
      kind: 'TraefikWholeMap',
      values: {
        metrics: { prometheus: { entryPoint: 'metrics', addRoutersLabels: true } },
        tracing: { capturedRequestHeaders: ['X-Edge-Principal'] },
        env: [{ name: 'TZ', value: 'UTC' }],
      },
    });
    const consumer = rgd(bootstrap.toYaml(), 'TraefikWholeMap');
    const values = resource(consumer, 'traefikHelmRelease').template?.spec?.values as Record<
      string,
      Record<string, unknown> | unknown[]
    >;
    const section = (key: string) => values[key] as Record<string, unknown> | undefined;

    // The raw keys survived the merge...
    expect(section('metrics')?.prometheus).toEqual({
      entryPoint: 'metrics',
      addRoutersLabels: true,
    });
    expect(section('tracing')?.capturedRequestHeaders).toEqual(['X-Edge-Principal']);
    expect(values.env).toEqual([{ name: 'TZ', value: 'UTC' }]);
    // ...and so did the graph-aware siblings the mapper wrote beside them.
    expect(JSON.stringify(section('metrics')?.otlp)).toContain('schema.spec.otlp.endpoint');
    expect(String(section('tracing')?.serviceName)).toContain('schema.spec.otlp.serviceName');

    // No serialization casualties anywhere in the merged tree.
    const serialized = JSON.stringify(values);
    expect(serialized).not.toContain('[object Object]');
    expect(serialized).not.toContain('__KUBERNETES_REF_');
    expect(serialized).not.toContain('__CEL_EXPRESSION__');
    expect(serialized).not.toContain('undefined');
  });

  it('cannot be talked out of the security pins by raw values', () => {
    // Raw values merge BENEATH the pins, which is the whole reason they are
    // build-time (see TraefikBootstrapBuildOptions.values): a shallow runtime
    // merge could not both keep the pins and preserve a caller's siblings.
    const bootstrap = makeTraefikBootstrap({
      name: 'traefik-pin-attempt',
      kind: 'TraefikPinAttempt',
      values: {
        api: { dashboard: true, insecure: true, basePath: '/dashboard' },
        service: { enabled: true, annotations: { 'example.com/note': 'kept' } },
        podSecurityContext: { runAsNonRoot: false, fsGroup: 65532 },
      },
    });
    const consumer = rgd(bootstrap.toYaml(), 'TraefikPinAttempt');
    const values = resource(consumer, 'traefikHelmRelease').template?.spec?.values as Record<
      string,
      Record<string, unknown>
    >;

    expect(values.api?.dashboard).toBe(false);
    expect(values.api?.insecure).toBe(false);
    expect(values.service?.enabled).toBe(false);
    expect(values.podSecurityContext?.runAsNonRoot).toBe(true);
    // The pins are surgical: unpinned siblings in the same sections survive.
    expect(values.api?.basePath).toBe('/dashboard');
    expect(values.service?.annotations).toEqual({ 'example.com/note': 'kept' });
    expect(values.podSecurityContext?.fsGroup).toBe(65532);
  });

  it('can hand the CRD lifecycle to something else', () => {
    const bootstrap = makeTraefikBootstrap({
      name: 'traefik-skip-crds',
      kind: 'TraefikSkipCrds',
      crds: 'Skip',
    });
    const consumer = rgd(bootstrap.toYaml(), 'TraefikSkipCrds');
    const release = resource(consumer, 'traefikHelmRelease').template?.spec as {
      install?: { crds?: string };
      upgrade?: { crds?: string };
    };

    expect(release.install?.crds).toBe('Skip');
    expect(release.upgrade?.crds).toBe('Skip');
  });
});
