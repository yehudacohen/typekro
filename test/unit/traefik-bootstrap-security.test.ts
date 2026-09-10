/**
 * Traefik security defaults (#172).
 *
 * The single most consequential misconfiguration for a Traefik edge is an
 * exposed dashboard or an unauthenticated insecure API: the chart ships
 * `api.dashboard: true`, and `api.insecure` serves the routing API over plain
 * HTTP. This suite proves neither can be reached through the factory, from any
 * direction:
 *
 *  - not through the runtime spec (the field is typed as the literal `false`),
 *  - not through the build-time values passthrough (the pins are applied last),
 *  - not through the mapper called directly,
 *  - and not through the serialized KRO / direct output.
 *
 * It also pins the non-root, read-only-root-filesystem profile and the
 * `forwardAuth` / `TLSOption` defaults.
 */
import { describe, expect, it } from 'bun:test';
import { loadAll } from 'js-yaml';

import {
  makeTraefikBootstrap,
  traefikBootstrap,
} from '../../src/factories/traefik/compositions/traefik-bootstrap.js';
import { traefikForwardAuthMiddleware } from '../../src/factories/traefik/resources/middleware.js';
import { traefikTLSOption } from '../../src/factories/traefik/resources/tls.js';
import { TraefikBootstrapConfigSchema } from '../../src/factories/traefik/types.js';
import {
  applyTraefikSecurityPins,
  mapTraefikConfigToHelmValues,
  TRAEFIK_CONTAINER_SECURITY_CONTEXT,
  TRAEFIK_POD_SECURITY_CONTEXT,
  traefikEntrypointServiceType,
  validateTraefikHelmValues,
} from '../../src/factories/traefik/utils/helm-values-mapper.js';

/**
 * Read the HelmRelease values out of either serialization shape: a KRO
 * ResourceGraphDefinition wrapping resource templates, or the plain manifests
 * direct mode emits.
 */
function releaseValues(yaml: string): Record<string, unknown> {
  const documents = loadAll(yaml).filter(
    (document): document is Record<string, unknown> =>
      document !== null && typeof document === 'object' && !Array.isArray(document)
  );
  for (const document of documents) {
    if (document.kind === 'HelmRelease') {
      const values = (document.spec as { values?: Record<string, unknown> } | undefined)?.values;
      if (values) return values;
    }
    const spec = document.spec as
      | {
          resources?: {
            template?: { kind?: string; spec?: { values?: Record<string, unknown> } };
          }[];
        }
      | undefined;
    const release = spec?.resources?.find((entry) => entry.template?.kind === 'HelmRelease');
    if (release?.template?.spec?.values) return release.template.spec.values;
  }
  throw new Error('No HelmRelease values found in the serialized output');
}

describe('Traefik dashboard and insecure API cannot be enabled', () => {
  it('rejects `dashboard: true` in the runtime spec schema', () => {
    const rejected = TraefikBootstrapConfigSchema({ name: 'traefik', dashboard: true });
    // ArkType reports a problem rather than returning the parsed value.
    expect('dashboard' in rejected).toBe(false);

    const accepted = TraefikBootstrapConfigSchema({ name: 'traefik', dashboard: false });
    expect(accepted).toHaveProperty('name');
  });

  it('pins the dashboard, the insecure API and the debug API off in the mapper', () => {
    const values = mapTraefikConfigToHelmValues({ name: 'traefik' });

    expect(values.api?.dashboard).toBe(false);
    expect(values.api?.insecure).toBe(false);
    expect(values.api?.debug).toBe(false);
    expect(values.ingressRoute?.dashboard?.enabled).toBe(false);
    expect(values.ingressRoute?.healthcheck?.enabled).toBe(false);
  });

  it('beats a build-time values passthrough that tries to re-enable them', () => {
    const values = mapTraefikConfigToHelmValues(
      { name: 'traefik' },
      {
        baseValues: {
          api: { dashboard: true, insecure: true, debug: true, basePath: '/traefik' },
          ingressRoute: { dashboard: { enabled: true }, healthcheck: { enabled: true } },
        },
      }
    );

    expect(values.api?.dashboard).toBe(false);
    expect(values.api?.insecure).toBe(false);
    expect(values.api?.debug).toBe(false);
    expect(values.ingressRoute?.dashboard?.enabled).toBe(false);
    expect(values.ingressRoute?.healthcheck?.enabled).toBe(false);
    // Unrelated keys in the same section survive the pin.
    expect(values.api?.basePath).toBe('/traefik');
  });

  it('pins them off even when applied to already-subverted values', () => {
    const subverted = applyTraefikSecurityPins({
      api: { dashboard: true, insecure: true },
      podSecurityContext: { runAsNonRoot: false, runAsUser: 0 },
      securityContext: { allowPrivilegeEscalation: true, readOnlyRootFilesystem: false },
    });

    expect(subverted.api?.dashboard).toBe(false);
    expect(subverted.api?.insecure).toBe(false);
    expect(subverted.podSecurityContext?.runAsNonRoot).toBe(true);
    expect(subverted.podSecurityContext?.runAsUser).toBe(65532);
    expect(subverted.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(subverted.securityContext?.readOnlyRootFilesystem).toBe(true);
  });

  it('never serializes an enabled dashboard from the default composition', () => {
    const values = releaseValues(traefikBootstrap.toYaml());
    const api = values.api as Record<string, unknown>;
    const ingressRoute = values.ingressRoute as {
      dashboard?: { enabled?: unknown };
      healthcheck?: { enabled?: unknown };
    };

    expect(api.dashboard).toBe(false);
    expect(api.insecure).toBe(false);
    expect(api.debug).toBe(false);
    expect(ingressRoute.dashboard?.enabled).toBe(false);
    expect(ingressRoute.healthcheck?.enabled).toBe(false);

    // No schema reference can reach these keys, so no CEL placeholder for them
    // may appear anywhere in the emitted graph. (`insecure` is not scanned by
    // regex: the OTLP exporter has an unrelated key of the same name.)
    const yaml = traefikBootstrap.toYaml();
    expect(yaml).not.toContain('schema.spec.dashboard');
    expect(yaml).not.toMatch(/dashboard: true/);
  });

  it('never serializes an enabled dashboard from a subverted build-time variant', () => {
    const subverted = makeTraefikBootstrap({
      name: 'traefik-subverted',
      kind: 'TraefikSubverted',
      values: {
        api: { dashboard: true, insecure: true },
        ingressRoute: { dashboard: { enabled: true } },
        podSecurityContext: { runAsNonRoot: false, runAsUser: 0 },
      },
    });
    const yaml = subverted.toYaml();
    const values = releaseValues(yaml);
    const api = values.api as Record<string, unknown>;

    expect(api.dashboard).toBe(false);
    expect(api.insecure).toBe(false);
    expect(values.podSecurityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 65532 });
    expect(yaml).not.toMatch(/dashboard: true/);
    expect(yaml).not.toMatch(/runAsNonRoot: false/);
    expect(yaml).not.toMatch(/runAsUser: 0/);
  });

  it('never serializes an enabled dashboard in direct mode', () => {
    const yaml = traefikBootstrap.factory('direct', { namespace: 'flux-system' }).toYaml({
      name: 'traefik',
      namespace: 'traefik',
      dashboard: false,
    });
    const values = releaseValues(yaml);
    const api = values.api as Record<string, unknown>;

    expect(api.dashboard).toBe(false);
    expect(api.insecure).toBe(false);
    expect(api.debug).toBe(false);
    expect(yaml).not.toMatch(/dashboard: true/);
  });
});

describe('Traefik runs non-root with a read-only root filesystem', () => {
  it('pins the pod and container security contexts', () => {
    const values = mapTraefikConfigToHelmValues({ name: 'traefik' });

    expect(values.podSecurityContext).toMatchObject(TRAEFIK_POD_SECURITY_CONTEXT);
    expect(values.securityContext).toMatchObject(TRAEFIK_CONTAINER_SECURITY_CONTEXT);
    expect(TRAEFIK_POD_SECURITY_CONTEXT.runAsNonRoot).toBe(true);
    expect(TRAEFIK_CONTAINER_SECURITY_CONTEXT.readOnlyRootFilesystem).toBe(true);
    expect(TRAEFIK_CONTAINER_SECURITY_CONTEXT.capabilities?.drop).toEqual(['ALL']);
  });

  it('keeps the internal entrypoint off the Service and off the cluster default class', () => {
    const values = mapTraefikConfigToHelmValues({ name: 'traefik' });

    expect(values.ports?.traefik?.expose?.default).toBe(false);
    expect(values.ingressClass?.isDefaultClass).toBe(false);
  });

  it('never publishes the internal entrypoint on the Service it owns', () => {
    // Stronger than the chart value above: the port simply does not exist on
    // the owned Service, so no chart value can reintroduce it.
    const yaml = traefikBootstrap
      .factory('direct', { namespace: 'flux-system' })
      .toYaml({ name: 'traefik', namespace: 'traefik' });
    const owned = loadAll(yaml).find(
      (document): document is { kind?: string; spec?: { ports?: { name?: string }[] } } =>
        document !== null &&
        typeof document === 'object' &&
        (document as { kind?: string }).kind === 'Service'
    );

    expect((owned?.spec?.ports ?? []).map((port) => port.name)).toEqual(['web', 'websecure']);
  });

  it('disables the chart phone-home defaults', () => {
    const values = mapTraefikConfigToHelmValues({ name: 'traefik' });

    expect(values.global?.checkNewVersion).toBe(false);
    expect(values.global?.sendAnonymousUsage).toBe(false);
  });
});

describe('validateTraefikHelmValues', () => {
  it('reports nothing for the factory defaults', () => {
    expect(validateTraefikHelmValues(mapTraefikConfigToHelmValues({ name: 'traefik' }))).toEqual(
      []
    );
  });

  it('warns loudly when the pins have been bypassed', () => {
    const warnings = validateTraefikHelmValues({
      api: { dashboard: true, insecure: true },
      podSecurityContext: { runAsNonRoot: false },
      providers: { kubernetesCRD: { enabled: false } },
      ingressClass: { isDefaultClass: true },
      ports: { traefik: { expose: { default: true } } },
    });

    expect(warnings.some((warning) => warning.includes('dashboard is enabled'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('insecure API is enabled'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('runAsNonRoot is not true'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('CRD provider is disabled'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('cluster-default IngressClass'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('internal `traefik` entrypoint'))).toBe(
      true
    );
  });

  it('warns about a single replica behind a LoadBalancer', () => {
    const config = {
      name: 'traefik',
      replicas: 1,
      service: { type: 'LoadBalancer' as const },
    };
    // The Service type is no longer a chart value — this factory owns the
    // Service — so it is supplied as validation context.
    const warnings = validateTraefikHelmValues(mapTraefikConfigToHelmValues(config), {
      serviceType: traefikEntrypointServiceType(config),
    });

    expect(warnings.some((warning) => warning.includes('single Traefik replica'))).toBe(true);
  });

  it('warns when the chart has been handed the entrypoint Service back', () => {
    const warnings = validateTraefikHelmValues({ service: { enabled: true } });

    expect(
      warnings.some((warning) => warning.includes('creating its own entrypoint Service'))
    ).toBe(true);
  });
});

describe('forwardAuth and TLSOption secure defaults', () => {
  it('does not trust client-supplied forwarded headers by default', () => {
    const middleware = traefikForwardAuthMiddleware({
      name: 'authz',
      namespace: 'edge',
      address: 'http://authz.edge.svc.cluster.local:8080',
      authResponseHeaders: ['X-Edge-Principal'],
      id: 'authz',
    });

    expect(middleware.spec.forwardAuth?.trustForwardHeader).toBe(false);
  });

  it('defaults TLS to 1.2 with strict SNI', () => {
    const option = traefikTLSOption({
      name: 'default',
      namespace: 'traefik',
      spec: {},
      id: 'defaultTlsOption',
    });

    expect(option.spec.minVersion).toBe('VersionTLS12');
    expect(option.spec.sniStrict).toBe(true);
  });
});
