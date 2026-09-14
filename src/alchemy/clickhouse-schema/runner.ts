/**
 * Convergence logic for the `ClickHouseSchema` alchemy resource: fingerprinting,
 * `clickhouse-client` command rendering, Ready-pod selection and statement execution.
 *
 * Kept free of alchemy and of `@kubernetes/client-node` so it can be exercised whole
 * against an injected {@link ClickHouseExecutor}.
 */

import { createHash } from 'node:crypto';
import { getComponentLogger } from '../../core/logging/index.js';
import {
  type ClickHouseExecutor,
  type ClickHousePodSummary,
  type ClickHouseSchemaConfig,
  ClickHouseSchemaError,
  type ClickHouseSchemaState,
  parseClickHouseErrorCode,
  parseClickHouseExceptionName,
  redactClickHouseOutput,
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
 * sha256 over the ordered statements, the settings, the client configuration and the
 * execution model.
 *
 * The TARGET is deliberately NOT part of the fingerprint — it describes where to reach
 * the server, not what is applied — so {@link needsApply} compares it separately and a
 * re-pointed resource re-applies even though its DDL is byte-identical.
 *
 * The EXECUTION MODEL is part of it, because switching from `onCluster` to `fanout`
 * changes which servers the identical statements reached, and that is a change to what is
 * applied even though the SQL is untouched.
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
    execution: config.execution,
    replicatedDatabases: [...(config.replicatedDatabases ?? [])].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Everything one converge needs, in one place.
 *
 * An options object rather than a parameter list: the execution model gives the runner
 * several independent knobs, and `clusterId` is not derivable here at all — the runner is
 * deliberately free of `@kubernetes/client-node`, so the identity of the cluster it is
 * talking to has to arrive from the provider that built the transport.
 */
export interface ClickHouseSchemaRunContext {
  readonly executor: ClickHouseExecutor;
  readonly config: ClickHouseSchemaConfig;
  /** The alchemy resource `id` — what every error and log line is attributed to. */
  readonly resourceId: string;
  /** Credential-free cluster identity; see {@link ClickHouseSchemaState.clusterId}. */
  readonly clusterId?: string | undefined;
  readonly deps?: ClickHouseSchemaRuntimeDeps | undefined;
  readonly abortSignal?: AbortSignal | undefined;
}

function runtimeDeps(context: ClickHouseSchemaRunContext): ClickHouseSchemaRuntimeDeps {
  return context.deps ?? defaultRuntimeDeps;
}

/**
 * Whether a converge must (re-)run the statements against this target.
 *
 * Three things are compared, and the third is the one that is easy to forget: the
 * fingerprint (what is applied), the target strings (where, within a cluster), and the
 * CLUSTER ITSELF. Namespace, selector and container are just strings — `telemetry` +
 * `chi=orders` names a pod in staging exactly as well as it names one in production — so
 * without the cluster identity, re-pointing a resource at a second cluster matches the
 * recorded target, matches the fingerprint, and silently applies nothing there.
 *
 * The live pod SET is deliberately not compared here: it needs an API call, so
 * {@link applyClickHouseSchema} checks it separately and only under `fanout`.
 */
export function needsApply(
  config: ClickHouseSchemaConfig,
  previous: ClickHouseSchemaState | undefined,
  clusterId?: string
): boolean {
  if (!previous) return true;
  if (previous.fingerprint !== computeFingerprint(config)) return true;
  if (previous.clusterId !== clusterId) return true;
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

function selectorText(config: ClickHouseSchemaConfig): string {
  return Object.entries(config.target.podSelector)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

/**
 * A pod whose container list is empty is a pod the transport could not describe, not a
 * pod without containers; exec'ing into it and letting the API server object is a better
 * failure than refusing it here on missing information.
 */
function hasContainer(pod: ClickHousePodSummary, container: string): boolean {
  return pod.containers.length === 0 || pod.containers.includes(container);
}

/** Phases a pod never leaves. It cannot become Ready, so waiting for one is waiting forever. */
const TERMINAL_PHASES = new Set(['Succeeded', 'Failed']);

/**
 * Whether a matching pod belongs to the set this converge is responsible for.
 *
 * Excluded are pods on their way out (`metadata.deletionTimestamp` set) and pods that have
 * already finished (`Succeeded`/`Failed`). Both are matched by the selector and neither
 * will ever serve a statement, so counting them would make `fanout` hang until its budget
 * expired and then fail on a pod nobody was waiting for. Everything else — Ready, Pending,
 * Running-but-not-Ready, phase unknown — is in the set and must become Ready.
 */
function isMatchingPod(pod: ClickHousePodSummary): boolean {
  return pod.terminating !== true && !TERMINAL_PHASES.has(pod.phase ?? '');
}

/** `name: Ready` / `name: Pending, not Ready` — what a failure has to name to be actionable. */
function describePod(pod: ClickHousePodSummary): string {
  if (pod.ready) return `${pod.name}: Ready`;
  return `${pod.name}: ${pod.phase ?? 'phase unknown'}, not Ready`;
}

function byName(left: ClickHousePodSummary, right: ClickHousePodSummary): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/**
 * One `list pods` call, reduced to the matching set and sorted by name.
 *
 * Sorted so the recorded pod set, the execution order and every error message are stable
 * across converges.
 */
async function listMatchingPods(
  context: ClickHouseSchemaRunContext
): Promise<readonly ClickHousePodSummary[]> {
  const pods = await context.executor.listPods(
    context.config.target.namespace,
    context.config.target.podSelector,
    context.abortSignal
  );
  return [...pods].filter(isMatchingPod).sort(byName);
}

/**
 * `fanout`: EVERY matching pod, or none at all.
 *
 * The rule this enforces is that a `fanout` converge is never partial. Taking whichever
 * pods happen to be Ready is what makes a StatefulSet mid-rollout — one Ready replica and
 * two Pending ones — record a successful, fingerprinted, cluster-wide apply after updating
 * a single server; the remaining replicas then come up with no schema and the fingerprint
 * says the work is done. So the whole matching set is enumerated first and each pod must
 * become Ready within `waitForPod.timeoutMs`:
 *
 * - a pod that never becomes Ready fails the converge, naming the pods and their phases;
 * - a pod without the requested container fails IMMEDIATELY rather than after the budget,
 *   because no amount of waiting adds a container to a running pod.
 *
 * Failing is the conservative outcome: alchemy retries a failed converge, and the
 * fingerprint is recorded only on success, so the next converge applies the full set. A
 * recorded partial apply would never be retried at all.
 */
async function selectFanoutPods(
  context: ClickHouseSchemaRunContext
): Promise<readonly ClickHousePodSummary[]> {
  const { config, resourceId } = context;
  const deps = runtimeDeps(context);
  const timeoutMs = config.waitForPod?.timeoutMs ?? DEFAULT_WAIT_FOR_POD_TIMEOUT_MS;
  const container = resolveContainer(config);
  const deadline = deps.now() + timeoutMs;

  for (;;) {
    const matching = await listMatchingPods(context);

    const withoutContainer = matching.filter((pod) => !hasContainer(pod, container));
    if (withoutContainer.length > 0) {
      throw new ClickHouseSchemaError(
        `ClickHouseSchema '${resourceId}': execution.mode 'fanout' applies the statements to ` +
          `EVERY pod matching ${selectorText(config)} in namespace ` +
          `'${config.target.namespace}', and ${withoutContainer.length} of ${matching.length} ` +
          `has no container '${container}' (` +
          `${withoutContainer.map((pod) => `${pod.name}: ${pod.containers.join(', ')}`).join('; ')}` +
          `). Set target.container, or narrow target.podSelector to the server pods.`,
        resourceId
      );
    }

    const notReady = matching.filter((pod) => !pod.ready);
    if (matching.length > 0 && notReady.length === 0) return matching;

    if (deps.now() >= deadline) {
      const state =
        matching.length === 0
          ? 'no pod matched the selector'
          : `${notReady.length} of ${matching.length} pod(s) were still not Ready ` +
            `(${notReady.map(describePod).join('; ')})`;
      throw new ClickHouseSchemaError(
        `ClickHouseSchema '${resourceId}': execution.mode 'fanout' applies the statements to ` +
          `EVERY pod matching ${selectorText(config)} in namespace ` +
          `'${config.target.namespace}' and never to a subset, but after ${timeoutMs}ms ` +
          `${state}. Let the rollout finish, raise waitForPod.timeoutMs, or switch to ` +
          `execution.mode 'onCluster'.`,
        resourceId
      );
    }
    await deps.sleep(Math.min(POD_POLL_INTERVAL_MS, Math.max(0, deadline - deps.now())));
  }
}

/**
 * `onCluster`: the ONE pod that initiates the distributed DDL.
 *
 * The opposite trade-off to {@link selectFanoutPods}, and deliberately so: the statements
 * distribute themselves through Keeper's DDL queue, so a pod that is still starting is not
 * a pod this converge has to wait for — the server it eventually becomes picks the DDL up
 * from the queue. Only one usable Ready pod is needed, which is what makes `onCluster` the
 * right mode on a large cluster where some replica is almost always rolling.
 *
 * EVERY Ready pod is considered, not just the first: a rollout can leave a Ready pod whose
 * container set does not match — a sidecar-injected replica, a pod from an older template —
 * and judging by the first one throws away perfectly good initiators behind it.
 */
async function selectInitiatorPod(
  context: ClickHouseSchemaRunContext
): Promise<readonly ClickHousePodSummary[]> {
  const { config, resourceId } = context;
  const deps = runtimeDeps(context);
  const timeoutMs = config.waitForPod?.timeoutMs ?? DEFAULT_WAIT_FOR_POD_TIMEOUT_MS;
  const container = resolveContainer(config);
  const deadline = deps.now() + timeoutMs;
  let lastSeen = 0;

  for (;;) {
    const matching = await listMatchingPods(context);
    lastSeen = matching.length;
    const ready = matching.filter((pod) => pod.ready);
    const initiator = ready.find((pod) => hasContainer(pod, container));

    if (initiator) return [initiator];
    if (ready.length > 0) {
      throw new ClickHouseSchemaError(
        `ClickHouseSchema '${resourceId}': no Ready pod in namespace ` +
          `'${config.target.namespace}' has a container '${container}' (` +
          `${ready.map((pod) => `${pod.name}: ${pod.containers.join(', ')}`).join('; ')}). ` +
          `Set target.container.`,
        resourceId
      );
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

/**
 * Poll until the server pods the execution model needs are Ready, or the budget runs out.
 *
 * A ClickHouse server accepts connections only once it is Ready, and a CHI rollout has a
 * window where pods exist but are still replaying logs — exec'ing then produces a
 * connection-refused that looks like a SQL failure. Waiting for readiness first is what
 * makes "ordered after the instance is ready" true in practice as well as in the
 * dependency graph.
 *
 * WHICH pods have to be Ready is the execution model's whole difference: `fanout` reaches
 * every server itself and so needs all of them ({@link selectFanoutPods}); `onCluster`
 * hands the statements to Keeper and so needs exactly one ({@link selectInitiatorPod}).
 */
export async function selectExecutionPods(
  context: ClickHouseSchemaRunContext
): Promise<readonly ClickHousePodSummary[]> {
  return context.config.execution.mode === 'fanout'
    ? await selectFanoutPods(context)
    : await selectInitiatorPod(context);
}

/**
 * Run one statement on one pod, retrying only TRANSIENT transport failures.
 *
 * The two failure modes are kept strictly apart (see {@link ClickHouseExecutor}): a
 * rejected exec is the transport, a non-zero exit code is the server. Re-issuing a
 * statement the server actively rejected cannot help and, for a statement that is not
 * perfectly idempotent, can compound the damage.
 */
async function runStatement(
  context: ClickHouseSchemaRunContext,
  podName: string,
  statement: string,
  index: number
): Promise<void> {
  const { config, resourceId } = context;
  const deps = runtimeDeps(context);
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
      result = await context.executor.exec(command, context.abortSignal);
    } catch (error) {
      lastTransport = error instanceof Error ? error : new Error(String(error));
      if (attempt === maxAttempts) break;
      await deps.sleep(backoffMs * attempt);
      continue;
    }

    if (result.exitCode === 0) return;

    // A server-side failure. The code and exception class are parsed from the RAW output
    // — before redaction, which may well blank the very line that carries them — and the
    // message is then redacted against the statement that was submitted.
    const raw = `${result.stderr}\n${result.stdout}`.trim();
    const code = parseClickHouseErrorCode(raw);
    const exception = parseClickHouseExceptionName(raw);
    throw new ClickHouseSchemaError(
      `ClickHouseSchema '${resourceId}': statement ${index} failed on pod ${podName}` +
        `${code === undefined ? '' : ` with ClickHouse code ${code}`}` +
        `${exception === undefined ? '' : ` (${exception})`} ` +
        `(exit ${result.exitCode}).`,
      resourceId,
      index,
      code,
      redactClickHouseOutput(raw, statement),
      exception
    );
  }

  throw new ClickHouseSchemaError(
    `ClickHouseSchema '${resourceId}': exec transport failed for statement ${index} on pod ` +
      `${podName} after ${maxAttempts} attempt(s): ` +
      redactClickHouseOutput(lastTransport?.message ?? 'unknown error', statement),
    resourceId,
    index,
    undefined,
    undefined,
    undefined,
    lastTransport ? { cause: lastTransport } : undefined
  );
}

/**
 * Run an ordered statement list against every selected pod, stopping at the first failure.
 *
 * Per POD, not per statement: each server receives the whole list in order, because the
 * order is what makes the list meaningful (a table cannot be created before its database)
 * and interleaving across pods would only make a partial failure harder to read.
 */
export async function runStatements(
  context: ClickHouseSchemaRunContext,
  statements: readonly string[]
): Promise<{ readonly podNames: readonly string[] }> {
  const pods = await selectExecutionPods(context);
  for (const pod of pods) {
    for (const [index, statement] of statements.entries()) {
      await runStatement(context, pod.name, statement, index);
    }
  }
  return { podNames: pods.map((pod) => pod.name) };
}

/** Set equality over two sorted-on-write pod name lists. */
function samePodSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}

/**
 * Converge the schema: no-op when nothing changed, otherwise re-run EVERY statement.
 *
 * There is no partial application. A fingerprint change re-runs the whole ordered list,
 * which is only correct because every statement is required to be idempotent — and it is
 * also what makes a failed converge recoverable: the fingerprint is recorded only after
 * the last statement succeeds, so a run that dies at statement 7 re-runs 0..6 next time.
 *
 * Under `fanout` the POD SET is part of what "nothing changed" means. A statement list
 * applied to two replicas is not applied to the third one that a scale-out added, and the
 * fingerprint cannot see that — so an otherwise-unchanged converge still lists pods and
 * re-applies when the set moved. That listing is one API call and no exec, so an
 * unchanged, unchanged-topology converge stays free.
 */
export async function applyClickHouseSchema(
  context: ClickHouseSchemaRunContext,
  previous: ClickHouseSchemaState | undefined
): Promise<ClickHouseSchemaState> {
  const { config } = context;
  const deps = runtimeDeps(context);

  if (previous && !needsApply(config, previous, context.clusterId)) {
    if (config.execution.mode !== 'fanout') return previous;
    const liveNames = (await selectExecutionPods(context)).map((pod) => pod.name);
    if (samePodSet(liveNames, previous.podNames)) return previous;
  }

  const { podNames } = await runStatements(context, config.statements);

  if (config.execution.mode === 'fanout') {
    // THE SCALE RACE. Selection saw one matching set; a replica can be added, replaced or
    // removed while the statements are still running, so the set that is live now is not
    // necessarily the set that was applied to. What goes into state is always the set the
    // statements ACTUALLY reached — recording the live one instead would claim coverage of
    // a pod nothing ran on, and that claim is never revisited because it makes the two sets
    // agree. Re-listing here makes the divergence explicit and observable; `needsApply`
    // does the rest, because the recorded set no longer matches the live one and the next
    // converge re-applies the whole list.
    const live = (await listMatchingPods(context)).map((pod) => pod.name);
    if (!samePodSet(live, podNames)) {
      getComponentLogger('alchemy-clickhouse-schema').warn(
        'ClickHouse server pod set changed while the schema was being applied; recording the ' +
          'pods the statements actually reached, so the next converge re-applies',
        { resourceId: context.resourceId, appliedTo: podNames, live }
      );
    }
  }

  return {
    fingerprint: computeFingerprint(config),
    appliedAt: new Date(deps.now()).toISOString(),
    statementCount: config.statements.length,
    database: resolveDatabase(config),
    target: config.target,
    podNames,
    ...(context.clusterId !== undefined ? { clusterId: context.clusterId } : {}),
  };
}

/**
 * Teardown. `retain` touches nothing at all — not even the cluster — so a destroyed
 * stack leaves the data and the schema exactly as they were.
 */
export async function deleteClickHouseSchema(context: ClickHouseSchemaRunContext): Promise<void> {
  const statements = context.config.deleteStatements ?? [];
  if (context.config.onDelete !== 'run' || statements.length === 0) return;
  await runStatements(context, statements);
}
