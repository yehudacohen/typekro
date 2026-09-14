/**
 * Traefik export surface — every symbol #171-#178 promise is reachable from
 * both the focused entrypoint and the umbrella factories namespace.
 */
import { describe, expect, test } from 'bun:test';

import * as factories from '../../../src/factories/index.js';
import * as traefik from '../../../src/factories/traefik/index.js';

describe('Traefik exports', () => {
  test('exports the compositions from the focused entrypoint', () => {
    expect(traefik.traefikBootstrap).toBeDefined();
    expect(traefik.makeTraefikBootstrap).toBeTypeOf('function');
    expect(traefik.traefikHelmRepositoryBootstrap).toBeDefined();
  });

  test('exports the Helm resources', () => {
    expect(traefik.traefikHelmRepository).toBeTypeOf('function');
    expect(traefik.traefikHelmRelease).toBeTypeOf('function');
    expect(traefik.traefikHelmReleaseReadinessEvaluator).toBeTypeOf('function');
  });

  test('exports every typed CRD factory', () => {
    expect(traefik.traefikIngressRoute).toBeTypeOf('function');
    expect(traefik.traefikIngressRouteTCP).toBeTypeOf('function');
    expect(traefik.traefikService).toBeTypeOf('function');
    expect(traefik.traefikServersTransport).toBeTypeOf('function');
    expect(traefik.traefikMiddleware).toBeTypeOf('function');
    expect(traefik.traefikTLSOption).toBeTypeOf('function');
    expect(traefik.traefikTLSStore).toBeTypeOf('function');
  });

  test('exports a typed builder for every middleware the orders-api edge needs', () => {
    // The consumer scenario from a downstream consumer must be
    // expressible with exported functions only — no hand-written CRD literals.
    expect(traefik.traefikForwardAuthMiddleware).toBeTypeOf('function');
    expect(traefik.traefikRateLimitMiddleware).toBeTypeOf('function');
    expect(traefik.traefikInFlightReqMiddleware).toBeTypeOf('function');
    expect(traefik.traefikHeadersMiddleware).toBeTypeOf('function');
    expect(traefik.traefikRedirectSchemeMiddleware).toBeTypeOf('function');
    expect(traefik.traefikBufferingMiddleware).toBeTypeOf('function');
    expect(traefik.traefikChainMiddleware).toBeTypeOf('function');
  });

  test('exports the Gateway API wrappers pinned to Traefik controller', () => {
    expect(traefik.traefikGatewayClass).toBeTypeOf('function');
    expect(traefik.traefikGateway).toBeTypeOf('function');
    expect(traefik.traefikHTTPRoute).toBeTypeOf('function');
    expect(traefik.traefikGRPCRoute).toBeTypeOf('function');
    expect(traefik.traefikMiddlewareFilter).toBeTypeOf('function');
    expect(traefik.TRAEFIK_GATEWAY_CONTROLLER_NAME).toBe('traefik.io/gateway-controller');
  });

  test('exports the values mapper, validators and pinned constants', () => {
    expect(traefik.mapTraefikConfigToHelmValues).toBeTypeOf('function');
    expect(traefik.validateTraefikHelmValues).toBeTypeOf('function');
    expect(traefik.validateTraefikMiddlewareSpec).toBeTypeOf('function');
    expect(traefik.assertTraefikMiddlewareSpec).toBeTypeOf('function');
    expect(traefik.applyTraefikSecurityPins).toBeTypeOf('function');
    expect(traefik.TRAEFIK_API_VERSION).toBe('traefik.io/v1alpha1');
    expect(traefik.DEFAULT_TRAEFIK_CHART_VERSION).toBe('41.5.0');
    expect(traefik.DEFAULT_TRAEFIK_APP_VERSION).toBe('v3.7.13');
    expect(traefik.DEFAULT_TRAEFIK_REPOSITORY_URL).toBe('https://traefik.github.io/charts');
    expect(traefik.DEFAULT_TRAEFIK_NAMESPACE).toBe('traefik');
  });

  test('exports the arktype schemas so consumers can validate specs', () => {
    expect(traefik.TraefikBootstrapConfigSchema).toBeDefined();
    expect(traefik.TraefikBootstrapStatusSchema).toBeDefined();
    expect(traefik.TraefikHelmRepositorySingletonSpecSchema).toBeDefined();
    expect(traefik.TraefikHelmRepositorySingletonStatusSchema).toBeDefined();
  });

  test('exports one discoverable ecosystem namespace from the umbrella entrypoint', () => {
    expect(factories.traefik.traefikBootstrap).toBe(traefik.traefikBootstrap);
    expect(factories.traefik.traefikMiddleware).toBe(traefik.traefikMiddleware);
  });

  test('lists the full OSS middleware set', () => {
    expect(traefik.TRAEFIK_MIDDLEWARE_KINDS).toContain('forwardAuth');
    expect(traefik.TRAEFIK_MIDDLEWARE_KINDS).toContain('rateLimit');
    expect(traefik.TRAEFIK_MIDDLEWARE_KINDS).toContain('inFlightReq');
    expect(traefik.TRAEFIK_MIDDLEWARE_KINDS).toContain('buffering');
    expect(traefik.TRAEFIK_MIDDLEWARE_KINDS).toContain('passTLSClientCert');
    expect(traefik.TRAEFIK_MIDDLEWARE_KINDS).toContain('plugin');
    // Deprecated aliases the CRD still carries are deliberately not offered.
    expect(traefik.TRAEFIK_MIDDLEWARE_KINDS).not.toContain('ipWhiteList');
  });
});
