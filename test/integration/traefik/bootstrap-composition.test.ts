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
 * The distributed (Redis-backed) rate limit is NOT exercised here: a single
 * Traefik replica makes the local counter sufficient, and standing up Valkey
 * would test the Valkey factory rather than this one. The Redis wiring is
 * covered by the serialization tests.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { DEFAULT_TRAEFIK_CHART_VERSION } from '../../../src/factories/traefik/constants.js';
import { traefikBootstrap } from '../../../src/factories/traefik/compositions/traefik-bootstrap.js';
import {
  traefikForwardAuthMiddleware,
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
      providers: { crd: true },
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
      providers: { crd: true },
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
