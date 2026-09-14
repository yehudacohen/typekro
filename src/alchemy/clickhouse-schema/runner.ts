/**
 * Convergence logic for the `ClickHouseSchema` alchemy resource: fingerprinting,
 * `clickhouse-client` command rendering, Ready-pod selection and statement execution.
 *
 * Kept free of alchemy and of `@kubernetes/client-node` so it can be exercised whole
 * against an injected {@link ClickHouseExecutor}.
 */

import { createHash } from 'node:crypto';
import {
  type ClickHouseExecutor,
  type ClickHousePodSummary,
  type ClickHouseSchemaConfig,
  ClickHouseSchemaError,
  type ClickHouseSchemaState,
  parseClickHouseErrorCode,
  redactClickHouseText,
} from './types.js';

/** The Altinity CHI server container name (see `clickHouseInstallation`'s pod template). */
export const DEFAULT_CLICKHOUSE_CONTAINER = 'clickhouse';

/** ClickHouse's native protocol port, which `clickhouse-client` speaks. */
export const DEFAULT_CLICKHOUSE_PORT = 9000;

export const DEFAULT_CLICKHOUSE_USER = 'default';
export const DEFAULT_CLICKHOUSE_DATABASE = 'default';

/**
 * Default environment variable read for the password INSIDE the container.
 *
 * This is the convention every in-repo ClickHouse workload already uses: the ClickStack
 * retention CronJob reads `CLICKHOUSE_PASSWORD`, and `clickHouseS3BackupCronJob` sets
 * that same variable from the credentials Secret. `clickhouse-client` also honours
 * `CLICKHOUSE_PASSWORD` natively, but this resource does NOT depend on that: it passes
 * `--password "${VAR:-}"` explicitly through `sh -c`, which behaves identically for a
 * custom `passwordEnv` and on images whose client build predates the native support.
 */
export const DEFAULT_CLICKHOUSE_PASSWORD_ENV = 'CLICKHOUSE_PASSWORD';

export const DEFAULT_WAIT_FOR_POD_TIMEOUT_MS = 120_000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = 1_000;
const POD_POLL_INTERVAL_MS = 2_000;

/** Injected clock and sleep, so the wait/timeout and backoff paths are testable. */
export interface ClickHouseSchemaRuntimeDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export const defaultRuntimeDeps: ClickHouseSchemaRuntimeDeps = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** Single-quote a word for `sh -c`, closing and reopening around any embedded quote. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function resolveDatabase(config: ClickHouseSchemaConfig): string {
  return config.client?.database ?? DEFAULT_CLICKHOUSE_DATABASE;
}

export function resolveContainer(config: ClickHouseSchemaConfig): string {
  return config.target.container ?? DEFAULT_CLICKHOUSE_CONTAINER;
}

/**
 * The `sh -c` command run inside the server container.
 *
 * The password is expanded from the container's OWN environment (`"${VAR:-}"`, a POSIX
 * default expansion so an unset variable means the empty password the stock Altinity
 * `default` user has) and is therefore never in props, never in alchemy state, never in
 * this process's memory, and never echoed. `exec` replaces the shell so the client is
 * the container's direct child and receives the statement on stdin unbuffered.
 *
 * `--host 127.0.0.1`: the exec already landed inside a server pod, so the connection
 * never leaves it. There is no port-forward and no network path from the runner.
 */
export function renderClickHouseCommand(config: ClickHouseSchemaConfig): readonly string[] {
  const user = config.client?.user ?? DEFAULT_CLICKHOUSE_USER;
  const port = config.client?.port ?? DEFAULT_CLICKHOUSE_PORT;
  const passwordEnv = config.client?.passwordEnv ?? DEFAULT_CLICKHOUSE_PASSWORD_ENV;
  const settings = Object.entries(config.settings ?? {}).map(
    ([name, value]) => `--${name}=${shellQuote(String(value))}`
  );
  const client = [
    'exec clickhouse-client',
    '--host 127.0.0.1',
    `--port ${port}`,
    `--user ${shellQuote(user)}`,
    `--database ${shellQuote(resolveDatabase(config))}`,
    // POSIX default-value expansion: an unset variable means the empty password.
    `--password "\${${passwordEnv}:-}"`,
    ...settings,
  ].join(' ');
  return ['sh', '-c', client];
}

/**
 * sha256 over the ordered statements, the settings and the client configuration.
 *
 * The TARGET is deliberately NOT part of the fingerprint — it describes where to reach
 * the server, not what is applied — so {@link needsApply} compares it separately and a
 * re-pointed resource re-applies even though its DDL is byte-identical.
 */
export function computeFingerprint(config: ClickHouseSchemaConfig): string {
  const canonical = JSON.stringify({
    statements: config.statements,
    settings: Object.entries(config.settings ?? {})
      .map(([name, value]): [string, string] => [name, String(value)])
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    client: {
      user: config.client?.user ?? DEFAULT_CLICKHOUSE_USER,
      passwordEnv: config.client?.passwordEnv ?? DEFAULT_CLICKHOUSE_PASSWORD_ENV,
      database: resolveDatabase(config),
      port: config.client?.port ?? DEFAULT_CLICKHOUSE_PORT,
    },
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Whether a converge must (re-)run the statements against this target. */
export function needsApply(
  config: ClickHouseSchemaConfig,
  previous: ClickHouseSchemaState | undefined
): boolean {
  if (!previous) return true;
  if (previous.fingerprint !== computeFingerprint(config)) return true;
  return (
    JSON.stringify({
      namespace: previous.target.namespace,
      podSelector: previous.target.podSelector,
      container: previous.target.container,
    }) !==
    JSON.stringify({
      namespace: config.target.namespace,
      podSelector: config.target.podSelector,
      container: config.target.container,
    })
  );
}

/**
 * Poll until a Ready pod matching the selector exists, or the budget runs out.
 *
 * A ClickHouse server accepts connections only once it is Ready, and a CHI rollout has
 * a window where pods exist but are still replaying logs — exec'ing then produces a
 * connection-refused that looks like a SQL failure. Waiting for readiness first is what
 * makes "ordered after the instance is ready" true in practice as well as in the
 * dependency graph.
 */
export async function selectReadyPod(
  executor: ClickHouseExecutor,
  config: ClickHouseSchemaConfig,
  resourceId: string,
  deps: ClickHouseSchemaRuntimeDeps = defaultRuntimeDeps,
  abortSignal?: AbortSignal
): Promise<ClickHousePodSummary> {
  const timeoutMs = config.waitForPod?.timeoutMs ?? DEFAULT_WAIT_FOR_POD_TIMEOUT_MS;
  const container = resolveContainer(config);
  const deadline = deps.now() + timeoutMs;
  let lastSeen = 0;

  for (;;) {
    const pods = await executor.listPods(
      config.target.namespace,
      config.target.podSelector,
      abortSignal
    );
    lastSeen = pods.length;
    const ready = pods.find((pod) => pod.ready);
    if (ready) {
      if (ready.containers.length > 0 && !ready.containers.includes(container)) {
        throw new ClickHouseSchemaError(
          `ClickHouseSchema '${resourceId}': pod ${config.target.namespace}/${ready.name} has no ` +
            `container '${container}' (has: ${ready.containers.join(', ')}). Set target.container.`,
          resourceId
        );
      }
      return ready;
    }
    if (deps.now() >= deadline) {
      throw new ClickHouseSchemaError(
        `ClickHouseSchema '${resourceId}': no Ready pod matched ${selectorText(config)} in ` +
          `namespace '${config.target.namespace}' within ${timeoutMs}ms (${lastSeen} pod(s) matched ` +
          `the selector but none were Ready).`,
        resourceId
      );
    }
    await deps.sleep(Math.min(POD_POLL_INTERVAL_MS, Math.max(0, deadline - deps.now())));
  }
}

function selectorText(config: ClickHouseSchemaConfig): string {
  return Object.entries(config.target.podSelector)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

/**
 * Run one statement, retrying only TRANSIENT transport failures.
 *
 * The two failure modes are kept strictly apart (see {@link ClickHouseExecutor}): a
 * rejected exec is the transport, a non-zero exit code is the server. Re-issuing a
 * statement the server actively rejected cannot help and, for a statement that is not
 * perfectly idempotent, can compound the damage.
 */
async function runStatement(
  executor: ClickHouseExecutor,
  config: ClickHouseSchemaConfig,
  resourceId: string,
  podName: string,
  statement: string,
  index: number,
  deps: ClickHouseSchemaRuntimeDeps,
  abortSignal?: AbortSignal
): Promise<void> {
  const maxAttempts = config.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = config.retry?.backoffMs ?? DEFAULT_BACKOFF_MS;
  const command = {
    namespace: config.target.namespace,
    podName,
    container: resolveContainer(config),
    command: renderClickHouseCommand(config),
    stdin: `${statement.trim()}\n`,
    timeoutMs: config.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
  };

  let lastTransport: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let result: Awaited<ReturnType<ClickHouseExecutor['exec']>>;
    try {
      result = await executor.exec(command, abortSignal);
    } catch (error) {
      lastTransport = error instanceof Error ? error : new Error(String(error));
      if (attempt === maxAttempts) break;
      await deps.sleep(backoffMs * attempt);
      continue;
    }

    if (result.exitCode === 0) return;

    // A server-side failure. Surface the INDEX and ClickHouse's code; never the SQL.
    const output = redactClickHouseText(`${result.stderr}\n${result.stdout}`.trim());
    const code = parseClickHouseErrorCode(output);
    throw new ClickHouseSchemaError(
      `ClickHouseSchema '${resourceId}': statement ${index} failed` +
        `${code === undefined ? '' : ` with ClickHouse code ${code}`} ` +
        `(exit ${result.exitCode}).`,
      resourceId,
      index,
      code,
      output
    );
  }

  throw new ClickHouseSchemaError(
    `ClickHouseSchema '${resourceId}': exec transport failed for statement ${index} after ` +
      `${maxAttempts} attempt(s): ${redactClickHouseText(lastTransport?.message ?? 'unknown error')}`,
    resourceId,
    index,
    undefined,
    undefined,
    lastTransport ? { cause: lastTransport } : undefined
  );
}

/** Run an ordered statement list against one Ready pod, stopping at the first failure. */
export async function runStatements(
  executor: ClickHouseExecutor,
  config: ClickHouseSchemaConfig,
  resourceId: string,
  statements: readonly string[],
  deps: ClickHouseSchemaRuntimeDeps = defaultRuntimeDeps,
  abortSignal?: AbortSignal
): Promise<{ readonly podName: string }> {
  const pod = await selectReadyPod(executor, config, resourceId, deps, abortSignal);
  for (const [index, statement] of statements.entries()) {
    await runStatement(executor, config, resourceId, pod.name, statement, index, deps, abortSignal);
  }
  return { podName: pod.name };
}

/**
 * Converge the schema: no-op when nothing changed, otherwise re-run EVERY statement.
 *
 * There is no partial application. A fingerprint change re-runs the whole ordered list,
 * which is only correct because every statement is required to be idempotent — and it is
 * also what makes a failed converge recoverable: the fingerprint is recorded only after
 * the last statement succeeds, so a run that dies at statement 7 re-runs 0..6 next time.
 */
export async function applyClickHouseSchema(
  executor: ClickHouseExecutor,
  config: ClickHouseSchemaConfig,
  resourceId: string,
  previous: ClickHouseSchemaState | undefined,
  deps: ClickHouseSchemaRuntimeDeps = defaultRuntimeDeps,
  abortSignal?: AbortSignal
): Promise<ClickHouseSchemaState> {
  if (!needsApply(config, previous) && previous) return previous;

  const { podName } = await runStatements(
    executor,
    config,
    resourceId,
    config.statements,
    deps,
    abortSignal
  );

  return {
    fingerprint: computeFingerprint(config),
    appliedAt: new Date(deps.now()).toISOString(),
    statementCount: config.statements.length,
    database: resolveDatabase(config),
    target: config.target,
    podName,
  };
}

/**
 * Teardown. `retain` touches nothing at all — not even the cluster — so a destroyed
 * stack leaves the data and the schema exactly as they were.
 */
export async function deleteClickHouseSchema(
  executor: ClickHouseExecutor,
  config: ClickHouseSchemaConfig,
  resourceId: string,
  deps: ClickHouseSchemaRuntimeDeps = defaultRuntimeDeps,
  abortSignal?: AbortSignal
): Promise<void> {
  if (config.onDelete !== 'run') return;
  const statements = config.deleteStatements ?? [];
  if (statements.length === 0) return;
  await runStatements(executor, config, resourceId, statements, deps, abortSignal);
}
