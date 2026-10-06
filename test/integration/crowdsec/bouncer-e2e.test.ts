/**
 * CrowdSec in front of a Traefik route, end to end on a real cluster.
 *
 * Skips without a reachable cluster; `REQUIRE_CLUSTER_TESTS=true` fails
 * instead. Needs the TypeKro runtime (Flux source and helm controllers) and
 * outbound access to the CrowdSec and Traefik chart repositories, Docker Hub,
 * the CrowdSec hub, and plugins.traefik.io (Traefik downloads the plugin).
 *
 * What it proves:
 * 1. `makeCrowdsecBootstrap` installs LAPI, the agent DaemonSet and AppSec,
 *    and the status contract hydrates (`lapiHost`, `appsecHost`, `version`).
 * 2. Traefik loads the hash-pinned bouncer plugin, and a clean request through
 *    a route with `crowdsecBouncerMiddleware` answers 200.
 * 3. A decision added with `cscli decisions add` makes the bouncer answer 403,
 *    and deleting it restores 200.
 * 4. The agent reads Traefik's access logs: a burst of 404 probes from one
 *    client raises `crowdsecurity/http-probing`, and that client is banned.
 * 5. AppSec in-band virtual patching blocks a request for `/.env`.
 * 6. The optional NetworkPolicies let the Traefik namespace reach LAPI and
 *    AppSec, and drop other clients (kindnet enforces NetworkPolicy).
 *    The drop needs #285: before it, direct mode dropped `ingress[].from`.
 * 7. Fail-open: with LAPI and AppSec scaled to zero, requests still pass.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import {
  CROWDSEC_LAPI_PORT,
  crowdsecBouncerMiddleware,
  crowdsecTraefikPlugin,
  DEFAULT_CROWDSEC_APP_VERSION,
  DEFAULT_CROWDSEC_CHART_VERSION,
  makeCrowdsecBootstrap,
} from '../../../src/factories/crowdsec/index.js';
import { makeTraefikBootstrap } from '../../../src/factories/traefik/compositions/traefik-bootstrap.js';
import { traefikMiddleware } from '../../../src/factories/traefik/resources/middleware.js';
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

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

setDefaultTimeout(1_200_000);

const UPSTREAM = `
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        status = 200 if self.path in ("/", "/ok") else 404
        body = b"ok" if status == 200 else b"missing"
        self.send_response(status)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass

HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
`;

const BOUNCER_SECRET = { name: 'crowdsec-bouncer', key: 'api-key' };

describeOrSkip('CrowdSec bootstrap + Traefik bouncer integration', () => {
  const runId = crypto.randomUUID().slice(0, 8);
  const crowdsecNs = `crowdsec-e2e-${runId}`;
  const traefikNs = `traefik-e2e-${runId}`;
  const crowdsecName = 'crowdsec';
  const traefikName = 'traefik';
  const routeName = 'api';
  const bouncerKey = randomBytes(24).toString('hex');
  const leases: TestNamespaceLease[] = [];
  const edge = `http://${traefikName}.${traefikNs}.svc.cluster.local`;
  const lapiUrl = `http://${crowdsecName}-service.${crowdsecNs}.svc.cluster.local:${CROWDSEC_LAPI_PORT}`;

  let kubeConfig: k8s.KubeConfig;
  const deployed: {
    factory: Parameters<typeof deleteTestFactoryInstanceAndRecoverNamespaces>[0];
    name: string;
  }[] = [];
  let lapiHost = '';
  let appsecHost = '';
  let probe = 0;

  const crowdsec = makeCrowdsecBootstrap({
    name: 'crowdsec-e2e',
    kind: 'CrowdsecE2e',
    // The bouncer key Secret has to exist before LAPI starts.
    namespaceOwnership: 'external',
    acquisitions: [{ namespace: traefikNs, podName: `${traefikName}-*` }],
    bouncers: [{ name: 'traefik', keySecretRef: BOUNCER_SECRET }],
    // The probes come from pod IPs, which `crowdsecurity/whitelists` (part of
    // the base install) allowlists as private ranges. A real edge sees public IPs.
    agent: { env: [{ name: 'DISABLE_PARSERS', value: 'crowdsecurity/whitelists' }] },
    appsec: { crs: false },
    networkPolicy: { traefikNamespace: traefikNs },
  });

  const traefik = makeTraefikBootstrap({
    name: 'traefik-crowdsec-e2e',
    kind: 'TraefikCrowdsecE2e',
    namespaceOwnership: 'external',
    redirectWebToWebsecure: false,
    plugins: { crowdsec: crowdsecTraefikPlugin() },
    // Keeps the fields the CrowdSec Traefik parser reads, User-Agent included.
    accessLog: { preset: 'crowdsec' },
  });

  const route = kubernetesComposition(
    {
      name: 'crowdsec-e2e-route',
      kind: 'CrowdsecE2eRoute',
      spec: type({ namespace: 'string', lapiHost: 'string', appsecHost: 'string' }),
      status: type({ ready: 'boolean' }),
    },
    (spec) => {
      const bouncer = traefikMiddleware({
        name: 'crowdsec',
        namespace: spec.namespace,
        spec: crowdsecBouncerMiddleware({
          lapiHost: spec.lapiHost,
          appsecHost: spec.appsecHost,
          apiKeySecret: BOUNCER_SECRET,
          updateIntervalSeconds: 5,
          logLevel: 'DEBUG',
        }),
        id: 'bouncer',
      });
      const ingress = traefikIngressRoute({
        name: routeName,
        namespace: spec.namespace,
        spec: {
          entryPoints: ['web'],
          ingressClassName: 'traefik',
          routes: [
            {
              match: 'PathPrefix(`/`)',
              kind: 'Rule',
              // The bouncer runs first, before any other middleware.
              middlewares: [{ name: 'crowdsec' }],
              services: [{ name: 'upstream', port: 8080 }],
            },
          ],
        },
        id: 'route',
      });
      ingress.dependsOn(bouncer);
      return { ready: true };
    }
  );

  /** Run curl from a fresh pod and return one status code per URL. */
  async function curl(paths: string[], options: { sleepAfter?: number; tail?: string[] } = {}) {
    probe += 1;
    const lines = [
      ...paths.map((path) => `curl -s -o /dev/null -w '%{http_code}\\n' -m 10 '${edge}${path}'`),
      ...(options.sleepAfter ? [`sleep ${options.sleepAfter}`] : []),
      ...(options.tail ?? []).map(
        (path) => `curl -s -o /dev/null -w '%{http_code}\\n' -m 10 '${edge}${path}'`
      ),
    ];
    const logs = await runTestPodAndReadLogs(
      {
        name: `curl-${runId}-${probe}`,
        namespace: traefikNs,
        image: 'curlimages/curl:8.11.1',
        command: ['sh', '-c', lines.join('; ')],
        timeoutMs: 240_000,
      },
      kubeConfig
    );
    return logs.trim().split('\n');
  }

  /** Run cscli in a throwaway pod registered as a machine with the LAPI token. */
  async function cscli(commands: string[]): Promise<string> {
    probe += 1;
    const script = [
      'set -e',
      // The image keeps its config under /staging until its entrypoint runs.
      'ln -s /staging/etc/crowdsec /etc/crowdsec',
      `cscli lapi register --machine e2e-${runId}-${probe} -u ${lapiUrl} --token "$REGISTRATION_TOKEN" >/dev/null 2>&1`,
      ...commands.map((command) => `cscli ${command}`),
    ].join('\n');
    const secret = await createCoreV1ApiClient(kubeConfig).readNamespacedSecret({
      namespace: crowdsecNs,
      name: 'crowdsec-lapi-secrets',
    });
    const token = Buffer.from(secret.data?.registrationToken ?? '', 'base64').toString();
    // From the Traefik namespace: the NetworkPolicy admits it to LAPI.
    return runTestPodAndReadLogs(
      {
        name: `cscli-${runId}-${probe}`,
        namespace: traefikNs,
        image: `crowdsecurity/crowdsec:${DEFAULT_CROWDSEC_APP_VERSION}`,
        command: ['sh', '-c', script],
        env: [{ name: 'REGISTRATION_TOKEN', value: token }],
        timeoutMs: 240_000,
      },
      kubeConfig
    );
  }

  async function scale(name: string, replicas: number) {
    const appsApi = createAppsV1ApiClient(kubeConfig);
    const deadline = Date.now() + 300_000;
    let scaled = false;
    // Retried: a loaded kind node can time out a single API call.
    while (Date.now() < deadline) {
      try {
        const current = await appsApi.readNamespacedDeployment({ namespace: crowdsecNs, name });
        if (!scaled) {
          current.spec = { ...current.spec!, replicas };
          await appsApi.replaceNamespacedDeployment({ namespace: crowdsecNs, name, body: current });
          scaled = true;
        } else if (
          (current.status?.readyReplicas ?? 0) === replicas &&
          (current.status?.replicas ?? 0) === replicas
        ) {
          return;
        }
      } catch (error) {
        console.warn(`scale ${name}: ${String(error).slice(0, 120)}`);
      }
      await Bun.sleep(2_000);
    }
    throw new Error(`${name} did not reach ${replicas} replicas`);
  }

  beforeAll(async () => {
    kubeConfig = getIntegrationTestKubeConfig();
    const coreApi = createCoreV1ApiClient(kubeConfig);
    for (const namespace of [crowdsecNs, traefikNs]) {
      leases.push(await createTestNamespace(namespace, kubeConfig));
      // The same key in both namespaces: LAPI registers it, the Middleware reads it.
      await coreApi.createNamespacedSecret({
        namespace,
        body: {
          metadata: { name: BOUNCER_SECRET.name },
          stringData: { [BOUNCER_SECRET.key]: bouncerKey },
        },
      });
    }
    const appsApi = createAppsV1ApiClient(kubeConfig);
    await appsApi.createNamespacedDeployment({
      namespace: traefikNs,
      body: {
        metadata: { name: 'upstream' },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: 'upstream' } },
          template: {
            metadata: { labels: { app: 'upstream' } },
            spec: {
              containers: [
                {
                  name: 'server',
                  image: 'python:3.12-alpine',
                  command: ['python', '-u', '-c', UPSTREAM],
                  ports: [{ containerPort: 8080 }],
                  readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 2 },
                  resources: { requests: { cpu: '10m', memory: '32Mi' } },
                },
              ],
            },
          },
        },
      },
    });
    await coreApi.createNamespacedService({
      namespace: traefikNs,
      body: {
        metadata: { name: 'upstream' },
        spec: { selector: { app: 'upstream' }, ports: [{ port: 8080, targetPort: 8080 }] },
      },
    });
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const { factory, name } of deployed.reverse()) {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        factory,
        name,
        [],
        kubeConfig,
        300_000
      ).catch((error) => errors.push(error));
    }
    for (const lease of leases) {
      await deleteTestNamespaceAndWait(lease, kubeConfig, 300_000).catch((error) =>
        errors.push(error)
      );
    }
    if (errors.length > 0) throw new AggregateError(errors, 'CrowdSec integration cleanup failed');
  });

  it('installs CrowdSec and hydrates the status contract', async () => {
    const factory = crowdsec.factory('direct', {
      namespace: 'flux-system',
      waitForReady: true,
      timeout: 1_200_000,
      kubeConfig,
    });
    const instance = await factory.deploy({ name: crowdsecName, namespace: crowdsecNs });
    deployed.push({ factory, name: crowdsecName });

    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.version).toBe(DEFAULT_CROWDSEC_CHART_VERSION);
    lapiHost = instance.status.lapiHost;
    appsecHost = instance.status.appsecHost;
    expect(lapiHost).toBe(`${crowdsecName}-service.${crowdsecNs}.svc.cluster.local:8080`);
    expect(appsecHost).toBe(`${crowdsecName}-appsec-service.${crowdsecNs}.svc.cluster.local:7422`);

    const pods = await createCoreV1ApiClient(kubeConfig).listNamespacedPod({
      namespace: crowdsecNs,
    });
    const running = pods.items.filter(
      (pod) =>
        pod.status?.phase === 'Running' &&
        (pod.status.containerStatuses ?? []).every((status) => status.ready)
    );
    const types = running.map((pod) => pod.metadata?.labels?.type).sort();
    expect(types).toEqual(['agent', 'appsec', 'lapi']);
    for (const pod of running) {
      for (const container of pod.spec?.containers ?? []) {
        expect(container.resources?.requests?.cpu).toBeString();
        expect(container.resources?.requests?.memory).toBeString();
      }
    }
  });

  it('registers the bouncer from its Secret', async () => {
    const coreApi = createCoreV1ApiClient(kubeConfig);
    const pods = await coreApi.listNamespacedPod({
      namespace: crowdsecNs,
      labelSelector: 'type=lapi',
    });
    const name = pods.items[0]?.metadata?.name;
    expect(name).toBeString();
    const logs = await coreApi.readNamespacedPodLog({ namespace: crowdsecNs, name: name! });
    // Printed by the chart's start script for each BOUNCER_KEY_<name> env var.
    expect(logs).toContain('Registered bouncer for traefik');
  });

  it('loads the hash-pinned plugin into Traefik and lets clean traffic through', async () => {
    const factory = traefik.factory('direct', {
      namespace: 'flux-system',
      waitForReady: true,
      timeout: 900_000,
      kubeConfig,
    });
    await factory.deploy({
      name: traefikName,
      namespace: traefikNs,
      replicas: 1,
      service: { type: 'ClusterIP' },
      providers: { crd: true },
      accessLogs: true,
    });
    deployed.push({ factory, name: traefikName });

    const routeFactory = route.factory('direct', {
      namespace: traefikNs,
      waitForReady: true,
      timeout: 300_000,
      kubeConfig,
    });
    await routeFactory.deploy({ namespace: traefikNs, lapiHost, appsecHost });
    deployed.push({ factory: routeFactory, name: routeName });

    // Traefik may take a moment to pick up the route and load the plugin.
    let codes: string[] = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      codes = await curl(['/ok']);
      if (codes[0] === '200') break;
      await Bun.sleep(5_000);
    }
    expect(codes).toEqual(['200']);
  });

  it('bans a client after a cscli decision, and lets it back after deletion', async () => {
    // One pod polls the route for two minutes while the decision is added for
    // its own IP and then deleted. (The plugin's stream cache is keyed by
    // decision value, so a range decision would never match an IP.)
    probe += 1;
    const name = `poll-${runId}-${probe}`;
    const polling = runTestPodAndReadLogs(
      {
        name,
        namespace: traefikNs,
        image: 'curlimages/curl:8.11.1',
        command: [
          'sh',
          '-c',
          `for i in $(seq 1 40); do curl -s -o /dev/null -w '%{http_code}\\n' -m 5 '${edge}/ok'; sleep 3; done`,
        ],
        timeoutMs: 300_000,
      },
      kubeConfig
    );
    const coreApi = createCoreV1ApiClient(kubeConfig);
    let ip: string | undefined;
    for (let attempt = 0; attempt < 60 && !ip; attempt++) {
      await Bun.sleep(1_000);
      ip = await coreApi
        .readNamespacedPod({ namespace: traefikNs, name })
        .then((pod) => pod.status?.podIP)
        .catch(() => undefined);
    }
    expect(ip).toBeString();

    await cscli([`decisions add --ip ${ip} --duration 10m --reason e2e --type ban`]);
    await Bun.sleep(30_000);
    await cscli([`decisions delete --ip ${ip}`]);

    const codes = (await polling).trim().split('\n');
    const firstBan = codes.indexOf('403');
    const lastBan = codes.lastIndexOf('403');
    expect(codes[0]).toBe('200');
    expect(firstBan).toBeGreaterThan(0);
    // Banned for the whole window, then let back in.
    expect(codes.slice(firstBan, lastBan + 1).every((code) => code === '403')).toBe(true);
    expect(codes.at(-1)).toBe('200');
  });

  it('reads Traefik access logs and bans a probing client', async () => {
    const probes = Array.from({ length: 25 }, (_, index) => `/probe-${runId}-${index}`);
    // Same pod: probe, wait for the agent, LAPI and one bouncer pull, then retry.
    const codes = await curl(probes, { sleepAfter: 40, tail: ['/ok'] });
    expect(codes.slice(0, 5)).toEqual(['404', '404', '404', '404', '404']);
    expect(codes.at(-1)).toBe('403');

    const out = await cscli(['decisions list -o json']);
    const decisions = JSON.parse(out.slice(out.indexOf('['))) as {
      scenario?: string;
      decisions?: { scenario?: string }[];
    }[];
    const scenarios = decisions.flatMap((alert) => [
      alert.scenario,
      ...(alert.decisions ?? []).map((decision) => decision.scenario),
    ]);
    expect(scenarios).toContain('crowdsecurity/http-probing');
  });

  it('blocks a virtual-patching match in-band through AppSec', async () => {
    expect(await curl(['/.env'])).toEqual(['403']);
  });

  it('admits the Traefik namespace to LAPI and AppSec and drops other clients', async () => {
    const probeFrom = async (namespace: string) => {
      probe += 1;
      const logs = await runTestPodAndReadLogs(
        {
          name: `netpol-${runId}-${probe}`,
          namespace,
          image: 'curlimages/curl:8.11.1',
          command: [
            'sh',
            '-c',
            [`http://${lapiHost}/health`, `http://${appsecHost}/`]
              .map((url) => `curl -s -o /dev/null -w '%{http_code}\\n' -m 5 '${url}' || true`)
              .join('; '),
          ],
          timeoutMs: 120_000,
        },
        kubeConfig
      );
      return logs.trim().split('\n');
    };
    const [lapiAllowed, appsecAllowed] = await probeFrom(traefikNs);
    // Any HTTP answer proves the connection was admitted.
    expect(lapiAllowed).toBe('200');
    expect(appsecAllowed).not.toBe('000');
    // An unlabelled pod next to CrowdSec is neither an agent nor AppSec.
    expect(await probeFrom(crowdsecNs)).toEqual(['000', '000']);
  });

  it('fails open while LAPI and AppSec are down', async () => {
    await scale(`${crowdsecName}-lapi`, 0);
    await scale(`${crowdsecName}-appsec`, 0);
    let codes: string[] = [];
    try {
      // Long enough for several failed decision pulls.
      await Bun.sleep(20_000);
      codes = await curl(['/ok']);
    } finally {
      // LAPI first: the AppSec pods wait for it before they start.
      await scale(`${crowdsecName}-lapi`, 1);
      await scale(`${crowdsecName}-appsec`, 1);
    }
    expect(codes).toEqual(['200']);
  });
});
