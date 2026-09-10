/**
 * Traefik ArkType schema tests (no cluster).
 *
 * The guide makes ArkType the single source of truth for configuration, so
 * these tests exercise the schemas directly rather than only the factories:
 *
 *  - the exactly-one-middleware invariant, which is a schema-level `.narrow()`
 *    and not just a factory guard;
 *  - the field-by-field CRD verification, as regressions for the drift the
 *    conversion found. Each expectation names the CRD fact it protects, read
 *    back from a live API server with
 *    `kubectl get crd <name> -o jsonpath='{.spec.versions[0].schema.openAPIV3Schema.properties.spec}'`
 *    against chart 41.5.0's CRDs;
 *  - `Composable<T>` on every factory signature, proven by building each
 *    resource inside a composition from optional (proxy-sourced) spec fields.
 */
import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import {
  traefikChainMiddleware,
  traefikForwardAuthMiddleware,
  traefikHeadersMiddleware,
  traefikInFlightReqMiddleware,
  traefikMiddleware,
  traefikRateLimitMiddleware,
} from '../../../src/factories/traefik/resources/middleware.js';
import {
  traefikIngressRoute,
  traefikIngressRouteTCP,
  traefikServersTransport,
  traefikService as traefikServiceResource,
} from '../../../src/factories/traefik/resources/routing.js';
import { traefikTLSOption, traefikTLSStore } from '../../../src/factories/traefik/resources/tls.js';
import {
  TraefikErrorsMiddlewareSchema,
  TraefikForwardAuthMiddlewareSchema,
  TraefikHealthCheckSchema,
  TraefikIngressRouteSpecSchema,
  TraefikMiddlewareSpecSchema,
  TraefikPluginMiddlewareSchema,
  TraefikServiceSpecSchema,
  TraefikTLSOptionSpecSchema,
} from '../../../src/factories/traefik/types.js';

function rejects(result: unknown): boolean {
  return result instanceof type.errors;
}

describe('Middleware spec schema', () => {
  it('accepts exactly one middleware key', () => {
    const result = TraefikMiddlewareSpecSchema({
      forwardAuth: { address: 'http://authorizer.edge.svc.cluster.local:8080/auth' },
    });

    expect(rejects(result)).toBe(false);
  });

  it('rejects two middleware keys through the schema, not only the factory', () => {
    // Traefik would apply one of these and silently drop the other, so this is
    // a real misconfiguration and the invariant belongs in the schema.
    const result = TraefikMiddlewareSpecSchema({
      forwardAuth: { address: 'http://authorizer:8080' },
      rateLimit: { average: 1 },
    });

    expect(rejects(result)).toBe(true);
    expect(String(result)).toContain('exactly one behavior');
  });

  it('rejects an empty middleware spec', () => {
    expect(rejects(TraefikMiddlewareSpecSchema({}))).toBe(true);
  });

  it('rejects an unknown middleware key', () => {
    expect(rejects(TraefikMiddlewareSpecSchema({ notAMiddleware: {} }))).toBe(true);
  });

  it('keeps plugin config as an opaque map', () => {
    // The CRD marks `plugin` x-kubernetes-preserve-unknown-fields, so `unknown`
    // is the correct boundary here rather than a modelled shape.
    const result = TraefikPluginMiddlewareSchema({
      'my-plugin': { headers: { 'X-Trace': 'on' }, depth: 3 },
    });

    expect(rejects(result)).toBe(false);
  });
});

describe('CRD field verification regressions', () => {
  it('spells the health-check Host override hostname, with no host field', () => {
    // CRD: services[].healthCheck has `hostname`; there is no `host`. The
    // schemas stay permissive about undeclared keys — a chart or CRD may be
    // newer than this factory — so the check asks what the schema DECLARES,
    // which is what a mis-typed field name would show up in.
    const declared = TraefikHealthCheckSchema.onUndeclaredKey('reject');

    expect(rejects(declared({ hostname: 'api.internal', path: '/healthz' }))).toBe(false);
    expect(rejects(declared({ host: 'api.internal' }))).toBe(true);
  });

  it('requires errors alongside service and fallback on a failover TraefikService', () => {
    // CRD: spec.failover.required == [errors, fallback, service]. A failover
    // without `errors` is rejected by the API server.
    const complete = TraefikServiceSpecSchema({
      failover: {
        service: { name: 'orders-api', port: 8080 },
        fallback: { name: 'orders-api-standby', port: 8080 },
        errors: { status: ['500-599'] },
      },
    });
    const missingErrors = TraefikServiceSpecSchema({
      failover: {
        service: { name: 'orders-api', port: 8080 },
        fallback: { name: 'orders-api-standby', port: 8080 },
      },
    });

    expect(rejects(complete)).toBe(false);
    expect(rejects(missingErrors)).toBe(true);
  });

  it('models errorRequestHeaders on the errors middleware', () => {
    const result = TraefikErrorsMiddlewareSchema({
      status: ['500-599'],
      query: '/{status}.html',
      service: { name: 'error-pages', port: 8080 },
      errorRequestHeaders: ['X-Edge-Principal'],
    });

    expect(rejects(result)).toBe(false);
  });

  it('accepts a named port as well as a numeric one on a service ref', () => {
    // CRD: services[].port is x-kubernetes-int-or-string.
    expect(
      rejects(
        TraefikIngressRouteSpecSchema({
          routes: [{ match: 'PathPrefix(`/v1`)', services: [{ name: 'orders-api', port: 'http' }] }],
        })
      )
    ).toBe(false);
    expect(
      rejects(
        TraefikIngressRouteSpecSchema({
          routes: [{ match: 'PathPrefix(`/v1`)', services: [{ name: 'orders-api', port: 8080 }] }],
        })
      )
    ).toBe(false);
  });

  it('accepts the CRD traceVerbosity enum and rejects anything else', () => {
    const ok = TraefikIngressRouteSpecSchema({
      routes: [{ match: 'PathPrefix(`/v1`)', observability: { traceVerbosity: 'detailed' } }],
    });
    const bad = TraefikIngressRouteSpecSchema({
      routes: [{ match: 'PathPrefix(`/v1`)', observability: { traceVerbosity: 'verbose' } }],
    });

    expect(rejects(ok)).toBe(false);
    expect(rejects(bad)).toBe(true);
  });

  it('narrows the TLS versions the proxy actually accepts', () => {
    // The CRD types minVersion as a bare string; Traefik accepts only these.
    expect(rejects(TraefikTLSOptionSpecSchema({ minVersion: 'VersionTLS13' }))).toBe(false);
    expect(rejects(TraefikTLSOptionSpecSchema({ minVersion: 'TLSv1.3' }))).toBe(true);
  });

  it('requires a forwardAuth address', () => {
    // Optional in the CRD, required here: a forwardAuth without an authorizer
    // fails every request it is attached to.
    expect(rejects(TraefikForwardAuthMiddlewareSchema({ trustForwardHeader: false }))).toBe(true);
  });
});

describe('Composable factory signatures', () => {
  it('builds every Traefik resource from optional composition spec fields', () => {
    // Optional spec fields are `T | undefined` inside a composition. This
    // compiles only because each factory takes `Composable<...>`; running it
    // also proves the resources are registered.
    const edge = kubernetesComposition(
      {
        name: 'traefik-composable-probe',
        kind: 'TraefikComposableProbe',
        spec: type({
          name: 'string',
          namespace: 'string',
          'authorizerUrl?': 'string',
          'upstream?': 'string',
          'certSecret?': 'string',
        }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        traefikForwardAuthMiddleware({
          name: `${spec.name}-authz`,
          namespace: spec.namespace,
          address: spec.authorizerUrl ?? 'http://authorizer:8080',
          authResponseHeaders: ['X-Edge-Principal'],
          id: 'authz',
        });
        traefikRateLimitMiddleware({
          name: `${spec.name}-rate-limit`,
          namespace: spec.namespace,
          average: 10,
          burst: 20,
          requestHeaderName: 'X-Edge-Principal',
          id: 'rateLimit',
        });
        traefikInFlightReqMiddleware({
          name: `${spec.name}-concurrency`,
          namespace: spec.namespace,
          amount: 25,
          id: 'concurrency',
        });
        traefikHeadersMiddleware({
          name: `${spec.name}-headers`,
          namespace: spec.namespace,
          headers: { frameDeny: true, contentTypeNosniff: true },
          id: 'headers',
        });
        traefikChainMiddleware({
          name: `${spec.name}-chain`,
          namespace: spec.namespace,
          middlewares: [{ name: `${spec.name}-authz` }, { name: `${spec.name}-rate-limit` }],
          id: 'chain',
        });
        traefikMiddleware({
          name: `${spec.name}-strip`,
          namespace: spec.namespace,
          spec: { stripPrefix: { prefixes: ['/v1'] } },
          id: 'strip',
        });
        traefikIngressRoute({
          name: spec.name,
          namespace: spec.namespace,
          spec: {
            entryPoints: ['websecure'],
            routes: [
              {
                match: 'PathPrefix(`/v1`)',
                services: [{ name: spec.upstream ?? 'orders-api', port: 8080 }],
              },
            ],
            tls: { secretName: spec.certSecret ?? 'orders-api-tls' },
          },
          id: 'route',
        });
        traefikIngressRouteTCP({
          name: `${spec.name}-tcp`,
          namespace: spec.namespace,
          spec: {
            entryPoints: ['websecure'],
            routes: [
              { match: 'HostSNI(`*`)', services: [{ name: spec.upstream ?? 'orders-api', port: 5432 }] },
            ],
          },
          id: 'tcpRoute',
        });
        traefikServiceResource({
          name: `${spec.name}-canary`,
          namespace: spec.namespace,
          spec: {
            weighted: {
              services: [
                { name: spec.upstream ?? 'orders-api', port: 8080, weight: 9 },
                { name: `${spec.name}-next`, port: 8080, weight: 1 },
              ],
            },
          },
          id: 'canary',
        });
        traefikServersTransport({
          name: `${spec.name}-transport`,
          namespace: spec.namespace,
          spec: { forwardingTimeouts: { responseHeaderTimeout: '120s' } },
          id: 'transport',
        });
        traefikTLSOption({
          name: `${spec.name}-tls`,
          namespace: spec.namespace,
          spec: { minVersion: 'VersionTLS13' },
          id: 'tlsOption',
        });
        traefikTLSStore({
          name: `${spec.name}-store`,
          namespace: spec.namespace,
          spec: { defaultCertificate: { secretName: spec.certSecret ?? 'edge-wildcard-tls' } },
          id: 'tlsStore',
        });

        return { ready: true };
      }
    );

    const yaml = edge.toYaml();

    for (const kind of [
      'Middleware',
      'IngressRoute',
      'IngressRouteTCP',
      'TraefikService',
      'ServersTransport',
      'TLSOption',
      'TLSStore',
    ]) {
      expect(yaml).toContain(`kind: ${kind}`);
    }
    expect(yaml).not.toContain('[object Object]');
    expect(yaml).not.toContain('__KUBERNETES_REF_');
  });
});
