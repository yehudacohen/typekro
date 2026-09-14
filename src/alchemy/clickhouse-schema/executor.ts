/**
 * The default {@link ClickHouseExecutor}: `@kubernetes/client-node`'s `Exec` over the
 * Kubernetes API server's `pods/exec` subresource.
 *
 * WHY EXEC AND NOT A CLIENT CONNECTION. A converge runs wherever the alchemy runtime
 * runs — a laptop, a CI runner — which in general has no network path to a ClickHouse
 * pod. The alternatives are a port-forward (a second moving part, a local listening
 * socket, and a tunnel that has to outlive every statement) or exposing the native port
 * (a durable hole punched for a one-off migration). Exec needs neither: the statement
 * travels over the same authenticated API-server connection everything else uses, the
 * client runs next to the server, and the credentials stay inside the pod.
 *
 * RBAC: the identity running the converge needs `create` on `pods/exec` and `list` on
 * `pods` in the target namespace.
 */

import type { Readable, Writable } from 'node:stream';
import { PassThrough, Readable as NodeReadable } from 'node:stream';
import type { KubeConfig, V1Status } from '@kubernetes/client-node';
import { createBunCompatibleApiClient } from '../../core/kubernetes/bun-api-client.js';
import { getKubernetesClientNode } from '../../core/kubernetes/client-node-runtime.js';
import type {
  ClickHouseExecCommand,
  ClickHouseExecResult,
  ClickHouseExecutor,
  ClickHousePodSummary,
} from './types.js';

/** Collect a stream into a string, capped so a runaway command cannot exhaust memory. */
const MAX_CAPTURED_BYTES = 64 * 1024;

function collector(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  let size = 0;
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => {
    if (size >= MAX_CAPTURED_BYTES) return;
    const slice = chunk.subarray(0, MAX_CAPTURED_BYTES - size);
    chunks.push(slice);
    size += slice.length;
  });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

/**
 * Kubernetes reports a non-zero exit as a `Failure` status carrying an `ExitCode` cause.
 * A `Failure` with no such cause (the connection died mid-command, for instance) is
 * reported as exit 1 — a command failure, deliberately NOT a transient transport error,
 * because the statement may well have run.
 */
function exitCodeFromStatus(status: V1Status | undefined): number {
  if (!status) return 1;
  if (status.status === 'Success') return 0;
  const cause = status.details?.causes?.find((entry) => entry.reason === 'ExitCode');
  const parsed = Number.parseInt(cause?.message ?? '', 10);
  return Number.isNaN(parsed) ? 1 : parsed;
}

/** `Exec` over the API server. Constructed per resource from the resolved KubeConfig. */
export class KubeExecClickHouseExecutor implements ClickHouseExecutor {
  constructor(private readonly kubeConfig: KubeConfig) {}

  async listPods(
    namespace: string,
    podSelector: Readonly<Record<string, string>>,
    _abortSignal?: AbortSignal
  ): Promise<readonly ClickHousePodSummary[]> {
    const clientNode = getKubernetesClientNode();
    const coreApi = createBunCompatibleApiClient(this.kubeConfig, clientNode.CoreV1Api);
    const labelSelector = Object.entries(podSelector)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const pods = await coreApi.listNamespacedPod({ namespace, labelSelector });
    return pods.items.flatMap((pod): ClickHousePodSummary[] => {
      const name = pod.metadata?.name;
      if (!name) return [];
      // A terminating pod still reports Ready for a while; exec'ing into one races the
      // kubelet's SIGTERM, so it is not a candidate.
      const terminating = pod.metadata?.deletionTimestamp !== undefined;
      const ready =
        !terminating &&
        (pod.status?.conditions ?? []).some(
          (condition) => condition.type === 'Ready' && condition.status === 'True'
        );
      return [
        {
          name,
          ready,
          containers: (pod.spec?.containers ?? []).flatMap((c) => (c.name ? [c.name] : [])),
        },
      ];
    });
  }

  async exec(
    command: ClickHouseExecCommand,
    abortSignal?: AbortSignal
  ): Promise<ClickHouseExecResult> {
    const clientNode = getKubernetesClientNode();
    const exec = new clientNode.Exec(this.kubeConfig);
    const stdout = collector();
    const stderr = collector();
    const stdin: Readable = NodeReadable.from([Buffer.from(command.stdin, 'utf8')]);

    return await new Promise<ClickHouseExecResult>((resolve, reject) => {
      let status: V1Status | undefined;
      let settled = false;
      let socket: { close: () => void } | undefined;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
        fn();
      };
      const fail = (error: Error) => {
        finish(() => {
          try {
            socket?.close();
          } catch {
            // The socket may already be gone; the original failure is what matters.
          }
          reject(error);
        });
      };
      const onAbort = () => fail(new Error('ClickHouse exec aborted'));
      const timer = setTimeout(
        () => fail(new Error(`ClickHouse exec timed out after ${command.timeoutMs}ms`)),
        command.timeoutMs
      );

      abortSignal?.addEventListener('abort', onAbort, { once: true });
      if (abortSignal?.aborted) {
        onAbort();
        return;
      }

      exec
        .exec(
          command.namespace,
          command.podName,
          command.container,
          [...command.command],
          stdout.stream,
          stderr.stream,
          stdin,
          false,
          (received) => {
            status = received;
          }
        )
        .then((ws) => {
          socket = ws;
          // A websocket error before the command completes is a TRANSPORT failure and is
          // what the retry loop exists for; a clean close carries the command's own status.
          ws.on('error', (error: Error) => fail(error));
          ws.on('close', () => {
            finish(() =>
              resolve({
                stdout: stdout.text(),
                stderr: stderr.text(),
                exitCode: exitCodeFromStatus(status),
              })
            );
          });
        })
        .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
    });
  }
}
