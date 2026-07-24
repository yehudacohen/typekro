/**
 * Opt-in live Valkey proof against a real cluster.
 *
 * RUN_VALKEY_INTEGRATION=true bun test test/integration/valkey/valkey-resources.test.ts
 *
 * Requires the Hyperspike v0.0.61 operator, KRO, Flux, and a default
 * ReadWriteOnce StorageClass. Every run uses a unique namespace and deletes
 * only resources it created.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { Cel } from '../../../src/core/references/cel.js';
import { isKubernetesRef } from '../../../src/utils/type-guards.js';
import { valkey } from '../../../src/factories/valkey/resources/valkey.js';
import {
  createCoreV1ApiClient,
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  deleteTestPodAndWait,
  isClusterAvailable,
  runTestPodAndReadLogs,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

const runRequested = process.env.RUN_VALKEY_INTEGRATION === 'true';
const describeOrSkip = runRequested && (await isClusterAvailable()) ? describe : describe.skip;
const runId = crypto.randomUUID().slice(0, 12);
const namespace = `tk-valkey-${runId}`.slice(0, 63);

setDefaultTimeout(900_000);

const liveValkey = kubernetesComposition(
  {
    name: 'live-valkey-cluster',
    kind: 'LiveValkeyCluster',
    spec: type({
      name: 'string',
      namespace: 'string',
      storageClassName: 'string',
    }),
    status: type({ ready: 'boolean', serviceName: 'string' }),
  },
  (spec) => {
    const cache = valkey({
      name: spec.name,
      namespace: spec.namespace,
      spec: {
        shards: 1,
        replicas: 0,
        anonymousAuth: true,
        volumePermissions: true,
        storage: {
          spec: {
            accessModes: ['ReadWriteOnce'],
            storageClassName: spec.storageClassName,
            resources: { requests: { storage: '1Gi' } },
          },
        },
      },
      id: 'cache',
    });

    return {
      ready: cache.status.ready,
      serviceName: isKubernetesRef(cache.metadata.name)
        ? Cel.expr<string>(cache.metadata.name)
        : cache.metadata.name,
    };
  }
);

async function runClient(
  name: string,
  serviceName: string,
  commands: string,
  kubeConfig: ReturnType<typeof getKubeConfig>
): Promise<string> {
  return runTestPodAndReadLogs(
    {
      name,
      namespace,
      image: 'valkey/valkey:8.1-alpine',
      command: ['sh', '-ec'],
      args: [
        `until valkey-cli -h ${serviceName} PING >/dev/null 2>&1; do sleep 2; done; ${commands}`,
      ],
      timeoutMs: 300_000,
    },
    kubeConfig
  );
}

async function restartValkeyPod(
  instanceName: string,
  kubeConfig: ReturnType<typeof getKubeConfig>
): Promise<void> {
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const pods = await coreApi.listNamespacedPod({
    namespace,
    labelSelector: `app.kubernetes.io/instance=${instanceName}`,
  });
  const pod = pods.items[0];
  const podName = pod?.metadata?.name;
  const oldUid = pod?.metadata?.uid;
  if (!podName || !oldUid) {
    throw new Error(`Could not identify the Valkey Pod for ${instanceName}`);
  }
  await deleteTestPodAndWait(namespace, podName, kubeConfig, 60_000);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 300_000) {
    const replacements = await coreApi.listNamespacedPod({
      namespace,
      labelSelector: `app.kubernetes.io/instance=${instanceName}`,
    });
    const ready = replacements.items.find(
      (candidate) =>
        candidate.metadata?.uid !== oldUid &&
        candidate.status?.conditions?.some(
          (condition) => condition.type === 'Ready' && condition.status === 'True'
        )
    );
    if (ready) return;
    await Bun.sleep(2_000);
  }
  throw new Error(`Timed out waiting for a replacement Valkey Pod for ${instanceName}`);
}

async function proveDataPlane(mode: 'direct' | 'kro', name: string): Promise<void> {
  const kubeConfig = getKubeConfig({ skipTLSVerify: true });
  const factory = liveValkey.factory(mode, {
    namespace,
    waitForReady: true,
    timeout: 600_000,
    kubeConfig,
  });

  let testError: unknown;
  try {
    const instance = await factory.deploy({
      name,
      namespace,
      storageClassName: 'local-path',
    });
    expect(instance.status.ready).toBe(true);
    expect(instance.status.serviceName).toBe(name);

    const beforeRestart = await runClient(
      `${name}-client-a`,
      name,
      [
        `test "$(valkey-cli -h ${name} SET e2e-key e2e-value)" = OK`,
        `valkey-cli -h ${name} XGROUP CREATE e2e-stream e2e-group 0 MKSTREAM >/dev/null`,
        `valkey-cli -h ${name} XADD e2e-stream "*" payload hello >/dev/null`,
        `valkey-cli -h ${name} XREADGROUP GROUP e2e-group worker COUNT 1 STREAMS e2e-stream ">" | grep -q hello`,
        `valkey-cli -h ${name} SAVE >/dev/null`,
        `valkey-cli -h ${name} CONFIG GET appendonly`,
      ].join('; '),
      kubeConfig
    );
    expect(beforeRestart).toContain('appendonly');
    expect(beforeRestart).toContain('no');

    await restartValkeyPod(name, kubeConfig);

    const recovered = await runClient(
      `${name}-client-b`,
      name,
      `test "$(valkey-cli -h ${name} GET e2e-key)" = e2e-value; valkey-cli -h ${name} XLEN e2e-stream`,
      kubeConfig
    );
    const streamLength = recovered.match(/^\d+$/m)?.[0];
    expect(Number(streamLength)).toBeGreaterThanOrEqual(1);
  } catch (error: unknown) {
    testError = error;
  }

  let cleanupError: unknown;
  try {
    await deleteTestFactoryInstanceAndRecoverNamespaces(factory, name, [], kubeConfig);
  } catch (error: unknown) {
    cleanupError = error;
  }
  const failures: unknown[] = [];
  if (testError !== undefined) failures.push(testError);
  if (cleanupError !== undefined) failures.push(cleanupError);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${mode} Valkey integration did not complete safely`);
  }
}

describeOrSkip('Valkey live direct and KRO integration', () => {
  const kubeConfig = getKubeConfig({ skipTLSVerify: true });
  let namespaceLease: TestNamespaceLease;

  beforeAll(async () => {
    namespaceLease = await createTestNamespace(namespace, kubeConfig);
  });

  afterAll(async () => {
    await deleteTestNamespaceAndWait(namespaceLease, kubeConfig);
  });

  it('executes commands and Streams and recovers an explicit RDB snapshot in direct mode', async () => {
    await proveDataPlane('direct', 'direct-cache');
  });

  it('projects readiness and executes the same data-plane proof in KRO mode', async () => {
    await proveDataPlane('kro', 'kro-cache');
  });
});
