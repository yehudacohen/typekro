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
 *  - the status contract, including the observed entrypoint Service.
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

  it('points the singleton at the official repository URL', () => {
    const yaml = traefikBootstrap.factory('kro', { namespace: 'traefik' }).toYaml({
      name: 'traefik',
      namespace: 'traefik',
    });
    expect(yaml).toContain(DEFAULT_TRAEFIK_REPOSITORY_URL);
  });

  it('pins fullnameOverride so the observed Service name is predictable', () => {
    const consumer = rgd(traefikBootstrap.toYaml(), 'TraefikBootstrap');
    const release = resource(consumer, 'traefikHelmRelease');
    const values = release.template?.spec?.values as Record<string, unknown>;

    expect(values.fullnameOverride).toBe('${schema.spec.name}');

    const observed = consumer.spec?.resources?.find((entry) => entry.id === 'traefikService');
    expect(observed?.externalRef?.kind).toBe('Service');
    expect(observed?.externalRef?.metadata).toMatchObject({ name: '${schema.spec.name}' });
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
    expect(loadBalancer?.hostname).toContain(
      'size(traefikService.status.loadBalancer.ingress) > 0'
    );
    expect(loadBalancer?.hostname).toContain('ingress[0].hostname');
    expect(loadBalancer?.ip).toContain('ingress[0].ip');
  });

  it('accepts the declared status contract shape', () => {
    const result = TraefikBootstrapStatusSchema({
      ready: true,
      failed: false,
      phase: 'Ready',
      loadBalancer: { hostname: 'a1b2.elb.us-east-1.amazonaws.com', ip: '' },
      entrypoints: ['web', 'websecure'],
      serviceName: 'traefik',
    });

    expect(result).toHaveProperty('phase');
    if ('phase' in result) {
      expect(result.phase).toBe('Ready');
      expect(result.entrypoints).toEqual(['web', 'websecure']);
    }
  });

  it('reports the entrypoints and load-balancer contract in a direct plan', () => {
    const plan = traefikBootstrap.plan?.(
      { name: 'traefik', namespace: 'traefik' },
      { strict: true }
    );
    const serialized = JSON.stringify(plan);

    expect(serialized).not.toContain('[object Object]');
    // The owned namespace exists as a graph resource in direct mode.
    expect(serialized).toContain('"Namespace"');
    expect(serialized).toContain('"HelmRelease"');
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
    expect((values.service as { enabled?: boolean }).enabled).toBe(true);
  });
});
