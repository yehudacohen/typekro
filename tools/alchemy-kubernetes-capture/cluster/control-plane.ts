// Cluster slice for the generated Rivet control plane. Run from the TypeKro root with
// `bun tools/alchemy-kubernetes-capture/cluster/control-plane.ts up|down`.
// It touches only the namespace below, the one RGD and the CRD kro generates for it.
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import * as k8s from '@kubernetes/client-node';
import {
  createBunCompatibleAppsV1Api,
  createBunCompatibleBatchV1Api,
  createBunCompatibleCoreV1Api,
  createBunCompatibleCustomObjectsApi,
} from '../../../src/core/kubernetes/bun-api-client.js';
import {
  rivetControlPlane,
  rivetControlPlaneAdminToken,
} from '../generated/rivet-control-plane.js';

/** A local cluster context; the runner refuses any API server that is not on loopback. */
export const CONTEXT = process.env.TKCAPTURE_KUBE_CONTEXT ?? 'orbstack';
export const NAMESPACE = 'typekro-rivet-spike';
export const INSTANCE = 'rivet';
/** Alchemy's default engine image, pinned to its multi-arch index digest (2026-11-18). */
export const ENGINE_IMAGE =
  'rivetdev/engine:3.0.0@sha256:5ae3c24275eeff87ad1962f4d66fcdb85786fc1397feeeb55afc2ca1f7ccf6f2';

const receiptPath = process.env.TKCAPTURE_RECEIPT;

function record(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  console.log(line);
  if (receiptPath) appendFileSync(receiptPath, `${line}\n`);
}

async function timed<T>(step: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    record({ step, ok: true, ms: Date.now() - started });
    return result;
  } catch (error) {
    record({ step, ok: false, ms: Date.now() - started, error: String(error).slice(0, 2000) });
    throw error;
  }
}

function kubeConfig(): k8s.KubeConfig {
  const config = new k8s.KubeConfig();
  config.loadFromDefault();
  config.setCurrentContext(CONTEXT);
  if (config.getCurrentContext() !== CONTEXT)
    throw new Error(`Context ${CONTEXT} is not available.`);
  return config;
}

async function up(): Promise<void> {
  const config = kubeConfig();
  const core = createBunCompatibleCoreV1Api(config);
  await timed('namespace', async () => {
    const existing = await core.readNamespace({ name: NAMESPACE }).catch(() => undefined);
    if (existing) throw new Error(`Namespace ${NAMESPACE} already exists; refusing to reuse it.`);
    await core.createNamespace({
      body: {
        metadata: {
          name: NAMESPACE,
          labels: { 'typekro.dev/spike': 'alchemy-kubernetes-capture' },
        },
      },
    });
  });
  await timed('admin-token-secret (direct)', async () => {
    const factory = await rivetControlPlaneAdminToken.factory('direct', {
      namespace: NAMESPACE,
      kubeConfig: config,
      waitForReady: true,
      timeout: 120_000,
    });
    // Generated here and written only into the Secret; never printed or recorded.
    await factory.deploy({
      name: INSTANCE,
      namespace: NAMESPACE,
      token: randomBytes(32).toString('hex'),
    });
  });
  const factory = await rivetControlPlane.factory('kro', {
    namespace: NAMESPACE,
    kubeConfig: config,
    waitForReady: true,
    timeout: 600_000,
  });
  await timed('rgd + instance (kro)', () =>
    factory.deploy({
      name: INSTANCE,
      namespace: NAMESPACE,
      image: ENGINE_IMAGE,
      diskSize: '1Gi',
      pool: 'default',
    })
  );
  await timed('instance status', async () => {
    const custom = createBunCompatibleCustomObjectsApi(config);
    const instance = (await custom.getNamespacedCustomObject({
      group: 'kro.run',
      version: 'v1alpha1',
      namespace: NAMESPACE,
      plural: 'rivetcontrolplanes',
      name: INSTANCE,
    })) as { status?: { ready?: boolean; nodeEndpoint?: string; state?: string } };
    record({ step: 'instance status values', status: instance.status ?? null });
    if (instance.status?.ready !== true || !instance.status.nodeEndpoint) {
      throw new Error('The instance is not ready with a nodeEndpoint.');
    }
  });
}

async function down(): Promise<void> {
  const config = kubeConfig();
  const factory = await rivetControlPlane.factory('kro', {
    namespace: NAMESPACE,
    kubeConfig: config,
    waitForReady: true,
    timeout: 300_000,
  });
  await timed('delete instance (kro)', () => factory.deleteInstance(INSTANCE));
  await timed('instance objects removed', async () => {
    const apps = createBunCompatibleAppsV1Api(config);
    const core = createBunCompatibleCoreV1Api(config);
    const batch = createBunCompatibleBatchV1Api(config);
    const deadline = Date.now() + 180_000;
    for (;;) {
      const left = [
        ...(await apps.listNamespacedStatefulSet({ namespace: NAMESPACE })).items.map(
          (item) => `StatefulSet/${item.metadata?.name}`
        ),
        ...(await core.listNamespacedService({ namespace: NAMESPACE })).items.map(
          (item) => `Service/${item.metadata?.name}`
        ),
        ...(await batch.listNamespacedJob({ namespace: NAMESPACE })).items.map(
          (item) => `Job/${item.metadata?.name}`
        ),
      ];
      if (left.length === 0) return;
      if (Date.now() > deadline) throw new Error(`kro left objects behind: ${left.join(', ')}`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  });
}

const phase = process.argv[2];
if (phase === 'up') await up();
else if (phase === 'down') await down();
else throw new Error('Usage: control-plane.ts up|down');
process.exit(0);
