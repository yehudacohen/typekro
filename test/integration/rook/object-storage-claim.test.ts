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
import { createBunCompatibleCoreV1Api } from '../../../src/core/kubernetes/index.js';
import { Cel } from '../../../src/core/references/cel.js';
import { singleton } from '../../../src/core/singleton/singleton.js';
import {
  cephObjectStore,
  rookBucketStorageClass,
  rookCephOperatorBootstrap,
  rookObjectStorageClaim,
} from '../../../src/factories/rook/index.js';
import {
  deleteNamespaceAndWait,
  ensureNamespaceExists,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

const runRequested = process.env.RUN_ROOK_INTEGRATION === 'true';
const describeOrSkip = runRequested && isClusterAvailable() ? describe : describe.skip;
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

async function kubectl(args: string[], input?: string, timeout = 600_000): Promise<string> {
  const proc = Bun.spawn(['kubectl', ...args], {
    stdin: input === undefined ? undefined : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (input !== undefined && proc.stdin) {
    proc.stdin.write(input);
    proc.stdin.end();
  }
  const timer = setTimeout(() => proc.kill(), timeout);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`kubectl ${args.join(' ')} failed (${exitCode}): ${stderr || stdout}`);
    }
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function waitForJsonPath(
  resource: string,
  namespace: string,
  jsonPath: string,
  expected: (value: string) => boolean,
  timeout = 900_000
): Promise<string> {
  const started = Date.now();
  let latest = '';
  while (Date.now() - started < timeout) {
    latest = await kubectl(
      ['get', resource, '-n', namespace, '-o', `jsonpath=${jsonPath}`],
      undefined,
      30_000
    ).catch(() => '');
    if (expected(latest)) return latest;
    await Bun.sleep(5_000);
  }
  throw new Error(`Timed out waiting for ${resource} (${jsonPath}); latest value: ${latest}`);
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
                'printf "%s" "$loop" | tee "$loopFile"; ' +
                'sleep infinity',
            ],
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
  await kubectl([
    'wait',
    '--for=condition=Ready',
    `pod/${loopPodName}`,
    '-n',
    cephNamespace,
    '--timeout=180s',
  ]);
  const loopDevice = await kubectl([
    'exec',
    loopPodName,
    '-n',
    cephNamespace,
    '--',
    'cat',
    `/host/${cephClusterName}.loop`,
  ]);
  const nodeName = await kubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}']);

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
  await kubectl(['apply', '-f', '-'], JSON.stringify(manifest));
  await waitForJsonPath(
    `cephcluster/${cephClusterName}`,
    cephNamespace,
    '{.status.phase}',
    (phase) => phase === 'Ready'
  );
  await waitForJsonPath(
    `cephcluster/${cephClusterName}`,
    cephNamespace,
    '{.status.ceph.health}',
    (health) => health === 'HEALTH_OK' || health === 'HEALTH_WARN'
  );
}

async function proveS3(claimName: string): Promise<void> {
  const coreApi = createBunCompatibleCoreV1Api(getKubeConfig({ skipTLSVerify: true }));
  await coreApi.createNamespacedPod({
    namespace: appNamespace,
    body: {
      metadata: { name: `${claimName}-s3-client` },
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
                'printf typekro-e2e > /tmp/payload; ' +
                'mc cp /tmp/payload "rook/${BUCKET_NAME}/proof"; ' +
                'test "$(mc cat "rook/${BUCKET_NAME}/proof")" = typekro-e2e; ' +
                'mc rm "rook/${BUCKET_NAME}/proof"',
            ],
          },
        ],
      },
    },
  });
  await kubectl([
    'wait',
    '--for=jsonpath={.status.phase}=Succeeded',
    `pod/${claimName}-s3-client`,
    '-n',
    appNamespace,
    '--timeout=300s',
  ]);
}

describeOrSkip('Rook/Ceph live KRO platform and direct data-path integration', () => {
  const kubeConfig = getKubeConfig({ skipTLSVerify: true });
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

  beforeAll(async () => {
    await ensureNamespaceExists(controlNamespace, kubeConfig);
    await ensureNamespaceExists(appNamespace, kubeConfig);
  });

  afterAll(async () => {
    await platformFactory.deleteInstance('platform').catch(() => {});
    await kubectl(['wait', '--for=delete', 'crd/rooke2eplatforms.kro.run', '--timeout=60s']).catch(
      async () => {
        await kubectl([
          'patch',
          'crd',
          'rooke2eplatforms.kro.run',
          '--type=merge',
          '-p',
          '{"metadata":{"finalizers":[]}}',
        ]).catch(() => {});
      }
    );
    await kubectl([
      'delete',
      'cephobjectstore',
      objectStoreName,
      '-n',
      cephNamespace,
      '--ignore-not-found=true',
      '--wait=true',
      '--timeout=300s',
    ]).catch(() => {});
    await kubectl([
      'delete',
      'storageclass',
      storageClassName,
      '--ignore-not-found=true',
      '--wait=true',
    ]).catch(() => {});
    await kubectl([
      'patch',
      'cephcluster',
      cephClusterName,
      '-n',
      cephNamespace,
      '--type=merge',
      '-p',
      '{"spec":{"cleanupPolicy":{"confirmation":"yes-really-destroy-data"}}}',
    ]).catch(() => {});
    await kubectl([
      'delete',
      'cephcluster',
      cephClusterName,
      '-n',
      cephNamespace,
      '--ignore-not-found=true',
      '--wait=true',
      '--timeout=600s',
    ]).catch((error: unknown) => console.error('CephCluster cleanup failed:', error));
    await kubectl([
      'exec',
      loopPodName,
      '-n',
      cephNamespace,
      '--',
      '/bin/bash',
      '-ec',
      `loopFile=/host/${cephClusterName}.loop; ` +
        'test ! -f "$loopFile" || losetup -d "$(cat "$loopFile")"; ' +
        `rm -f /host/${cephClusterName}.img "$loopFile"`,
    ]).catch(() => {});
    await kubectl([
      'delete',
      'pod',
      loopPodName,
      '-n',
      cephNamespace,
      '--ignore-not-found=true',
      '--wait=true',
    ]).catch(() => {});
    await Promise.allSettled([
      deleteNamespaceAndWait(appNamespace, kubeConfig, 180_000),
      deleteNamespaceAndWait(controlNamespace, kubeConfig, 180_000),
    ]);
  });

  it('preserves the complete singleton-owned operator after deleting its consumer', async () => {
    const consumer = await consumerFactory.deploy({ name: 'consumer' });
    expect(consumer.status.ready).toBe(true);
    await consumerFactory.deleteInstance('consumer');
    await kubectl(['wait', '--for=delete', 'crd/rooke2econsumers.kro.run', '--timeout=60s']).catch(
      async () => {
        await kubectl([
          'patch',
          'crd',
          'rooke2econsumers.kro.run',
          '--type=merge',
          '-p',
          '{"metadata":{"finalizers":[]}}',
        ]);
      }
    );

    expect(await kubectl(['get', 'namespace', operatorNamespace, '-o', 'name'])).toBe(
      `namespace/${operatorNamespace}`
    );
    expect(
      await kubectl([
        'get',
        'helmrelease/rook-ceph',
        '-n',
        operatorNamespace,
        '-o',
        'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
      ])
    ).toContain('True');
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
    const instance = await factory.deploy({
      name,
      namespace: appNamespace,
      storageClassName,
      bucket: { name: `direct-${runId}`, mode: 'generated' },
    });
    expect(instance.status.phase).toBe('Bound');
    expect(instance.status.claimName).toBe(name);
    await proveS3(name);
    await factory.deleteInstance(name);
    await kubectl([
      'delete',
      'objectbucketclaim',
      name,
      '-n',
      appNamespace,
      '--ignore-not-found=true',
      '--wait=false',
    ]).catch(() => {});
    await kubectl([
      'wait',
      '--for=delete',
      `objectbucketclaim/${name}`,
      '-n',
      appNamespace,
      '--timeout=120s',
    ]).catch(async () => {
      await kubectl([
        'delete',
        'objectbucket',
        `obc-${appNamespace}-${name}`,
        '--ignore-not-found=true',
        '--wait=false',
      ]).catch(() => {});
    });
  });
});
