/**
 * Traefik routing resources (#173): `IngressRoute`, `IngressRouteTCP`,
 * `TraefikService` and `ServersTransport`.
 */
import { describe, expect, it } from 'bun:test';

import {
  traefikIngressRoute,
  traefikIngressRouteTCP,
  traefikServersTransport,
  traefikService,
} from '../../../src/factories/traefik/resources/routing.js';

const NAMESPACE = 'edge';

describe('traefikIngressRoute', () => {
  it('creates the HTTP router with entrypoints, middleware chain and TLS', () => {
    const route = traefikIngressRoute({
      name: 'orders-api',
      namespace: NAMESPACE,
      spec: {
        entryPoints: ['websecure'],
        routes: [
          {
            match: 'Host(`api.example.com`) && PathPrefix(`/v1`)',
            kind: 'Rule',
            priority: 100,
            middlewares: [{ name: 'orders-api-edge' }],
            services: [{ name: 'orders-api', port: 8080, passHostHeader: true }],
          },
        ],
        tls: {
          secretName: 'orders-api-tls',
          options: { name: 'default', namespace: 'traefik' },
        },
      },
      id: 'costApiRoute',
    });

    expect(route.apiVersion).toBe('traefik.io/v1alpha1');
    expect(route.kind).toBe('IngressRoute');
    expect(route.metadata.name).toBe('orders-api');
    expect(route.metadata.namespace).toBe(NAMESPACE);
    expect(route.spec.entryPoints).toEqual(['websecure']);
    expect(route.spec.routes[0]?.match).toBe('Host(`api.example.com`) && PathPrefix(`/v1`)');
    expect(route.spec.routes[0]?.priority).toBe(100);
    expect(route.spec.routes[0]?.middlewares).toEqual([{ name: 'orders-api-edge' }]);
    expect(route.spec.routes[0]?.services?.[0]).toMatchObject({ name: 'orders-api', port: 8080 });
    expect(route.spec.tls?.secretName).toBe('orders-api-tls');
    expect(route.spec.tls?.options).toEqual({ name: 'default', namespace: 'traefik' });
  });

  it('supports a cross-namespace service and a ServersTransport reference', () => {
    const route = traefikIngressRoute({
      name: 'slow-api',
      namespace: NAMESPACE,
      spec: {
        entryPoints: ['websecure'],
        routes: [
          {
            match: 'Host(`slow.example.com`)',
            services: [
              {
                name: 'slow-api',
                namespace: 'workloads',
                port: 8080,
                serversTransport: 'slow-api-transport',
              },
            ],
          },
        ],
      },
      id: 'slowApiRoute',
    });

    expect(route.spec.routes[0]?.services?.[0]?.namespace).toBe('workloads');
    expect(route.spec.routes[0]?.services?.[0]?.serversTransport).toBe('slow-api-transport');
  });

  it('routes to a TraefikService backend by kind', () => {
    const route = traefikIngressRoute({
      name: 'canary',
      namespace: NAMESPACE,
      spec: {
        routes: [
          {
            match: 'Host(`api.example.com`)',
            services: [{ name: 'orders-api-canary', kind: 'TraefikService' }],
          },
        ],
      },
      id: 'canaryRoute',
    });

    expect(route.spec.routes[0]?.services?.[0]?.kind).toBe('TraefikService');
  });

  it('is always ready because IngressRoute has no status subresource', () => {
    const route = traefikIngressRoute({
      name: 'ready-check',
      namespace: NAMESPACE,
      spec: { routes: [{ match: 'PathPrefix(`/`)' }] },
      id: 'readyCheck',
    });

    const status = route.readinessEvaluator?.({ metadata: { name: 'ready-check' } });
    expect(status).toMatchObject({ ready: true });
    expect(status?.message).toContain('no status subresource');
  });
});

describe('traefikIngressRouteTCP', () => {
  it('matches on SNI and can pass TLS through to the backend', () => {
    const route = traefikIngressRouteTCP({
      name: 'postgres',
      namespace: NAMESPACE,
      spec: {
        entryPoints: ['postgres'],
        routes: [
          {
            match: 'HostSNI(`db.example.com`)',
            services: [{ name: 'pg-rw', port: 5432 }],
          },
        ],
        tls: { passthrough: true },
      },
      id: 'postgresRoute',
    });

    expect(route.kind).toBe('IngressRouteTCP');
    expect(route.spec.routes[0]?.match).toBe('HostSNI(`db.example.com`)');
    expect(route.spec.routes[0]?.services?.[0]?.port).toBe(5432);
    expect(route.spec.tls?.passthrough).toBe(true);
  });
});

describe('traefikService', () => {
  it('creates a weighted backend for a canary split', () => {
    const composed = traefikService({
      name: 'orders-api-canary',
      namespace: NAMESPACE,
      spec: {
        weighted: {
          services: [
            { name: 'orders-api', port: 8080, weight: 9 },
            { name: 'orders-api-next', port: 8080, weight: 1 },
          ],
          sticky: { cookie: { name: 'canary', secure: true, httpOnly: true, sameSite: 'strict' } },
        },
      },
      id: 'costApiCanary',
    });

    expect(composed.kind).toBe('TraefikService');
    expect(composed.spec.weighted?.services?.map((service) => service.weight)).toEqual([9, 1]);
    expect(composed.spec.weighted?.sticky?.cookie?.secure).toBe(true);
  });

  it('creates a mirroring backend', () => {
    const composed = traefikService({
      name: 'orders-api-mirror',
      namespace: NAMESPACE,
      spec: {
        mirroring: {
          name: 'orders-api',
          port: 8080,
          mirrors: [{ name: 'orders-api-shadow', port: 8080, percent: 10 }],
        },
      },
      id: 'costApiMirror',
    });

    expect(composed.spec.mirroring?.mirrors?.[0]?.percent).toBe(10);
  });
});

describe('traefikServersTransport', () => {
  it('carries the upstream timeouts an edge needs above the 60s default', () => {
    const transport = traefikServersTransport({
      name: 'orders-api-slow',
      namespace: NAMESPACE,
      spec: {
        forwardingTimeouts: {
          dialTimeout: '5s',
          responseHeaderTimeout: '120s',
          idleConnTimeout: '150s',
        },
        maxIdleConnsPerHost: 64,
      },
      id: 'costApiTransport',
    });

    expect(transport.kind).toBe('ServersTransport');
    expect(transport.spec.forwardingTimeouts?.responseHeaderTimeout).toBe('120s');
    expect(transport.spec.forwardingTimeouts?.idleConnTimeout).toBe('150s');
    expect(transport.spec.maxIdleConnsPerHost).toBe(64);
  });

  it('supports upstream TLS trust without disabling verification', () => {
    const transport = traefikServersTransport({
      name: 'mtls-upstream',
      namespace: NAMESPACE,
      spec: {
        serverName: 'upstream.internal',
        rootCAsSecrets: ['internal-ca'],
        certificatesSecrets: ['edge-client-cert'],
        minVersion: 'VersionTLS13',
      },
      id: 'mtlsUpstream',
    });

    // Nothing here turns verification off; trust comes from an explicit CA
    // Secret. (Absent top-level spec fields read back as magic-proxy
    // references, so this asserts the configured fields instead.)
    expect(transport.spec.rootCAsSecrets).toEqual(['internal-ca']);
    expect(transport.spec.minVersion).toBe('VersionTLS13');
  });
});
