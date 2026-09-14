/**
 * Shared Gateway API ArkType schema tests (no cluster).
 *
 * The spec types are inferred from these schemas, so the schemas are what has
 * to match the CRDs. Each expectation names the CRD fact it protects, read
 * back from a live API server with
 * `kubectl get crd <name> -o jsonpath='{.spec.versions[*].schema.openAPIV3Schema}'`
 * after installing the Gateway API v1.2.1 experimental channel.
 */
import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { backendTLSPolicy } from '../../../src/factories/gateway-api/resources/gateway.js';
import {
  type BackendTLSPolicyConfig,
  BackendTLSPolicyConfigSchema,
  BackendTLSPolicySpecSchema,
  GatewayApiClusterResourceMetadataSchema,
  GatewayApiNamespacedResourceMetadataSchema,
  GatewayListenerSchema,
  GatewaySpecSchema,
  HTTPRouteFilterSchema,
  HTTPRouteMatchSchema,
  HTTPRouteRuleSchema,
  ParentReferenceSchema,
  ReferenceGrantSpecSchema,
} from '../../../src/factories/gateway-api/types.js';

function rejects(result: unknown): boolean {
  return result instanceof type.errors;
}

describe('Gateway spec schema', () => {
  it('accepts the fields the CRD adds beyond a plain listener list', () => {
    // CRD: spec has `backendTLS.clientCertificateRef` and
    // `infrastructure.parametersRef`; listener TLS has `frontendValidation`.
    const result = GatewaySpecSchema({
      gatewayClassName: 'traefik',
      listeners: [
        {
          name: 'https',
          protocol: 'HTTPS',
          port: 443,
          tls: {
            mode: 'Terminate',
            certificateRefs: [{ name: 'edge-wildcard-tls' }],
            frontendValidation: {
              caCertificateRefs: [{ group: '', kind: 'ConfigMap', name: 'client-ca' }],
            },
          },
          allowedRoutes: {
            namespaces: {
              from: 'Selector',
              selector: {
                matchExpressions: [{ key: 'edge', operator: 'In', values: ['public'] }],
              },
            },
          },
        },
      ],
      infrastructure: {
        parametersRef: { group: 'traefik.io', kind: 'TraefikService', name: 'edge-params' },
      },
      backendTLS: { clientCertificateRef: { name: 'edge-client-cert' } },
    });

    expect(rejects(result)).toBe(false);
  });

  it('rejects a protocol the API does not define', () => {
    // Narrower than the CRD's bare string, on purpose.
    expect(rejects(GatewayListenerSchema({ name: 'ws', protocol: 'WEBSOCKET', port: 8080 }))).toBe(
      true
    );
  });
});

describe('Route schemas', () => {
  it('lets a parentRef name a non-Gateway kind', () => {
    // CRD: parentRefs[].kind is a plain string — the mesh profile attaches a
    // route to a Service.
    expect(rejects(ParentReferenceSchema({ kind: 'Service', name: 'orders-api' }))).toBe(false);
  });

  it('uses the CRD method enum rather than an arbitrary verb', () => {
    expect(rejects(HTTPRouteMatchSchema({ method: 'PATCH' }))).toBe(false);
    expect(rejects(HTTPRouteMatchSchema({ method: 'FETCH' }))).toBe(true);
  });

  it('allows a path match with no value, which the CRD reads as the / prefix', () => {
    expect(rejects(HTTPRouteMatchSchema({ path: { type: 'PathPrefix' } }))).toBe(false);
  });

  it('models the request-mirror sampling fields', () => {
    // CRD: filters[].requestMirror has `percent` and `fraction`.
    const percent = HTTPRouteFilterSchema({
      type: 'RequestMirror',
      requestMirror: { backendRef: { name: 'orders-api-shadow', port: 8080 }, percent: 10 },
    });
    const fraction = HTTPRouteFilterSchema({
      type: 'RequestMirror',
      requestMirror: {
        backendRef: { name: 'orders-api-shadow', port: 8080 },
        fraction: { numerator: 1, denominator: 20 },
      },
    });

    expect(rejects(percent)).toBe(false);
    expect(rejects(fraction)).toBe(false);
  });

  it('models sessionPersistence cookieConfig', () => {
    const result = HTTPRouteRuleSchema({
      sessionPersistence: {
        sessionName: 'edge',
        type: 'Cookie',
        cookieConfig: { lifetimeType: 'Session' },
      },
    });

    expect(rejects(result)).toBe(false);
  });

  it('carries per-backend filters on a backendRef', () => {
    const result = HTTPRouteRuleSchema({
      backendRefs: [
        {
          name: 'orders-api',
          port: 8080,
          filters: [
            {
              type: 'RequestHeaderModifier',
              requestHeaderModifier: { set: [{ name: 'X-Edge-Route', value: 'v1' }] },
            },
          ],
        },
      ],
    });

    expect(rejects(result)).toBe(false);
  });
});

describe('ReferenceGrant and BackendTLSPolicy schemas', () => {
  it('requires from and to on a ReferenceGrant', () => {
    expect(
      rejects(
        ReferenceGrantSpecSchema({
          from: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', namespace: 'edge' }],
          to: [{ group: '', kind: 'Service', name: 'orders-api' }],
        })
      )
    ).toBe(false);
    expect(rejects(ReferenceGrantSpecSchema({ from: [] }))).toBe(true);
  });

  it('accepts the CRD validation block, including subjectAltNames', () => {
    const result = BackendTLSPolicySpecSchema({
      targetRefs: [{ group: '', kind: 'Service', name: 'orders-api' }],
      validation: {
        hostname: 'orders-api.example.com',
        wellKnownCACertificates: 'System',
        subjectAltNames: [{ type: 'Hostname', hostname: 'orders-api.example.com' }],
      },
    });

    expect(rejects(result)).toBe(false);
  });

  it('rejects a CA-certificate source the CRD does not define', () => {
    const result = BackendTLSPolicySpecSchema({
      targetRefs: [{ group: '', kind: 'Service', name: 'orders-api' }],
      validation: { hostname: 'orders-api.example.com', wellKnownCACertificates: 'LetsEncrypt' },
    });

    expect(rejects(result)).toBe(true);
  });
});

describe('Resource configuration schemas', () => {
  it('accepts the identity every namespaced Gateway API factory takes', () => {
    const result = GatewayApiNamespacedResourceMetadataSchema({
      name: 'orders-api-route',
      namespace: 'edge',
      labels: { 'example.com/team': 'platform' },
      annotations: { 'example.com/owner': 'platform' },
      id: 'ordersApiRoute',
    });

    expect(rejects(result)).toBe(false);
  });

  it('rejects a name the API server would reject', () => {
    expect(
      rejects(GatewayApiNamespacedResourceMetadataSchema({ name: 'Orders_API', namespace: 'edge' }))
    ).toBe(true);
  });

  it('requires a namespace on the namespaced shape and forbids one on the cluster shape', () => {
    expect(rejects(GatewayApiNamespacedResourceMetadataSchema({ name: 'orders-api-route' }))).toBe(
      true
    );

    const cluster = GatewayApiClusterResourceMetadataSchema.onUndeclaredKey('reject');
    expect(rejects(cluster({ name: 'traefik-edge' }))).toBe(false);
    expect(rejects(cluster({ name: 'traefik-edge', namespace: 'edge' }))).toBe(true);
  });

  it('requires the controllerName that decides BackendTLSPolicy readiness', () => {
    // A cluster can run several Gateway API controllers and each publishes its
    // own ancestor entry, so a policy with no controller to watch would be
    // ready-forever or never-ready depending on whose entry landed first.
    const spec = {
      targetRefs: [{ group: '', kind: 'Service', name: 'orders-api' }],
      validation: { hostname: 'orders-api.example.com', wellKnownCACertificates: 'System' },
    };

    expect(
      rejects(BackendTLSPolicyConfigSchema({ name: 'orders-api-tls', namespace: 'edge', spec }))
    ).toBe(true);
    expect(
      rejects(
        BackendTLSPolicyConfigSchema({
          name: 'orders-api-tls',
          namespace: 'edge',
          controllerName: 'traefik.io/gateway-controller',
          spec,
        })
      )
    ).toBe(false);
  });

  it('builds a BackendTLSPolicy from its own schema output', () => {
    // The config type is inferred from this schema, so the schema and the
    // factory cannot drift while this passes.
    const config = BackendTLSPolicyConfigSchema.assert({
      name: 'orders-api-tls',
      namespace: 'edge',
      controllerName: 'traefik.io/gateway-controller',
      spec: {
        targetRefs: [{ group: '', kind: 'Service', name: 'orders-api' }],
        validation: { hostname: 'orders-api.example.com', wellKnownCACertificates: 'System' },
      },
      id: 'ordersApiTls',
    }) as BackendTLSPolicyConfig;

    const policy = backendTLSPolicy(config);

    expect(policy.kind).toBe('BackendTLSPolicy');
    expect(policy.metadata?.namespace).toBe('edge');
    expect(policy.spec?.validation?.hostname).toBe('orders-api.example.com');
  });
});
