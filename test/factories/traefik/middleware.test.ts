/**
 * Traefik `Middleware` — the discriminated union, its typed builders, and the
 * negative cases the union exists to prevent (#174).
 */
import { describe, expect, it } from 'bun:test';

import { TypeKroError } from '../../../src/core/errors.js';
import { TRAEFIK_MIDDLEWARE_KINDS } from '../../../src/factories/traefik/constants.js';
import {
  traefikBufferingMiddleware,
  traefikChainMiddleware,
  traefikForwardAuthMiddleware,
  traefikHeadersMiddleware,
  traefikInFlightReqMiddleware,
  traefikMiddleware,
  traefikRateLimitMiddleware,
  traefikRedirectSchemeMiddleware,
} from '../../../src/factories/traefik/resources/middleware.js';
import type { TraefikMiddlewareSpec } from '../../../src/factories/traefik/types.js';
import {
  assertTraefikMiddlewareSpec,
  traefikMiddlewareKeys,
  validateTraefikMiddlewareSpec,
} from '../../../src/factories/traefik/utils/middleware-validation.js';

const NAMESPACE = 'edge';

describe('traefikMiddleware', () => {
  it('creates a Middleware with the pinned apiVersion, managed labels and no status', () => {
    const middleware = traefikMiddleware({
      name: 'strip-v1',
      namespace: NAMESPACE,
      spec: { stripPrefix: { prefixes: ['/v1'] } },
      id: 'stripV1',
    });

    expect(middleware.apiVersion).toBe('traefik.io/v1alpha1');
    expect(middleware.kind).toBe('Middleware');
    expect(middleware.metadata.name).toBe('strip-v1');
    expect(middleware.metadata.namespace).toBe(NAMESPACE);
    expect(middleware.metadata.labels).toMatchObject({
      'app.kubernetes.io/name': 'traefik',
      'app.kubernetes.io/instance': 'strip-v1',
      'app.kubernetes.io/managed-by': 'typekro',
    });
    expect(middleware.spec.stripPrefix?.prefixes).toEqual(['/v1']);
  });

  it('registers an always-ready evaluator because the CRD has no status', () => {
    const middleware = traefikMiddleware({
      name: 'compress',
      namespace: NAMESPACE,
      spec: { compress: { minResponseBodyBytes: 1024 } },
      id: 'compress',
    });

    // The evaluator must answer ready for the live object as the API returns
    // it — Traefik never writes a status onto its CRDs.
    expect(middleware.readinessEvaluator).toBeDefined();
    expect(middleware.readinessEvaluator?.({ metadata: { name: 'compress' } })).toMatchObject({
      ready: true,
    });
  });

  it('merges caller labels over the managed set without losing it', () => {
    const middleware = traefikMiddleware({
      name: 'retry',
      namespace: NAMESPACE,
      labels: { 'sela.dev/tier': 'edge' },
      annotations: { 'sela.dev/owner': 'platform' },
      spec: { retry: { attempts: 3, initialInterval: '100ms' } },
      id: 'retry',
    });

    expect(middleware.metadata.labels?.['sela.dev/tier']).toBe('edge');
    expect(middleware.metadata.labels?.['app.kubernetes.io/managed-by']).toBe('typekro');
    expect(middleware.metadata.annotations?.['sela.dev/owner']).toBe('platform');
  });

  it('accepts one variant per OSS middleware kind', () => {
    const specs: Record<string, TraefikMiddlewareSpec> = {
      addPrefix: { addPrefix: { prefix: '/api' } },
      basicAuth: { basicAuth: { secret: 'edge-users' } },
      buffering: { buffering: { maxRequestBodyBytes: 1_048_576 } },
      chain: { chain: { middlewares: [{ name: 'a' }, { name: 'b' }] } },
      circuitBreaker: { circuitBreaker: { expression: 'NetworkErrorRatio() > 0.30' } },
      compress: { compress: { encodings: ['gzip', 'br'] } },
      contentType: { contentType: { autoDetect: false } },
      digestAuth: { digestAuth: { secret: 'edge-users' } },
      encodedCharacters: { encodedCharacters: { allowEncodedSlash: true } },
      errors: {
        errors: {
          status: ['500-599'],
          query: '/{status}.html',
          service: { name: 'errors', port: 80 },
        },
      },
      forwardAuth: { forwardAuth: { address: 'http://authz.edge.svc.cluster.local:8080' } },
      grpcWeb: { grpcWeb: { allowOrigins: ['https://console.example.com'] } },
      headers: { headers: { frameDeny: true } },
      inFlightReq: { inFlightReq: { amount: 20 } },
      ipAllowList: { ipAllowList: { sourceRange: ['10.0.0.0/8'] } },
      passTLSClientCert: { passTLSClientCert: { pem: true } },
      plugin: { plugin: { 'my-plugin': { enabled: true } } },
      rateLimit: { rateLimit: { average: 50, burst: 100 } },
      redirectRegex: { redirectRegex: { regex: '^/old/(.*)', replacement: '/new/$1' } },
      redirectScheme: { redirectScheme: { scheme: 'https', permanent: true } },
      replacePath: { replacePath: { path: '/canonical' } },
      replacePathRegex: { replacePathRegex: { regex: '^/a/(.*)', replacement: '/b/$1' } },
      retry: { retry: { attempts: 3 } },
      stripPrefix: { stripPrefix: { prefixes: ['/v1'] } },
      stripPrefixRegex: { stripPrefixRegex: { regex: ['^/v[0-9]+'] } },
    };

    // Every kind the constant advertises has a covered variant, and vice versa.
    expect(Object.keys(specs).sort()).toEqual([...TRAEFIK_MIDDLEWARE_KINDS].sort());

    for (const [kind, spec] of Object.entries(specs)) {
      const middleware = traefikMiddleware({
        name: kind.toLowerCase(),
        namespace: NAMESPACE,
        spec,
        id: `mw${kind}`,
      });
      expect(traefikMiddlewareKeys(middleware.spec)).toEqual([kind]);
    }
  });
});

describe('Middleware spec validation (negative cases)', () => {
  it('rejects two middleware keys in one spec', () => {
    const issues = validateTraefikMiddlewareSpec({
      forwardAuth: { address: 'http://authz' },
      rateLimit: { average: 10, burst: 20 },
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('sets 2 middlewares');
    expect(issues[0]).toContain('forwardAuth');
    expect(issues[0]).toContain('rateLimit');
  });

  it('rejects an empty spec', () => {
    const issues = validateTraefikMiddlewareSpec({});
    expect(issues[0]).toContain('is empty');
  });

  it('rejects unknown middleware keys', () => {
    const issues = validateTraefikMiddlewareSpec({ notAMiddleware: {} });
    expect(issues.some((issue) => issue.includes('unknown key(s): notAMiddleware'))).toBe(true);
  });

  it('rejects a non-object spec', () => {
    expect(validateTraefikMiddlewareSpec(null)[0]).toContain('must be an object');
    expect(validateTraefikMiddlewareSpec([])[0]).toContain('must be an object');
    expect(validateTraefikMiddlewareSpec('forwardAuth')[0]).toContain('must be an object');
  });

  it('accepts a well-formed spec', () => {
    expect(validateTraefikMiddlewareSpec({ inFlightReq: { amount: 5 } })).toEqual([]);
  });

  it('ignores keys explicitly set to undefined', () => {
    // An optional field spread as `undefined` must not read as a second key.
    expect(
      validateTraefikMiddlewareSpec({ rateLimit: { average: 1, burst: 2 }, headers: undefined })
    ).toEqual([]);
  });

  it('throws a structured TypeKroError from the assert helper', () => {
    expect(() =>
      assertTraefikMiddlewareSpec(
        { forwardAuth: { address: 'http://authz' }, chain: { middlewares: [] } },
        'cost-api-edge'
      )
    ).toThrow('Invalid Traefik Middleware "cost-api-edge"');
  });

  it('refuses to build a Middleware whose spec sets two middlewares', () => {
    // The union makes this a compile error; the runtime check covers JavaScript
    // callers and dynamically assembled specs.
    const twoKeys = { stripPrefix: { prefixes: ['/v1'] }, addPrefix: { prefix: '/v2' } };
    const build = () =>
      traefikMiddleware({
        name: 'double',
        namespace: NAMESPACE,
        // @ts-expect-error exactly one middleware key is allowed
        spec: twoKeys,
        id: 'double',
      });

    expect(build).toThrow('sets 2 middlewares');
    try {
      build();
      throw new Error('expected traefikMiddleware to reject a two-key spec');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeKroError);
      expect((error as TypeKroError).code).toBe('TRAEFIK_MIDDLEWARE_INVALID_SPEC');
    }
  });
});

describe('Middleware builders', () => {
  it('forwardAuth defaults to trustForwardHeader: false with an explicit allowlist', () => {
    const middleware = traefikForwardAuthMiddleware({
      name: 'cost-api-authz',
      namespace: NAMESPACE,
      address: 'http://cost-api-authorizer.edge.svc.cluster.local:8080/authorize',
      authResponseHeaders: ['X-Sela-Principal', 'X-Sela-Tier', 'X-Sela-Customer'],
      authRequestHeaders: ['Authorization', 'X-Sela-Api-Key'],
      id: 'costApiAuthz',
    });

    expect(middleware.spec.forwardAuth?.trustForwardHeader).toBe(false);
    expect(middleware.spec.forwardAuth?.authResponseHeaders).toEqual([
      'X-Sela-Principal',
      'X-Sela-Tier',
      'X-Sela-Customer',
    ]);
    expect(middleware.spec.forwardAuth?.authRequestHeaders).toEqual([
      'Authorization',
      'X-Sela-Api-Key',
    ]);
    // No regex escape hatch is added implicitly — the allowlist is the contract.
    expect(middleware.spec.forwardAuth?.authResponseHeadersRegex).toBeUndefined();
  });

  it('forwardAuth only trusts forwarded headers when asked explicitly', () => {
    const middleware = traefikForwardAuthMiddleware({
      name: 'internal-authz',
      namespace: NAMESPACE,
      address: 'http://authz.edge.svc.cluster.local:8080',
      authResponseHeaders: ['X-Sela-Principal'],
      trustForwardHeader: true,
      id: 'internalAuthz',
    });

    expect(middleware.spec.forwardAuth?.trustForwardHeader).toBe(true);
  });

  it('rateLimit keys on a request header and carries the Redis backend', () => {
    const middleware = traefikRateLimitMiddleware({
      name: 'cost-api-rate-limit',
      namespace: NAMESPACE,
      average: 50,
      burst: 100,
      period: '1s',
      requestHeaderName: 'X-Sela-Principal',
      redis: {
        endpoints: ['valkey-primary.edge.svc.cluster.local:6379'],
        secret: 'valkey-auth',
        db: 3,
        dialTimeout: '500ms',
      },
      id: 'costApiRateLimit',
    });

    expect(middleware.spec.rateLimit?.average).toBe(50);
    expect(middleware.spec.rateLimit?.burst).toBe(100);
    expect(middleware.spec.rateLimit?.period).toBe('1s');
    expect(middleware.spec.rateLimit?.sourceCriterion).toEqual({
      requestHeaderName: 'X-Sela-Principal',
    });
    expect(middleware.spec.rateLimit?.redis?.endpoints).toEqual([
      'valkey-primary.edge.svc.cluster.local:6379',
    ]);
    expect(middleware.spec.rateLimit?.redis?.secret).toBe('valkey-auth');
    expect(middleware.spec.rateLimit?.redis?.db).toBe(3);
  });

  it('rateLimit defaults the period to one second and omits an unset backend', () => {
    const middleware = traefikRateLimitMiddleware({
      name: 'anon-rate-limit',
      namespace: NAMESPACE,
      average: 5,
      burst: 10,
      id: 'anonRateLimit',
    });

    expect(middleware.spec.rateLimit?.period).toBe('1s');
    expect(middleware.spec.rateLimit?.redis).toBeUndefined();
    expect(middleware.spec.rateLimit?.sourceCriterion).toBeUndefined();
  });

  it('rateLimit prefers an explicit sourceCriterion over the header shorthand', () => {
    const middleware = traefikRateLimitMiddleware({
      name: 'ip-rate-limit',
      namespace: NAMESPACE,
      average: 5,
      burst: 10,
      requestHeaderName: 'X-Ignored',
      sourceCriterion: { ipStrategy: { depth: 2 } },
      id: 'ipRateLimit',
    });

    expect(middleware.spec.rateLimit?.sourceCriterion).toEqual({ ipStrategy: { depth: 2 } });
  });

  it('inFlightReq caps concurrency per source', () => {
    const middleware = traefikInFlightReqMiddleware({
      name: 'cost-api-concurrency',
      namespace: NAMESPACE,
      amount: 20,
      requestHeaderName: 'X-Sela-Customer',
      id: 'costApiConcurrency',
    });

    expect(middleware.spec.inFlightReq?.amount).toBe(20);
    expect(middleware.spec.inFlightReq?.sourceCriterion).toEqual({
      requestHeaderName: 'X-Sela-Customer',
    });
  });

  it('headers carries the CORS and security header set verbatim', () => {
    const middleware = traefikHeadersMiddleware({
      name: 'cost-api-headers',
      namespace: NAMESPACE,
      headers: {
        accessControlAllowOriginList: ['https://console.example.com'],
        accessControlAllowMethods: ['GET', 'POST', 'OPTIONS'],
        accessControlAllowHeaders: ['authorization', 'content-type'],
        accessControlAllowCredentials: true,
        accessControlMaxAge: 600,
        addVaryHeader: true,
        frameDeny: true,
        contentTypeNosniff: true,
        referrerPolicy: 'strict-origin-when-cross-origin',
        stsSeconds: 31_536_000,
        stsIncludeSubdomains: true,
      },
      id: 'costApiHeaders',
    });

    expect(middleware.spec.headers?.accessControlAllowOriginList).toEqual([
      'https://console.example.com',
    ]);
    expect(middleware.spec.headers?.accessControlAllowCredentials).toBe(true);
    expect(middleware.spec.headers?.stsSeconds).toBe(31_536_000);
  });

  it('redirectScheme defaults to a permanent https redirect', () => {
    const middleware = traefikRedirectSchemeMiddleware({
      name: 'https-only',
      namespace: NAMESPACE,
      id: 'httpsOnly',
    });

    expect(middleware.spec.redirectScheme?.scheme).toBe('https');
    expect(middleware.spec.redirectScheme?.permanent).toBe(true);
    expect(middleware.spec.redirectScheme?.port).toBeUndefined();
  });

  it('buffering carries the body limits', () => {
    const middleware = traefikBufferingMiddleware({
      name: 'cost-api-body-limit',
      namespace: NAMESPACE,
      buffering: { maxRequestBodyBytes: 1_048_576, memRequestBodyBytes: 262_144 },
      id: 'costApiBodyLimit',
    });

    expect(middleware.spec.buffering?.maxRequestBodyBytes).toBe(1_048_576);
    expect(middleware.spec.buffering?.memRequestBodyBytes).toBe(262_144);
  });

  it('chain preserves middleware order', () => {
    const middleware = traefikChainMiddleware({
      name: 'cost-api-edge',
      namespace: NAMESPACE,
      middlewares: [
        { name: 'cost-api-headers' },
        { name: 'cost-api-authz' },
        { name: 'cost-api-rate-limit' },
      ],
      id: 'costApiEdgeChain',
    });

    expect(middleware.spec.chain?.middlewares.map((entry) => entry.name)).toEqual([
      'cost-api-headers',
      'cost-api-authz',
      'cost-api-rate-limit',
    ]);
  });
});
