/**
 * Traefik edge — cluster-gated integration suite (#177).
 *
 * Mirrors the `describeOrSkip` pattern used by the clickstack/envoy suites:
 * the whole suite SKIPS cleanly when no cluster is reachable. Set
 * `REQUIRE_CLUSTER_TESTS=true` to fail instead of skipping.
 *
 * LIVE-PATH PREREQUISITES (skipping without a cluster is the hard
 * requirement; a live pass needs all of these):
 * - A reachable cluster with the TypeKro runtime installed — Flux source and
 *   helm controllers, i.e. the `bun run scripts/e2e-setup.ts` environment.
 * - Outbound access to https://traefik.github.io/charts and to the
 *   `traefik`, `python:3.12-alpine` and `curlimages/curl` images.
 *
 * Its KRO-mode counterpart is `kro-lifecycle.test.ts`; the two share their
 * status, HelmRelease-values and pod-health assertions through
 * `shared-traefik-e2e.ts` so neither mode can pass on weaker evidence than
 * the other.
 *
 * WHAT IS PROVEN END TO END
 * 0. Every field the status schema declares is hydrated, the in-cluster
 *    HelmRelease carries the expected final `spec.values`, and every Traefik
 *    pod is Running with its containers ready.
 * 1. `traefikBootstrap` deploys FROM SCRATCH into an empty namespace — the
 *    reviewer's bar for #186: nothing in the graph may be read before it is
 *    applied. The HelmRepository singleton, the release, the CRDs the chart
 *    carries and the OWNED entrypoint Service all come up, and the status
 *    contract hydrates.
 * 2. The `loadBalancer` projection is exercised on the owned Service: kind has
 *    no load-balancer controller, so the suite asserts the documented empty
 *    result for `ClusterIP` and then writes an address onto the Service's
 *    status subresource and re-reads the instance to prove the CEL actually
 *    projects it.
 * 3. A typed `IngressRoute` routes a request to a Service and answers 200.
 * 3a. The `web` → `websecure` redirect leaves `/.well-known/acme-challenge/`
 *    to a solver route on `web` (HTTP-01), and still redirects other paths.
 * 3b. `proxyProtocol.trustedIPs`: a PROXY header from a trusted source sets
 *    the client address, the same header from an untrusted source does not,
 *    and a client's own `X-Forwarded-For` is never kept.
 * 3c. `allowEmptyServices`: a route whose Service has no endpoints answers 503.
 * 3d. The forwardAuth secure pair strips client-supplied identity headers
 *    before the authorizer sees them; bare forwardAuth does not. An alias
 *    spelling (`X_Edge_Principal`) is deleted at the entrypoint.
 * 3e. A Redis-backed rate limit answers 500 while Valkey is down and recovers
 *    when it returns.
 * 4. `forwardAuth` denies: a request the stub authorizer rejects gets 403 and
 *    never reaches the upstream.
 * 5. `forwardAuth` propagates the principal/tier/customer headers it
 *    allowlists, and drops one the authorizer sends outside the allowlist.
 * 6. `rateLimit` answers 429 once the burst is spent.
 *
 * The Service type is `ClusterIP`: kind has no load-balancer controller, and a
 * `LoadBalancer` Service is now part of the graph, so `waitForReady` would
 * block on an address no controller is going to assign.
 *
 * The distributed (Redis-backed) rate limit is exercised only for its failure
 * mode, against a plain Valkey Deployment: a single Traefik replica cannot
 * show the shared budget itself.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { DEFAULT_TRAEFIK_CHART_VERSION } from '../../../src/factories/traefik/constants.js';
import { traefikBootstrap } from '../../../src/factories/traefik/compositions/traefik-bootstrap.js';
import {
  traefikForwardAuthMiddleware,
  traefikForwardAuthSecurePair,
  traefikHeadersMiddleware,
  traefikInFlightReqMiddleware,
  traefikRateLimitMiddleware,
} from '../../../src/factories/traefik/resources/middleware.js';
import { traefikIngressRoute } from '../../../src/factories/traefik/resources/routing.js';
import {
  createAppsV1ApiClient,
  createCoreV1ApiClient,
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  runTestPodAndReadLogs,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';
import {
  assertTraefikHelmReleaseValues,
  assertTraefikPodsHealthy,
  assertTraefikStatusContract,
  readHelmRelease,
} from './shared-traefik-e2e.js';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

setDefaultTimeout(1_200_000);

/**
 * Stub authorizer.
 *
 * Allows `X-Edge-Api-Key: allow` and answers 403 otherwise. On success it
 * returns the three headers the edge allowlists plus one it does not, so the
 * suite can prove the allowlist is an allowlist.
 */
const AUTHORIZER = `
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        key = self.headers.get("x-edge-api-key", "")
        # A client-supplied identity header reaching the authorizer is the
        # spoof the forwardAuth secure pair exists to prevent.
        if self.headers.get("x-edge-principal") is not None:
            body = b"spoofed-principal-seen"
            self.send_response(403)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if key == "allow-partial":
            self.send_response(200)
            self.send_header("X-Edge-Principal", "svc-partial")
            self.send_header("content-length", "0")
            self.end_headers()
            return
        if key == "allow":
            self.send_response(200)
            self.send_header("X-Edge-Principal", "svc-integration")
            self.send_header("X-Edge-Tier", "gold")
            self.send_header("X-Edge-Customer", "acme")
            self.send_header("X-Edge-Not-Allowlisted", "leaked")
            self.send_header("content-length", "0")
            self.end_headers()
            return
        body = b"denied"
        self.send_response(403)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass

HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
`;

/** Upstream echo service: reports back the headers the edge injected. */
const UPSTREAM = `
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        payload = json.dumps({
            "path": self.path,
            "principal": self.headers.get("x-edge-principal", ""),
            "tier": self.headers.get("x-edge-tier", ""),
            "customer": self.headers.get("x-edge-customer", ""),
            "notAllowlisted": self.headers.get("x-edge-not-allowlisted", ""),
            "forwardedFor": self.headers.get("x-forwarded-for", ""),
            "aliasPrincipal": self.headers.get("x_edge_principal", ""),
        }, separators=(",", ":")).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        pass

HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
`;

/** The edge policy for one API, expressed only with exported factories. */
const ordersApiEdge = kubernetesComposition(
  {
    name: 'traefik-e2e-edge',
    kind: 'TraefikE2eEdge',
    spec: type({
      name: 'string',
      namespace: 'string',
      authorizerUrl: 'string',
      upstreamService: 'string',
      redisEndpoint: 'string',
    }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    const headers = traefikHeadersMiddleware({
      name: `${spec.name}-headers`,
      namespace: spec.namespace,
      headers: {
        accessControlAllowOriginList: ['https://console.example.test'],
        accessControlAllowMethods: ['GET', 'OPTIONS'],
        accessControlAllowHeaders: ['authorization', 'x-edge-api-key'],
        accessControlMaxAge: 600,
        addVaryHeader: true,
        frameDeny: true,
        contentTypeNosniff: true,
      },
      id: 'edgeHeaders',
    });

    const authz = traefikForwardAuthMiddleware({
      name: `${spec.name}-authz`,
      namespace: spec.namespace,
      address: spec.authorizerUrl,
      authResponseHeaders: ['X-Edge-Principal', 'X-Edge-Tier', 'X-Edge-Customer'],
      authRequestHeaders: ['X-Edge-Api-Key'],
      id: 'edgeAuthz',
    });

    const rateLimit = traefikRateLimitMiddleware({
      name: `${spec.name}-rate-limit`,
      namespace: spec.namespace,
      average: 1,
      burst: 2,
      period: '1m',
      requestHeaderName: 'X-Edge-Principal',
      id: 'edgeRateLimit',
    });

    const concurrency = traefikInFlightReqMiddleware({
      name: `${spec.name}-concurrency`,
      namespace: spec.namespace,
      amount: 50,
      id: 'edgeConcurrency',
    });

    const route = traefikIngressRoute({
      name: spec.name,
      namespace: spec.namespace,
      spec: {
        // `websecure`: the default composition redirects `web` permanently to
        // `websecure`, so a functional probe has to speak TLS. No `secretName`
        // — Traefik serves its built-in self-signed certificate, which the
        // probes accept with `curl -k`.
        entryPoints: ['websecure'],
        tls: {},
        // REQUIRED. The bootstrap sets `providers.kubernetesCRD.ingressClass`,
        // and Traefik then processes only the CRDs whose class matches — an
        // IngressRoute without it is silently ignored and the edge answers 404.
        // That is what scopes a route to one of several Traefik installations.
        ingressClassName: 'traefik',
        routes: [
          {
            match: 'PathPrefix(`/v1`)',
            kind: 'Rule',
            middlewares: [
              { name: `${spec.name}-headers` },
              { name: `${spec.name}-authz` },
              { name: `${spec.name}-rate-limit` },
              { name: `${spec.name}-concurrency` },
            ],
            services: [{ name: spec.upstreamService, port: 8080 }],
          },
        ],
      },
      id: 'edgeRoute',
    });
    route.dependsOn(headers);
    route.dependsOn(authz);
    route.dependsOn(rateLimit);
    route.dependsOn(concurrency);

    // Stands in for the route cert-manager's HTTP-01 solver creates: a router
    // on the plain-HTTP `web` entrypoint matching the challenge prefix. The
    // redirect on `web` must leave exactly this prefix alone.
    traefikIngressRoute({
      name: `${spec.name}-acme-solver`,
      namespace: spec.namespace,
      spec: {
        entryPoints: ['web'],
        ingressClassName: 'traefik',
        routes: [
          {
            match: 'PathPrefix(`/.well-known/acme-challenge/`)',
            kind: 'Rule',
            services: [{ name: spec.upstreamService, port: 8080 }],
          },
        ],
      },
      id: 'acmeSolverRoute',
    });

    // A bare echo route on `websecure`, so the PROXY-protocol probes spend no
    // forwardAuth or rate-limit budget.
    traefikIngressRoute({
      name: `${spec.name}-echo`,
      namespace: spec.namespace,
      spec: {
        entryPoints: ['websecure'],
        tls: {},
        ingressClassName: 'traefik',
        routes: [
          {
            match: 'PathPrefix(`/echo`)',
            kind: 'Rule',
            services: [{ name: spec.upstreamService, port: 8080 }],
          },
        ],
      },
      id: 'echoRoute',
    });

    // forwardAuth WITHOUT an authRequestHeaders allowlist, so every client
    // header reaches the authorizer: once bare, once as the secure pair.
    const bareAuthz = traefikForwardAuthMiddleware({
      name: `${spec.name}-bare-authz`,
      namespace: spec.namespace,
      address: spec.authorizerUrl,
      authResponseHeaders: ['X-Edge-Principal', 'X-Edge-Tier', 'X-Edge-Customer'],
      id: 'bareAuthz',
    });
    const securePair = traefikForwardAuthSecurePair({
      name: `${spec.name}-secure-authz`,
      namespace: spec.namespace,
      address: spec.authorizerUrl,
      authResponseHeaders: ['X-Edge-Principal', 'X-Edge-Tier', 'X-Edge-Customer'],
      id: 'secureAuthz',
    });
    // A rate limit counted in Valkey, so its failure mode can be observed.
    const redisRateLimit = traefikRateLimitMiddleware({
      name: `${spec.name}-redis-rate-limit`,
      namespace: spec.namespace,
      average: 1000,
      burst: 1000,
      redis: { endpoints: [spec.redisEndpoint], dialTimeout: '1s', readTimeout: '1s' },
      id: 'redisRateLimit',
    });
    const authRoutes = traefikIngressRoute({
      name: `${spec.name}-auth-variants`,
      namespace: spec.namespace,
      spec: {
        entryPoints: ['websecure'],
        tls: {},
        ingressClassName: 'traefik',
        routes: [
          {
            match: 'PathPrefix(`/bare`)',
            kind: 'Rule',
            middlewares: [{ name: `${spec.name}-bare-authz` }],
            services: [{ name: spec.upstreamService, port: 8080 }],
          },
          {
            match: 'PathPrefix(`/secure`)',
            kind: 'Rule',
            middlewares: [{ name: `${spec.name}-secure-authz` }],
            services: [{ name: spec.upstreamService, port: 8080 }],
          },
          {
            match: 'PathPrefix(`/redis`)',
            kind: 'Rule',
            middlewares: [{ name: `${spec.name}-redis-rate-limit` }],
            services: [{ name: spec.upstreamService, port: 8080 }],
          },
        ],
      },
      id: 'authVariantRoutes',
    });
    authRoutes.dependsOn(bareAuthz);
    authRoutes.dependsOn(securePair.chain);
    authRoutes.dependsOn(redisRateLimit);

    // A route whose Service has no endpoints. With `allowEmptyServices` the
    // router stays and answers 503; without it Traefik drops the router (404).
    traefikIngressRoute({
      name: `${spec.name}-empty`,
      namespace: spec.namespace,
      spec: {
        entryPoints: ['websecure'],
        tls: {},
        ingressClassName: 'traefik',
        routes: [
          {
            match: 'PathPrefix(`/empty`)',
            kind: 'Rule',
            services: [{ name: 'no-endpoints', port: 8080 }],
          },
        ],
      },
      id: 'emptyRoute',
    });

    return { ready: true };
  }
);

async function installStub(
  namespace: string,
  name: string,
  script: string,
  kubeConfig: k8s.KubeConfig
): Promise<void> {
  const appsApi = createAppsV1ApiClient(kubeConfig);
  const coreApi = createCoreV1ApiClient(kubeConfig);

  await appsApi.createNamespacedDeployment({
    namespace,
    body: {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, labels: { 'typekro.dev/integration-test': 'owned' } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            containers: [
              {
                name: 'server',
                image: 'python:3.12-alpine',
                command: ['python', '-u', '-c', script],
                ports: [{ name: 'http', containerPort: 8080 }],
                readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 2 },
                resources: {
                  requests: { cpu: '10m', memory: '32Mi' },
                  limits: { cpu: '250m', memory: '128Mi' },
                },
              },
            ],
          },
        },
      },
    },
  });

  await coreApi.createNamespacedService({
    namespace,
    body: {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, labels: { 'typekro.dev/integration-test': 'owned' } },
      spec: { selector: { app: name }, ports: [{ name: 'http', port: 8080, targetPort: 8080 }] },
    },
  });

  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const deployment = await appsApi.readNamespacedDeployment({ namespace, name });
    if (
      deployment.status?.observedGeneration === deployment.metadata?.generation &&
      deployment.status?.readyReplicas === 1
    ) {
      return;
    }
    await Bun.sleep(2_000);
  }
  throw new Error(`Stub ${namespace}/${name} did not become ready`);
}

/** A single Valkey for the Redis-backed rate limit. */
async function installValkey(namespace: string, kubeConfig: k8s.KubeConfig): Promise<void> {
  const appsApi = createAppsV1ApiClient(kubeConfig);
  const coreApi = createCoreV1ApiClient(kubeConfig);
  await appsApi.createNamespacedDeployment({
    namespace,
    body: {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'valkey', labels: { 'typekro.dev/integration-test': 'owned' } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'valkey' } },
        template: {
          metadata: { labels: { app: 'valkey' } },
          spec: {
            containers: [
              {
                name: 'valkey',
                image: 'valkey/valkey:8.1-alpine',
                ports: [{ name: 'redis', containerPort: 6379 }],
                readinessProbe: { tcpSocket: { port: 6379 }, periodSeconds: 2 },
                resources: {
                  requests: { cpu: '10m', memory: '32Mi' },
                  limits: { cpu: '250m', memory: '128Mi' },
                },
              },
            ],
          },
        },
      },
    },
  });
  await coreApi.createNamespacedService({
    namespace,
    body: {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'valkey', labels: { 'typekro.dev/integration-test': 'owned' } },
      spec: {
        selector: { app: 'valkey' },
        ports: [{ name: 'redis', port: 6379, targetPort: 6379 }],
      },
    },
  });
  await scaleAndWait(namespace, 'valkey', 1, kubeConfig);
}

/** Scale a Deployment and wait until exactly that many replicas are ready. */
async function scaleAndWait(
  namespace: string,
  name: string,
  replicas: number,
  kubeConfig: k8s.KubeConfig
): Promise<void> {
  const appsApi = createAppsV1ApiClient(kubeConfig);
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const current = await appsApi.readNamespacedDeployment({ namespace, name });
  if (current.spec?.replicas !== replicas) {
    await appsApi.replaceNamespacedDeployment({
      namespace,
      name,
      body: { ...current, spec: { ...current.spec, replicas } } as k8s.V1Deployment,
    });
  }
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const deployment = await appsApi.readNamespacedDeployment({ namespace, name });
    const pods = await coreApi.listNamespacedPod({ namespace, labelSelector: `app=${name}` });
    if (
      deployment.status?.observedGeneration === deployment.metadata?.generation &&
      (deployment.status?.readyReplicas ?? 0) === replicas &&
      pods.items.length === replicas
    ) {
      return;
    }
    await Bun.sleep(2_000);
  }
  throw new Error(`Deployment ${namespace}/${name} did not settle at ${replicas} replicas`);
}

describeOrSkip('Traefik bootstrap + edge policy integration', () => {
  const runId = crypto.randomUUID().slice(0, 8);
  const traefikNs = `traefik-e2e-${runId}`;
  const appNs = `traefik-e2e-app-${runId}`;
  const traefikName = 'traefik';
  const routeName = 'orders-api';
  const LOAD_BALANCER_HOSTNAME = 'edge.example.test';
  const namespaceLeases: TestNamespaceLease[] = [];

  let kubeConfig: k8s.KubeConfig;
  // The factory generics are inferred per-composition; the harness helpers
  // accept the structural `TestDeletableFactory` shape, which is what matters.
  let bootstrapFactory: ReturnType<typeof traefikBootstrap.factory> | undefined;
  let edgeFactory: ReturnType<typeof ordersApiEdge.factory> | undefined;
  let bootstrapDeployed = false;
  let edgeDeployed = false;
  /** The plain-HTTP `web` entrypoint, which redirects to `websecure`. */
  let webEntrypoint = '';
  /** The TLS `websecure` entrypoint the routes are published on. */
  let secureEntrypoint = '';
  /**
   * PROXY protocol trust for the suite. `web` trusts every in-cluster pod and
   * node range kind uses, so a probe's PROXY header is honored there.
   * `websecure` trusts only TEST-NET-1, which no pod is in, so the same header
   * is ignored there. Neither entrypoint trusts forwarded headers.
   */
  const entrypointTrust = {
    web: { proxyProtocol: { trustedIPs: ['10.0.0.0/8', '172.16.0.0/12'] } },
    websecure: { proxyProtocol: { trustedIPs: ['192.0.2.0/24'] } },
  };

  beforeAll(async () => {
    // The harness contract: cluster configuration comes from the shared
    // helper, so `bun run test:integration:required` and a focused run see the
    // same cluster.
    kubeConfig = getIntegrationTestKubeConfig();
    namespaceLeases.push(await createTestNamespace(appNs, kubeConfig));
    webEntrypoint = `http://${traefikName}.${traefikNs}.svc.cluster.local`;
    secureEntrypoint = `https://${traefikName}.${traefikNs}.svc.cluster.local`;
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    if (edgeFactory && edgeDeployed) {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        edgeFactory,
        routeName,
        [],
        kubeConfig,
        120_000
      ).catch((error) => cleanupErrors.push(error));
    }
    if (bootstrapFactory && bootstrapDeployed) {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        bootstrapFactory,
        traefikName,
        [],
        kubeConfig,
        300_000
      ).catch((error) => cleanupErrors.push(error));
    }
    for (const lease of namespaceLeases) {
      await deleteTestNamespaceAndWait(lease, kubeConfig, 180_000).catch((error) =>
        cleanupErrors.push(error)
      );
    }
    // The bootstrap OWNS its install namespace, so `deleteInstance` above
    // removes it as a graph child — the same contract the clickstack
    // direct-mode suite relies on. Only the harness-leased app namespace is
    // recovered explicitly.
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Traefik integration cleanup failed');
    }
  });

  it('deploys traefikBootstrap and hydrates the status contract', async () => {
    bootstrapFactory = traefikBootstrap.factory('direct', {
      namespace: 'flux-system',
      waitForReady: true,
      timeout: 900_000,
      kubeConfig,
    });

    const instance = await bootstrapFactory.deploy({
      name: traefikName,
      namespace: traefikNs,
      // kind has no load-balancer controller and the probes run in-cluster.
      service: { type: 'ClusterIP' },
      replicas: 1,
      entrypoints: entrypointTrust,
      providers: { crd: true, allowEmptyServices: true },
      accessLogs: true,
      dashboard: false,
    });
    bootstrapDeployed = true;

    // Every field the status schema declares, held to the same bar as KRO mode.
    // Documented behavior for a non-LoadBalancer Service: no address to report.
    assertTraefikStatusContract(instance.status, {
      serviceName: traefikName,
      chartVersion: DEFAULT_TRAEFIK_CHART_VERSION,
      loadBalancer: { hostname: '', ip: '' },
    });
  });

  it('reconciles a HelmRelease whose final values carry the pins', async () => {
    // In-cluster values, not local YAML: this is what proves the Flux handoff
    // produced the chart config the factory promises.
    const release = await readHelmRelease('flux-system', traefikName, kubeConfig);

    assertTraefikHelmReleaseValues(release, {
      instanceName: traefikName,
      targetNamespace: traefikNs,
      chartVersion: DEFAULT_TRAEFIK_CHART_VERSION,
    });
    expect(release.status?.history?.[0]?.chartVersion).toBe(DEFAULT_TRAEFIK_CHART_VERSION);
  });

  it('runs healthy pods, not merely existing ones', async () => {
    // A CrashLooping pod exists too. Direct mode applies in dependency order,
    // so the restart budget is tighter than KRO mode's.
    await assertTraefikPodsHealthy(traefikNs, traefikName, kubeConfig, { maxRestarts: 3 });
  });

  it('owns the entrypoint Service rather than letting the chart create it', async () => {
    const coreApi = createCoreV1ApiClient(kubeConfig);
    const owned = await coreApi.readNamespacedService({
      namespace: traefikNs,
      name: traefikName,
    });

    // A chart-created Service carries `app.kubernetes.io/managed-by: Helm`;
    // this one is a graph resource, so TypeKro owns it.
    expect(owned.metadata?.labels?.['app.kubernetes.io/managed-by']).toBe('typekro');
    expect(owned.spec?.selector).toEqual({
      'app.kubernetes.io/name': 'traefik',
      'app.kubernetes.io/instance': traefikName,
    });

    // Proof the selector is not merely self-consistent: it matches pods the
    // chart created AND those pods are actually serving.
    await assertTraefikPodsHealthy(traefikNs, traefikName, kubeConfig, { maxRestarts: 3 });

    // And that traffic can reach them: the Service has ready endpoints.
    const endpoints = await coreApi.readNamespacedEndpoints({
      namespace: traefikNs,
      name: traefikName,
    });
    const addresses = (endpoints.subsets ?? []).flatMap((subset) => subset.addresses ?? []);
    expect(addresses.length).toBeGreaterThan(0);
  });

  it('does not expose the dashboard on the live deployment', async () => {
    const coreApi = createCoreV1ApiClient(kubeConfig);
    const service = await coreApi.readNamespacedService({
      namespace: traefikNs,
      name: traefikName,
    });
    const ports = (service.spec?.ports ?? []).map((port) => port.name);

    // The internal `traefik` entrypoint (which would serve the dashboard and
    // the insecure API) is never published by the Service. Now that TypeKro
    // owns the Service, that port simply does not exist rather than depending
    // on a chart value.
    expect(ports).toEqual(['web', 'websecure']);
  });

  it('routes a request through the typed IngressRoute and answers 200', async () => {
    await installStub(appNs, 'authorizer', AUTHORIZER, kubeConfig);
    await installStub(appNs, 'upstream', UPSTREAM, kubeConfig);
    await installValkey(appNs, kubeConfig);
    // Selects no pods, so it never has endpoints.
    await createCoreV1ApiClient(kubeConfig).createNamespacedService({
      namespace: appNs,
      body: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'no-endpoints', labels: { 'typekro.dev/integration-test': 'owned' } },
        spec: { selector: { app: 'no-such-pod' }, ports: [{ port: 8080, targetPort: 8080 }] },
      },
    });

    edgeFactory = ordersApiEdge.factory('direct', {
      namespace: appNs,
      waitForReady: true,
      timeout: 300_000,
      kubeConfig,
    });
    await edgeFactory.deploy({
      name: routeName,
      namespace: appNs,
      authorizerUrl: `http://authorizer.${appNs}.svc.cluster.local:8080`,
      upstreamService: 'upstream',
      redisEndpoint: `valkey.${appNs}.svc.cluster.local:6379`,
    });
    edgeDeployed = true;

    const logs = await runTestPodAndReadLogs(
      {
        namespace: appNs,
        name: `probe-allow-${runId}`,
        image: 'curlimages/curl:8.17.0',
        command: [
          'sh',
          '-ec',
          `for attempt in $(seq 1 60); do ` +
            `body=$(curl --silent --insecure --max-time 10 -o /dev/stdout -w '\\nHTTP:%{http_code}' ` +
            `-H 'X-Edge-Api-Key: allow' ${secureEntrypoint}/v1/orders); ` +
            `case "$body" in *HTTP:200*) echo "$body"; exit 0;; esac; ` +
            `sleep 2; done; ` +
            `echo "edge never answered 200: $body" >&2; exit 1`,
        ],
        timeoutMs: 300_000,
      },
      kubeConfig
    );

    expect(logs).toContain('HTTP:200');
    // forwardAuth copied exactly the allowlisted headers onto the upstream
    // request — and nothing else the authorizer returned.
    expect(logs).toContain('"principal":"svc-integration"');
    expect(logs).toContain('"tier":"gold"');
    expect(logs).toContain('"customer":"acme"');
    expect(logs).toContain('"notAllowlisted":""');
  });

  it('redirects the plain-HTTP entrypoint to websecure', async () => {
    // `redirectWebToWebsecure` is on by default and is structural — the chart
    // expresses "no redirect" by OMITTING the redirection block — so this is
    // the only place the default is proven end to end.
    const logs = await runTestPodAndReadLogs(
      {
        namespace: appNs,
        name: `probe-redirect-${runId}`,
        image: 'curlimages/curl:8.17.0',
        command: [
          'sh',
          '-ec',
          `curl --silent --insecure --max-time 10 -o /dev/null ` +
            `-w 'HTTP:%{http_code} LOCATION:%{redirect_url}\\n' ` +
            `${webEntrypoint}/v1/orders`,
        ],
        timeoutMs: 180_000,
      },
      kubeConfig
    );

    expect(logs).toContain('HTTP:301');
    expect(logs).toContain('LOCATION:https://');
  });

  it('serves ACME HTTP-01 challenge paths on web instead of redirecting them', async () => {
    // The redirect router Traefik generates has priority MaxInt - 1, so before
    // `allowACMEByPass` it answered cert-manager's challenge with a 301 and
    // HTTP-01 never completed. The challenge path must reach the solver route
    // on `web`, while a sibling path on the same host is still redirected.
    const challengePath = '/.well-known/acme-challenge/e2e-token';
    const logs = await runTestPodAndReadLogs(
      {
        namespace: appNs,
        name: `probe-acme-${runId}`,
        image: 'curlimages/curl:8.17.0',
        command: [
          'sh',
          '-ec',
          `for attempt in $(seq 1 30); do ` +
            `body=$(curl --silent --max-time 10 -o /dev/stdout -w '\nHTTP:%{http_code}' ` +
            `${webEntrypoint}${challengePath}); ` +
            `case "$body" in *HTTP:200*) break;; esac; sleep 2; done; ` +
            `echo "CHALLENGE $body"; ` +
            `curl --silent --max-time 10 -o /dev/null -w 'SIBLING HTTP:%{http_code}\n' ` +
            `${webEntrypoint}/.well-known/security.txt`,
        ],
        timeoutMs: 180_000,
      },
      kubeConfig
    );

    expect(logs).toContain(`"path":"${challengePath}"`);
    expect(logs).toMatch(/CHALLENGE [\s\S]*HTTP:200/);
    expect(logs).toContain('SIBLING HTTP:301');
  });

  it('honors a PROXY header only from a trusted source, and never a client X-Forwarded-For', async () => {
    // curl's --haproxy-clientip writes the client address into a PROXY v1
    // header, which is exactly what a load balancer does. The probe pod's own
    // address is inside `web`'s trusted ranges and outside `websecure`'s.
    const spoofed = '203.0.113.7';
    const forged = '198.51.100.66';
    const logs = await runTestPodAndReadLogs(
      {
        namespace: appNs,
        name: `probe-proxy-protocol-${runId}`,
        image: 'curlimages/curl:8.17.0',
        command: [
          'sh',
          '-ec',
          `echo "WEB $(curl --silent --max-time 10 --haproxy-protocol --haproxy-clientip ${spoofed} ` +
            `-H 'X-Forwarded-For: ${forged}' ${webEntrypoint}/.well-known/acme-challenge/pp)"; ` +
            `echo "SECURE $(curl --silent --insecure --max-time 10 --haproxy-protocol ` +
            `--haproxy-clientip ${spoofed} ${secureEntrypoint}/echo)"; ` +
            `echo "SELF $(hostname -i)"`,
        ],
        timeoutMs: 180_000,
      },
      kubeConfig
    );

    const line = (prefix: string) =>
      logs.split('\n').find((entry) => entry.startsWith(`${prefix} `)) ?? '';
    const forwardedFor = (prefix: string) =>
      (JSON.parse(line(prefix).slice(prefix.length + 1)) as { forwardedFor: string }).forwardedFor;
    const self = line('SELF').slice('SELF '.length).trim();

    // Trusted: the address from the PROXY header is the client address, and
    // the client's own X-Forwarded-For is discarded rather than appended to.
    expect(forwardedFor('WEB')).toBe(spoofed);
    // Untrusted: Traefik reads past the header but keeps the real peer.
    expect(forwardedFor('SECURE')).not.toContain(spoofed);
    expect(forwardedFor('SECURE')).toBe(self);
  });

  it('answers 503 for a route whose Service has no endpoints (allowEmptyServices)', async () => {
    const logs = await runTestPodAndReadLogs(
      {
        namespace: appNs,
        name: `probe-empty-${runId}`,
        image: 'curlimages/curl:8.17.0',
        command: [
          'sh',
          '-ec',
          // A 404 means Traefik dropped the router; retry while it reconciles.
          `for attempt in $(seq 1 30); do ` +
            `code=$(curl --silent --insecure --max-time 10 -o /dev/null -w '%{http_code}' ` +
            `${secureEntrypoint}/empty); ` +
            `[ "$code" = 503 ] && break; sleep 2; done; echo "HTTP:$code"`,
        ],
        timeoutMs: 180_000,
      },
      kubeConfig
    );

    expect(logs).toContain('HTTP:503');
  });

  it('strips spoofed identity headers before forwardAuth with the secure pair', async () => {
    // The client asserts its own principal and tier. Bare forwardAuth (no
    // authRequestHeaders allowlist) forwards them to the authorizer, which
    // sees the spoof and refuses. The secure pair strips them first: the
    // authorizer sees a clean request, and the upstream sees only what the
    // authorizer returned. With `allow-partial` the authorizer returns no
    // tier, and the client's tier must not survive either.
    // `X_Edge_Principal` aliases the principal for backends that fold `_`
    // into `-`; the entrypoints' default aliasHeadersStrategy deletes it.
    const spoof =
      `-H 'X-Edge-Principal: admin' -H 'X-Edge-Tier: platinum' ` + `-H 'X_Edge_Principal: admin'`;
    const curl = (key: string, path: string) =>
      `curl --silent --insecure --max-time 10 -w ' HTTP:%{http_code}' ${spoof} ` +
      `-H 'X-Edge-Api-Key: ${key}' ${secureEntrypoint}${path}`;
    const logs = await runTestPodAndReadLogs(
      {
        namespace: appNs,
        name: `probe-secure-pair-${runId}`,
        image: 'curlimages/curl:8.17.0',
        command: [
          'sh',
          '-ec',
          `for attempt in $(seq 1 30); do ` +
            `out=$(${curl('allow', '/secure/orders')}); ` +
            `case "$out" in *HTTP:200*) break;; esac; sleep 2; done; echo "SECURE $out"; ` +
            `echo "PARTIAL $(${curl('allow-partial', '/secure/orders')})"; ` +
            `echo "BARE $(${curl('allow', '/bare/orders')})"`,
        ],
        timeoutMs: 180_000,
      },
      kubeConfig
    );

    const line = (prefix: string) =>
      logs.split('\n').find((entry) => entry.startsWith(`${prefix} `)) ?? '';
    expect(line('SECURE')).toContain('HTTP:200');
    expect(line('SECURE')).toContain('"principal":"svc-integration"');
    expect(line('SECURE')).toContain('"tier":"gold"');
    expect(line('SECURE')).toContain('"aliasPrincipal":""');
    expect(line('PARTIAL')).toContain('HTTP:200');
    expect(line('PARTIAL')).toContain('"principal":"svc-partial"');
    expect(line('PARTIAL')).toContain('"tier":""');
    expect(line('BARE')).toContain('spoofed-principal-seen');
    expect(line('BARE')).toContain('HTTP:403');
  });

  it('fails closed with 500 while the rate-limit Valkey is down, and recovers', async () => {
    // Traefik's Redis-backed limiter answers 500 "Could not insert/update
    // bucket" when it cannot reach Redis (pkg/middlewares/ratelimiter). This
    // pins that behavior: a Valkey outage is an outage of every route behind
    // the middleware, so Valkey needs the same availability as the edge.
    const probe = (label: string, want: string) =>
      runTestPodAndReadLogs(
        {
          namespace: appNs,
          name: `probe-redis-${label}-${runId}`,
          image: 'curlimages/curl:8.17.0',
          command: [
            'sh',
            '-ec',
            `for attempt in $(seq 1 45); do ` +
              `out=$(curl --silent --insecure --max-time 10 -w ' HTTP:%{http_code}' ` +
              `${secureEntrypoint}/redis/orders); ` +
              `case "$out" in *HTTP:${want}*) break;; esac; sleep 2; done; echo "$out"`,
          ],
          timeoutMs: 180_000,
        },
        kubeConfig
      );

    expect(await probe('up', '200')).toContain('HTTP:200');

    await scaleAndWait(appNs, 'valkey', 0, kubeConfig);
    const down = await probe('down', '500');
    expect(down).toContain('HTTP:500');
    expect(down).toContain('Could not insert/update bucket');

    await scaleAndWait(appNs, 'valkey', 1, kubeConfig);
    expect(await probe('back', '200')).toContain('HTTP:200');
  });

  it('denies an unauthorized request at the edge with 403', async () => {
    const logs = await runTestPodAndReadLogs(
      {
        namespace: appNs,
        name: `probe-deny-${runId}`,
        image: 'curlimages/curl:8.17.0',
        command: [
          'sh',
          '-ec',
          `curl --silent --insecure --max-time 10 -o /dev/null -w 'HTTP:%{http_code}\\n' ` +
            `-H 'X-Edge-Api-Key: deny' ${secureEntrypoint}/v1/orders`,
        ],
        timeoutMs: 180_000,
      },
      kubeConfig
    );

    expect(logs).toContain('HTTP:403');
  });

  it('answers 429 once the rate-limit burst is spent', async () => {
    const logs = await runTestPodAndReadLogs(
      {
        namespace: appNs,
        name: `probe-ratelimit-${runId}`,
        image: 'curlimages/curl:8.17.0',
        command: [
          'sh',
          '-ec',
          // average 1/min with burst 2, keyed on the principal forwardAuth
          // injects: a short burst of identical requests must be throttled.
          `for attempt in $(seq 1 20); do ` +
            `curl --silent --insecure --max-time 10 -o /dev/null -w '%{http_code}\\n' ` +
            `-H 'X-Edge-Api-Key: allow' ${secureEntrypoint}/v1/orders; ` +
            `done`,
        ],
        timeoutMs: 180_000,
      },
      kubeConfig
    );

    const codes = logs.trim().split('\n');
    expect(codes).toContain('200');
    expect(codes).toContain('429');
  });
  it('projects a load-balancer address once one is assigned', async () => {
    // The `loadBalancer` projection is the reason the entrypoint Service is a
    // graph resource at all, so it is exercised rather than assumed. kind has
    // no load-balancer controller, so the Service is switched to
    // `LoadBalancer` and the address is written onto its status subresource
    // the way a cloud controller would. (The API server REFUSES
    // `status.loadBalancer.ingress` on a `ClusterIP` Service, so the switch is
    // required, not cosmetic.) Everything else — the readiness evaluator, the
    // guarded CEL and the direct-mode status hydration that evaluates it — is
    // the real path. The empty arm of the projection is asserted on the
    // ClusterIP deployment above.
    const lbFactory = traefikBootstrap.factory('direct', {
      namespace: 'flux-system',
      waitForReady: false,
      timeout: 300_000,
      kubeConfig,
    });
    const lbSpec = {
      name: traefikName,
      namespace: traefikNs,
      service: { type: 'LoadBalancer' as const },
      replicas: 1,
      entrypoints: entrypointTrust,
      providers: { crd: true, allowEmptyServices: true },
      accessLogs: true,
      dashboard: false as const,
    };

    // First pass switches the Service to `LoadBalancer`; readiness is off
    // because nothing on kind will ever assign it an address.
    await lbFactory.deploy(lbSpec);

    const coreApi = createCoreV1ApiClient(kubeConfig);
    const current = await coreApi.readNamespacedService({
      namespace: traefikNs,
      name: traefikName,
    });
    await coreApi.replaceNamespacedServiceStatus({
      namespace: traefikNs,
      name: traefikName,
      body: {
        ...current,
        status: { loadBalancer: { ingress: [{ hostname: LOAD_BALANCER_HOSTNAME }] } },
      },
    });

    // Second pass runs WITH readiness: the Service readiness evaluator now sees
    // an address, so this also proves a LoadBalancer entrypoint Service is a
    // real participant in `waitForReady` now that the composition owns it.
    const readyFactory = traefikBootstrap.factory('direct', {
      namespace: 'flux-system',
      waitForReady: true,
      timeout: 300_000,
      kubeConfig,
    });
    const assigned = await readyFactory.deploy(lbSpec);
    // The entry carries a hostname and no ip; the guarded CEL reports the
    // absent sibling as '' rather than failing the whole status object.
    assertTraefikStatusContract(assigned.status, {
      serviceName: traefikName,
      chartVersion: DEFAULT_TRAEFIK_CHART_VERSION,
      loadBalancer: { hostname: LOAD_BALANCER_HOSTNAME, ip: '' },
    });
  });
});
