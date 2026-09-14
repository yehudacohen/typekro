import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { caddyIngress } from '../../src/factories/caddy/index.js';
import { APISixBootstrapConfigSchema } from '../../src/factories/apisix/types.js';
import { generateKroSchemaFromArktype } from '../../src/core/serialization/schema.js';
import {
  BackendRefSchema,
  GatewayListenerSchema,
  HTTPRouteFilterSchema,
  HTTPRouteRuleSchema,
  ParentReferenceSchema,
} from '../../src/factories/gateway-api/types.js';
import { traefikBootstrap } from '../../src/factories/traefik/index.js';
import {
  TraefikBootstrapConfigSchema,
  TraefikBootstrapStatusSchema,
  TraefikCircuitBreakerMiddlewareSchema,
  TraefikCompressMiddlewareSchema,
  TraefikErrorsMiddlewareSchema,
  TraefikHeadersMiddlewareSchema,
  TraefikHealthCheckSchema,
  TraefikInFlightReqMiddlewareConfigSchema,
  TraefikInFlightReqMiddlewareSchema,
  TraefikIngressRouteTCPRuleSchema,
  TraefikIpStrategySchema,
  TraefikRateLimitMiddlewareConfigSchema,
  TraefikRateLimitMiddlewareSchema,
  TraefikRetryMiddlewareSchema,
  TraefikServersTransportSpecSchema,
  TraefikServiceRefSchema,
  TraefikTCPServiceRefSchema,
} from '../../src/factories/traefik/types.js';

/**
 * Regression for the 0.27 strict-CEL break: KRO's CEL type-checker rejects a `float` (double)
 * schema field used where an int is expected — e.g. a Caddy port reference reaching
 * `spec.template.spec.containers[].ports[].containerPort`
 * ("expression schema.spec.httpPort returns type double but expected int").
 *
 * The mapping in `getKroTypeFromJson` is correct as-is (bare arktype `number` → KRO `float`,
 * `number.integer` → KRO `integer`). The fix is that Kubernetes-integral factory fields must
 * DECLARE their integrality via `number.integer` rather than bare `number`. This test locks in
 * that the shipped factory schemas serialize integral fields as KRO `integer`.
 */
describe('factory integer schema fields (strict-CEL)', () => {
  it('preserves ArkType singleton literals and bounded arrays in SimpleSchema', () => {
    const kroSpec = generateKroSchemaFromArktype('literal-contract', {
      apiVersion: 'v1alpha1',
      kind: 'LiteralContract',
      spec: type({
        requiredTrue: 'true',
        requiredFalse: 'false',
        exactNumber: '3',
        values: 'string[] > 0',
      }),
      status: type({ ready: 'boolean' }),
    }).spec as Record<string, unknown>;

    expect(kroSpec.requiredTrue).toBe('boolean | validation="self == true"');
    expect(kroSpec.requiredFalse).toBe('boolean | validation="self == false"');
    expect(kroSpec.exactNumber).toBe('integer | validation="self == 3"');
    expect(kroSpec.values).toBe('[]string | minItems=1');
  });

  it('emits structured field rules through named SimpleSchema types', () => {
    const schema = generateKroSchemaFromArktype(
      'validated-contract',
      {
        apiVersion: 'v1alpha1',
        kind: 'ValidatedContract',
        spec: type({ policy: { enabled: 'boolean', destinations: 'string[]' } }),
        status: type({ ready: 'boolean' }),
      },
      undefined,
      undefined,
      undefined,
      { policy: 'self.enabled && size(self.destinations) > 0' }
    );

    expect(schema.spec.policy).toBe(
      'ValidatedContractPolicy | validation="self.enabled && size(self.destinations) > 0"'
    );
    expect(schema.types?.ValidatedContractPolicy).toEqual({
      enabled: 'boolean',
      destinations: '[]string',
    });
  });

  it('caddy httpPort/httpsPort serialize as KRO integer, not float', () => {
    const yaml = caddyIngress.toYaml();
    expect(yaml).toContain('httpPort: integer');
    expect(yaml).toContain('httpsPort: integer');
    expect(yaml).not.toContain('httpPort: float');
    expect(yaml).not.toContain('httpsPort: float');
    // The CEL reference into an int-typed container/Service port resolves to the integer field.
    expect(yaml).toContain('containerPort: ${schema.spec.httpPort}');
  });

  it('apisix stream port arrays (tcp/udp) serialize as KRO []integer, not []float', () => {
    const kroSpec = generateKroSchemaFromArktype('apisix', {
      apiVersion: 'v1alpha1',
      kind: 'APISix',
      spec: APISixBootstrapConfigSchema,
      status: type({ ready: 'boolean' }),
    }).spec as Record<string, unknown>;
    const gateway = kroSpec.gateway as Record<string, unknown>;
    const stream = gateway.stream as Record<string, unknown>;
    expect(stream.tcp).toBe('[]integer');
    expect(stream.udp).toBe('[]integer');
  });

  it('int-or-string fields (nodePort, rolling-update / PDB limits) reject fractional numbers at validation', () => {
    // Mirrors ory nodePort/maxSurge/maxUnavailable/minAvailable, which use `string | number.integer`
    // (a k8s IntOrString whose numeric branch must be integral). KRO SimpleSchema collapses the union
    // to `object`, so this integrality is enforced at the arktype validation layer.
    const intOrString = type({ 'nodePort?': 'string | number.integer' });
    expect(intOrString({ nodePort: 30000.5 }) instanceof type.errors).toBe(true);
    expect(intOrString({ nodePort: 30000 }) instanceof type.errors).toBe(false);
    expect(intOrString({ nodePort: '30000' }) instanceof type.errors).toBe(false);

    const intArray = type({ 'tcp?': 'number.integer[]' });
    expect(intArray({ tcp: [9000.5] }) instanceof type.errors).toBe(true);
    expect(intArray({ tcp: [9000] }) instanceof type.errors).toBe(false);
  });
});

/**
 * The same rule applied to the Traefik and Gateway API factories.
 *
 * Both describe CRDs that type most of their numeric fields as `integer`, and
 * both were re-declared as ArkType schemas in this PR — the migration is
 * exactly where a `number.integer` quietly becomes a `number`. The table below
 * is derived from the shipped CRD schemas: Traefik chart 41.5.0's `crds/`
 * (`traefik.io/v1alpha1`) and Gateway API v1.2.1, each entry naming the CRD
 * path it stands for. A float reaching any of them is rejected by the API
 * server, so ArkType has to reject it first.
 */
describe('Traefik and Gateway API integral schema fields', () => {
  const rejects = (result: unknown) => result instanceof type.errors;

  /** `[label, schema, integral value, the same value with a fraction]`. */
  const integralFields: readonly [string, (data: unknown) => unknown, unknown, unknown][] = [
    // --- Traefik CRDs ------------------------------------------------------
    ['Middleware.spec.*.ipStrategy.depth', TraefikIpStrategySchema, { depth: 2 }, { depth: 2.5 }],
    [
      'Middleware.spec.*.ipStrategy.ipv6Subnet',
      TraefikIpStrategySchema,
      { ipv6Subnet: 64 },
      { ipv6Subnet: 64.5 },
    ],
    [
      'IngressRoute.spec.routes[].services[].healthCheck.status',
      TraefikHealthCheckSchema,
      { status: 200 },
      { status: 200.5 },
    ],
    [
      'IngressRoute.spec.routes[].services[].healthCheck.port',
      TraefikHealthCheckSchema,
      { port: 8080 },
      { port: 8080.5 },
    ],
    [
      'IngressRoute.spec.routes[].services[].healthCheck.interval (int-or-string)',
      TraefikHealthCheckSchema,
      { interval: 1000 },
      { interval: 1000.5 },
    ],
    [
      'IngressRoute.spec.routes[].services[].weight',
      TraefikServiceRefSchema,
      { name: 'api', weight: 3 },
      { name: 'api', weight: 3.5 },
    ],
    [
      'IngressRoute.spec.routes[].services[].port (int-or-string)',
      TraefikServiceRefSchema,
      { name: 'api', port: 8080 },
      { name: 'api', port: 8080.5 },
    ],
    [
      'IngressRoute.spec.routes[].services[].passiveHealthCheck.maxFailedAttempts',
      TraefikServiceRefSchema,
      { name: 'api', passiveHealthCheck: { maxFailedAttempts: 3 } },
      { name: 'api', passiveHealthCheck: { maxFailedAttempts: 3.5 } },
    ],
    [
      'IngressRoute.spec.routes[].services[].sticky.cookie.maxAge',
      TraefikServiceRefSchema,
      { name: 'api', sticky: { cookie: { maxAge: 60 } } },
      { name: 'api', sticky: { cookie: { maxAge: 60.5 } } },
    ],
    [
      'IngressRouteTCP.spec.routes[].priority',
      TraefikIngressRouteTCPRuleSchema,
      { match: 'HostSNI(`*`)', priority: 10 },
      { match: 'HostSNI(`*`)', priority: 10.5 },
    ],
    [
      'IngressRouteTCP.spec.routes[].services[].proxyProtocol.version',
      TraefikTCPServiceRefSchema,
      { name: 'db', port: 5432, proxyProtocol: { version: 2 } },
      { name: 'db', port: 5432, proxyProtocol: { version: 1.5 } },
    ],
    [
      'ServersTransport.spec.maxIdleConnsPerHost',
      TraefikServersTransportSpecSchema,
      { maxIdleConnsPerHost: 200 },
      { maxIdleConnsPerHost: 200.5 },
    ],
    [
      'Middleware.spec.rateLimit.average',
      TraefikRateLimitMiddlewareSchema,
      { average: 100 },
      { average: 100.5 },
    ],
    [
      'Middleware.spec.rateLimit.burst',
      TraefikRateLimitMiddlewareSchema,
      { burst: 50 },
      { burst: 50.5 },
    ],
    [
      'Middleware.spec.rateLimit.redis.poolSize',
      TraefikRateLimitMiddlewareSchema,
      { redis: { endpoints: ['valkey:6379'], poolSize: 10 } },
      { redis: { endpoints: ['valkey:6379'], poolSize: 10.5 } },
    ],
    [
      'Middleware.spec.inFlightReq.amount',
      TraefikInFlightReqMiddlewareSchema,
      { amount: 20 },
      { amount: 20.5 },
    ],
    [
      'Middleware.spec.headers.stsSeconds',
      TraefikHeadersMiddlewareSchema,
      { stsSeconds: 31536000 },
      { stsSeconds: 31536000.5 },
    ],
    [
      'Middleware.spec.headers.accessControlMaxAge',
      TraefikHeadersMiddlewareSchema,
      { accessControlMaxAge: 600 },
      { accessControlMaxAge: 600.5 },
    ],
    [
      'Middleware.spec.retry.attempts',
      TraefikRetryMiddlewareSchema,
      { attempts: 3 },
      { attempts: 3.5 },
    ],
    [
      'Middleware.spec.retry.maxRequestBodyBytes',
      TraefikRetryMiddlewareSchema,
      { maxRequestBodyBytes: 1048576 },
      { maxRequestBodyBytes: 1048576.5 },
    ],
    [
      'Middleware.spec.circuitBreaker.responseCode',
      TraefikCircuitBreakerMiddlewareSchema,
      { responseCode: 503 },
      { responseCode: 503.5 },
    ],
    [
      'Middleware.spec.compress.minResponseBodyBytes',
      TraefikCompressMiddlewareSchema,
      { minResponseBodyBytes: 1024 },
      { minResponseBodyBytes: 1024.5 },
    ],
    [
      'Middleware.spec.errors.statusRewrites{}',
      TraefikErrorsMiddlewareSchema,
      { service: { name: 'errors' }, statusRewrites: { '500-599': 502 } },
      { service: { name: 'errors' }, statusRewrites: { '500-599': 502.5 } },
    ],
    // --- The middleware BUILDER configs, which restate the same fields -----
    [
      'traefikRateLimitMiddleware({ average, burst })',
      TraefikRateLimitMiddlewareConfigSchema,
      { name: 'rl', namespace: 'edge', average: 100, burst: 50 },
      { name: 'rl', namespace: 'edge', average: 100.5, burst: 50 },
    ],
    [
      'traefikInFlightReqMiddleware({ amount })',
      TraefikInFlightReqMiddlewareConfigSchema,
      { name: 'ifr', namespace: 'edge', amount: 20 },
      { name: 'ifr', namespace: 'edge', amount: 20.5 },
    ],
    // --- Gateway API v1.2.1 ------------------------------------------------
    [
      'Gateway.spec.listeners[].port',
      GatewayListenerSchema,
      { name: 'https', protocol: 'HTTPS', port: 443 },
      { name: 'https', protocol: 'HTTPS', port: 443.5 },
    ],
    [
      'HTTPRoute.spec.parentRefs[].port',
      ParentReferenceSchema,
      { name: 'edge', port: 443 },
      { name: 'edge', port: 443.5 },
    ],
    [
      'HTTPRoute.spec.rules[].backendRefs[].port',
      BackendRefSchema,
      { name: 'api', port: 8080 },
      { name: 'api', port: 8080.5 },
    ],
    [
      'HTTPRoute.spec.rules[].backendRefs[].weight',
      BackendRefSchema,
      { name: 'api', weight: 10 },
      { name: 'api', weight: 10.5 },
    ],
    [
      'HTTPRoute.spec.rules[].filters[].requestRedirect.port',
      HTTPRouteFilterSchema,
      { type: 'RequestRedirect', requestRedirect: { port: 443 } },
      { type: 'RequestRedirect', requestRedirect: { port: 443.5 } },
    ],
    [
      'HTTPRoute.spec.rules[].filters[].requestMirror.percent',
      HTTPRouteFilterSchema,
      { type: 'RequestMirror', requestMirror: { backendRef: { name: 'shadow' }, percent: 10 } },
      { type: 'RequestMirror', requestMirror: { backendRef: { name: 'shadow' }, percent: 10.5 } },
    ],
    [
      'HTTPRoute.spec.rules[].filters[].requestMirror.fraction',
      HTTPRouteFilterSchema,
      {
        type: 'RequestMirror',
        requestMirror: { backendRef: { name: 'shadow' }, fraction: { numerator: 1, denominator: 4 } },
      },
      {
        type: 'RequestMirror',
        requestMirror: {
          backendRef: { name: 'shadow' },
          fraction: { numerator: 1.5, denominator: 4 },
        },
      },
    ],
    ['HTTPRoute.spec.rules[].retry.codes[]', HTTPRouteRuleSchema, { retry: { codes: [503] } }, { retry: { codes: [503.5] } }],
    [
      'HTTPRoute.spec.rules[].retry.attempts',
      HTTPRouteRuleSchema,
      { retry: { attempts: 3 } },
      { retry: { attempts: 3.5 } },
    ],
  ];

  for (const [label, schema, integral, fractional] of integralFields) {
    it(`declares ${label} as an integer`, () => {
      expect(rejects(schema(integral))).toBe(false);
      expect(rejects(schema(fractional))).toBe(true);
    });
  }

  /**
   * Bounds the CRDs declare. These are not decoration: an out-of-range value is
   * rejected at admission, so a schema that accepts it only moves the failure
   * from `bun test` to the cluster.
   */
  const boundedFields: readonly [string, (data: unknown) => unknown, unknown][] = [
    ['a port above 65535', GatewayListenerSchema, { name: 'x', protocol: 'HTTP', port: 65536 }],
    ['a port of 0', GatewayListenerSchema, { name: 'x', protocol: 'HTTP', port: 0 }],
    ['a mirror percent above 100', HTTPRouteFilterSchema, {
      type: 'RequestMirror',
      requestMirror: { backendRef: { name: 's' }, percent: 101 },
    }],
    ['a retry code outside 400-599', HTTPRouteRuleSchema, { retry: { codes: [200] } }],
    ['a backendRef weight above 1000000', BackendRefSchema, { name: 'api', weight: 1000001 }],
    ['a PROXY protocol version above 2', TraefikTCPServiceRefSchema, {
      name: 'db',
      port: 5432,
      proxyProtocol: { version: 3 },
    }],
    ['a circuit-breaker response code below 100', TraefikCircuitBreakerMiddlewareSchema, {
      responseCode: 99,
    }],
    ['a negative ipStrategy depth', TraefikIpStrategySchema, { depth: -1 }],
    ['a negative rate-limit average', TraefikRateLimitMiddlewareSchema, { average: -1 }],
    ['a maxIdleConnsPerHost below -1', TraefikServersTransportSpecSchema, {
      maxIdleConnsPerHost: -2,
    }],
  ];

  for (const [label, schema, value] of boundedFields) {
    it(`rejects ${label}`, () => {
      expect(rejects(schema(value))).toBe(true);
    });
  }

  it('emits the bootstrap composition spec with integer, not float, numeric fields', () => {
    const spec = generateKroSchemaFromArktype('traefik-bootstrap', {
      apiVersion: 'v1alpha1',
      kind: 'TraefikBootstrap',
      spec: TraefikBootstrapConfigSchema,
      status: TraefikBootstrapStatusSchema,
    }).spec as Record<string, unknown>;

    const entrypoints = spec.entrypoints as Record<string, Record<string, unknown>>;
    expect(spec.replicas).toBe('integer | minimum=1');
    expect(entrypoints.web?.exposedPort).toBe('integer | minimum=1 maximum=65535');
    expect(entrypoints.websecure?.exposedPort).toBe('integer | minimum=1 maximum=65535');
  });

  it('leaves no float in the serialized Traefik bootstrap RGD', () => {
    // A `float` here is what KRO's CEL type-checker trips over the moment the
    // field is referenced from an int-typed Kubernetes path.
    const yaml = traefikBootstrap.toYaml();
    expect(yaml).toContain('replicas: integer | minimum=1');
    expect(yaml).not.toContain('float');
  });
});
