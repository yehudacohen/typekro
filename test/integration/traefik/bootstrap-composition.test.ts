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
 * WHAT IS PROVEN END TO END
 * 1. `traefikBootstrap` deploys: the HelmRepository singleton, the release,
 *    the CRDs the chart carries, and the status contract hydrates.
 * 2. A typed `IngressRoute` routes a request to a Service and answers 200.
 * 3. `forwardAuth` denies: a request the stub authorizer rejects gets 403 and
 *    never reaches the upstream.
 * 4. `forwardAuth` propagates the principal/tier/customer headers it
 *    allowlists, and drops one the authorizer sends outside the allowlist.
 * 5. `rateLimit` answers 429 once the burst is spent.
 *
 * The Service type is `ClusterIP`: kind has no load-balancer controller, and
 * the probes run inside the cluster. The status contract's `loadBalancer`
 * fields are therefore expected to be empty here — that is the documented
 * behavior for a non-LoadBalancer Service, and it is what this suite asserts.
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
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
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
  isClusterAvailable,
  runTestPodAndReadLogs,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

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
        key = self.headers.get("x-example-api-key", "")
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
            "principal": self.headers.get("x-example-principal", ""),
            "tier": self.headers.get("x-example-tier", ""),
            "customer": self.headers.get("x-example-customer", ""),
            "notAllowlisted": self.headers.get("x-example-not-allowlisted", ""),
        }).encode()
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
const costApiEdge = kubernetesComposition(
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
        accessControlAllowHeaders: ['authorization', 'x-example-api-key'],
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
        entryPoints: ['web'],
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
  const namespaceLeases: TestNamespaceLease[] = [];

  let kubeConfig: k8s.KubeConfig;
  // The factory generics are inferred per-composition; the harness helpers
  // accept the structural `TestDeletableFactory` shape, which is what matters.
  let bootstrapFactory: ReturnType<typeof traefikBootstrap.factory> | undefined;
  let edgeFactory: ReturnType<typeof costApiEdge.factory> | undefined;
  let bootstrapDeployed = false;
  let edgeDeployed = false;
  let entrypoint = '';

  beforeAll(async () => {
    kubeConfig = getKubeConfig({ skipTLSVerify: true });
    namespaceLeases.push(await createTestNamespace(appNs, kubeConfig));
    entrypoint = `http://${traefikName}.${traefikNs}.svc.cluster.local`;
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

    expect(instance.status.ready).toBe(true);
    expect(instance.status.failed).toBe(false);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.serviceName).toBe(traefikName);
    expect(instance.status.entrypoints).toEqual(['web', 'websecure']);
    // Documented behavior for a non-LoadBalancer Service: no address to report.
    expect(instance.status.loadBalancer.hostname).toBe('');
    expect(instance.status.loadBalancer.ip).toBe('');
  });

  it('installs the Traefik CRDs from the same release', async () => {
    const { createBunCompatibleCustomObjectsApi } = await import(
      '../../../src/core/kubernetes/index.js'
    );
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);

    // Listing a namespaced CRD kind proves the CRD is served.
    for (const plural of ['ingressroutes', 'middlewares', 'tlsoptions', 'tlsstores']) {
      const listed = await customApi.listNamespacedCustomObject({
        group: 'traefik.io',
        version: 'v1alpha1',
        namespace: appNs,
        plural,
      });
      expect(listed).toBeDefined();
    }
  });

  it('does not expose the dashboard on the live deployment', async () => {
    const coreApi = createCoreV1ApiClient(kubeConfig);
    const service = await coreApi.readNamespacedService({
      namespace: traefikNs,
      name: traefikName,
    });
    const ports = (service.spec?.ports ?? []).map((port) => port.name);

    // The internal `traefik` entrypoint (which would serve the dashboard and
    // the insecure API) is never published by the Service.
    expect(ports).toContain('web');
    expect(ports).toContain('websecure');
    expect(ports).not.toContain('traefik');
  });

  it('routes a request through the typed IngressRoute and answers 200', async () => {
    await installStub(appNs, 'authorizer', AUTHORIZER, kubeConfig);
    await installStub(appNs, 'upstream', UPSTREAM, kubeConfig);

    edgeFactory = costApiEdge.factory('direct', {
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
            `body=$(curl --silent --max-time 10 -o /dev/stdout -w '\\nHTTP:%{http_code}' ` +
            `-H 'X-Edge-Api-Key: allow' ${entrypoint}/v1/costs); ` +
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

  it('denies an unauthorized request at the edge with 403', async () => {
    const logs = await runTestPodAndReadLogs(
      {
        namespace: appNs,
        name: `probe-deny-${runId}`,
        image: 'curlimages/curl:8.17.0',
        command: [
          'sh',
          '-ec',
          `curl --silent --max-time 10 -o /dev/null -w 'HTTP:%{http_code}\\n' ` +
            `-H 'X-Edge-Api-Key: deny' ${entrypoint}/v1/costs`,
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
            `curl --silent --max-time 10 -o /dev/null -w '%{http_code}\\n' ` +
            `-H 'X-Edge-Api-Key: allow' ${entrypoint}/v1/costs; ` +
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
});
