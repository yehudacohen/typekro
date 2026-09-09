/**
 * Shared Gateway API module (#176).
 *
 * Two things must hold after extracting the upstream Gateway API kinds out of
 * `envoy-ai-gateway`:
 *
 *  1. The shared factories and readiness evaluators behave as the upstream
 *     conditions specify, for any implementation's controller name.
 *  2. `envoy-ai-gateway`'s public API is UNCHANGED — same exported symbols,
 *     same behavior, same portable readiness-strategy identifiers, so plans
 *     serialized before the extraction still resolve.
 */
import { describe, expect, it } from 'bun:test';

import { getPortableReadinessStrategy } from '../../../src/core/readiness/portable-strategies.js';
import * as envoy from '../../../src/factories/envoy-ai-gateway/index.js';
import {
  backendTLSPolicy,
  createGatewayApiPolicyReadinessEvaluator,
  GATEWAY_API_REFERENCE_GRANT_VERSION,
  GATEWAY_API_TLS_POLICY_VERSION,
  GATEWAY_API_VERSION,
  gateway,
  gatewayApiAcceptedReadinessEvaluator,
  gatewayApiConditionIsCurrent,
  gatewayApiGatewayClassReadinessEvaluator,
  gatewayApiGatewayReadinessEvaluator,
  gatewayApiRouteReadinessEvaluator,
  gatewayClass,
  grpcRoute,
  httpRoute,
  referenceGrant,
} from '../../../src/factories/gateway-api/index.js';
import { TRAEFIK_GATEWAY_CONTROLLER_NAME } from '../../../src/factories/traefik/constants.js';
import {
  traefikGateway,
  traefikGatewayClass,
  traefikHTTPRoute,
  traefikMiddlewareFilter,
} from '../../../src/factories/traefik/resources/gateway.js';

const ENVOY_CONTROLLER = 'gateway.envoyproxy.io/gatewayclass-controller';

describe('shared Gateway API resources', () => {
  it('pins the upstream API versions', () => {
    expect(GATEWAY_API_VERSION).toBe('gateway.networking.k8s.io/v1');
    expect(GATEWAY_API_REFERENCE_GRANT_VERSION).toBe('gateway.networking.k8s.io/v1beta1');
    expect(GATEWAY_API_TLS_POLICY_VERSION).toBe('gateway.networking.k8s.io/v1alpha3');
  });

  it('creates a cluster-scoped GatewayClass for any controller', () => {
    const traefikClass = gatewayClass({
      name: 'traefik',
      spec: { controllerName: TRAEFIK_GATEWAY_CONTROLLER_NAME },
      id: 'traefikClass',
    });

    expect(traefikClass.apiVersion).toBe(GATEWAY_API_VERSION);
    expect(traefikClass.kind).toBe('GatewayClass');
    expect(traefikClass.spec.controllerName).toBe('traefik.io/gateway-controller');
  });

  it('creates Gateway, HTTPRoute, GRPCRoute and ReferenceGrant', () => {
    const gatewayResource = gateway({
      name: 'edge',
      namespace: 'traefik',
      spec: {
        gatewayClassName: 'traefik',
        listeners: [
          { name: 'web', protocol: 'HTTP', port: 80 },
          {
            name: 'websecure',
            protocol: 'HTTPS',
            port: 443,
            tls: { mode: 'Terminate', certificateRefs: [{ name: 'edge-tls' }] },
            allowedRoutes: { namespaces: { from: 'All' } },
          },
        ],
      },
      id: 'edgeGateway',
    });
    expect(gatewayResource.kind).toBe('Gateway');
    expect(gatewayResource.spec.listeners[1]?.tls?.certificateRefs?.[0]?.name).toBe('edge-tls');

    const route = httpRoute({
      name: 'orders-api',
      namespace: 'edge',
      spec: {
        parentRefs: [{ name: 'edge', namespace: 'traefik' }],
        hostnames: ['api.example.com'],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: '/v1' } }],
            backendRefs: [{ name: 'orders-api', port: 8080 }],
            timeouts: { request: '120s' },
          },
        ],
      },
      id: 'costApiRoute',
    });
    expect(route.kind).toBe('HTTPRoute');
    expect(route.spec.rules?.[0]?.timeouts?.request).toBe('120s');

    const grpc = grpcRoute({
      name: 'cost-grpc',
      namespace: 'edge',
      spec: {
        parentRefs: [{ name: 'edge', namespace: 'traefik' }],
        rules: [{ backendRefs: [{ name: 'cost-grpc', port: 9090 }] }],
      },
      id: 'costGrpcRoute',
    });
    expect(grpc.kind).toBe('GRPCRoute');

    const grant = referenceGrant({
      name: 'allow-edge',
      namespace: 'workloads',
      spec: {
        from: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', namespace: 'edge' }],
        to: [{ group: '', kind: 'Service' }],
      },
      id: 'allowEdge',
    });
    expect(grant.apiVersion).toBe(GATEWAY_API_REFERENCE_GRANT_VERSION);
    // ReferenceGrant is pure authorization data with no status subresource.
    expect(grant.readinessEvaluator?.({})).toMatchObject({ ready: true });
  });

  it('creates a BackendTLSPolicy whose readiness is scoped to a controller', () => {
    const policy = backendTLSPolicy({
      name: 'upstream-tls',
      namespace: 'edge',
      controllerName: TRAEFIK_GATEWAY_CONTROLLER_NAME,
      spec: {
        targetRefs: [{ group: '', kind: 'Service', name: 'orders-api' }],
        validation: { hostname: 'orders-api.internal', wellKnownCACertificates: 'System' },
      },
      id: 'upstreamTls',
    });

    expect(policy.apiVersion).toBe(GATEWAY_API_TLS_POLICY_VERSION);
    // Another controller's ancestor entry must not make this policy ready.
    expect(
      policy.readinessEvaluator?.({
        metadata: { generation: 1 },
        status: {
          ancestors: [
            {
              controllerName: ENVOY_CONTROLLER,
              conditions: [{ type: 'Accepted', status: 'True', observedGeneration: 1 }],
            },
          ],
        },
      })
    ).toMatchObject({ ready: false });

    expect(
      policy.readinessEvaluator?.({
        metadata: { generation: 1 },
        status: {
          ancestors: [
            {
              controllerName: TRAEFIK_GATEWAY_CONTROLLER_NAME,
              conditions: [{ type: 'Accepted', status: 'True', observedGeneration: 1 }],
            },
          ],
        },
      })
    ).toMatchObject({ ready: true });
  });
});

describe('shared Gateway API readiness', () => {
  it('requires Accepted for the current generation', () => {
    expect(
      gatewayApiAcceptedReadinessEvaluator({
        metadata: { generation: 2 },
        status: { conditions: [{ type: 'Accepted', status: 'True', observedGeneration: 1 }] },
      })
    ).toMatchObject({ ready: false, reason: 'Reconciling' });

    expect(
      gatewayApiAcceptedReadinessEvaluator({
        metadata: { generation: 2 },
        status: { conditions: [{ type: 'Accepted', status: 'True', observedGeneration: 2 }] },
      })
    ).toMatchObject({ ready: true });
  });

  it('accepts the sparse condition shape controllers may emit', () => {
    // Some controllers omit observedGeneration on their v1beta1 resources.
    expect(gatewayApiConditionIsCurrent({ type: 'Accepted', status: 'True' }, 7)).toBe(true);
    expect(
      gatewayApiConditionIsCurrent({ type: 'Accepted', status: 'True', observedGeneration: 6 }, 7)
    ).toBe(false);
  });

  it('treats NotAccepted=True as a rejection', () => {
    expect(
      gatewayApiAcceptedReadinessEvaluator({
        metadata: { generation: 1 },
        status: {
          conditions: [
            { type: 'NotAccepted', status: 'True', reason: 'InvalidRule', observedGeneration: 1 },
          ],
        },
      })
    ).toMatchObject({ ready: false, reason: 'InvalidRule' });
  });

  it('requires both Accepted and Programmed for a Gateway', () => {
    expect(
      gatewayApiGatewayReadinessEvaluator({
        metadata: { generation: 1 },
        status: { conditions: [{ type: 'Accepted', status: 'True', observedGeneration: 1 }] },
      })
    ).toMatchObject({ ready: false });

    expect(
      gatewayApiGatewayReadinessEvaluator({
        metadata: { generation: 1 },
        status: {
          conditions: [
            { type: 'Accepted', status: 'True', observedGeneration: 1 },
            { type: 'Programmed', status: 'True', observedGeneration: 1 },
          ],
        },
      })
    ).toMatchObject({ ready: true, reason: 'GatewayProgrammed' });

    expect(
      gatewayApiGatewayReadinessEvaluator({
        metadata: { generation: 1 },
        status: {
          conditions: [
            { type: 'Accepted', status: 'True', observedGeneration: 1 },
            {
              type: 'Programmed',
              status: 'False',
              reason: 'AddressNotAssigned',
              observedGeneration: 1,
            },
          ],
        },
      })
    ).toMatchObject({ ready: false, reason: 'AddressNotAssigned' });
  });

  it('accepts a GatewayClass on Accepted alone', () => {
    expect(
      gatewayApiGatewayClassReadinessEvaluator({
        metadata: { generation: 1 },
        status: { conditions: [{ type: 'Accepted', status: 'True', observedGeneration: 1 }] },
      })
    ).toMatchObject({ ready: true });
  });

  it('reads the per-parent conditions of a route', () => {
    expect(
      gatewayApiRouteReadinessEvaluator({ metadata: { generation: 1 }, status: {} })
    ).toMatchObject({ ready: false, reason: 'Reconciling' });

    expect(
      gatewayApiRouteReadinessEvaluator({
        metadata: { generation: 1 },
        status: {
          parents: [
            {
              controllerName: TRAEFIK_GATEWAY_CONTROLLER_NAME,
              conditions: [
                { type: 'Accepted', status: 'True', observedGeneration: 1 },
                { type: 'ResolvedRefs', status: 'True', observedGeneration: 1 },
              ],
            },
          ],
        },
      })
    ).toMatchObject({ ready: true });

    expect(
      gatewayApiRouteReadinessEvaluator({
        metadata: { generation: 1 },
        status: {
          parents: [
            {
              conditions: [
                { type: 'Accepted', status: 'True', observedGeneration: 1 },
                {
                  type: 'ResolvedRefs',
                  status: 'False',
                  reason: 'BackendNotFound',
                  observedGeneration: 1,
                },
              ],
            },
          ],
        },
      })
    ).toMatchObject({ ready: false, reason: 'BackendNotFound' });
  });

  it('marks a rejected policy terminal so a waiter fails fast', () => {
    const evaluate = createGatewayApiPolicyReadinessEvaluator(ENVOY_CONTROLLER);

    expect(
      evaluate({
        metadata: { generation: 1 },
        status: {
          ancestors: [
            {
              controllerName: ENVOY_CONTROLLER,
              conditions: [
                { type: 'Accepted', status: 'False', reason: 'Invalid', observedGeneration: 1 },
              ],
            },
          ],
        },
      })
    ).toMatchObject({ ready: false, terminal: true, reason: 'Invalid' });
  });

  it('registers portable strategies under stable gateway-api identifiers', () => {
    expect(getPortableReadinessStrategy(gatewayApiAcceptedReadinessEvaluator)).toMatchObject({
      id: 'typekro.readiness.gateway-api.accepted',
      revision: '1',
    });
    expect(getPortableReadinessStrategy(gatewayApiGatewayReadinessEvaluator)).toMatchObject({
      id: 'typekro.readiness.gateway-api.gateway',
    });
    expect(getPortableReadinessStrategy(gatewayApiRouteReadinessEvaluator)).toMatchObject({
      id: 'typekro.readiness.gateway-api.route',
    });
    expect(
      getPortableReadinessStrategy(createGatewayApiPolicyReadinessEvaluator(ENVOY_CONTROLLER))
    ).toMatchObject({ id: 'typekro.readiness.gateway-api.policy' });
  });
});

describe('envoy-ai-gateway backward compatibility', () => {
  it('still exports every Gateway API symbol it used to own', () => {
    expect(envoy.envoyGatewayClass).toBeTypeOf('function');
    expect(envoy.envoyGateway).toBeTypeOf('function');
    expect(envoy.envoyBackendTLSPolicy).toBeTypeOf('function');
    expect(envoy.envoyAIAcceptedReadinessEvaluator).toBeTypeOf('function');
    expect(envoy.envoyGatewayClassReadinessEvaluator).toBeTypeOf('function');
    expect(envoy.envoyGatewayReadinessEvaluator).toBeTypeOf('function');
    expect(envoy.envoyGatewayPolicyReadinessEvaluator).toBeTypeOf('function');
    expect(envoy.GATEWAY_API_VERSION).toBe('gateway.networking.k8s.io/v1');
    expect(envoy.GATEWAY_API_TLS_POLICY_VERSION).toBe('gateway.networking.k8s.io/v1alpha3');
  });

  it('keeps its GatewayClass pinned to the Envoy controller', () => {
    const envoyClass = envoy.envoyGatewayClass({
      name: 'envoy-ai-gateway',
      spec: { controllerName: ENVOY_CONTROLLER },
      id: 'envoyClass',
    });

    expect(envoyClass.spec.controllerName).toBe(ENVOY_CONTROLLER);
    expect(envoyClass.metadata.labels?.['app.kubernetes.io/name']).toBe('envoy-ai-gateway');
  });

  it('keeps its own readiness behavior, including the sparse-condition allowance', () => {
    expect(
      envoy.envoyAIAcceptedReadinessEvaluator({
        metadata: { generation: 2 },
        status: { conditions: [{ type: 'Accepted', status: 'True' }] },
      })
    ).toMatchObject({ ready: true });

    expect(
      envoy.envoyAIAcceptedReadinessEvaluator({
        metadata: { generation: 2 },
        status: { conditions: [{ type: 'Accepted', status: 'True', observedGeneration: 1 }] },
      })
    ).toMatchObject({ ready: false, reason: 'Reconciling' });

    expect(
      envoy.envoyGatewayPolicyReadinessEvaluator({
        metadata: { generation: 1 },
        status: {
          ancestors: [
            {
              controllerName: ENVOY_CONTROLLER,
              conditions: [{ type: 'Accepted', status: 'True', observedGeneration: 1 }],
            },
          ],
        },
      })
    ).toMatchObject({ ready: true });
  });

  it('keeps the original portable readiness-strategy identifiers', () => {
    // These ids are embedded in previously serialized plans; renaming them
    // would make those plans unresolvable.
    expect(getPortableReadinessStrategy(envoy.envoyAIAcceptedReadinessEvaluator)).toMatchObject({
      id: 'typekro.readiness.envoy-ai-gateway.accepted',
      revision: '1',
    });
    expect(getPortableReadinessStrategy(envoy.envoyGatewayClassReadinessEvaluator)).toMatchObject({
      id: 'typekro.readiness.envoy-ai-gateway.gateway-class',
    });
    expect(getPortableReadinessStrategy(envoy.envoyGatewayReadinessEvaluator)).toMatchObject({
      id: 'typekro.readiness.envoy-ai-gateway.gateway',
    });
    expect(getPortableReadinessStrategy(envoy.envoyGatewayPolicyReadinessEvaluator)).toMatchObject({
      id: 'typekro.readiness.envoy-ai-gateway.policy',
    });
  });

  it('still serializes its gateway composition unchanged in shape', () => {
    const yaml = envoy.envoyProxyHelmRepositoryBootstrap.toYaml();
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('EnvoyProxyHelmRepository');
  });
});

describe('traefik consumes the shared Gateway API module', () => {
  it('claims its own controller name on a GatewayClass', () => {
    const traefikClass = traefikGatewayClass({
      name: 'traefik-edge',
      description: 'Traefik v3 edge',
      id: 'traefikGatewayClass',
    });

    expect(traefikClass.apiVersion).toBe(GATEWAY_API_VERSION);
    expect(traefikClass.kind).toBe('GatewayClass');
    expect(traefikClass.spec.controllerName).toBe(TRAEFIK_GATEWAY_CONTROLLER_NAME);
    expect(traefikClass.spec.description).toBe('Traefik v3 edge');
    expect(traefikClass.metadata.labels?.['app.kubernetes.io/name']).toBe('traefik');
  });

  it('stamps the Traefik managed labels on Gateway API objects', () => {
    const gatewayResource = traefikGateway({
      name: 'edge',
      namespace: 'traefik',
      spec: {
        gatewayClassName: 'traefik-edge',
        listeners: [{ name: 'websecure', protocol: 'HTTPS', port: 443 }],
      },
      id: 'edgeGateway',
    });

    expect(gatewayResource.metadata.labels?.['app.kubernetes.io/name']).toBe('traefik');
    expect(gatewayResource.metadata.labels?.['app.kubernetes.io/managed-by']).toBe('typekro');
  });

  it('attaches a Traefik Middleware to an HTTPRoute through an ExtensionRef filter', () => {
    const filter = traefikMiddlewareFilter('orders-api-authz');
    expect(filter).toEqual({
      type: 'ExtensionRef',
      extensionRef: { group: 'traefik.io', kind: 'Middleware', name: 'orders-api-authz' },
    });

    const route = traefikHTTPRoute({
      name: 'orders-api',
      namespace: 'edge',
      spec: {
        parentRefs: [{ name: 'edge', namespace: 'traefik' }],
        hostnames: ['api.example.com'],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: '/v1' } }],
            filters: [filter],
            backendRefs: [{ name: 'orders-api', port: 8080 }],
          },
        ],
      },
      id: 'costApiHttpRoute',
    });

    expect(route.spec.rules?.[0]?.filters?.[0]?.extensionRef?.kind).toBe('Middleware');
  });

  it('reuses the shared route readiness evaluator', () => {
    const route = traefikHTTPRoute({
      name: 'ready-check',
      namespace: 'edge',
      spec: { parentRefs: [{ name: 'edge' }] },
      id: 'readyCheckRoute',
    });

    expect(getPortableReadinessStrategy(route.readinessEvaluator!)).toMatchObject({
      id: 'typekro.readiness.gateway-api.route',
    });
  });
});
