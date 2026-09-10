/**
 * Minimal MinIO fixture for the S3-backed storage integration suites.
 *
 * There is no existing MinIO pattern in this repo's harness (the rook suites
 * talk to Ceph RGW), so this is the "minimal Deployment + Service" #184 asks
 * for: one single-replica MinIO on an `emptyDir`, a Secret holding the root
 * credentials in the AWS variable names ClickHouse's `from_env` disk config
 * expects, and a `mc` Pod that creates the bucket.
 *
 * DELIBERATELY NOT PRODUCTION SHAPED: no PVC, no TLS, no distributed mode.
 * It exists so a kind cluster can prove the rendered `storage_configuration`
 * actually works against an S3 API.
 */

import type * as k8s from '@kubernetes/client-node';
import {
  createAppsV1ApiClient,
  createCoreV1ApiClient,
  isNotFoundError,
  runTestPodAndReadLogs,
  waitForResourceAbsent,
} from './shared-kubeconfig.js';

/** MinIO server image (pinned — a floating tag makes failures unreadable). */
export const MINIO_IMAGE = 'minio/minio:RELEASE.2025-04-22T22-12-26Z';

/** MinIO client image used to create the bucket. */
export const MINIO_CLIENT_IMAGE = 'minio/mc:RELEASE.2025-04-16T18-13-26Z';

/** S3 API port. */
export const MINIO_PORT = 9000;

/** Root credentials, also the S3 access key pair ClickHouse uses. */
export const MINIO_ACCESS_KEY = 'typekro-test-access-key';
export const MINIO_SECRET_KEY = 'typekro-test-secret-key';

/** Coordinates a suite needs to point ClickHouse at this MinIO. */
export interface MinioFixture {
  /** Kubernetes namespace the fixture lives in. */
  namespace: string;
  /** Resource name shared by the Deployment, Service and Secret. */
  name: string;
  /** Bucket created by {@link deployMinio}. */
  bucket: string;
  /** Base URL for `storage.endpoint` (no bucket, no prefix, no trailing slash). */
  endpoint: string;
  /** Secret name for `storage.auth.secretRef.name`. */
  secretName: string;
}

interface DeployMinioOptions {
  namespace: string;
  bucket: string;
  /** Resource name (default: 'minio'). */
  name?: string;
  kubeConfig: k8s.KubeConfig;
  timeoutMs?: number;
}

/**
 * Deploy MinIO, wait for it to serve, and create the bucket.
 *
 * @param options - Namespace, bucket and kubeconfig
 * @returns The coordinates needed to configure an S3-backed ClickHouse
 */
export async function deployMinio(options: DeployMinioOptions): Promise<MinioFixture> {
  const name = options.name ?? 'minio';
  const { namespace, bucket, kubeConfig } = options;
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const appsApi = createAppsV1ApiClient(kubeConfig);

  await coreApi.createNamespacedSecret({
    namespace,
    body: {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name },
      stringData: {
        // The names ClickHouse's rendered disk config reads via `from_env`
        // defaults, so the suite exercises the documented default keys.
        AWS_ACCESS_KEY_ID: MINIO_ACCESS_KEY,
        AWS_SECRET_ACCESS_KEY: MINIO_SECRET_KEY,
      },
    },
  });

  await appsApi.createNamespacedDeployment({
    namespace,
    body: {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, labels: { app: name } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            containers: [
              {
                name: 'minio',
                image: MINIO_IMAGE,
                args: ['server', '/data'],
                env: [
                  {
                    name: 'MINIO_ROOT_USER',
                    valueFrom: {
                      secretKeyRef: { name, key: 'AWS_ACCESS_KEY_ID', optional: false },
                    },
                  },
                  {
                    name: 'MINIO_ROOT_PASSWORD',
                    valueFrom: {
                      secretKeyRef: { name, key: 'AWS_SECRET_ACCESS_KEY', optional: false },
                    },
                  },
                ],
                ports: [{ containerPort: MINIO_PORT, name: 's3' }],
                volumeMounts: [{ name: 'data', mountPath: '/data' }],
                readinessProbe: {
                  httpGet: { path: '/minio/health/ready', port: MINIO_PORT },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                },
                resources: {
                  requests: { cpu: '100m', memory: '256Mi' },
                  limits: { memory: '1Gi' },
                },
              },
            ],
            volumes: [{ name: 'data', emptyDir: {} }],
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
      metadata: { name },
      spec: {
        selector: { app: name },
        ports: [{ name: 's3', port: MINIO_PORT, targetPort: MINIO_PORT }],
      },
    },
  });

  await waitForDeploymentAvailable(namespace, name, kubeConfig, options.timeoutMs ?? 300_000);

  const endpoint = `http://${name}.${namespace}.svc.cluster.local:${MINIO_PORT}`;
  // `mc mb --ignore-existing` keeps a re-run of the suite idempotent.
  await runTestPodAndReadLogs(
    {
      namespace,
      name: `${name}-mb`,
      image: MINIO_CLIENT_IMAGE,
      command: [
        'sh',
        '-c',
        `mc alias set fixture ${endpoint} "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" && ` +
          `mc mb --ignore-existing fixture/${bucket} && mc ls fixture`,
      ],
      envFrom: [{ secretRef: { name, optional: false } }],
      timeoutMs: 180_000,
    },
    kubeConfig
  );

  return { namespace, name, bucket, endpoint, secretName: name };
}

/** Wait until a Deployment reports at least one available replica. */
async function waitForDeploymentAvailable(
  namespace: string,
  name: string,
  kubeConfig: k8s.KubeConfig,
  timeoutMs: number
): Promise<void> {
  const appsApi = createAppsV1ApiClient(kubeConfig);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const deployment = await appsApi.readNamespacedDeployment({ namespace, name });
    if ((deployment.status?.availableReplicas ?? 0) >= 1) return;
    await Bun.sleep(2_000);
  }
  throw new Error(`Timed out waiting for Deployment ${namespace}/${name} to become available`);
}

/**
 * Remove the fixture. Namespace teardown normally covers this; the explicit
 * delete keeps a suite that shares a namespace honest.
 */
export async function deleteMinio(
  fixture: MinioFixture,
  kubeConfig: k8s.KubeConfig
): Promise<void> {
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const appsApi = createAppsV1ApiClient(kubeConfig);
  const { namespace, name } = fixture;

  const ignoreMissing = async (operation: () => Promise<unknown>): Promise<void> => {
    try {
      await operation();
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
    }
  };

  await ignoreMissing(() => appsApi.deleteNamespacedDeployment({ namespace, name }));
  await ignoreMissing(() => coreApi.deleteNamespacedService({ namespace, name }));
  await ignoreMissing(() => coreApi.deleteNamespacedSecret({ namespace, name }));
  await waitForResourceAbsent(
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { namespace, name } },
    kubeConfig,
    60_000
  );
}
