import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import {
  createBunCompatibleCustomObjectsApi,
} from '../../../src/core/kubernetes/index.js';
import { makeEnvoyAIGateway } from '../../../src/factories/envoy-ai-gateway/index.js';
import {
  captureTestNamespaceLease,
  createAppsV1ApiClient,
  createCoreV1ApiClient,
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  deleteTestResourceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  type ResourceIdentity,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true'
    ? describe
    : describe.skip;
const runId = crypto.randomUUID().slice(0, 8);
const requestedMode = process.env.TYPEKRO_AI_GATEWAY_MODE;
if (
  requestedMode !== undefined &&
  requestedMode !== 'kro' &&
  requestedMode !== 'direct'
) {
  throw new Error(
    'TYPEKRO_AI_GATEWAY_MODE must be either "kro" or "direct".',
  );
}
const liveModes =
  requestedMode === undefined
    ? (['kro', 'direct'] as const)
    : ([requestedMode] as const);

setDefaultTimeout(1_500_000);

const MOCK_SERVER = `
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        response = {
            "id": "typekro-live",
            "object": "chat.completion",
            "created": 1,
            "model": body.get("model", "unknown"),
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "hello from the TypeKro Envoy AI Gateway"
                },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 3,
                "completion_tokens": 7,
                "total_tokens": 10
            }
        }
        payload = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        pass

HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
`;

async function installMockProvider(
  namespace: string,
  kubeConfig: k8s.KubeConfig,
): Promise<readonly ResourceIdentity[]> {
  const appsApi = createAppsV1ApiClient(kubeConfig);
  const coreApi = createCoreV1ApiClient(kubeConfig);
  await appsApi.createNamespacedDeployment({
    namespace,
    body: {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'mock-openai',
        labels: { 'typekro.dev/integration-test': 'owned' },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'mock-openai' } },
        template: {
          metadata: { labels: { app: 'mock-openai' } },
          spec: {
            containers: [
              {
                name: 'server',
                image: 'python:3.12-alpine',
                command: ['python', '-u', '-c', MOCK_SERVER],
                ports: [{ name: 'http', containerPort: 8080 }],
                readinessProbe: {
                  tcpSocket: { port: 8080 },
                  periodSeconds: 2,
                },
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
  const service = await coreApi.createNamespacedService({
    namespace,
    body: {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'mock-openai',
        labels: { 'typekro.dev/integration-test': 'owned' },
      },
      spec: {
        selector: { app: 'mock-openai' },
        ports: [{ name: 'http', port: 8080, targetPort: 8080 }],
      },
    },
  });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const deployment = await appsApi.readNamespacedDeployment({
      namespace,
      name: 'mock-openai',
    });
    if (
      deployment.status?.observedGeneration === deployment.metadata?.generation &&
      deployment.status?.readyReplicas === 1
    ) {
      const deploymentUid = deployment.metadata?.uid;
      const serviceUid = service.metadata?.uid;
      if (!deploymentUid || !serviceUid) {
        throw new Error(`Mock provider resources in ${namespace} have no metadata.uid`);
      }
      return [
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { namespace, name: 'mock-openai', uid: deploymentUid },
        },
        {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: { namespace, name: 'mock-openai', uid: serviceUid },
        },
      ];
    }
    await Bun.sleep(2_000);
  }
  throw new Error(`Timed out waiting for mock provider in ${namespace}`);
}

async function waitForPodCompletion(
  namespace: string,
  name: string,
  kubeConfig: k8s.KubeConfig,
): Promise<void> {
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const pod = await coreApi.readNamespacedPod({ namespace, name });
    if (pod.status?.phase === 'Succeeded') return;
    if (pod.status?.phase === 'Failed') {
      const logs = await coreApi
        .readNamespacedPodLog({ namespace, name, container: 'probe' })
        .catch(() => '');
      throw new Error(`Envoy AI Gateway probe ${namespace}/${name} failed: ${logs}`);
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Timed out waiting for probe ${namespace}/${name}`);
}

async function probeGateway(
  namespace: string,
  name: string,
  endpoint: string,
  kubeConfig: k8s.KubeConfig,
): Promise<string> {
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const pod = await coreApi.createNamespacedPod({
    namespace,
    body: {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name },
      spec: {
        restartPolicy: 'Never',
        containers: [
          {
            name: 'probe',
            image: 'curlimages/curl:8.17.0',
            command: [
              'sh',
              '-ec',
              `for attempt in $(seq 1 60); do ` +
                `if curl --fail --silent --max-time 10 ` +
                `-H 'content-type: application/json' ` +
                `--data '{"model":"fast","messages":[{"role":"user","content":"hello"}]}' ` +
                `${endpoint}/v1/chat/completions; then exit 0; fi; ` +
                `sleep 2; ` +
                `done; ` +
                `echo 'gateway did not become request-ready after 120 seconds' >&2; exit 1`,
            ],
          },
        ],
      },
    },
  });
  const uid = pod.metadata?.uid;
  if (!uid) throw new Error(`Probe ${namespace}/${name} has no metadata.uid`);
  try {
    await waitForPodCompletion(namespace, name, kubeConfig);
    return await coreApi.readNamespacedPodLog({
      namespace,
      name,
      container: 'probe',
    });
  } finally {
    await deleteTestResourceAndWait(
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { namespace, name, uid },
      },
      kubeConfig,
    );
  }
}

describeOrSkip('Envoy AI Gateway direct and KRO lifecycle', () => {
  const mockNamespace = `typekro-ai-mock-${runId}`;
  const mockHostname = `mock-openai.${mockNamespace}.svc.cluster.local`;
  const kubeConfig = getIntegrationTestKubeConfig();
  let mockLease: TestNamespaceLease;
  let mockResources: readonly ResourceIdentity[] = [];

  beforeAll(async () => {
    mockLease = await createTestNamespace(mockNamespace, kubeConfig);
    mockResources = await installMockProvider(mockNamespace, kubeConfig);
  });

  afterAll(async () => {
    if (mockLease) {
      for (const resource of mockResources) {
        await deleteTestResourceAndWait(resource, kubeConfig);
      }
      await deleteTestNamespaceAndWait(mockLease, kubeConfig);
    }
  });

  test('deploys, updates, routes real requests, and deletes in KRO and direct modes', async () => {
    for (const mode of liveModes) {
      const controlNamespace = `typekro-ai-${mode}-control-${runId}`;
      const gatewayNamespace = `typekro-ai-${mode}-${runId}`;
      const controlLease = await createTestNamespace(controlNamespace, kubeConfig);
      const gateway = makeEnvoyAIGateway({
        profile: 'development',
        platform: {
          profile: 'development',
        },
        providers: [
          {
            name: 'local',
            kind: 'openai-compatible',
            hostname: mockHostname,
            port: 8080,
            tls: false,
          },
        ],
        models: [
          {
            model: 'fast',
            targets: [{ provider: 'local', model: 'mock-fast' }],
          },
        ],
      });
      const factory = gateway.factory(mode, {
        namespace: controlNamespace,
        waitForReady: true,
        timeout: 1_200_000,
        kubeConfig,
      });
      let gatewayLease: TestNamespaceLease | undefined;
      let testError: unknown;
      try {
        const deployed = await factory.deploy({
          name: `${mode}-gateway`,
          namespace: gatewayNamespace,
          lifecycle: 'owned',
          listenerPort: 8080,
        });
        gatewayLease = await captureTestNamespaceLease(gatewayNamespace, kubeConfig);
        if (!gatewayLease) {
          throw new Error(`Gateway did not create owned Namespace ${gatewayNamespace}`);
        }
        expect(deployed.status).toMatchObject({
          ready: true,
          failed: false,
          phase: 'Ready',
          gatewayClassName: 'envoy-ai-gateway',
          providerCount: 1,
          acceptedProviderCount: 1,
          routeAccepted: true,
          gatewayProgrammed: true,
          aiGatewayVersion: 'v0.6.0',
        });
        expect(deployed.status.endpoint).toMatch(/^http:\/\/.+:8080$/);

        const firstResponse = JSON.parse(
          await probeGateway(
            controlNamespace,
            `${mode}-probe-1`,
            deployed.status.endpoint,
            kubeConfig,
          ),
        ) as {
          model?: string;
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { total_tokens?: number };
        };
        expect(firstResponse.model).toBe('mock-fast');
        expect(firstResponse.choices?.[0]?.message?.content).toContain(
          'TypeKro Envoy AI Gateway',
        );
        expect(firstResponse.usage?.total_tokens).toBe(10);

        const updated = await factory.deploy({
          name: `${mode}-gateway`,
          namespace: gatewayNamespace,
          lifecycle: 'owned',
          listenerPort: 8081,
        });
        expect(updated.status).toMatchObject({
          ready: true,
          failed: false,
          phase: 'Ready',
        });
        expect(updated.status.endpoint).toMatch(/^http:\/\/.+:8081$/);

        if (mode === 'kro') {
          const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
          const instanceRaw = await customApi.getNamespacedCustomObject({
            group: 'kro.run',
            version: 'v1alpha1',
            namespace: controlNamespace,
            plural: 'envoyaigateways',
            name: `${mode}-gateway`,
          });
          const instance =
            (instanceRaw as { readonly body?: Record<string, unknown> }).body ??
            instanceRaw;
          expect(Reflect.get(instance, 'status')).toMatchObject({
            ready: true,
            failed: false,
            phase: 'Ready',
            gatewayClassName: 'envoy-ai-gateway',
            providerCount: 1,
            acceptedProviderCount: 1,
            routeAccepted: true,
            gatewayProgrammed: true,
            aiGatewayVersion: 'v0.6.0',
          });
        }
      } catch (error) {
        testError = error;
        gatewayLease ??= await captureTestNamespaceLease(
          gatewayNamespace,
          kubeConfig,
        ).catch(() => undefined);
      }

      const cleanupErrors: unknown[] = [];
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        factory,
        `${mode}-gateway`,
        gatewayLease ? [gatewayLease] : [],
        kubeConfig,
        360_000,
      ).catch((error) => cleanupErrors.push(error));
      await deleteTestNamespaceAndWait(controlLease, kubeConfig).catch((error) =>
        cleanupErrors.push(error),
      );
      const errors = [...(testError ? [testError] : []), ...cleanupErrors];
      if (errors.length > 0) {
        throw new AggregateError(errors, `${mode} Envoy AI Gateway proof failed`);
      }
    }
  });
});
