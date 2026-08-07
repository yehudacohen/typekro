/**
 * Live NATS JetStream proof against a real cluster.
 *
 * bun test test/integration/nats/jetstream-resources.test.ts
 *
 * Requires Flux, KRO, and an explicit TYPEKRO_NATS_STORAGE_CLASS naming a
 * ReadWriteOnce StorageClass. Each mode
 * installs the official NATS and NACK charts, then reconciles a real Stream
 * and Consumer through NACK. Every run uses unique namespaces.
 */

import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { Cel } from '../../../src/core/references/cel.js';
import { nackControllerBootstrap } from '../../../src/factories/nats/compositions/nack-controller-bootstrap.js';
import { makeNatsBootstrap } from '../../../src/factories/nats/compositions/nats-bootstrap.js';
import {
  DEFAULT_NACK_VERSION,
  DEFAULT_NATS_VERSION,
} from '../../../src/factories/nats/resources/helm.js';
import {
  jetStreamConsumer,
  jetStreamStream,
} from '../../../src/factories/nats/resources/jetstream.js';
import {
  assertTestNamespaceAbsent,
  captureTestNamespaceLease,
  createAppsV1ApiClient,
  createCoreV1ApiClient,
  createKubernetesObjectApiClient,
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  deleteTestResourceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  requireTestStorageClass,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;
const runId = crypto.randomUUID().slice(0, 12);

setDefaultTimeout(1_200_000);

const liveResources = kubernetesComposition(
  {
    name: 'live-jetstream-resources',
    kind: 'LiveJetStreamResources',
    spec: type({ name: 'string', namespace: 'string', endpoint: 'string', description: 'string' }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    const stream = jetStreamStream({
      id: 'events',
      name: 'application-events',
      streamName: 'APPLIK8S_EVENTS',
      namespace: spec.namespace,
      subjects: ['applik8s.events.>'],
      description: spec.description,
      storage: 'file',
      replicas: 1,
      duplicateWindow: '2m',
      servers: [spec.endpoint],
    });
    const consumer = jetStreamConsumer({
      id: 'processor',
      name: 'account-commands',
      namespace: spec.namespace,
      streamName: 'APPLIK8S_EVENTS',
      ackPolicy: 'explicit',
      ackWait: '30s',
      maxDeliver: 5,
      filterSubject: 'applik8s.events.>',
      servers: [spec.endpoint],
    });

    return {
      ready: Cel.expr<boolean>(
        stream.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") && ',
        stream.status.observedGeneration,
        ' == ',
        stream.metadata.generation,
        ' && ',
        consumer.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") && ',
        consumer.status.observedGeneration,
        ' == ',
        consumer.metadata.generation
      ),
    };
  }
);

async function waitForPodCompletion(
  namespace: string,
  name: string,
  timeoutMs: number,
  kubeConfig: ReturnType<typeof getIntegrationTestKubeConfig>
): Promise<void> {
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pod = await coreApi.readNamespacedPod({ namespace, name });
    if (pod.status?.phase === 'Succeeded') return;
    if (pod.status?.phase === 'Failed') {
      const logs = await coreApi
        .readNamespacedPodLog({ namespace, name, container: 'probe' })
        .catch(() => '');
      throw new Error(`NATS data-plane probe ${namespace}/${name} failed: ${logs}`);
    }
    await Bun.sleep(1_000);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for NATS data-plane probe ${namespace}/${name}`
  );
}

async function runNatsDataPlaneProbe(
  mode: 'direct' | 'kro',
  namespace: string,
  endpoint: string,
  kubeConfig: ReturnType<typeof getIntegrationTestKubeConfig>
): Promise<string> {
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const podName = `nats-box-${mode}`;
  const pod = await coreApi.createNamespacedPod({
    namespace,
    body: {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: podName },
      spec: {
        restartPolicy: 'Never',
        containers: [
          {
            name: 'probe',
            image: 'natsio/nats-box:0.19.2',
            command: [
              'sh',
              '-ec',
              `nats --server ${endpoint} pub applik8s.events.test hello >/dev/null; nats --server ${endpoint} stream info APPLIK8S_EVENTS --json`,
            ],
          },
        ],
      },
    },
  });
  const podUid = pod.metadata?.uid;
  if (!podUid) {
    throw new Error(`Created NATS data-plane probe ${namespace}/${podName} has no metadata.uid`);
  }
  try {
    await waitForPodCompletion(namespace, podName, 180_000, kubeConfig);
    return await coreApi.readNamespacedPodLog({
      namespace,
      name: podName,
      container: 'probe',
    });
  } finally {
    await deleteTestResourceAndWait(
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { namespace, name: podName, uid: podUid },
      },
      kubeConfig
    );
  }
}

async function waitForStatefulSetReady(
  namespace: string,
  name: string,
  replicas: number,
  timeoutMs: number,
  kubeConfig: ReturnType<typeof getIntegrationTestKubeConfig>
): Promise<void> {
  const appsApi = createAppsV1ApiClient(kubeConfig);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const statefulSet = await appsApi.readNamespacedStatefulSet({ namespace, name });
    const generation = statefulSet.metadata?.generation ?? 0;
    const status = statefulSet.status;
    if (
      (status?.observedGeneration ?? 0) >= generation &&
      status?.readyReplicas === replicas &&
      status?.updatedReplicas === replicas
    ) {
      return;
    }
    await Bun.sleep(2_000);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for StatefulSet ${namespace}/${name} to have ${replicas} ready replicas`
  );
}

interface JetStreamResourceState {
  metadata?: { generation?: number };
  spec?: { description?: string };
  status?: {
    observedGeneration?: number;
    conditions?: Array<{ type?: string; status?: string }>;
  };
}

async function readJetStreamResource(
  kind: 'Stream' | 'Consumer',
  name: string,
  namespace: string,
  kubeConfig: ReturnType<typeof getIntegrationTestKubeConfig>
): Promise<JetStreamResourceState> {
  const objectApi = createKubernetesObjectApiClient(kubeConfig);
  return (await objectApi.read({
    apiVersion: 'jetstream.nats.io/v1beta2',
    kind,
    metadata: { name, namespace },
  })) as JetStreamResourceState;
}

function expectCurrentJetStreamReadiness(resource: JetStreamResourceState): void {
  expect(resource.status?.conditions).toContainEqual(
    expect.objectContaining({ type: 'Ready', status: 'True' })
  );
  const generation = resource.metadata?.generation;
  if (generation === undefined) {
    throw new Error('JetStream resource has no metadata.generation');
  }
  expect(resource.status?.observedGeneration).toBe(generation);
}

async function proveMode(mode: 'direct' | 'kro'): Promise<void> {
  const suffix = `${mode}-${runId}`.slice(0, 42);
  const controlNamespace = `tk-nats-control-${suffix}`.slice(0, 63);
  const targetNamespace = `tk-nats-${suffix}`.slice(0, 63);
  const appNamespace = `tk-nats-app-${suffix}`.slice(0, 63);
  const controllerName = `nack-${suffix}`.slice(0, 63);
  const controllerNamespace = `tk-nack-${suffix}`.slice(0, 63);
  const controllerSingletonId = `nack-${suffix}`.slice(0, 63);
  const controllerValues = {
    nameOverride: controllerName,
    serviceAccountName: controllerName,
  };
  const isolatedNats = makeNatsBootstrap({
    controller: {
      singletonId: controllerSingletonId,
      name: controllerName,
      namespace: controllerNamespace,
      values: controllerValues,
    },
  });
  const kubeConfig = getIntegrationTestKubeConfig();
  const storageClassName = await requireTestStorageClass({
    kubeConfig,
    envVar: 'TYPEKRO_NATS_STORAGE_CLASS',
  });

  const platformFactory = isolatedNats.factory(mode, {
    namespace: controlNamespace,
    waitForReady: true,
    timeout: 900_000,
    kubeConfig,
  });
  const resourcesFactory = liveResources.factory(mode, {
    namespace: appNamespace,
    waitForReady: true,
    timeout: 600_000,
    kubeConfig,
  });
  let testFailure: Error | undefined;
  let controlNamespaceLease: TestNamespaceLease | undefined;
  let appNamespaceLease: TestNamespaceLease | undefined;
  let targetNamespaceLease: TestNamespaceLease | undefined;
  let controllerNamespaceLease: TestNamespaceLease | undefined;
  const controllerFactory = nackControllerBootstrap.factory(mode, {
    namespace: 'typekro-singletons',
    waitForReady: true,
    timeout: 600_000,
    kubeConfig,
  });

  try {
    controlNamespaceLease = await createTestNamespace(controlNamespace, kubeConfig);
    appNamespaceLease = await createTestNamespace(appNamespace, kubeConfig);
    await assertTestNamespaceAbsent(targetNamespace, kubeConfig);
    await assertTestNamespaceAbsent(controllerNamespace, kubeConfig);

    let platform: Awaited<ReturnType<typeof platformFactory.deploy>>;
    try {
      platform = await platformFactory.deploy({
        name: 'nats',
        namespace: targetNamespace,
        replicas: mode === 'kro' ? 3 : 1,
        storageSize: '1Gi',
        pvcRetentionPolicy: 'delete',
        storageClassName,
      });
    } catch (deploymentError: unknown) {
      try {
        targetNamespaceLease = await captureTestNamespaceLease(targetNamespace, kubeConfig);
      } catch (leaseError: unknown) {
        throw new AggregateError(
          [deploymentError, leaseError],
          `NATS platform deployment failed and ownership of ${targetNamespace} could not be retained`
        );
      }
      throw deploymentError;
    }
    targetNamespaceLease = await captureTestNamespaceLease(targetNamespace, kubeConfig);
    if (!targetNamespaceLease) {
      throw new Error(`NATS platform did not create expected namespace ${targetNamespace}`);
    }
    controllerNamespaceLease ??= await captureTestNamespaceLease(controllerNamespace, kubeConfig);
    if (!controllerNamespaceLease) {
      throw new Error(`NACK singleton did not create expected namespace ${controllerNamespace}`);
    }

    expect(platform.status).toMatchObject({
      ready: true,
      failed: false,
      phase: 'Ready',
      serverVersion: DEFAULT_NATS_VERSION,
      controllerVersion: DEFAULT_NACK_VERSION,
      endpoint: `nats://nats.${targetNamespace}.svc:4222`,
    });

    if (mode === 'kro') {
      await waitForStatefulSetReady(targetNamespace, 'nats', 3, 600_000, kubeConfig);
    }

    const endpoint = `nats://nats.${targetNamespace}.svc:4222`;
    const resources = await resourcesFactory.deploy({
      name: 'resources',
      namespace: appNamespace,
      endpoint,
      description: 'initial live proof',
    });

    expect(resources.status).toMatchObject({ ready: true });

    const [stream, consumer] = await Promise.all([
      readJetStreamResource('Stream', 'application-events', appNamespace, kubeConfig),
      readJetStreamResource('Consumer', 'account-commands', appNamespace, kubeConfig),
    ]);
    expectCurrentJetStreamReadiness(stream);
    expectCurrentJetStreamReadiness(consumer);

    const updatedResources = await resourcesFactory.deploy({
      name: 'resources',
      namespace: appNamespace,
      endpoint,
      description: 'updated live proof',
    });
    expect(updatedResources.status).toMatchObject({ ready: true });
    const updatedStream = await readJetStreamResource(
      'Stream',
      'application-events',
      appNamespace,
      kubeConfig
    );
    expectCurrentJetStreamReadiness(updatedStream);
    expect(updatedStream.spec?.description).toBe('updated live proof');

    const dataPlane = await runNatsDataPlaneProbe(mode, appNamespace, endpoint, kubeConfig);
    const jsonStart = dataPlane.indexOf('{');
    const jsonEnd = dataPlane.lastIndexOf('}');
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    expect(jsonEnd).toBeGreaterThan(jsonStart);
    const streamInfo = JSON.parse(dataPlane.slice(jsonStart, jsonEnd + 1)) as {
      state?: { messages?: number };
    };
    expect(streamInfo.state?.messages).toBeGreaterThanOrEqual(1);
  } catch (error: unknown) {
    testFailure = error instanceof Error ? error : new Error(String(error));
  }

  const cleanupFailures: Error[] = [];
  // Delete in dependency order. Factory teardown owns normal graph deletion;
  // the harness recovers only a leased, empty Namespace stuck on Kubernetes'
  // standard finalizer, then retries the factory to prove definitions are gone.
  try {
    await deleteTestFactoryInstanceAndRecoverNamespaces(
      resourcesFactory,
      'resources',
      [],
      kubeConfig
    );
  } catch (error: unknown) {
    cleanupFailures.push(
      new Error(
        `${mode} cleanup failed for JetStream resources: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
  try {
    await deleteTestFactoryInstanceAndRecoverNamespaces(
      platformFactory,
      'nats',
      targetNamespaceLease ? [targetNamespaceLease] : [],
      kubeConfig,
      30_000,
      mode === 'direct' ? { scopes: ['cluster'] } : {}
    );
  } catch (error: unknown) {
    cleanupFailures.push(
      new Error(
        `${mode} cleanup failed for NATS platform: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
  try {
    await deleteTestFactoryInstanceAndRecoverNamespaces(
      controllerFactory,
      controllerSingletonId,
      controllerNamespaceLease ? [controllerNamespaceLease] : [],
      kubeConfig,
      30_000,
      mode === 'direct' ? { scopes: ['cluster'] } : {}
    );
  } catch (error: unknown) {
    cleanupFailures.push(
      new Error(
        `${mode} cleanup failed for shared NACK owner: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    );
  }

  for (const lease of [appNamespaceLease, controlNamespaceLease]) {
    if (!lease) continue;
    try {
      await deleteTestNamespaceAndWait(lease, kubeConfig);
    } catch (error: unknown) {
      cleanupFailures.push(
        new Error(
          `${mode} cleanup failed for namespace ${lease.name}: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }
  const failures = [...(testFailure ? [testFailure] : []), ...cleanupFailures];
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${mode} NATS integration or cleanup did not complete safely`
    );
  }
}

describeOrSkip('NATS JetStream live direct and KRO integration', () => {
  it('installs NATS/NACK and reconciles a persisted Stream and Consumer in direct mode', async () => {
    await proveMode('direct');
  });

  it('projects readiness and reconciles the same resources through KRO', async () => {
    await proveMode('kro');
  });

  it('keeps the shared NACK controller alive when one of two NATS installations is deleted', async () => {
    const suffix = `shared-${runId}`.slice(0, 36);
    const controllerName = `nack-${suffix}`.slice(0, 63);
    const controllerNamespace = `tk-nack-${suffix}`.slice(0, 63);
    const controllerSingletonId = `nack-${suffix}`.slice(0, 63);
    const controllerValues = {
      nameOverride: controllerName,
      serviceAccountName: controllerName,
    };
    const sharedNats = makeNatsBootstrap({
      controller: {
        singletonId: controllerSingletonId,
        name: controllerName,
        namespace: controllerNamespace,
        values: controllerValues,
      },
    });
    const kubeConfig = getIntegrationTestKubeConfig();
    const objectApi = createKubernetesObjectApiClient(kubeConfig);
    const storageClassName = await requireTestStorageClass({
      kubeConfig,
      envVar: 'TYPEKRO_NATS_STORAGE_CLASS',
    });
    const controllerFactory = nackControllerBootstrap.factory('direct', {
      namespace: 'typekro-singletons',
      waitForReady: true,
      timeout: 600_000,
      kubeConfig,
    });
    const installations = ['a', 'b'].map((id) => {
      const controlNamespace = `tk-nats-control-${id}-${suffix}`.slice(0, 63);
      const targetNamespace = `tk-nats-${id}-${suffix}`.slice(0, 63);
      const appNamespace = `tk-nats-app-${id}-${suffix}`.slice(0, 63);
      return {
        id,
        controlNamespace,
        targetNamespace,
        appNamespace,
        platformFactory: sharedNats.factory('direct', {
          namespace: controlNamespace,
          waitForReady: true,
          timeout: 900_000,
          kubeConfig,
        }),
        resourcesFactory: liveResources.factory('direct', {
          namespace: appNamespace,
          waitForReady: true,
          timeout: 600_000,
          kubeConfig,
        }),
      };
    });
    const namespaceLeases: TestNamespaceLease[] = [];
    let controllerNamespaceLease: TestNamespaceLease | undefined;
    let testFailure: Error | undefined;

    try {
      for (const installation of installations) {
        namespaceLeases.push(
          await createTestNamespace(installation.controlNamespace, kubeConfig),
          await createTestNamespace(installation.appNamespace, kubeConfig)
        );
        await assertTestNamespaceAbsent(installation.targetNamespace, kubeConfig);
      }
      await assertTestNamespaceAbsent(controllerNamespace, kubeConfig);

      for (const installation of installations) {
        const platform = await installation.platformFactory.deploy({
          name: `nats-${installation.id}`,
          namespace: installation.targetNamespace,
          replicas: 1,
          storageSize: '1Gi',
          pvcRetentionPolicy: 'delete',
          storageClassName,
        });
        expect(platform.status).toMatchObject({ ready: true, failed: false, phase: 'Ready' });
        controllerNamespaceLease ??= await captureTestNamespaceLease(
          controllerNamespace,
          kubeConfig
        );
        if (!controllerNamespaceLease) {
          throw new Error(`NACK owner did not create expected namespace ${controllerNamespace}`);
        }
        const resources = await installation.resourcesFactory.deploy({
          name: `resources-${installation.id}`,
          namespace: installation.appNamespace,
          endpoint: `nats://nats-${installation.id}.${installation.targetNamespace}.svc:4222`,
          description: `shared controller ${installation.id}`,
        });
        expect(resources.status).toMatchObject({ ready: true });
      }

      const deploymentIdentity = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: controllerName, namespace: controllerNamespace },
      };
      const roleIdentity = {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRole',
        metadata: { name: `${controllerName}-cluster-role` },
      };
      const controllerDeployment = await objectApi.read(deploymentIdentity);
      const controllerRole = await objectApi.read(roleIdentity);
      const deploymentUid = controllerDeployment.metadata?.uid;
      const roleUid = controllerRole.metadata?.uid;
      if (!deploymentUid || !roleUid) {
        throw new Error('Shared NACK controller resources have no Kubernetes UID');
      }

      const first = installations[0];
      const second = installations[1];
      if (!first || !second) {
        throw new Error('Expected two NATS installations');
      }
      const firstTargetLease = await captureTestNamespaceLease(first.targetNamespace, kubeConfig);
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        first.resourcesFactory,
        `resources-${first.id}`,
        [],
        kubeConfig
      );
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        first.platformFactory,
        `nats-${first.id}`,
        firstTargetLease ? [firstTargetLease] : [],
        kubeConfig,
        30_000,
        { scopes: ['cluster'] }
      );

      expect((await objectApi.read(deploymentIdentity)).metadata?.uid).toBe(deploymentUid);
      expect((await objectApi.read(roleIdentity)).metadata?.uid).toBe(roleUid);

      const updated = await second.resourcesFactory.deploy({
        name: `resources-${second.id}`,
        namespace: second.appNamespace,
        endpoint: `nats://nats-${second.id}.${second.targetNamespace}.svc:4222`,
        description: 'reconciled after sibling deletion',
      });
      expect(updated.status).toMatchObject({ ready: true });
      const survivingStream = await readJetStreamResource(
        'Stream',
        'application-events',
        second.appNamespace,
        kubeConfig
      );
      expectCurrentJetStreamReadiness(survivingStream);
      expect(survivingStream.spec?.description).toBe('reconciled after sibling deletion');
    } catch (error: unknown) {
      testFailure = error instanceof Error ? error : new Error(String(error));
    }

    const cleanupFailures: Error[] = [];
    for (const installation of installations) {
      try {
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          installation.resourcesFactory,
          `resources-${installation.id}`,
          [],
          kubeConfig
        );
      } catch (error: unknown) {
        cleanupFailures.push(
          new Error(
            `Shared-controller resource cleanup failed for ${installation.id}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      }
      try {
        const targetLease = await captureTestNamespaceLease(
          installation.targetNamespace,
          kubeConfig
        );
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          installation.platformFactory,
          `nats-${installation.id}`,
          targetLease ? [targetLease] : [],
          kubeConfig,
          30_000,
          { scopes: ['cluster'] }
        );
      } catch (error: unknown) {
        cleanupFailures.push(
          new Error(
            `Shared-controller platform cleanup failed for ${installation.id}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      }
    }
    try {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        controllerFactory,
        controllerName,
        controllerNamespaceLease ? [controllerNamespaceLease] : [],
        kubeConfig,
        30_000,
        { scopes: ['cluster'] }
      );
    } catch (error: unknown) {
      cleanupFailures.push(
        new Error(
          `Shared NACK owner cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
    }
    for (const lease of namespaceLeases) {
      try {
        await deleteTestNamespaceAndWait(lease, kubeConfig);
      } catch (error: unknown) {
        cleanupFailures.push(
          new Error(
            `Shared-controller namespace cleanup failed for ${lease.name}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      }
    }
    const failures = [...(testFailure ? [testFailure] : []), ...cleanupFailures];
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Shared NACK controller lifecycle proof did not complete safely'
      );
    }
  });
});
