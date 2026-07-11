/**
 * Opt-in live NATS JetStream proof against a real cluster.
 *
 * RUN_NATS_INTEGRATION=true bun test test/integration/nats/jetstream-resources.test.ts
 *
 * Requires Flux, KRO, and a default ReadWriteOnce StorageClass. Each mode
 * installs the official NATS and NACK charts, then reconciles a real Stream
 * and Consumer through NACK. Every run uses unique namespaces.
 */

import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { Cel } from '../../../src/core/references/cel.js';
import { natsBootstrap } from '../../../src/factories/nats/compositions/nats-bootstrap.js';
import {
  jetStreamConsumer,
  jetStreamStream,
} from '../../../src/factories/nats/resources/jetstream.js';
import {
  deleteNamespaceAndWait,
  ensureNamespaceExists,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

const runRequested = process.env.RUN_NATS_INTEGRATION === 'true';
const describeOrSkip = runRequested && isClusterAvailable() ? describe : describe.skip;
const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;

setDefaultTimeout(1_200_000);

const liveResources = kubernetesComposition(
  {
    name: 'live-jetstream-resources',
    kind: 'LiveJetStreamResources',
    spec: type({ name: 'string', namespace: 'string', endpoint: 'string' }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    const stream = jetStreamStream({
      id: 'events',
      name: 'application-events',
      streamName: 'APPLIK8S_EVENTS',
      namespace: spec.namespace,
      subjects: ['applik8s.events.>'],
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
        consumer.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
    };
  }
);

async function kubectl(args: string[], timeout = 300_000): Promise<string> {
  const proc = Bun.spawn(['kubectl', ...args], { stdout: 'pipe', stderr: 'pipe' });
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

const namespaces = new Set<string>();

async function proveMode(mode: 'direct' | 'kro'): Promise<void> {
  const suffix = `${mode}-${runId}`.slice(0, 42);
  const controlNamespace = `tk-nats-control-${suffix}`.slice(0, 63);
  const targetNamespace = `tk-nats-${suffix}`.slice(0, 63);
  const appNamespace = `tk-nats-app-${suffix}`.slice(0, 63);
  const kubeConfig = getKubeConfig({ skipTLSVerify: true });
  namespaces.add(controlNamespace);
  namespaces.add(targetNamespace);
  namespaces.add(appNamespace);
  await ensureNamespaceExists(controlNamespace, kubeConfig);
  await ensureNamespaceExists(appNamespace, kubeConfig);

  const platformFactory = natsBootstrap.factory(mode, {
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

  try {
    const platform = await platformFactory.deploy({
      name: 'nats',
      namespace: targetNamespace,
      storageSize: '1Gi',
    });

    if (mode === 'kro') {
      expect(platform.status.ready).toBe(true);
      expect(platform.status.phase).toBe('Ready');
    }

    const endpoint = `nats://nats.${targetNamespace}.svc:4222`;
    const resources = await resourcesFactory.deploy({
      name: 'resources',
      namespace: appNamespace,
      endpoint,
    });

    if (mode === 'kro') expect(resources.status.ready).toBe(true);

    const ready = await kubectl([
      'get',
      'streams.jetstream.nats.io/application-events',
      'consumers.jetstream.nats.io/account-commands',
      '-n',
      appNamespace,
      '-o',
      'jsonpath={range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}',
    ]);
    expect(ready.split('\n')).toEqual(['True', 'True']);

    const dataPlane = await kubectl([
      'run',
      `nats-box-${mode}`,
      '--namespace',
      appNamespace,
      '--image=natsio/nats-box:0.19.2',
      '--restart=Never',
      '--rm',
      '-i',
      '--command',
      '--',
      'sh',
      '-ec',
      `nats --server ${endpoint} pub applik8s.events.test hello >/dev/null; nats --server ${endpoint} stream info APPLIK8S_EVENTS --json`,
    ]);
    const jsonStart = dataPlane.indexOf('{');
    const jsonEnd = dataPlane.lastIndexOf('}');
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    expect(jsonEnd).toBeGreaterThan(jsonStart);
    const streamInfo = JSON.parse(dataPlane.slice(jsonStart, jsonEnd + 1)) as {
      state?: { messages?: number };
    };
    expect(streamInfo.state?.messages).toBeGreaterThanOrEqual(1);
  } finally {
    await resourcesFactory.deleteInstance('resources').catch(() => {});
    await kubectl([
      'delete',
      'streams.jetstream.nats.io/application-events',
      'consumers.jetstream.nats.io/account-commands',
      '-n',
      appNamespace,
      '--ignore-not-found=true',
      '--wait=true',
      '--timeout=120s',
    ]).catch(() => {});
    await platformFactory.deleteInstance('nats').catch(() => {});
    await kubectl([
      'delete',
      'namespace',
      targetNamespace,
      '--ignore-not-found=true',
      '--wait=true',
      '--timeout=300s',
    ]).catch(() => {});
  }
}

describeOrSkip('NATS JetStream live direct and KRO integration', () => {
  afterAll(async () => {
    const kubeConfig = getKubeConfig({ skipTLSVerify: true });
    for (const namespace of [...namespaces].reverse()) {
      await deleteNamespaceAndWait(namespace, kubeConfig, 300_000).catch((error: unknown) => {
        console.error(`NATS integration cleanup failed for ${namespace}:`, error);
      });
    }
    for (const rgd of ['nats-bootstrap', 'live-jetstream-resources']) {
      await kubectl([
        'delete',
        'resourcegraphdefinition',
        rgd,
        '--ignore-not-found=true',
        '--wait=true',
        '--timeout=120s',
      ]).catch(() => {});
    }
  });

  it('installs NATS/NACK and reconciles a persisted Stream and Consumer in direct mode', async () => {
    await proveMode('direct');
  });

  it('projects readiness and reconciles the same resources through KRO', async () => {
    await proveMode('kro');
  });
});
