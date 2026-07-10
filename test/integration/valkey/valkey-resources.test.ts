/**
 * Opt-in live Valkey proof against a real cluster.
 *
 * RUN_VALKEY_INTEGRATION=true bun test test/integration/valkey/valkey-resources.test.ts
 *
 * Requires the Hyperspike v0.0.61 operator, KRO, Flux, and a default
 * ReadWriteOnce StorageClass. Every run uses a unique namespace and deletes
 * only resources it created.
 */

import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { Cel } from '../../../src/core/references/cel.js';
import { isKubernetesRef } from '../../../src/utils/type-guards.js';
import { valkey } from '../../../src/factories/valkey/resources/valkey.js';
import {
  deleteNamespaceAndWait,
  ensureNamespaceExists,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

const runRequested = process.env.RUN_VALKEY_INTEGRATION === 'true';
const describeOrSkip = runRequested && isClusterAvailable() ? describe : describe.skip;
const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
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

async function runClient(name: string, serviceName: string, commands: string): Promise<string> {
  return kubectl([
    'run',
    name,
    '--namespace',
    namespace,
    '--image=valkey/valkey:8.1-alpine',
    '--restart=Never',
    '--rm',
    '-i',
    '--command',
    '--',
    'sh',
    '-ec',
    `until valkey-cli -h ${serviceName} PING >/dev/null 2>&1; do sleep 2; done; ${commands}`,
  ]);
}

async function proveDataPlane(mode: 'direct' | 'kro', name: string): Promise<void> {
  const kubeConfig = getKubeConfig({ skipTLSVerify: true });
  const factory = liveValkey.factory(mode, {
    namespace,
    waitForReady: true,
    timeout: 600_000,
    kubeConfig,
  });

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
      ].join('; ')
    );
    expect(beforeRestart).toContain('appendonly');
    expect(beforeRestart).toContain('no');

    const pod = await kubectl([
      'get',
      'pods',
      '-n',
      namespace,
      '-l',
      `app.kubernetes.io/instance=${name}`,
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ]);
    expect(pod).not.toBe('');
    await kubectl(['delete', 'pod', pod, '-n', namespace, '--wait=true']);
    await kubectl([
      'wait',
      '--for=condition=Ready',
      'pod',
      '-l',
      `app.kubernetes.io/instance=${name}`,
      '-n',
      namespace,
      '--timeout=300s',
    ]);

    const recovered = await runClient(
      `${name}-client-b`,
      name,
      `test "$(valkey-cli -h ${name} GET e2e-key)" = e2e-value; valkey-cli -h ${name} XLEN e2e-stream`
    );
    const streamLength = recovered.match(/^\d+$/m)?.[0];
    expect(Number(streamLength)).toBeGreaterThanOrEqual(1);
  } finally {
    await factory.deleteInstance(name).catch(() => {});
    await kubectl([
      'delete',
      'valkey',
      name,
      '-n',
      namespace,
      '--ignore-not-found=true',
      '--wait=true',
      '--timeout=120s',
    ]).catch(() => {});
  }
}

describeOrSkip('Valkey live direct and KRO integration', () => {
  const kubeConfig = getKubeConfig({ skipTLSVerify: true });

  afterAll(async () => {
    await deleteNamespaceAndWait(namespace, kubeConfig, 180_000).catch((error: unknown) => {
      console.error('Valkey integration cleanup failed:', error);
    });
    await kubectl([
      'delete',
      'resourcegraphdefinition',
      'live-valkey-cluster',
      '--ignore-not-found=true',
      '--wait=true',
      '--timeout=120s',
    ]).catch(() => {});
  });

  it('executes commands and Streams and recovers an explicit RDB snapshot in direct mode', async () => {
    await kubectl([
      'delete',
      'resourcegraphdefinition',
      'live-valkey-cluster',
      '--ignore-not-found=true',
      '--wait=true',
      '--timeout=120s',
    ]);
    await ensureNamespaceExists(namespace, kubeConfig);
    await proveDataPlane('direct', 'direct-cache');
  });

  it('projects readiness and executes the same data-plane proof in KRO mode', async () => {
    await ensureNamespaceExists(namespace, kubeConfig);
    await proveDataPlane('kro', 'kro-cache');
  });
});
