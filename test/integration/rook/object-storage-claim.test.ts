/**
 * Opt-in full Rook/Ceph proof for a one-node development cluster.
 *
 * RUN_ROOK_INTEGRATION=true bun test test/integration/rook/object-storage-claim.test.ts
 *
 * The suite installs the operator behind a singleton owner, proves consumer
 * deletion preserves it, creates a one-node CephCluster + RGW + bucket
 * StorageClass through KRO, then performs S3 put/get/delete through a direct
 * claim. OBC claims themselves are intentionally direct-only because they are
 * mutated by the provisioner and are unsafe children of a continuous-apply
 * graph controller. Every namespaced resource uses a unique run id.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import {
  createBunCompatibleCoreV1Api,
  createBunCompatibleCustomObjectsApi,
  createBunCompatibleKubernetesObjectApi,
} from '../../../src/core/kubernetes/index.js';
import { Cel } from '../../../src/core/references/cel.js';
import { singleton } from '../../../src/core/singleton/singleton.js';
import {
  cephObjectStore,
  rookBucketStorageClass,
  rookCephOperatorBootstrap,
  rookObjectStorageClaim,
} from '../../../src/factories/rook/index.js';
import {
  createTestNamespace,
  deleteGeneratedCrdAndWait,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  deleteTestPodAndWait,
  deleteTestResourceAndWait,
  isClusterAvailable,
  runTestPodAndReadLogs,
  TestFactoryCleanupRegistry,
  type TestNamespaceLease,
  waitForResourceAbsent,
} from '../shared-kubeconfig.js';

const runRequested = process.env.RUN_ROOK_INTEGRATION === 'true';
const describeOrSkip = runRequested && (await isClusterAvailable()) ? describe : describe.skip;
const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const controlNamespace = `tk-rook-ctl-${runId}`.slice(0, 63);
const operatorNamespace = 'typekro-rook-e2e-operator';
const cephNamespace = operatorNamespace;
const cephClusterName = `e2e-${runId}`.slice(0, 63);
const appNamespace = `tk-rook-app-${runId}`.slice(0, 63);
const singletonId = 'rook-e2e-operator';
const objectStoreName = 'e2e-store';
const storageClassName = `tk-rook-bucket-${runId}`.slice(0, 63);
const loopPodName = 'rook-loop-device';

setDefaultTimeout(1_800_000);

const sharedOperatorConsumer = kubernetesComposition(
  {
    name: `rook-consumer-${runId}`.slice(0, 63),
    kind: 'RookE2EConsumer',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean' }),
  },
  () => {
    const operator = singleton(rookCephOperatorBootstrap, {
      id: singletonId,
      spec: {
        name: 'rook-ceph',
        namespace: operatorNamespace,
        enableOBCWatchOperatorNamespace: true,
        values: { allowLoopDevices: true },
      },
    });
    return { ready: operator.status.ready };
  }
);

const objectStorePlatform = kubernetesComposition(
  {
    name: `rook-platform-${runId}`.slice(0, 63),
    kind: 'RookE2EPlatform',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean', storageClassName: 'string' }),
  },
  () => {
    const store = cephObjectStore({
      name: objectStoreName,
      namespace: cephNamespace,
      spec: {
        metadataPool: {
          failureDomain: 'host',
          replicated: { size: 1, requireSafeReplicaSize: false },
        },
        dataPool: {
          failureDomain: 'host',
          replicated: { size: 1, requireSafeReplicaSize: false },
        },
        preservePoolsOnDelete: false,
        gateway: { port: 80, instances: 1 },
      },
      id: 'objectStore',
    });

    const _bucketClass = rookBucketStorageClass({
      name: storageClassName,
      objectStoreName,
      objectStoreNamespace: cephNamespace,
      operatorNamespace,
      reclaimPolicy: 'Delete',
      id: 'bucketStorageClass',
    });

    return {
      ready: Cel.expr<boolean>(store.status.phase, ' == "Ready"'),
      storageClassName: Cel.expr<string>('bucketStorageClass.metadata.name'),
    };
  }
);

async function waitForCephClusterStatus(
  expected: (status: Record<string, unknown>) => boolean,
  timeout = 900_000
): Promise<Record<string, unknown>> {
  const customApi = createBunCompatibleCustomObjectsApi(getKubeConfig({ skipTLSVerify: true }));
  const started = Date.now();
  let latest: Record<string, unknown> = {};
  while (Date.now() - started < timeout) {
    const live = (await customApi.getNamespacedCustomObject({
      group: 'ceph.rook.io',
      version: 'v1',
      namespace: cephNamespace,
      plural: 'cephclusters',
      name: cephClusterName,
    })) as { status?: Record<string, unknown> };
    latest = live.status ?? {};
    if (expected(latest)) return latest;
    await Bun.sleep(5_000);
  }
  throw new Error(`Timed out waiting for CephCluster status: ${JSON.stringify(latest)}`);
}

async function createCephCluster(): Promise<void> {
  const coreApi = createBunCompatibleCoreV1Api(getKubeConfig({ skipTLSVerify: true }));
  await coreApi.createNamespacedPod({
    namespace: cephNamespace,
    body: {
      metadata: { name: loopPodName },
      spec: {
        restartPolicy: 'Never',
        containers: [
          {
            name: 'loop',
            image: 'quay.io/ceph/ceph:v19.2.3',
            securityContext: { privileged: true },
            command: ['/bin/bash', '-ec'],
            args: [
              `image=/host/${cephClusterName}.img; ` +
                `loopFile=/host/${cephClusterName}.loop; ` +
                'truncate -s 6G "$image"; ' +
                'loop=$(losetup --find --show "$image"); ' +
                'printf "%s\\n" "$loop" | tee "$loopFile"; ' +
                'sleep infinity',
            ],
            lifecycle: {
              preStop: {
                exec: {
                  command: [
                    '/bin/bash',
                    '-ec',
                    `loopFile=/host/${cephClusterName}.loop; ` +
                      'test ! -f "$loopFile" || losetup -d "$(cat "$loopFile")"; ' +
                      `rm -f /host/${cephClusterName}.img "$loopFile"`,
                  ],
                },
              },
            },
            volumeMounts: [
              { name: 'dev', mountPath: '/dev' },
              { name: 'host-rook', mountPath: '/host' },
            ],
          },
        ],
        volumes: [
          { name: 'dev', hostPath: { path: '/dev', type: 'Directory' } },
          {
            name: 'host-rook',
            hostPath: { path: '/var/lib/rook', type: 'DirectoryOrCreate' },
          },
        ],
      },
    },
  });
  const podDeadline = Date.now() + 180_000;
  let loopDevice = '';
  while (Date.now() < podDeadline) {
    const pod = await coreApi.readNamespacedPod({
      namespace: cephNamespace,
      name: loopPodName,
    });
    const ready = pod.status?.conditions?.some(
      (condition) => condition.type === 'Ready' && condition.status === 'True'
    );
    if (ready) {
      loopDevice = (
        await coreApi.readNamespacedPodLog({
          namespace: cephNamespace,
          name: loopPodName,
          container: 'loop',
        })
      ).trim();
      if (loopDevice) break;
    }
    await Bun.sleep(2_000);
  }
  if (!loopDevice) throw new Error('Loop-device Pod did not report its allocated device');
  const nodeName = (await coreApi.listNode()).items[0]?.metadata?.name;
  if (!nodeName) throw new Error('Rook integration cluster has no schedulable node');

  const manifest = {
    apiVersion: 'ceph.rook.io/v1',
    kind: 'CephCluster',
    metadata: { name: cephClusterName, namespace: cephNamespace },
    spec: {
      dataDirHostPath: `/var/lib/rook/${cephClusterName}`,
      cephVersion: { image: 'quay.io/ceph/ceph:v19.2.3', allowUnsupported: false },
      skipUpgradeChecks: false,
      continueUpgradeAfterChecksEvenIfNotHealthy: false,
      mon: { count: 1, allowMultiplePerNode: true },
      mgr: { count: 1, allowMultiplePerNode: true },
      dashboard: { enabled: false },
      crashCollector: { disable: true },
      storage: {
        nodes: [
          {
            name: nodeName,
            useAllDevices: false,
            devices: [{ name: loopDevice }],
          },
        ],
      },
    },
  };
  await createBunCompatibleCustomObjectsApi(
    getKubeConfig({ skipTLSVerify: true })
  ).createNamespacedCustomObject({
    group: 'ceph.rook.io',
    version: 'v1',
    namespace: cephNamespace,
    plural: 'cephclusters',
    body: manifest,
  });
  await waitForCephClusterStatus(
    (status) =>
      status.phase === 'Ready' &&
      typeof status.ceph === 'object' &&
      status.ceph !== null &&
      ['HEALTH_OK', 'HEALTH_WARN'].includes(String((status.ceph as Record<string, unknown>).health))
  );
}

async function proveS3(claimName: string): Promise<void> {
  await runTestPodAndReadLogs(
    {
      namespace: appNamespace,
      name: `${claimName}-s3-client`,
      image: 'minio/mc:RELEASE.2025-05-21T01-59-54Z',
      envFrom: [{ secretRef: { name: claimName } }, { configMapRef: { name: claimName } }],
      command: ['/bin/sh', '-ec'],
      args: [
        'mc alias set rook "http://${BUCKET_HOST}:${BUCKET_PORT}" "${AWS_ACCESS_KEY_ID}" "${AWS_SECRET_ACCESS_KEY}"; ' +
          'printf typekro-e2e > /tmp/payload; ' +
          'mc cp /tmp/payload "rook/${BUCKET_NAME}/proof"; ' +
          'test "$(mc cat "rook/${BUCKET_NAME}/proof")" = typekro-e2e; ' +
          'mc rm "rook/${BUCKET_NAME}/proof"',
      ],
      timeoutMs: 300_000,
    },
    getKubeConfig({ skipTLSVerify: true })
  );
}

describeOrSkip('Rook/Ceph live KRO platform and direct data-path integration', () => {
  const kubeConfig = getKubeConfig({ skipTLSVerify: true });
  let controlNamespaceLease: TestNamespaceLease;
  let appNamespaceLease: TestNamespaceLease;
  const consumerFactory = sharedOperatorConsumer.factory('kro', {
    namespace: controlNamespace,
    waitForReady: true,
    timeout: 900_000,
    kubeConfig,
  });
  const platformFactory = objectStorePlatform.factory('kro', {
    namespace: controlNamespace,
    waitForReady: true,
    timeout: 900_000,
    kubeConfig,
  });
  const directClaimCleanup = new TestFactoryCleanupRegistry();

  beforeAll(async () => {
    [controlNamespaceLease, appNamespaceLease] = await Promise.all([
      createTestNamespace(controlNamespace, kubeConfig),
      createTestNamespace(appNamespace, kubeConfig),
    ]);
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    await directClaimCleanup
      .cleanup(kubeConfig, 120_000)
      .catch((error) => cleanupErrors.push(error));
    await deleteTestFactoryInstanceAndRecoverNamespaces(
      platformFactory,
      'platform',
      [],
      kubeConfig,
      180_000
    ).catch((error) => cleanupErrors.push(error));
    await deleteGeneratedCrdAndWait(
      {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'rooke2eplatforms.kro.run' },
      },
      'kro.run/v1alpha1',
      'RookE2EPlatform',
      kubeConfig
    ).catch((error) => cleanupErrors.push(error));

    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
    await customApi
      .patchNamespacedCustomObject({
        group: 'ceph.rook.io',
        version: 'v1',
        namespace: cephNamespace,
        plural: 'cephclusters',
        name: cephClusterName,
        body: [
          {
            op: 'add',
            path: '/spec/cleanupPolicy',
            value: { confirmation: 'yes-really-destroy-data' },
          },
        ],
      })
      .catch((error) => {
        if (!/not found|NotFound/i.test(String(error))) cleanupErrors.push(error);
      });
    await deleteTestResourceAndWait(
      {
        apiVersion: 'ceph.rook.io/v1',
        kind: 'CephCluster',
        metadata: { name: cephClusterName, namespace: cephNamespace },
      },
      kubeConfig,
      600_000
    ).catch((error) => cleanupErrors.push(error));
    await deleteTestPodAndWait(cephNamespace, loopPodName, kubeConfig, 180_000).catch((error) =>
      cleanupErrors.push(error)
    );
    await deleteTestNamespaceAndWait(appNamespaceLease, kubeConfig).catch((error) =>
      cleanupErrors.push(error)
    );
    await deleteTestNamespaceAndWait(controlNamespaceLease, kubeConfig).catch((error) =>
      cleanupErrors.push(error)
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Rook object-storage integration cleanup failed');
    }
  });

  it('preserves the complete singleton-owned operator after deleting its consumer', async () => {
    const consumer = await consumerFactory.deploy({ name: 'consumer' });
    expect(consumer.status.ready).toBe(true);
    await deleteTestFactoryInstanceAndRecoverNamespaces(
      consumerFactory,
      'consumer',
      [],
      kubeConfig,
      120_000
    );
    await deleteGeneratedCrdAndWait(
      {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'rooke2econsumers.kro.run' },
      },
      'kro.run/v1alpha1',
      'RookE2EConsumer',
      kubeConfig
    );

    const objectApi = createBunCompatibleKubernetesObjectApi(kubeConfig);
    expect(
      await objectApi.read({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: operatorNamespace },
      })
    ).toBeDefined();
    const helmRelease = (await objectApi.read({
      apiVersion: 'helm.toolkit.fluxcd.io/v2',
      kind: 'HelmRelease',
      metadata: { name: 'rook-ceph', namespace: operatorNamespace },
    })) as unknown as {
      status?: { conditions?: Array<{ type?: string; status?: string }> };
    };
    expect(
      helmRelease.status?.conditions?.some(
        (condition) => condition.type === 'Ready' && condition.status === 'True'
      )
    ).toBe(true);
  });

  it('provisions a real one-node Ceph RGW and bucket StorageClass through KRO', async () => {
    await createCephCluster();
    const platform = await platformFactory.deploy({ name: 'platform' });
    expect(platform.status.ready).toBe(true);
    expect(platform.status.storageClassName).toBe(storageClassName);
  });

  it('binds a direct claim and performs S3 put/get/delete', async () => {
    const factory = rookObjectStorageClaim.factory('direct', {
      namespace: appNamespace,
      waitForReady: true,
      timeout: 600_000,
      kubeConfig,
    });
    const name = 'direct-bucket';
    directClaimCleanup.track(factory, name);
    const instance = await factory.deploy({
      name,
      namespace: appNamespace,
      storageClassName,
      bucket: { name: `direct-${runId}`, mode: 'generated' },
    });
    expect(instance.status.phase).toBe('Bound');
    expect(instance.status.claimName).toBe(name);
    await proveS3(name);
    const deletion = await factory.deleteInstance(name);
    expect(deletion.status).toBe('complete');
    await waitForResourceAbsent(
      {
        apiVersion: 'objectbucket.io/v1alpha1',
        kind: 'ObjectBucketClaim',
        metadata: { name, namespace: appNamespace },
      },
      kubeConfig,
      120_000
    );
    await waitForResourceAbsent(
      {
        apiVersion: 'objectbucket.io/v1alpha1',
        kind: 'ObjectBucket',
        metadata: { name: `obc-${appNamespace}-${name}` },
      },
      kubeConfig,
      120_000
    );
  });
});
