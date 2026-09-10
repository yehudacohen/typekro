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

import {
  BackendTLSPolicySpecSchema,
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
    expect(
      rejects(GatewayListenerSchema({ name: 'ws', protocol: 'WEBSOCKET', port: 8080 }))
    ).toBe(true);
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
