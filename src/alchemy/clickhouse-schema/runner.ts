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
  type ClickHouseSchemaAppliedPod,
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

/**
 * How many times a `fanout` apply re-lists and applies to newly appeared pods before it
 * gives up and fails. Three covers the ordinary races — a scale-out or a replacement
 * landing mid-apply — without letting a cluster that is genuinely churning stretch one
 * converge indefinitely.
 */
export const DEFAULT_MAX_RECONCILE_PASSES = 3;
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
 * {@link applyClickHouseSchema} checks it separately and only under `fanout`, by NAME AND
 * UID ({@link samePodIdentitySet}) so a same-name replacement is not invisible.
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
 * The mid-run empty set, in the words a reader needs to recognise the race.
 *
 * A set that goes empty after this run has already applied to pods is not convergence and
 * is not "nothing matched": it is the window in which a pod has been deleted and its
 * replacement has not yet appeared. Naming the count that WAS applied to, and the
 * successor that would otherwise be missed, is what tells the reader which of the two
 * empty-set situations they are looking at.
 */
function fanoutSetBecameEmptyClause(appliedSoFar: number): string {
  return (
    `the matching set became empty after ${appliedSoFar} pod(s) were applied; a same-named ` +
    `successor would be unapplied`
  );
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
 *
 * `deadline` lets {@link applyFanoutUntilCovered} spend ONE `waitForPod` budget across all
 * of its reconcile passes rather than handing each pass a fresh one, so a set that keeps
 * churning cannot stretch the converge without limit.
 *
 * `appliedSoFar` distinguishes the two ways the matching set can be empty. Empty from the
 * start is "no pod matched the selector" — a selector or a namespace to fix. Empty AFTER
 * this run applied to some pods is the replacement race {@link fanoutSetBecameEmptyClause}
 * names, and it gets the same budget: a single-replica StatefulSet being replaced shows an
 * empty set between the old pod disappearing and its same-named successor appearing, and
 * the successor must be waited for and applied to rather than declared covered.
 */
async function selectFanoutPods(
  context: ClickHouseSchemaRunContext,
  budgetDeadline?: number,
  appliedSoFar = 0
): Promise<readonly ClickHousePodSummary[]> {
  const { config, resourceId } = context;
  const deps = runtimeDeps(context);
  const timeoutMs = config.waitForPod?.timeoutMs ?? DEFAULT_WAIT_FOR_POD_TIMEOUT_MS;
  const container = resolveContainer(config);
  const deadline = budgetDeadline ?? deps.now() + timeoutMs;

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
          ? appliedSoFar > 0
            ? fanoutSetBecameEmptyClause(appliedSoFar)
            : 'no pod matched the selector'
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
): Promise<{
  readonly podNames: readonly string[];
  readonly pods: readonly ClickHousePodSummary[];
}> {
  const pods = await selectExecutionPods(context);
  for (const pod of pods) {
    await runStatementsOnPod(context, pod, statements);
  }
  return { podNames: pods.map((pod) => pod.name), pods };
}

/** The whole ordered list against ONE pod, in statement order. */
async function runStatementsOnPod(
  context: ClickHouseSchemaRunContext,
  pod: ClickHousePodSummary,
  statements: readonly string[]
): Promise<void> {
  for (const [index, statement] of statements.entries()) {
    await runStatement(context, pod.name, statement, index);
  }
}

/**
 * The identity of one pod, for the set comparison: NAME AND UID.
 *
 * The name alone is not an identity — a StatefulSet replica that is deleted and recreated
 * comes back as `chi-orders-0-0-0` with an empty disk and no schema — so a replacement is
 * invisible to a set of names. `metadata.uid` is unique per pod object and never reused,
 * which is exactly the distinction that was missing. The NUL separator keeps a name that
 * happens to contain the delimiter from colliding with a UID.
 */
function podKey(pod: ClickHousePodSummary | ClickHouseSchemaAppliedPod): string {
  return `${pod.name}\u0000${pod.uid ?? ''}`;
}

/** What goes into state for one applied pod. */
function appliedPod(pod: ClickHousePodSummary): ClickHouseSchemaAppliedPod {
  return { name: pod.name, ...(pod.uid !== undefined ? { uid: pod.uid } : {}) };
}

/** Set equality over two key lists, order-insensitively. */
function sameKeySet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((key, index) => key === sortedRight[index]);
}

/**
 * Whether the live pod set is the one the recorded state covers, by NAME AND UID.
 *
 * State written before UIDs were recorded has only names, and comparing a name-only record
 * against UID-bearing live pods would re-apply on every converge forever. Such state falls
 * back to the name comparison; the apply it eventually does rewrites state in the new
 * shape, and the UID guarantee starts from there.
 */
function samePodIdentitySet(
  live: readonly ClickHousePodSummary[],
  previous: ClickHouseSchemaState
): boolean {
  if (previous.pods === undefined) {
    return sameKeySet(
      live.map((pod) => pod.name),
      previous.podNames
    );
  }
  return sameKeySet(live.map(podKey), previous.pods.map(podKey));
}

/**
 * THE EXIT PREDICATE of a `fanout` apply — the single condition under which a pod set may
 * be recorded as successfully applied. All three parts are load-bearing:
 *
 * 1. `observed` is NON-EMPTY. An empty observation is never convergence: "no pod is
 *    uncovered" is vacuously true of the empty set, so a run that applied to a pod which
 *    then disappeared would otherwise commit `pods: []` as success. During a single-replica
 *    StatefulSet replacement that empty window sits exactly between the old pod going away
 *    and its SAME-NAMED successor arriving, and the successor — a new pod object with an
 *    empty disk — would be left unapplied behind a fingerprint that says the work is done.
 * 2. every pod in `observed` is in `applied`, by NAME AND UID ({@link podKey}). Coverage is
 *    of pod OBJECTS; a replacement wearing the applied pod's name is not covered by it.
 * 3. `observed` equals the observation BEFORE it. The two preceding parts describe a single
 *    snapshot, and a snapshot cannot distinguish a settled set from one that is still
 *    moving: a pod that vanished between the selection and the re-list leaves every
 *    remaining pod covered while the set itself is mid-change. Requiring two consecutive
 *    identical observations is what makes the set, and not merely the last glimpse of it,
 *    the thing that is recorded.
 *
 * The cost of part 3 on a settled cluster is nothing: the selection's list and the re-list
 * are the two observations, so one pass still converges.
 */
function fanoutCovered(
  observed: readonly ClickHousePodSummary[],
  previous: readonly ClickHousePodSummary[],
  applied: ReadonlyMap<string, ClickHousePodSummary>
): boolean {
  if (observed.length === 0) return false;
  if (!observed.every((pod) => applied.has(podKey(pod)))) return false;
  return sameKeySet(observed.map(podKey), previous.map(podKey));
}

/** Which part of {@link fanoutCovered} an observation failed, in one readable clause. */
function unconvergedReason(
  observed: readonly ClickHousePodSummary[],
  previous: readonly ClickHousePodSummary[],
  uncovered: readonly ClickHousePodSummary[],
  appliedTotal: number
): string {
  if (observed.length === 0) return fanoutSetBecameEmptyClause(appliedTotal);
  if (uncovered.length > 0) {
    return (
      `${uncovered.length} pod(s) had still not been applied to ` +
      `(${uncovered.map((pod) => pod.name).join(', ')})`
    );
  }
  return (
    `the matching set was still moving between two consecutive observations ` +
    `(${previous.map((pod) => pod.name).join(', ')} then ` +
    `${observed.map((pod) => pod.name).join(', ')})`
  );
}

/**
 * `fanout`: apply, re-list, apply again — until the LIVE pod set is covered, or fail.
 *
 * THE SCALE RACE. Selection sees one matching set; a replica can be added, replaced or
 * removed while the statements are still running, so the set that is live when the run
 * finishes is not necessarily the set that was applied to. Recording the live set instead
 * would claim coverage of a pod nothing ran on — and that claim is never revisited,
 * because it makes the two sets agree. Recording only what was reached and WARNING about
 * the difference does not fix it either: alchemy commits that state without another
 * reconcile, so the newly observed pod stays unapplied until some future deployment
 * happens to change the fingerprint or the set. A converge that observed an uncovered pod
 * and returned success is exactly the half-applied schema `fanout` exists to rule out.
 *
 * So the loop keeps going instead:
 *
 * 1. select the complete Ready set (the all-or-nothing rules of {@link selectFanoutPods});
 * 2. apply the whole ordered list to every pod not yet applied to IN THIS RUN — a pod
 *    already covered by an earlier pass is not re-run, so a settled set costs one pass;
 * 3. re-list. Pods that appeared are uncovered and get another pass; pods that DISAPPEARED
 *    are dropped from the recorded set, because state must describe coverage of pods that
 *    exist rather than of ones that are gone;
 * 4. repeat until {@link fanoutCovered} — the ONE exit predicate — holds.
 *
 * Two bounds keep a genuinely churning cluster from looping forever: `maxReconcilePasses`
 * and the overall `waitForPod` budget, which is spent ACROSS the passes rather than renewed
 * by each one. Hitting either before the predicate holds FAILS the converge, naming what is
 * wrong with the observation ({@link unconvergedReason}) — never returns a successful state
 * — so alchemy does not commit a partial apply and the next converge starts over. Failing is
 * the recoverable outcome; a recorded partial apply would never be retried at all.
 */
async function applyFanoutUntilCovered(
  context: ClickHouseSchemaRunContext,
  statements: readonly string[]
): Promise<readonly ClickHousePodSummary[]> {
  const { config, resourceId } = context;
  const deps = runtimeDeps(context);
  const maxPasses = config.maxReconcilePasses ?? DEFAULT_MAX_RECONCILE_PASSES;
  const timeoutMs = config.waitForPod?.timeoutMs ?? DEFAULT_WAIT_FOR_POD_TIMEOUT_MS;
  const budgetDeadline = deps.now() + timeoutMs;
  const logger = getComponentLogger('alchemy-clickhouse-schema');
  /** Pods this run has applied to, by {@link podKey}; pruned to what is still live. */
  const applied = new Map<string, ClickHousePodSummary>();
  /** How many pods this run has applied to IN TOTAL, including ones since departed. */
  let appliedTotal = 0;

  for (let pass = 1; ; pass += 1) {
    // The selection's own final list is the FIRST of the two observations the exit
    // predicate compares; the re-list below is the second.
    const selected = await selectFanoutPods(context, budgetDeadline, appliedTotal);
    for (const pod of selected) {
      if (applied.has(podKey(pod))) continue;
      await runStatementsOnPod(context, pod, statements);
      applied.set(podKey(pod), pod);
      appliedTotal += 1;
    }

    const live = await listMatchingPods(context);
    const liveKeys = new Set(live.map(podKey));
    for (const key of [...applied.keys()]) {
      if (!liveKeys.has(key)) applied.delete(key);
    }

    if (fanoutCovered(live, selected, applied)) return [...applied.values()].sort(byName);

    const uncovered = live.filter((pod) => !applied.has(podKey(pod)));
    if (pass >= maxPasses) {
      throw new ClickHouseSchemaError(
        `ClickHouseSchema '${resourceId}': execution.mode 'fanout' applies the statements to ` +
          `EVERY pod matching ${selectorText(config)} in namespace ` +
          `'${config.target.namespace}', but the pod set kept changing: after ${maxPasses} ` +
          `reconcile pass(es), ${unconvergedReason(live, selected, uncovered, appliedTotal)}. ` +
          `Nothing is recorded, so the next converge re-applies the whole list. Let the ` +
          `rollout settle, raise maxReconcilePasses, or switch to execution.mode 'onCluster'.`,
        resourceId
      );
    }

    logger.info(
      'ClickHouse server pod set changed while the schema was being applied; reconciling again',
      {
        resourceId,
        pass,
        maxPasses,
        appliedTo: [...applied.values()].map((pod) => pod.name),
        uncovered: uncovered.map((pod) => pod.name),
        reason: unconvergedReason(live, selected, uncovered, appliedTotal),
      }
    );
  }
}

/**
 * Converge the schema: no-op when nothing changed, otherwise re-run EVERY statement.
 *
 * There is no partial application. A fingerprint change re-runs the whole ordered list,
 * which is only correct because every statement is required to be idempotent — and it is
 * also what makes a failed converge recoverable: the fingerprint is recorded only after
 * the last statement succeeds, so a run that dies at statement 7 re-runs 0..6 next time.
 *
 * Under `fanout` the POD SET is part of what "nothing changed" means, and the set is
 * compared by NAME AND UID. A statement list applied to two replicas is not applied to the
 * third one that a scale-out added, nor to the replacement a drain put back under the same
 * name with an empty disk, and the fingerprint cannot see either — so an otherwise-unchanged
 * converge still lists pods and re-applies when the set moved. That listing is one API call
 * and no exec, so an unchanged, unchanged-topology converge stays free. When it does apply,
 * it applies until the live set is COVERED; see {@link applyFanoutUntilCovered}.
 *
 * `onCluster` has no coverage to reconcile: one execution hands the DDL to Keeper's queue,
 * which reaches the pods this converge never looked at, including ones that appear later.
 */
export async function applyClickHouseSchema(
  context: ClickHouseSchemaRunContext,
  previous: ClickHouseSchemaState | undefined
): Promise<ClickHouseSchemaState> {
  const { config } = context;
  const deps = runtimeDeps(context);

  if (previous && !needsApply(config, previous, context.clusterId)) {
    if (config.execution.mode !== 'fanout') return previous;
    const live = await selectExecutionPods(context);
    if (samePodIdentitySet(live, previous)) return previous;
  }

  const pods =
    config.execution.mode === 'fanout'
      ? await applyFanoutUntilCovered(context, config.statements)
      : (await runStatements(context, config.statements)).pods;

  return {
    fingerprint: computeFingerprint(config),
    appliedAt: new Date(deps.now()).toISOString(),
    statementCount: config.statements.length,
    database: resolveDatabase(config),
    target: config.target,
    podNames: pods.map((pod) => pod.name),
    pods: pods.map(appliedPod),
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
