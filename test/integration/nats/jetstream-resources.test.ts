/**
 * Opt-in live NATS JetStream proof against a real cluster.
 *
 * RUN_NATS_INTEGRATION=true bun test test/integration/nats/jetstream-resources.test.ts
 *
 * Requires Flux, KRO, and a default ReadWriteOnce StorageClass. Each mode
 * installs the official NATS and NACK charts, then reconciles a real Stream
 * and Consumer through NACK. Every run uses unique namespaces.
 */

import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { Cel } from '../../../src/core/references/cel.js';
import { natsBootstrap } from '../../../src/factories/nats/compositions/nats-bootstrap.js';
import {
  DEFAULT_NACK_VERSION,
  DEFAULT_NATS_VERSION,
} from '../../../src/factories/nats/resources/helm.js';
import {
  jetStreamConsumer,
  jetStreamStream,
} from '../../../src/factories/nats/resources/jetstream.js';
import {
  ensureNamespaceExists,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

const clusterAvailable = isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;
const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;

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

function isAlreadyAbsentInstance(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Instance not found:');
}

async function proveMode(mode: 'direct' | 'kro'): Promise<void> {
  const suffix = `${mode}-${runId}`.slice(0, 42);
  const controlNamespace = `tk-nats-control-${suffix}`.slice(0, 63);
  const targetNamespace = `tk-nats-${suffix}`.slice(0, 63);
  const appNamespace = `tk-nats-app-${suffix}`.slice(0, 63);
  const kubeConfig = getIntegrationTestKubeConfig();
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
  let testFailure: Error | undefined;

  try {
    const platform = await platformFactory.deploy({
      name: 'nats',
      namespace: targetNamespace,
      replicas: mode === 'kro' ? 3 : 1,
      storageSize: '1Gi',
      pvcRetentionPolicy: 'delete',
      ...(process.env.TYPEKRO_NATS_STORAGE_CLASS
        ? { storageClassName: process.env.TYPEKRO_NATS_STORAGE_CLASS }
        : {}),
    });

    expect(platform.status).toEqual({
      ready: true,
      failed: false,
      phase: 'Ready',
      serverVersion: DEFAULT_NATS_VERSION,
      controllerVersion: DEFAULT_NACK_VERSION,
      endpoint: `nats://nats.${targetNamespace}.svc:4222`,
    });

    if (mode === 'kro') {
      await kubectl([
        'rollout',
        'status',
        'statefulset/nats',
        '-n',
        targetNamespace,
        '--timeout=600s',
      ]);
      const readyReplicas = await kubectl([
        'get',
        'statefulset/nats',
        '-n',
        targetNamespace,
        '-o',
        'jsonpath={.status.readyReplicas}',
      ]);
      expect(readyReplicas).toBe('3');
    }

    const endpoint = `nats://nats.${targetNamespace}.svc:4222`;
    const resources = await resourcesFactory.deploy({
      name: 'resources',
      namespace: appNamespace,
      endpoint,
      description: 'initial live proof',
    });

    expect(resources.status).toEqual({ ready: true });

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

    const updatedResources = await resourcesFactory.deploy({
      name: 'resources',
      namespace: appNamespace,
      endpoint,
      description: 'updated live proof',
    });
    expect(updatedResources.status).toEqual({ ready: true });
    const generation = await kubectl([
      'get',
      'streams.jetstream.nats.io/application-events',
      '-n',
      appNamespace,
      '-o',
      'jsonpath={.metadata.generation}:{.status.observedGeneration}:{.spec.description}',
    ]);
    expect(generation).toMatch(/^(\d+):\1:updated live proof$/);

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
  } catch (error: unknown) {
    testFailure = error instanceof Error ? error : new Error(String(error));
  }

  const cleanupFailures: Error[] = [];
  // Delete in dependency order and let each factory enforce its own lifecycle.
  // In KRO mode deleteInstance() waits for kro.run/finalizer and deliberately
  // preserves the RGD when finalization times out, so KRO can keep recovering.
  for (const [label, cleanup] of [
    ['JetStream resources', () => resourcesFactory.deleteInstance('resources')],
    ['NATS platform', () => platformFactory.deleteInstance('nats')],
  ] as const) {
    try {
      await cleanup();
    } catch (error: unknown) {
      if (!isAlreadyAbsentInstance(error)) {
        cleanupFailures.push(
          new Error(
            `${mode} cleanup failed for ${label}: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    }
  }
  try {
    const remainingTargetNamespace = await kubectl([
      'get',
      'namespace',
      targetNamespace,
      '--ignore-not-found=true',
      '-o',
      'name',
    ]);
    if (remainingTargetNamespace) {
      cleanupFailures.push(
        new Error(`${mode} cleanup left the factory-owned namespace ${targetNamespace} behind`)
      );
    }
  } catch (error: unknown) {
    cleanupFailures.push(
      new Error(
        `${mode} cleanup could not verify namespace ${targetNamespace}: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
  for (const namespace of [appNamespace, controlNamespace]) {
    try {
      await kubectl([
        'delete',
        'namespace',
        namespace,
        '--ignore-not-found=true',
        '--wait=true',
        '--timeout=300s',
      ]);
    } catch (error: unknown) {
      cleanupFailures.push(
        new Error(
          `${mode} cleanup failed for namespace ${namespace}: ${error instanceof Error ? error.message : String(error)}`
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
});
