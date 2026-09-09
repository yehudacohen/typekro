/**
 * Traefik Edge Example — an API edge behind Traefik
 *
 * A representative scenario for the Traefik factory:
 * one public HTTPS entrypoint in front of an internal API, where every request
 * must be authorized, budgeted, bounded and observable.
 *
 * Layer by layer:
 *
 *  1. `traefikBootstrap` — the proxy itself, behind an AWS NLB, owning the
 *     cluster-default `TLSOption`/`TLSStore` so a cert-manager `Certificate`
 *     supplies the default certificate.
 *  2. `forwardAuth` — an in-cluster authorizer that returns
 *     principal/tier/customer headers, with `trustForwardHeader: false` and an
 *     explicit response-header allowlist.
 *  3. `rateLimit` — keyed on the principal the authorizer injected, with the
 *     Redis (Valkey) backend so the budget holds across replicas.
 *  4. `inFlightReq` — a concurrency cap, because a rate limit alone still lets
 *     slow requests pile up on the upstream.
 *  5. `headers` — CORS for the console plus the browser security headers.
 *  6. `buffering` — a request-body cap.
 *  7. `ServersTransport` + entrypoint timeouts — both halves raised above
 *     Traefik's 60s default, for the long analytical queries this API serves.
 *  8. An `IngressRoute` terminating TLS from the cert-manager Secret, and an
 *     optional Gateway API `HTTPRoute` expressing the same policy.
 *
 * Everything below is built from exported factory functions — no hand-written
 * CRD literals.
 *
 * Run: `bun run build:examples` typechecks this file.
 */

import type { KubeConfig } from '@kubernetes/client-node';
import { type } from 'arktype';
import { certificate } from '../src/factories/cert-manager/resources/certificates.js';
import { makeTraefikBootstrap } from '../src/factories/traefik/compositions/traefik-bootstrap.js';
import {
  traefikBufferingMiddleware,
  traefikChainMiddleware,
  traefikForwardAuthMiddleware,
  traefikHeadersMiddleware,
  traefikInFlightReqMiddleware,
  traefikRateLimitMiddleware,
} from '../src/factories/traefik/resources/middleware.js';
import {
  traefikHTTPRoute,
  traefikMiddlewareFilter,
} from '../src/factories/traefik/resources/gateway.js';
import {
  traefikIngressRoute,
  traefikServersTransport,
} from '../src/factories/traefik/resources/routing.js';
import { Cel, kubernetesComposition } from '../src/index.js';

// =============================================================================
// 1. The edge proxy
// =============================================================================

/**
 * A bootstrap variant that owns the cluster-default TLS resources.
 *
 * Namespace lifecycle, the default TLS resources and the HTTP→HTTPS redirect
 * decide WHICH resources the graph contains, so they are build-time options
 * rather than runtime spec fields.
 */
export const costApiTraefik = makeTraefikBootstrap({
  name: 'example-edge-traefik',
  kind: 'ExampleEdgeTraefik',
  namespaceOwnership: 'owned',
  redirectWebToWebsecure: true,
  defaultTlsOption: {
    minVersion: 'VersionTLS13',
    sniStrict: true,
  },
  // Fed by the cert-manager Certificate in section 2.
  defaultTlsStore: {
    defaultCertificateSecretName: 'example-edge-wildcard-tls',
  },
});

/**
 * Deploy the proxy.
 *
 * The NLB annotations are the standard AWS Load Balancer Controller set for an
 * internet-facing, IP-target NLB. `readTimeout`/`writeTimeout` are raised past
 * the 60s default on the `websecure` entrypoint; the upstream half is raised in
 * section 4.
 */
export async function deployEdgeProxy(kubeConfig: KubeConfig) {
  const factory = costApiTraefik.factory('direct', {
    namespace: 'flux-system',
    waitForReady: true,
    timeout: 900_000,
    kubeConfig,
  });

  const edge = await factory.deploy({
    name: 'traefik',
    namespace: 'example-edge',
    replicas: 3,
    ingressClass: 'traefik',
    service: {
      type: 'LoadBalancer',
      annotations: {
        'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
        'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'ip',
        'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing',
        'service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled': 'true',
        'service.beta.kubernetes.io/aws-load-balancer-healthcheck-path': '/ping',
        'service.beta.kubernetes.io/aws-load-balancer-healthcheck-port': '9000',
      },
    },
    entrypoints: {
      web: { exposedPort: 80, expose: true },
      websecure: {
        exposedPort: 443,
        expose: true,
        // The orders API serves long analytical queries.
        readTimeout: '120s',
        writeTimeout: '120s',
        idleTimeout: '180s',
      },
    },
    providers: { crd: true, gatewayApi: true, kubernetesIngress: false },
    accessLogs: true,
    logLevel: 'INFO',
    otlp: {
      endpoint: 'otel-collector.observability.svc.cluster.local:4317',
      insecure: true,
      serviceName: 'example-edge-traefik',
    },
    dashboard: false,
  });

  // The hostname to point DNS at. Empty until the NLB is provisioned.
  return {
    hostname: edge.status.loadBalancer.hostname,
    ready: edge.status.ready,
  };
}

// =============================================================================
// 2-8. The edge policy for one API
// =============================================================================

const CostApiEdgeSpec = type({
  /** Resource-name prefix for the middlewares and the route. */
  name: 'string',
  /** Namespace holding the route, the middlewares and the upstream Service. */
  namespace: 'string',
  /** Public hostname served on the `websecure` entrypoint. */
  hostname: 'string',
  /** Upstream Service name. */
  upstreamService: 'string',
  /** Upstream Service port. */
  upstreamPort: 'number',
  /** Authorizer URL, e.g. `http://orders-authorizer.example-edge.svc.cluster.local:8080/authorize`. */
  authorizerUrl: 'string',
  /** Origin allowed to call the API from a browser. */
  consoleOrigin: 'string',
  /** Valkey endpoint backing the distributed rate limit, `host:port`. */
  valkeyEndpoint: 'string',
  /** Secret with `username` / `password` keys for Valkey. */
  valkeySecret: 'string',
  /** cert-manager `ClusterIssuer` issuing the edge certificate. */
  clusterIssuer: 'string',
  /** Sustained requests per second, per principal. */
  rateLimitAverage: 'number',
  /** Requests absorbed above the average before Traefik answers 429. */
  rateLimitBurst: 'number',
  /** Concurrent requests allowed per customer. */
  concurrency: 'number',
});

const CostApiEdgeStatus = type({
  ready: 'boolean',
  url: 'string',
  certificateSecret: 'string',
});

/**
 * The whole edge policy for the orders API.
 *
 * The middleware ORDER in the chain is the order requests traverse it: CORS
 * first so a browser preflight is answered before authorization runs,
 * authorization next so the rate limit can be keyed on an authenticated
 * principal, then the budget, the concurrency cap, and finally the body limit.
 */
export const costApiEdge = kubernetesComposition(
  {
    name: 'example-orders-api-edge',
    apiVersion: 'edge.example.dev/v1alpha1',
    kind: 'ExampleEdge',
    spec: CostApiEdgeSpec,
    status: CostApiEdgeStatus,
  },
  (spec) => {
    const certificateSecret = `${spec.name}-tls`;

    // -- 2. TLS material -----------------------------------------------------
    const cert = certificate({
      name: spec.name,
      namespace: spec.namespace,
      spec: {
        secretName: certificateSecret,
        dnsNames: [spec.hostname],
        issuerRef: { name: spec.clusterIssuer, kind: 'ClusterIssuer' },
      },
      id: 'edgeCertificate',
    });

    // -- 3. CORS and browser security headers --------------------------------
    const headers = traefikHeadersMiddleware({
      name: `${spec.name}-headers`,
      namespace: spec.namespace,
      headers: {
        accessControlAllowOriginList: [spec.consoleOrigin],
        accessControlAllowMethods: ['GET', 'POST', 'OPTIONS'],
        accessControlAllowHeaders: ['authorization', 'content-type', 'x-example-api-key'],
        accessControlAllowCredentials: true,
        accessControlMaxAge: 600,
        addVaryHeader: true,
        frameDeny: true,
        contentTypeNosniff: true,
        referrerPolicy: 'strict-origin-when-cross-origin',
        stsSeconds: 31_536_000,
        stsIncludeSubdomains: true,
        stsPreload: true,
      },
      id: 'edgeHeaders',
    });

    // -- 4. Authorization ----------------------------------------------------
    const authz = traefikForwardAuthMiddleware({
      name: `${spec.name}-authz`,
      namespace: spec.namespace,
      address: spec.authorizerUrl,
      // Only these three headers reach the upstream. The authorizer cannot
      // inject anything else, by construction.
      authResponseHeaders: ['X-Edge-Principal', 'X-Edge-Tier', 'X-Edge-Customer'],
      // Only the credential headers reach the authorizer.
      authRequestHeaders: ['Authorization', 'X-Edge-Api-Key'],
      // Default, restated because it is the load-bearing choice here: clients
      // reach this entrypoint directly from the internet, so their own
      // X-Forwarded-* must never be believed.
      trustForwardHeader: false,
      id: 'edgeAuthz',
    });

    // -- 5. Distributed rate limit ------------------------------------------
    const rateLimit = traefikRateLimitMiddleware({
      name: `${spec.name}-rate-limit`,
      namespace: spec.namespace,
      average: spec.rateLimitAverage,
      burst: spec.rateLimitBurst,
      period: '1s',
      // Keyed on the principal `forwardAuth` just injected — one budget per
      // caller rather than one per source IP.
      requestHeaderName: 'X-Edge-Principal',
      // Without this the budget would be per-replica, i.e. average x replicas.
      redis: {
        endpoints: [spec.valkeyEndpoint],
        secret: spec.valkeySecret,
        db: 3,
        dialTimeout: '500ms',
        readTimeout: '500ms',
        writeTimeout: '500ms',
      },
      id: 'edgeRateLimit',
    });

    // -- 6. Concurrency cap --------------------------------------------------
    const concurrency = traefikInFlightReqMiddleware({
      name: `${spec.name}-concurrency`,
      namespace: spec.namespace,
      amount: spec.concurrency,
      // Per customer: one tenant's slow queries must not exhaust the upstream.
      requestHeaderName: 'X-Edge-Customer',
      id: 'edgeConcurrency',
    });

    // -- 7. Request body limit ----------------------------------------------
    const bodyLimit = traefikBufferingMiddleware({
      name: `${spec.name}-body-limit`,
      namespace: spec.namespace,
      buffering: {
        maxRequestBodyBytes: 1_048_576,
        memRequestBodyBytes: 262_144,
      },
      id: 'edgeBodyLimit',
    });

    // -- The chain, in traversal order --------------------------------------
    const chain = traefikChainMiddleware({
      name: `${spec.name}-edge`,
      namespace: spec.namespace,
      middlewares: [
        { name: `${spec.name}-headers` },
        { name: `${spec.name}-authz` },
        { name: `${spec.name}-rate-limit` },
        { name: `${spec.name}-concurrency` },
        { name: `${spec.name}-body-limit` },
      ],
      id: 'edgeChain',
    });
    chain.dependsOn(headers);
    chain.dependsOn(authz);
    chain.dependsOn(rateLimit);
    chain.dependsOn(concurrency);
    chain.dependsOn(bodyLimit);

    // -- 8. Upstream transport: the other half of the timeout budget --------
    const transport = traefikServersTransport({
      name: `${spec.name}-transport`,
      namespace: spec.namespace,
      spec: {
        forwardingTimeouts: {
          dialTimeout: '5s',
          // Above Traefik's 60s default, matching the entrypoint's 120s.
          responseHeaderTimeout: '120s',
          idleConnTimeout: '150s',
        },
        maxIdleConnsPerHost: 64,
      },
      id: 'edgeTransport',
    });

    // -- The router ----------------------------------------------------------
    const route = traefikIngressRoute({
      name: spec.name,
      namespace: spec.namespace,
      spec: {
        entryPoints: ['websecure'],
        routes: [
          {
            match: Cel.template('Host(`%s`) && PathPrefix(`/v1`)', spec.hostname),
            kind: 'Rule',
            priority: 100,
            middlewares: [{ name: `${spec.name}-edge` }],
            services: [
              {
                name: spec.upstreamService,
                port: spec.upstreamPort,
                passHostHeader: true,
                serversTransport: `${spec.name}-transport`,
              },
            ],
          },
        ],
        tls: {
          secretName: certificateSecret,
          options: { name: 'default', namespace: 'example-edge' },
        },
      },
      id: 'edgeRoute',
    });
    route.dependsOn(chain);
    route.dependsOn(transport);
    route.dependsOn(cert);

    return {
      // The certificate is the last thing to become ready, and the route is
      // useless without it.
      ready: Cel.expr<boolean>(
        cert.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      url: Cel.template('https://%s/v1', spec.hostname),
      certificateSecret,
    };
  }
);

// =============================================================================
// The same policy through Gateway API
// =============================================================================

const CostApiGatewayRouteSpec = type({
  name: 'string',
  namespace: 'string',
  hostname: 'string',
  gatewayName: 'string',
  gatewayNamespace: 'string',
  upstreamService: 'string',
  upstreamPort: 'number',
});

/**
 * The Gateway API expression of the same route.
 *
 * Gateway API has no vendor-neutral `forwardAuth` or `rateLimit` filter, so the
 * Traefik middlewares from `costApiEdge` are attached through `ExtensionRef`
 * filters. Enable the provider with `providers: { gatewayApi: true }` on the
 * bootstrap spec; the middlewares themselves are unchanged.
 */
export const costApiGatewayRoute = kubernetesComposition(
  {
    name: 'example-orders-api-gateway-route',
    apiVersion: 'edge.example.dev/v1alpha1',
    kind: 'ExampleEdgeGatewayRoute',
    spec: CostApiGatewayRouteSpec,
    status: type({ ready: 'boolean', url: 'string' }),
  },
  (spec) => {
    const route = traefikHTTPRoute({
      name: spec.name,
      namespace: spec.namespace,
      spec: {
        parentRefs: [{ name: spec.gatewayName, namespace: spec.gatewayNamespace }],
        hostnames: [spec.hostname],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: '/v1' } }],
            filters: [
              traefikMiddlewareFilter(`${spec.name}-headers`),
              traefikMiddlewareFilter(`${spec.name}-authz`),
              traefikMiddlewareFilter(`${spec.name}-rate-limit`),
              traefikMiddlewareFilter(`${spec.name}-concurrency`),
            ],
            backendRefs: [{ name: spec.upstreamService, port: spec.upstreamPort }],
            timeouts: { request: '120s' },
          },
        ],
      },
      id: 'gatewayRoute',
    });

    return {
      // The route is ready once Traefik has accepted it on its parent Gateway.
      ready: Cel.expr<boolean>(
        route.status.parents,
        '.exists(p, has(p.conditions) && p.conditions.exists(c, c.type == "Accepted" && c.status == "True"))'
      ),
      url: Cel.template('https://%s/v1', spec.hostname),
    };
  }
);

// =============================================================================
// Deploying the policy
// =============================================================================

/** Deploy the edge policy for the orders API. */
export async function deployCostApiEdge(kubeConfig: KubeConfig) {
  const factory = costApiEdge.factory('direct', {
    namespace: 'example-edge',
    waitForReady: true,
    timeout: 600_000,
    kubeConfig,
  });

  return factory.deploy({
    name: 'orders-api',
    namespace: 'example-edge',
    hostname: 'cost.api.example.dev',
    upstreamService: 'orders-api',
    upstreamPort: 8080,
    authorizerUrl: 'http://orders-authorizer.example-edge.svc.cluster.local:8080/authorize',
    consoleOrigin: 'https://console.example.dev',
    valkeyEndpoint: 'valkey-primary.example-edge.svc.cluster.local:6379',
    valkeySecret: 'valkey-auth',
    clusterIssuer: 'letsencrypt-production',
    rateLimitAverage: 50,
    rateLimitBurst: 100,
    concurrency: 20,
  });
}

/** Print the KRO ResourceGraphDefinitions for both layers. */
export function printEdgeYaml(): string {
  return [costApiTraefik.toYaml(), costApiEdge.toYaml(), costApiGatewayRoute.toYaml()].join(
    '\n---\n'
  );
}
