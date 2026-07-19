/**
 * Opt-in full official-chart Rook/Ceph platform proof.
 *
 * RUN_ROOK_PLATFORM_INTEGRATION=true bun test \
 *   test/integration/rook/ceph-platform.test.ts
 *
 * Set KEEP_ROOK_PLATFORM=true to retain the platform intentionally for a
 * subsequent Harbor integration run. Test-owned bucket claims and their
 * Delete-policy StorageClass are always removed through TypeKro factories.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { createBunCompatibleCoreV1Api } from '../../../src/core/kubernetes/index.js';
import { rookBucketStorageClass } from '../../../src/factories/rook/resources/bucket-storage-class.js';
import {
  rookCephExternalOperatorSingleNodePlatform,
  rookObjectStorageClaim,
} from '../../../src/factories/rook/index.js';
import {
  deleteNamespaceAndWait,
  ensureNamespaceExists,
  isClusterAvailable,
} from '../shared-kubeconfig.js';
import { createOrbStackLocalBlockFixture } from './local-block-fixture.js';

const requested = process.env.RUN_ROOK_PLATFORM_INTEGRATION === 'true';
const describeOrSkip = requested && isClusterAvailable() ? describe : describe.skip;
const retainPlatform = process.env.KEEP_ROOK_PLATFORM === 'true';
const stable = retainPlatform;
const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const suffix = stable ? 'harbor' : runId;
const controlNamespace = `typekro-${suffix}-platform-control`.slice(0, 63);
const platformNamespace = `typekro-${suffix}-ceph`.slice(0, 63);
const appNamespace = `typekro-${suffix}-s3-proof`.slice(0, 63);
// Rook persists monitor identity below dataDirHostPath outside Kubernetes. A
// deleted development cluster therefore must not reuse the same Ceph identity
// unless an operator has explicitly cleaned that retained host state.
const clusterName = `typekro-${runId}-ceph`.slice(0, 63);
const objectStoreName = 'harbor-object-store';
const retainedStorageClass = `typekro-${suffix}-bucket-retain`.slice(0, 63);
const disposableStorageClass = `typekro-${suffix}-bucket-delete`.slice(0, 63);
const operatorNamespace = 'typekro-rook-e2e-operator';
const localBlock = createOrbStackLocalBlockFixture({
  name: `typekro-${suffix}-ceph-block`.slice(0, 48),
  namespace: controlNamespace,
  nodeName: 'orbstack',
  loopDeviceNumber: 63,
  storageClassName: `typekro-${suffix}-ceph-block`.slice(0, 63),
  persistentVolumeName: `typekro-${suffix}-ceph-block-0`.slice(0, 63),
  capacity: '8Gi',
});

setDefaultTimeout(1_800_000);

const disposableBucketClass = kubernetesComposition(
  {
    name: `rook-disposable-buckets-${suffix}`.slice(0, 63),
    kind: 'RookDisposableBuckets',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean', name: 'string' }),
  },
  () => {
    const storageClass = rookBucketStorageClass({
      name: disposableStorageClass,
      objectStoreName,
      objectStoreNamespace: platformNamespace,
      operatorNamespace,
      reclaimPolicy: 'Delete',
      id: 'bucketStorageClass',
    });
    return { ready: true, name: storageClass.metadata.name };
  }
);

async function kubectlRead(args: string[], timeout = 60_000): Promise<string> {
  const proc = Bun.spawn(['kubectl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeout);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr || stdout);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function proveS3(claimName: string): Promise<void> {
  const coreApi = createBunCompatibleCoreV1Api(getKubeConfig({ skipTLSVerify: true }));
  const podName = `${claimName}-client`;
  await coreApi.createNamespacedPod({
    namespace: appNamespace,
    body: {
      metadata: { name: podName },
      spec: {
        restartPolicy: 'Never',
        containers: [
          {
            name: 'client',
            image: 'minio/mc:RELEASE.2025-05-21T01-59-54Z',
            envFrom: [{ secretRef: { name: claimName } }, { configMapRef: { name: claimName } }],
            command: ['/bin/sh', '-ec'],
            args: [
              'mc alias set rook "http://${BUCKET_HOST}:${BUCKET_PORT}" "${AWS_ACCESS_KEY_ID}" "${AWS_SECRET_ACCESS_KEY}"; ' +
                'printf typekro-rgw-proof > /tmp/payload; ' +
                'mc cp /tmp/payload "rook/${BUCKET_NAME}/proof"; ' +
                'test "$(mc cat "rook/${BUCKET_NAME}/proof")" = typekro-rgw-proof; ' +
                'mc rm "rook/${BUCKET_NAME}/proof"',
            ],
          },
        ],
      },
    },
  });
  await kubectlRead(
    [
      'wait',
      '--for=jsonpath={.status.phase}=Succeeded',
      `pod/${podName}`,
      '-n',
      appNamespace,
      '--timeout=300s',
    ],
    330_000
  );
  await coreApi.deleteNamespacedPod({ name: podName, namespace: appNamespace });
}

describeOrSkip('official Rook/Ceph platform over a shared operator', () => {
  const kubeConfig = getKubeConfig({ skipTLSVerify: true });
  const platformFactory = rookCephExternalOperatorSingleNodePlatform.factory('kro', {
    namespace: controlNamespace,
    waitForReady: true,
    timeout: 1_500_000,
    kubeConfig,
  });
  const bucketClassFactory = disposableBucketClass.factory('direct', {
    namespace: controlNamespace,
    waitForReady: true,
    timeout: 120_000,
    kubeConfig,
  });
  const claimFactory = rookObjectStorageClaim.factory('direct', {
    namespace: appNamespace,
    waitForReady: true,
    timeout: 600_000,
    kubeConfig,
  });
  const localBlockFactory = localBlock.prepare.factory('direct', {
    namespace: controlNamespace,
    waitForReady: true,
    timeout: 180_000,
    kubeConfig,
  });
  const localBlockCleanupFactory = localBlock.cleanup.factory('direct', {
    namespace: controlNamespace,
    waitForReady: true,
    timeout: 120_000,
    kubeConfig,
  });
  let platformAttempted = false;
  let platformDeployed = false;
  let appNamespacePrepared = false;
  let localBlockAttempted = false;
  let bucketClassAttempted = false;
  let claimAttempted = false;

  beforeAll(async () => {
    await ensureNamespaceExists(controlNamespace, kubeConfig);
    localBlockAttempted = true;
    await localBlockFactory.deploy({ name: 'block' });
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    if (claimAttempted) {
      await claimFactory.deleteInstance('s3-proof').catch((error) => cleanupErrors.push(error));
    }
    if (bucketClassAttempted) {
      await bucketClassFactory
        .deleteInstance('bucket-class', { scopes: ['cluster'], includeUnscopedResources: true })
        .catch((error) => cleanupErrors.push(error));
    }
    if (appNamespacePrepared) {
      await deleteNamespaceAndWait(appNamespace, kubeConfig, 600_000).catch((error) =>
        cleanupErrors.push(error)
      );
    }
    const preservePlatform = platformDeployed && retainPlatform;
    let platformCleanupComplete = !platformAttempted || preservePlatform;
    if (platformAttempted && !preservePlatform) {
      try {
        await platformFactory.deleteInstance(clusterName);
        platformCleanupComplete = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (platformCleanupComplete) {
        const namespaceStillExists = await kubectlRead(
          ['get', 'namespace', platformNamespace, '-o', 'name'],
          30_000
        )
          .then(
            () => true,
            (error: unknown) => {
              if (String(error).toLowerCase().includes('not found')) return false;
              throw error;
            }
          )
          .catch((error) => {
            cleanupErrors.push(error);
            return true;
          });
        if (namespaceStillExists) {
          platformCleanupComplete = false;
          cleanupErrors.push(
            new Error(
              `TypeKro platform deletion returned before owned namespace ${platformNamespace} was gone`
            )
          );
        }
      }
    }
    // Never remove the block device underneath a Ceph installation whose
    // TypeKro lifecycle has not completed. Preserve the fixture and control
    // namespace so a retry can finish safely instead of stranding Rook.
    if (localBlockAttempted && !preservePlatform && platformCleanupComplete) {
      await localBlockFactory
        .deleteInstance('block', { scopes: ['cluster'], includeUnscopedResources: true })
        .catch((error) => cleanupErrors.push(error));
      try {
        await localBlockCleanupFactory.deploy({ name: 'block-cleanup' });
        await localBlockCleanupFactory.deleteInstance('block-cleanup');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!preservePlatform && platformCleanupComplete) {
      await deleteNamespaceAndWait(controlNamespace, kubeConfig, 600_000).catch((error) =>
        cleanupErrors.push(error)
      );
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Rook/Ceph integration cleanup failed');
    }
  });

  it('creates a healthy CephCluster, RGW, and retained bucket class through KRO', async () => {
    platformAttempted = true;
    const platform = await platformFactory.deploy({
      name: clusterName,
      profile: 'single-node-development',
      namespace: platformNamespace,
      operatorNamespace,
      operatorDeploymentName: 'rook-ceph-operator',
      storageClassName: localBlock.storageClassName,
      // OrbStack's hostpath CSI Block volume lacks the host udev record that
      // ceph-volume requires. The test-only static Local PV is a bounded 8 GiB
      // raw block device; production profiles still require real storage.
      storageSize: '8Gi',
      objectStoreName,
      bucketStorageClassName: retainedStorageClass,
    });
    platformDeployed = true;
    expect(platform.status).toMatchObject({
      ready: true,
      failed: false,
      phase: 'Ready',
      operatorReady: true,
      clusterReady: true,
      objectStoreReady: true,
      storageClassReady: true,
      bucketStorageClassName: retainedStorageClass,
      version: 'v1.20.2',
      cephVersion: 'v20.2.2',
      profile: 'single-node-development',
    });
    expect(platform.status.endpoint).not.toBe('');
    expect(['HEALTH_OK', 'HEALTH_WARN']).toContain(platform.status.cephHealth);
    expect(
      await kubectlRead([
        'get',
        'storageclass',
        retainedStorageClass,
        '-o',
        'jsonpath={.reclaimPolicy}',
      ])
    ).toBe('Retain');
  });

  it('binds an application claim and performs S3 put/get/delete', async () => {
    await ensureNamespaceExists(appNamespace, kubeConfig);
    appNamespacePrepared = true;
    bucketClassAttempted = true;
    await bucketClassFactory.deploy({ name: 'bucket-class' });
    claimAttempted = true;
    const claim = await claimFactory.deploy({
      name: 's3-proof',
      namespace: appNamespace,
      storageClassName: disposableStorageClass,
      bucket: { name: `proof-${runId}`, mode: 'generated' },
    });
    expect(claim.status).toMatchObject({
      ready: true,
      phase: 'Bound',
      claimName: 's3-proof',
      credentialsSecretName: 's3-proof',
      connectionConfigMapName: 's3-proof',
      storageClassName: disposableStorageClass,
    });
    await proveS3('s3-proof');
  });
});
