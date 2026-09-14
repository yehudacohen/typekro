/**
 * Unit tests for the `ClickHouseSchema` alchemy resource.
 *
 * The exec transport is injected (`ClickHouseExecutor`), so the whole convergence
 * contract — ordering, fingerprint no-op, re-apply, execution model, cluster identity,
 * delete semantics, error attribution, retry policy, pod selection and redaction — is
 * covered without a cluster. The live behaviour of the default
 * `@kubernetes/client-node` transport is covered by
 * `test/integration/alchemy/clickhouse-schema.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { KubeConfig } from '@kubernetes/client-node';
import { type } from 'arktype';
import {
  applyClickHouseSchema,
  type ClickHouseExecCommand,
  type ClickHouseExecResult,
  type ClickHouseExecutor,
  type ClickHousePodSummary,
  type ClickHouseSchemaConfig,
  ClickHouseSchemaConfigSchema,
  ClickHouseSchemaError,
  type ClickHouseSchemaState,
  computeFingerprint,
  DEFAULT_CLICKHOUSE_PASSWORD_ENV,
  deleteClickHouseSchema,
  escapeClickHouseString,
  extractStatementSecrets,
  MAX_RETAINED_DETAIL_CHARS,
  needsApply,
  parseClickHouseErrorCode,
  parseClickHouseExceptionName,
  redactClickHouseOutput,
  redactClickHouseText,
  renderClickHouseCommand,
  selectExecutionPods,
  statementTargetsCluster,
  tokenizeClickHouseSql,
} from '../../../src/alchemy/index.js';
import type { ClickHouseSchemaRuntimeDeps } from '../../../src/alchemy/index.js';
import { clusterIdentity } from '../../../src/core/kubernetes/api-capability.js';

const RESOURCE_ID = 'orders-schema';

const readyPod = (name: string, uid?: string): ClickHousePodSummary => ({
  name,
  ...(uid === undefined ? {} : { uid }),
  ready: true,
  containers: ['clickhouse'],
  phase: 'Running',
});
const pendingPod = (name: string): ClickHousePodSummary => ({
  name,
  ready: false,
  containers: ['clickhouse'],
  phase: 'Pending',
});
/** Ready, but on its way out: matched by the selector, never part of the applied set. */
const terminatingPod = (name: string): ClickHousePodSummary => ({
  name,
  ready: true,
  containers: ['clickhouse'],
  phase: 'Running',
  terminating: true,
});
const finishedPod = (name: string): ClickHousePodSummary => ({
  name,
  ready: false,
  containers: ['clickhouse'],
  phase: 'Succeeded',
});

interface FakeExecutorOptions {
  readonly podPages?: readonly (readonly ClickHousePodSummary[])[];
  readonly results?: readonly (ClickHouseExecResult | Error)[];
}

/** Records every exec, and replays a scripted sequence of results / transport failures. */
function fakeExecutor(options: FakeExecutorOptions = {}) {
  const execCalls: ClickHouseExecCommand[] = [];
  const listCalls: Array<{ namespace: string; selector: Record<string, string> }> = [];
  const pages = options.podPages ?? [[readyPod('chi-orders-0-0-0')]];
  let listIndex = 0;
  let execIndex = 0;

  const executor: ClickHouseExecutor = {
    listPods: async (namespace, podSelector) => {
      listCalls.push({ namespace, selector: { ...podSelector } });
      const page = pages[Math.min(listIndex, pages.length - 1)] ?? [];
      listIndex += 1;
      return page;
    },
    exec: async (command) => {
      execCalls.push(command);
      const scripted = options.results?.[execIndex];
      execIndex += 1;
      if (scripted instanceof Error) throw scripted;
      return scripted ?? { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  return { executor, execCalls, listCalls };
}

/** Deterministic clock: `sleep` advances it instantly, so waits never take real time. */
function fakeDeps(startMs = 1_700_000_000_000) {
  let current = startMs;
  const slept: number[] = [];
  const deps: ClickHouseSchemaRuntimeDeps = {
    now: () => current,
    sleep: async (ms) => {
      slept.push(ms);
      current += ms;
    },
  };
  return { deps, slept };
}

function validConfig(overrides: Record<string, unknown> = {}): ClickHouseSchemaConfig {
  const result = ClickHouseSchemaConfigSchema({
    target: {
      namespace: 'example-observability',
      podSelector: { 'clickhouse.altinity.com/chi': 'orders' },
    },
    statements: [
      'CREATE DATABASE IF NOT EXISTS orders',
      'CREATE TABLE IF NOT EXISTS orders.events (id UUID, at DateTime) ENGINE = MergeTree ORDER BY at',
    ],
    ...overrides,
  });
  if (result instanceof type.errors) throw new Error(result.summary);
  return result;
}

/** The run context every test shares, with the pieces a given test cares about overridden. */
function context(
  executor: ClickHouseExecutor,
  config: ClickHouseSchemaConfig,
  extra: { deps?: ClickHouseSchemaRuntimeDeps; clusterId?: string } = {}
) {
  return {
    executor,
    config,
    resourceId: RESOURCE_ID,
    deps: extra.deps ?? fakeDeps().deps,
    clusterId: extra.clusterId,
  };
}

function stateFor(
  config: ClickHouseSchemaConfig,
  overrides: Partial<ClickHouseSchemaState> = {}
): ClickHouseSchemaState {
  return {
    fingerprint: computeFingerprint(config),
    appliedAt: '2023-11-14T22:13:20.000Z',
    statementCount: config.statements.length,
    database: 'default',
    target: config.target,
    podNames: ['chi-orders-0-0-0'],
    ...overrides,
  };
}

describe('ClickHouseSchema — configuration validation', () => {
  it('applies the retain default and infers the validated config', () => {
    const config = validConfig();
    expect(config.onDelete).toBe('retain');
    expect(config.statements).toHaveLength(2);
  });

  it('defaults the execution model to fanout', () => {
    expect(validConfig().execution).toEqual({ mode: 'fanout' });
  });

  it('rejects an empty statement list', () => {
    const result = ClickHouseSchemaConfigSchema({
      target: { namespace: 'ns', podSelector: { app: 'orders' } },
      statements: [],
    });
    expect(result instanceof type.errors).toBe(true);
  });

  it('rejects a blank statement, naming its index', () => {
    const result = ClickHouseSchemaConfigSchema({
      target: { namespace: 'ns', podSelector: { app: 'orders' } },
      statements: ['CREATE DATABASE IF NOT EXISTS orders', '   '],
    });
    expect(result instanceof type.errors).toBe(true);
    expect(String(result)).toContain('statement 1');
  });

  it('rejects an empty pod selector', () => {
    const result = ClickHouseSchemaConfigSchema({
      target: { namespace: 'ns', podSelector: {} },
      statements: ['CREATE DATABASE IF NOT EXISTS orders'],
    });
    expect(result instanceof type.errors).toBe(true);
    expect(String(result)).toContain('non-empty pod label selector');
  });

  it('rejects a malformed label key in the selector', () => {
    const result = ClickHouseSchemaConfigSchema({
      target: { namespace: 'ns', podSelector: { 'not a key': 'orders' } },
      statements: ['CREATE DATABASE IF NOT EXISTS orders'],
    });
    expect(result instanceof type.errors).toBe(true);
    expect(String(result)).toContain('label key');
  });

  it('rejects a plaintext password on the client (undeclared keys are rejected)', () => {
    const result = ClickHouseSchemaConfigSchema({
      target: { namespace: 'ns', podSelector: { app: 'orders' } },
      client: { user: 'writer', password: 'hunter2' },
      statements: ['CREATE DATABASE IF NOT EXISTS orders'],
    });
    expect(result instanceof type.errors).toBe(true);
    expect(String(result)).toContain('password');
  });

  it("requires deleteStatements when onDelete is 'run'", () => {
    const result = ClickHouseSchemaConfigSchema({
      target: { namespace: 'ns', podSelector: { app: 'orders' } },
      statements: ['CREATE DATABASE IF NOT EXISTS orders'],
      onDelete: 'run',
    });
    expect(result instanceof type.errors).toBe(true);
    expect(String(result)).toContain('deleteStatements');
  });

  it('rejects deleteStatements that could never run under the retain default', () => {
    const result = ClickHouseSchemaConfigSchema({
      target: { namespace: 'ns', podSelector: { app: 'orders' } },
      statements: ['CREATE DATABASE IF NOT EXISTS orders'],
      deleteStatements: ['DROP DATABASE IF EXISTS orders'],
    });
    expect(result instanceof type.errors).toBe(true);
  });

  it('rejects a setting name that is not a ClickHouse identifier', () => {
    const result = ClickHouseSchemaConfigSchema({
      target: { namespace: 'ns', podSelector: { app: 'orders' } },
      statements: ['CREATE DATABASE IF NOT EXISTS orders'],
      settings: { 'max_threads; DROP': 4 },
    });
    expect(result instanceof type.errors).toBe(true);
  });

  it('does not describe the non-serializable props — they are split off before validation', () => {
    // `kubeConfig`, `executor` and `readyBarrier` are deliberately outside the ArkType
    // schema (a KubeConfig shape, a runtime injection point, and an unresolved alchemy
    // Output respectively), so the schema must reject them as undeclared config keys.
    const validated = ClickHouseSchemaConfigSchema({
      target: { namespace: 'ns', podSelector: { app: 'orders' } },
      statements: ['CREATE DATABASE IF NOT EXISTS orders'],
    });
    expect(validated instanceof type.errors).toBe(false);
    expect(Object.keys(validated as object)).not.toContain('executor');
    expect(Object.keys(validated as object)).not.toContain('readyBarrier');
  });

  it('rejects an environment variable name that is not a POSIX identifier', () => {
    const result = ClickHouseSchemaConfigSchema({
      target: { namespace: 'ns', podSelector: { app: 'orders' } },
      client: { passwordEnv: 'not-an-env-var' },
      statements: ['CREATE DATABASE IF NOT EXISTS orders'],
    });
    expect(result instanceof type.errors).toBe(true);
  });
});

describe("ClickHouseSchema — execution.mode 'onCluster' validation", () => {
  const onCluster = (statements: string[], extra: Record<string, unknown> = {}) =>
    ClickHouseSchemaConfigSchema({
      target: { namespace: 'ns', podSelector: { app: 'orders' } },
      execution: { mode: 'onCluster', cluster: 'cluster' },
      statements,
      ...extra,
    });

  it('requires a cluster name', () => {
    const result = ClickHouseSchemaConfigSchema({
      target: { namespace: 'ns', podSelector: { app: 'orders' } },
      execution: { mode: 'onCluster' },
      statements: ['CREATE DATABASE IF NOT EXISTS orders'],
    });
    expect(result instanceof type.errors).toBe(true);
  });

  it('accepts statements that all carry the clause', () => {
    const result = onCluster([
      "CREATE DATABASE IF NOT EXISTS orders ON CLUSTER 'cluster'",
      'CREATE TABLE IF NOT EXISTS orders.events ON CLUSTER cluster (id UUID) ' +
        'ENGINE = ReplicatedMergeTree ORDER BY id',
    ]);
    expect(result instanceof type.errors).toBe(false);
  });

  it('accepts the clause in any case and with any identifier quoting', () => {
    expect(statementTargetsCluster('DROP TABLE t on cluster `cluster`', 'cluster')).toBe(true);
    expect(statementTargetsCluster('DROP TABLE t ON CLUSTER "cluster"', 'cluster')).toBe(true);
    expect(statementTargetsCluster("DROP TABLE t ON CLUSTER 'cluster'", 'cluster')).toBe(true);
    expect(statementTargetsCluster('DROP TABLE t ON CLUSTER cluster', 'cluster')).toBe(true);
  });

  it('does not accept a clause naming a DIFFERENT cluster', () => {
    expect(statementTargetsCluster('DROP TABLE t ON CLUSTER other', 'cluster')).toBe(false);
  });

  it('does not accept a clause that only appears inside a string literal', () => {
    expect(
      statementTargetsCluster("INSERT INTO audit VALUES ('ran ON CLUSTER cluster')", 'cluster')
    ).toBe(false);
  });

  it('rejects a statement without the clause, naming its index', () => {
    const result = onCluster([
      'CREATE DATABASE IF NOT EXISTS orders ON CLUSTER cluster',
      'CREATE TABLE IF NOT EXISTS orders.events (id UUID) ENGINE = MergeTree ORDER BY id',
    ]);
    expect(result instanceof type.errors).toBe(true);
    expect(String(result)).toContain('statements 1');
    expect(String(result)).toContain('ON CLUSTER cluster');
  });

  it('rejects a deleteStatement without the clause too', () => {
    const result = onCluster(['CREATE DATABASE IF NOT EXISTS orders ON CLUSTER cluster'], {
      onDelete: 'run',
      deleteStatements: ['DROP DATABASE IF EXISTS orders'],
    });
    expect(result instanceof type.errors).toBe(true);
    expect(String(result)).toContain('deleteStatements 0');
  });

  it('rejects the DDL target the old reference-based inference let through', () => {
    // `events` is created LOCALLY; `analytics.source` is only read from. Keying acceptance
    // on the dotted references rather than on the DDL target passed this statement and
    // left `events` on one server.
    const result = onCluster(['CREATE TABLE events AS analytics.source']);
    expect(result instanceof type.errors).toBe(true);
    expect(String(result)).toContain("carries no 'ON CLUSTER cluster' clause");
  });

  it('rejects a clause-free statement whatever databases it names', () => {
    for (const statement of [
      'CREATE TABLE IF NOT EXISTS orders.events (id UUID) ENGINE = MergeTree ORDER BY id',
      'CREATE TABLE IF NOT EXISTS billing.invoices (id UUID) ENGINE = MergeTree ORDER BY id',
      'CREATE TABLE IF NOT EXISTS events (id UUID) ENGINE = MergeTree',
    ]) {
      const result = onCluster([statement]);
      expect(result instanceof type.errors).toBe(true);
      expect(String(result)).toContain("execution.mode 'fanout'");
    }
  });

  it('rejects USE and SET, pointing at the mode that can run them', () => {
    const result = onCluster(['USE orders']);
    expect(result instanceof type.errors).toBe(true);
    expect(String(result)).toContain('session-scoped');
    expect(String(result)).toContain("execution.mode 'fanout'");
  });

  it("rejects the retired 'replicatedDatabases' prop rather than ignoring it", () => {
    const result = onCluster(['CREATE DATABASE IF NOT EXISTS orders ON CLUSTER cluster'], {
      replicatedDatabases: ['orders'],
    });
    expect(result instanceof type.errors).toBe(true);
    expect(String(result)).toContain('replicatedDatabases');
  });

  it('leaves fanout statements unvalidated — nothing is promised about distribution', () => {
    const result = ClickHouseSchemaConfigSchema({
      target: { namespace: 'ns', podSelector: { app: 'orders' } },
      statements: ['CREATE TABLE IF NOT EXISTS events (id UUID) ENGINE = MergeTree ORDER BY id'],
    });
    expect(result instanceof type.errors).toBe(false);
  });
});

describe('ClickHouseSchema — command rendering', () => {
  it('reads the password from the container environment and never from props', () => {
    const command = renderClickHouseCommand(validConfig());
    expect(command[0]).toBe('sh');
    expect(command[1]).toBe('-c');
    expect(command[2]).toContain(`--password "\${${DEFAULT_CLICKHOUSE_PASSWORD_ENV}:-}"`);
  });

  it('carries no SQL in argv — statements travel on stdin', async () => {
    const { executor, execCalls } = fakeExecutor();
    await applyClickHouseSchema(context(executor, validConfig()), undefined);
    for (const call of execCalls) {
      expect(call.command.join(' ')).not.toContain('CREATE');
      expect(call.stdin).toContain('CREATE');
    }
  });

  it('renders validated settings as --<setting>=<value>', () => {
    const command = renderClickHouseCommand(
      validConfig({ settings: { max_execution_time: 600, distributed_ddl_task_timeout: '300' } })
    );
    expect(command[2]).toContain("--max_execution_time='600'");
    expect(command[2]).toContain("--distributed_ddl_task_timeout='300'");
  });

  it('honours a custom user, database and port', () => {
    const command = renderClickHouseCommand(
      validConfig({ client: { user: 'writer', database: 'orders', port: 9440 } })
    );
    expect(command[2]).toContain("--user 'writer'");
    expect(command[2]).toContain("--database 'orders'");
    expect(command[2]).toContain('--port 9440');
  });
});

describe('ClickHouseSchema — create', () => {
  it('runs every statement, in order, against the Ready pod', async () => {
    const { executor, execCalls } = fakeExecutor();
    const state = await applyClickHouseSchema(context(executor, validConfig()), undefined);

    expect(execCalls.map((call) => call.stdin.trim())).toEqual([
      'CREATE DATABASE IF NOT EXISTS orders',
      'CREATE TABLE IF NOT EXISTS orders.events (id UUID, at DateTime) ENGINE = MergeTree ORDER BY at',
    ]);
    expect(new Set(execCalls.map((call) => call.podName)).size).toBe(1);
    expect(state.statementCount).toBe(2);
    expect(state.database).toBe('default');
    expect(state.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(state.appliedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(state.podNames).toEqual(['chi-orders-0-0-0']);
  });

  it('execs into the CHI server container by default', async () => {
    const { executor, execCalls } = fakeExecutor();
    await applyClickHouseSchema(context(executor, validConfig()), undefined);
    expect(execCalls[0]?.container).toBe('clickhouse');
  });
});

describe("ClickHouseSchema — execution.mode 'fanout'", () => {
  const threePods = [
    readyPod('chi-orders-0-2-0'),
    readyPod('chi-orders-0-0-0'),
    readyPod('chi-orders-0-1-0'),
  ];

  it('runs the whole ordered list against EVERY Ready pod', async () => {
    const { executor, execCalls } = fakeExecutor({ podPages: [threePods] });
    const state = await applyClickHouseSchema(context(executor, validConfig()), undefined);

    expect(execCalls).toHaveLength(6);
    // Per pod, in name order, each pod receiving the list in statement order.
    expect(execCalls.map((call) => `${call.podName}|${call.stdin.trim().split(' ')[1]}`)).toEqual([
      'chi-orders-0-0-0|DATABASE',
      'chi-orders-0-0-0|TABLE',
      'chi-orders-0-1-0|DATABASE',
      'chi-orders-0-1-0|TABLE',
      'chi-orders-0-2-0|DATABASE',
      'chi-orders-0-2-0|TABLE',
    ]);
    expect(state.podNames).toEqual(['chi-orders-0-0-0', 'chi-orders-0-1-0', 'chi-orders-0-2-0']);
  });

  it('re-applies when the pod set changes, although the fingerprint did not', async () => {
    const config = validConfig();
    const previous = stateFor(config, { podNames: ['chi-orders-0-0-0'] });
    // A scale-out: a second replica appeared and has no schema.
    const { executor, execCalls } = fakeExecutor({
      podPages: [[readyPod('chi-orders-0-0-0'), readyPod('chi-orders-0-1-0')]],
    });

    const state = await applyClickHouseSchema(context(executor, config), previous);

    expect(execCalls).toHaveLength(4);
    expect(state.podNames).toEqual(['chi-orders-0-0-0', 'chi-orders-0-1-0']);
  });

  it('re-applies when a pod was REPLACED, not only when one was added', async () => {
    const config = validConfig();
    const previous = stateFor(config, { podNames: ['chi-orders-0-0-0'] });
    const { executor, execCalls } = fakeExecutor({ podPages: [[readyPod('chi-orders-0-0-1')]] });

    const state = await applyClickHouseSchema(context(executor, config), previous);

    expect(execCalls).toHaveLength(2);
    expect(state.podNames).toEqual(['chi-orders-0-0-1']);
  });

  it('stays a no-op when the pod set is unchanged — it lists, it does not exec', async () => {
    const config = validConfig();
    const previous = stateFor(config, { podNames: ['chi-orders-0-0-0'] });
    const { executor, execCalls, listCalls } = fakeExecutor();

    const again = await applyClickHouseSchema(context(executor, config), previous);

    expect(execCalls).toHaveLength(0);
    expect(listCalls).toHaveLength(1);
    expect(again).toBe(previous);
  });
});

describe('ClickHouseSchema — pod identity (name + UID)', () => {
  const config = () => validConfig();
  /** State as the previous converge would have written it: pairs, not bare names. */
  const appliedTo = (pods: readonly ClickHousePodSummary[]) =>
    stateFor(config(), {
      podNames: pods.map((pod) => pod.name),
      pods: pods.map((pod) => ({ name: pod.name, ...(pod.uid ? { uid: pod.uid } : {}) })),
    });

  it('records a { name, uid } pair per applied pod, and keeps podNames alongside', async () => {
    const { executor } = fakeExecutor({
      podPages: [[readyPod('chi-orders-0-0-0', 'uid-a'), readyPod('chi-orders-0-1-0', 'uid-b')]],
    });
    const state = await applyClickHouseSchema(context(executor, config()), undefined);

    expect(state.pods).toEqual([
      { name: 'chi-orders-0-0-0', uid: 'uid-a' },
      { name: 'chi-orders-0-1-0', uid: 'uid-b' },
    ]);
    expect(state.podNames).toEqual(['chi-orders-0-0-0', 'chi-orders-0-1-0']);
  });

  it('RE-APPLIES to a pod with the same name and a NEW uid — it is a replacement', async () => {
    // The case a name-only set cannot see: a drained or recreated StatefulSet replica comes
    // back as `chi-orders-0-0-0` with an empty disk and no schema.
    const previous = appliedTo([readyPod('chi-orders-0-0-0', 'uid-before')]);
    const { executor, execCalls } = fakeExecutor({
      podPages: [[readyPod('chi-orders-0-0-0', 'uid-after')]],
    });

    const state = await applyClickHouseSchema(context(executor, config()), previous);

    expect(execCalls).toHaveLength(2);
    expect(execCalls.every((call) => call.podName === 'chi-orders-0-0-0')).toBe(true);
    expect(state.pods).toEqual([{ name: 'chi-orders-0-0-0', uid: 'uid-after' }]);
  });

  it('does NOT re-apply when the name AND uid are both unchanged', async () => {
    // Same pod object: its disk (and so its schema) persisted, or the replicated metadata
    // did. A container restart is not a reason to re-run the whole ordered list.
    const previous = appliedTo([readyPod('chi-orders-0-0-0', 'uid-a')]);
    const { executor, execCalls } = fakeExecutor({
      podPages: [[readyPod('chi-orders-0-0-0', 'uid-a')]],
    });

    const again = await applyClickHouseSchema(context(executor, config()), previous);

    expect(execCalls).toHaveLength(0);
    expect(again).toBe(previous);
  });

  it('falls back to names for state written before UIDs were recorded', async () => {
    // `pods` absent: comparing a name-only record against UID-bearing live pods would
    // otherwise re-apply on every converge forever.
    const previous = stateFor(config(), { podNames: ['chi-orders-0-0-0'] });
    const { executor, execCalls } = fakeExecutor({
      podPages: [[readyPod('chi-orders-0-0-0', 'uid-a')]],
    });

    const again = await applyClickHouseSchema(context(executor, config()), previous);

    expect(execCalls).toHaveLength(0);
    expect(again).toBe(previous);
  });
});

describe("ClickHouseSchema — execution.mode 'onCluster'", () => {
  const onClusterConfig = () =>
    validConfig({
      execution: { mode: 'onCluster', cluster: 'cluster' },
      statements: [
        'CREATE DATABASE IF NOT EXISTS orders ON CLUSTER cluster',
        'CREATE TABLE IF NOT EXISTS orders.events ON CLUSTER cluster (id UUID) ' +
          'ENGINE = ReplicatedMergeTree ORDER BY id',
      ],
    });

  it('runs the statements ONCE, on the first Ready pod', async () => {
    const { executor, execCalls } = fakeExecutor({
      podPages: [[readyPod('chi-orders-0-1-0'), readyPod('chi-orders-0-0-0')]],
    });
    const state = await applyClickHouseSchema(context(executor, onClusterConfig()), undefined);

    expect(execCalls).toHaveLength(2);
    expect(new Set(execCalls.map((call) => call.podName))).toEqual(new Set(['chi-orders-0-0-0']));
    expect(state.podNames).toEqual(['chi-orders-0-0-0']);
  });

  it('does not list pods at all on an unchanged converge', async () => {
    const config = onClusterConfig();
    const previous = stateFor(config, { podNames: ['chi-orders-0-0-0'] });
    const { executor, execCalls, listCalls } = fakeExecutor();

    const again = await applyClickHouseSchema(context(executor, config), previous);

    expect(execCalls).toHaveLength(0);
    expect(listCalls).toHaveLength(0);
    expect(again).toBe(previous);
  });

  it('re-applies when only the execution model changed', () => {
    const statements = [
      'CREATE DATABASE IF NOT EXISTS orders ON CLUSTER cluster',
      'CREATE TABLE IF NOT EXISTS orders.events ON CLUSTER cluster (id UUID) ' +
        'ENGINE = ReplicatedMergeTree ORDER BY id',
    ];
    expect(computeFingerprint(onClusterConfig())).not.toBe(
      computeFingerprint(validConfig({ statements }))
    );
  });
});

describe('ClickHouseSchema — update', () => {
  it('no-ops when the fingerprint is unchanged', async () => {
    const config = validConfig();
    const first = fakeExecutor();
    const state = await applyClickHouseSchema(context(first.executor, config), undefined);

    const second = fakeExecutor();
    const again = await applyClickHouseSchema(context(second.executor, config), state);

    expect(second.execCalls).toHaveLength(0);
    expect(again).toBe(state);
  });

  it('re-runs every statement when the statements change', async () => {
    const previous = stateFor(validConfig());
    const changed = validConfig({
      statements: [
        'CREATE DATABASE IF NOT EXISTS orders',
        'CREATE TABLE IF NOT EXISTS orders.events (id UUID, at DateTime) ENGINE = MergeTree ORDER BY at',
        'CREATE TABLE IF NOT EXISTS orders.shipments (id UUID) ENGINE = MergeTree ORDER BY id',
      ],
    });

    const { executor, execCalls } = fakeExecutor();
    const state = await applyClickHouseSchema(context(executor, changed), previous);

    expect(execCalls).toHaveLength(3);
    expect(state.fingerprint).not.toBe(previous.fingerprint);
    expect(state.statementCount).toBe(3);
  });

  it('re-applies when only the settings change', () => {
    const base = validConfig();
    const withSettings = validConfig({ settings: { max_execution_time: 600 } });
    expect(computeFingerprint(base)).not.toBe(computeFingerprint(withSettings));
  });

  it('re-applies when the target moves, even though the statements are identical', async () => {
    const config = validConfig();
    const previous = stateFor(config, {
      target: { namespace: 'other-namespace', podSelector: config.target.podSelector },
    });
    expect(needsApply(config, previous)).toBe(true);

    const { executor, execCalls } = fakeExecutor();
    await applyClickHouseSchema(context(executor, config), previous);
    expect(execCalls).toHaveLength(2);
  });
});

describe('ClickHouseSchema — cluster identity', () => {
  const kubeConfigFor = (server: string): KubeConfig => {
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromOptions({
      clusters: [{ name: 'target', server, skipTLSVerify: true }],
      users: [{ name: 'runner' }],
      contexts: [{ name: 'target', cluster: 'target', user: 'runner' }],
      currentContext: 'target',
    });
    return kubeConfig;
  };

  const staging = clusterIdentity(kubeConfigFor('https://staging.example.invalid:6443')) as string;
  const production = clusterIdentity(
    kubeConfigFor('https://production.example.invalid:6443')
  ) as string;

  it('derives a different identity for a different API server', () => {
    expect(staging).toBeDefined();
    expect(staging).not.toBe(production);
  });

  it('re-applies when the same target strings point at another cluster', async () => {
    const config = validConfig();
    const previous = stateFor(config, { clusterId: staging });

    // Identical namespace, selector, container and statements — only the cluster moved.
    expect(needsApply(config, previous, staging)).toBe(false);
    expect(needsApply(config, previous, production)).toBe(true);

    const { executor, execCalls } = fakeExecutor();
    const state = await applyClickHouseSchema(
      context(executor, config, { clusterId: production }),
      previous
    );
    expect(execCalls).toHaveLength(2);
    expect(state.clusterId).toBe(production);
  });

  it('surfaces the identity on the output so state says which cluster was touched', async () => {
    const { executor } = fakeExecutor();
    const state = await applyClickHouseSchema(
      context(executor, validConfig(), { clusterId: 'abc123' }),
      undefined
    );
    expect(state.clusterId).toBe('abc123');
  });

  it('carries no identity when there is none to carry', async () => {
    const { executor } = fakeExecutor();
    const state = await applyClickHouseSchema(context(executor, validConfig()), undefined);
    expect(state.clusterId).toBeUndefined();
  });
});

describe('ClickHouseSchema — delete', () => {
  it('retains by default: never touches the cluster', async () => {
    const { executor, execCalls, listCalls } = fakeExecutor();
    await deleteClickHouseSchema(context(executor, validConfig()));
    expect(execCalls).toHaveLength(0);
    expect(listCalls).toHaveLength(0);
  });

  it("runs the explicit delete statements, in order, when onDelete is 'run'", async () => {
    const config = validConfig({
      onDelete: 'run',
      deleteStatements: ['DROP TABLE IF EXISTS orders.events', 'DROP DATABASE IF EXISTS orders'],
    });
    const { executor, execCalls } = fakeExecutor();
    await deleteClickHouseSchema(context(executor, config));
    expect(execCalls.map((call) => call.stdin.trim())).toEqual([
      'DROP TABLE IF EXISTS orders.events',
      'DROP DATABASE IF EXISTS orders',
    ]);
  });

  it('fans the delete statements out across every server too', async () => {
    const config = validConfig({
      onDelete: 'run',
      deleteStatements: ['DROP DATABASE IF EXISTS orders'],
    });
    const { executor, execCalls } = fakeExecutor({
      podPages: [[readyPod('chi-orders-0-0-0'), readyPod('chi-orders-0-1-0')]],
    });
    await deleteClickHouseSchema(context(executor, config));
    expect(execCalls.map((call) => call.podName)).toEqual(['chi-orders-0-0-0', 'chi-orders-0-1-0']);
  });
});

describe('ClickHouseSchema — error handling', () => {
  it('attributes a SQL failure to its statement index and ClickHouse code, without retrying', async () => {
    const { executor, execCalls } = fakeExecutor({
      results: [
        { stdout: '', stderr: '', exitCode: 0 },
        {
          stdout: '',
          stderr: 'Code: 62. DB::Exception: Syntax error: failed at position 1',
          exitCode: 62,
        },
      ],
    });

    const error = await applyClickHouseSchema(context(executor, validConfig()), undefined).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(ClickHouseSchemaError);
    const schemaError = error as ClickHouseSchemaError;
    expect(schemaError.statementIndex).toBe(1);
    expect(schemaError.clickHouseCode).toBe(62);
    expect(schemaError.clickHouseException).toBe('DB::Exception');
    // Two execs total: statement 0 succeeded, statement 1 failed and was NOT retried.
    expect(execCalls).toHaveLength(2);
  });

  it('attributes the failure to the LOGICAL resource id, not the provider type', async () => {
    const { executor } = fakeExecutor({
      results: [{ stdout: '', stderr: 'Code: 60. DB::Exception: Unknown table', exitCode: 60 }],
    });
    const error = (await applyClickHouseSchema(
      { executor, config: validConfig(), resourceId: 'billing-schema', deps: fakeDeps().deps },
      undefined
    ).catch((caught: unknown) => caught)) as ClickHouseSchemaError;

    expect(error.resourceId).toBe('billing-schema');
    expect(error.message).toContain("'billing-schema'");
    expect(error.message).not.toContain('TypeKro.ClickHouseSchema');
  });

  it('names the pod a statement failed on', async () => {
    const { executor } = fakeExecutor({
      podPages: [[readyPod('chi-orders-0-1-0')]],
      results: [{ stdout: '', stderr: 'Code: 60. DB::Exception: Unknown table', exitCode: 60 }],
    });
    const error = (await applyClickHouseSchema(context(executor, validConfig()), undefined).catch(
      (caught: unknown) => caught
    )) as ClickHouseSchemaError;
    expect(error.message).toContain('chi-orders-0-1-0');
  });

  it('never carries the failing statement text on the error', async () => {
    const { executor } = fakeExecutor({
      results: [{ stdout: '', stderr: 'Code: 60. DB::Exception: Unknown table', exitCode: 60 }],
    });
    const error = (await applyClickHouseSchema(context(executor, validConfig()), undefined).catch(
      (caught: unknown) => caught
    )) as ClickHouseSchemaError;

    expect(error.message).not.toContain('CREATE DATABASE');
    expect(error.detail ?? '').not.toContain('CREATE DATABASE');
  });

  it('retries a transient transport failure and then succeeds', async () => {
    const { executor, execCalls } = fakeExecutor({
      results: [
        new Error('websocket closed unexpectedly'),
        { stdout: '', stderr: '', exitCode: 0 },
        { stdout: '', stderr: '', exitCode: 0 },
      ],
    });
    const { deps, slept } = fakeDeps();
    const state = await applyClickHouseSchema(
      context(executor, validConfig(), { deps }),
      undefined
    );
    expect(execCalls).toHaveLength(3);
    expect(slept.length).toBeGreaterThan(0);
    expect(state.statementCount).toBe(2);
  });

  it('gives up after the configured attempt budget on a persistent transport failure', async () => {
    const { executor, execCalls } = fakeExecutor({
      results: Array.from({ length: 10 }, () => new Error('ECONNRESET')),
    });
    const error = (await applyClickHouseSchema(
      context(executor, validConfig({ retry: { maxAttempts: 2, backoffMs: 5 } })),
      undefined
    ).catch((caught: unknown) => caught)) as ClickHouseSchemaError;

    expect(error).toBeInstanceOf(ClickHouseSchemaError);
    expect(error.statementIndex).toBe(0);
    expect(error.clickHouseCode).toBeUndefined();
    expect(execCalls).toHaveLength(2);
  });
});

describe("ClickHouseSchema — pod selection under 'fanout'", () => {
  it('waits for a Ready+Pending mix, then applies to ALL of them', async () => {
    // A StatefulSet mid-rollout. Taking the Ready pod alone would record a successful
    // cluster-wide apply after touching one replica of three.
    const { executor, execCalls } = fakeExecutor({
      podPages: [
        [readyPod('chi-orders-0-0-0'), pendingPod('chi-orders-0-1-0')],
        [readyPod('chi-orders-0-0-0'), pendingPod('chi-orders-0-1-0')],
        [readyPod('chi-orders-0-0-0'), readyPod('chi-orders-0-1-0')],
      ],
    });
    const state = await applyClickHouseSchema(
      context(executor, validConfig({ waitForPod: { timeoutMs: 30_000 } })),
      undefined
    );

    expect(execCalls).toHaveLength(4);
    expect(state.podNames).toEqual(['chi-orders-0-0-0', 'chi-orders-0-1-0']);
  });

  it('never applies to a strict subset: it execs nothing until every pod is Ready', async () => {
    const { executor, execCalls } = fakeExecutor({
      podPages: [[readyPod('chi-orders-0-0-0'), pendingPod('chi-orders-0-1-0')]],
    });
    const error = (await applyClickHouseSchema(
      context(executor, validConfig({ waitForPod: { timeoutMs: 5_000 } })),
      undefined
    ).catch((caught: unknown) => caught)) as ClickHouseSchemaError;

    expect(error).toBeInstanceOf(ClickHouseSchemaError);
    expect(execCalls).toHaveLength(0);
  });

  it('times out naming the pod that never became Ready, and its phase', async () => {
    const { executor } = fakeExecutor({
      podPages: [[readyPod('chi-orders-0-0-0'), pendingPod('chi-orders-0-1-0')]],
    });
    const error = (await selectExecutionPods(
      context(executor, validConfig({ waitForPod: { timeoutMs: 5_000 } }))
    ).catch((caught: unknown) => caught)) as ClickHouseSchemaError;

    expect(error).toBeInstanceOf(ClickHouseSchemaError);
    expect(error.message).toContain('clickhouse.altinity.com/chi=orders');
    expect(error.message).toContain('1 of 2 pod(s) were still not Ready');
    expect(error.message).toContain('chi-orders-0-1-0: Pending, not Ready');
    expect(error.message).toContain("execution.mode 'onCluster'");
  });

  it('times out with a diagnosable error when no pod matches at all', async () => {
    const { executor } = fakeExecutor({ podPages: [[]] });
    const error = (await selectExecutionPods(
      context(executor, validConfig({ waitForPod: { timeoutMs: 5_000 } }))
    ).catch((caught: unknown) => caught)) as ClickHouseSchemaError;

    expect(error).toBeInstanceOf(ClickHouseSchemaError);
    expect(error.message).toContain('no pod matched the selector');
  });

  it('waits for a pod to become Ready within the budget', async () => {
    const { executor, listCalls } = fakeExecutor({
      podPages: [[pendingPod('chi-orders-0-0-0')], [], [readyPod('chi-orders-0-0-0')]],
    });
    const pods = await selectExecutionPods(
      context(executor, validConfig({ waitForPod: { timeoutMs: 30_000 } }))
    );
    expect(pods.map((pod) => pod.name)).toEqual(['chi-orders-0-0-0']);
    expect(listCalls.length).toBe(3);
  });

  it('excludes a terminating pod — it is leaving, so nothing waits for it', async () => {
    const { executor } = fakeExecutor({
      podPages: [[readyPod('chi-orders-0-0-0'), terminatingPod('chi-orders-0-1-0')]],
    });
    const pods = await selectExecutionPods(context(executor, validConfig()));
    expect(pods.map((pod) => pod.name)).toEqual(['chi-orders-0-0-0']);
  });

  it('excludes a pod in a terminal phase rather than waiting out the budget on it', async () => {
    const { executor } = fakeExecutor({
      podPages: [[readyPod('chi-orders-0-0-0'), finishedPod('chi-orders-0-1-0')]],
    });
    const pods = await selectExecutionPods(context(executor, validConfig()));
    expect(pods.map((pod) => pod.name)).toEqual(['chi-orders-0-0-0']);
  });

  it('fails immediately when ONE matching pod lacks the container, naming it', async () => {
    // Waiting cannot add a container to a running pod, and applying to the other two would
    // be the partial fanout this mode exists to rule out.
    const { executor, listCalls } = fakeExecutor({
      podPages: [
        [
          readyPod('chi-orders-0-0-0'),
          { name: 'chi-orders-0-1-0', ready: true, containers: ['server', 'sidecar'] },
          readyPod('chi-orders-0-2-0'),
        ],
      ],
    });
    const error = (await selectExecutionPods(
      context(executor, validConfig({ waitForPod: { timeoutMs: 30_000 } }))
    ).catch((caught: unknown) => caught)) as ClickHouseSchemaError;

    expect(error).toBeInstanceOf(ClickHouseSchemaError);
    expect(error.message).toContain('1 of 3');
    expect(error.message).toContain('chi-orders-0-1-0: server, sidecar');
    expect(error.message).toContain('target.container');
    expect(listCalls).toHaveLength(1);
  });

  it('records the set the statements REACHED when the topology moves mid-run', async () => {
    // Selection saw two pods; a third appeared while the statements were running. State
    // records the two that were actually applied to, never the live three — and the next
    // converge re-applies precisely because the two sets now differ.
    const { executor, execCalls } = fakeExecutor({
      podPages: [
        [readyPod('chi-orders-0-0-0'), readyPod('chi-orders-0-1-0')],
        [readyPod('chi-orders-0-0-0'), readyPod('chi-orders-0-1-0'), readyPod('chi-orders-0-2-0')],
      ],
    });
    const config = validConfig();
    const state = await applyClickHouseSchema(context(executor, config), undefined);

    expect(execCalls).toHaveLength(4);
    expect(state.podNames).toEqual(['chi-orders-0-0-0', 'chi-orders-0-1-0']);

    // Nothing the fingerprint can see changed …
    expect(needsApply(config, state)).toBe(false);
    // … and yet the next converge re-applies, precisely because the recorded set is what
    // was reached rather than what was live, so it no longer matches the live set.
    const next = fakeExecutor({
      podPages: [
        [readyPod('chi-orders-0-0-0'), readyPod('chi-orders-0-1-0'), readyPod('chi-orders-0-2-0')],
      ],
    });
    const reapplied = await applyClickHouseSchema(context(next.executor, config), state);
    expect(next.execCalls).toHaveLength(6);
    expect(reapplied.podNames).toEqual([
      'chi-orders-0-0-0',
      'chi-orders-0-1-0',
      'chi-orders-0-2-0',
    ]);
  });
});

describe("ClickHouseSchema — pod selection under 'onCluster'", () => {
  const onClusterConfig = (overrides: Record<string, unknown> = {}) =>
    validConfig({
      execution: { mode: 'onCluster', cluster: 'cluster' },
      statements: ['CREATE DATABASE IF NOT EXISTS orders ON CLUSTER cluster'],
      ...overrides,
    });

  it('does NOT wait for the pods that are still rolling — Keeper distributes the DDL', async () => {
    const { executor } = fakeExecutor({
      podPages: [[pendingPod('chi-orders-0-0-0'), readyPod('chi-orders-0-1-0')]],
    });
    const pods = await selectExecutionPods(context(executor, onClusterConfig()));
    expect(pods.map((pod) => pod.name)).toEqual(['chi-orders-0-1-0']);
  });

  it('considers LATER Ready pods rather than judging by the first one', async () => {
    // The first Ready pod is from a template without the server container; the second is
    // a perfectly good initiator, and rejecting the converge because of the first one
    // would throw it away.
    const { executor } = fakeExecutor({
      podPages: [
        [
          { name: 'chi-orders-0-0-0', ready: true, containers: ['server'] },
          { name: 'chi-orders-0-1-0', ready: true, containers: ['clickhouse'] },
        ],
      ],
    });
    const pods = await selectExecutionPods(context(executor, onClusterConfig()));
    expect(pods.map((pod) => pod.name)).toEqual(['chi-orders-0-1-0']);
  });

  it('fails only when NO Ready pod qualifies, listing every candidate and its containers', async () => {
    const { executor } = fakeExecutor({
      podPages: [
        [
          { name: 'chi-orders-0-0-0', ready: true, containers: ['server'] },
          { name: 'chi-orders-0-1-0', ready: true, containers: ['server', 'sidecar'] },
        ],
      ],
    });
    const error = (await selectExecutionPods(context(executor, onClusterConfig())).catch(
      (caught: unknown) => caught
    )) as ClickHouseSchemaError;

    expect(error).toBeInstanceOf(ClickHouseSchemaError);
    expect(error.message).toContain('chi-orders-0-0-0: server');
    expect(error.message).toContain('chi-orders-0-1-0: server, sidecar');
    expect(error.message).toContain('target.container');
  });

  it('times out with a diagnosable error when no pod becomes Ready', async () => {
    const { executor } = fakeExecutor({ podPages: [[pendingPod('chi-orders-0-0-0')]] });
    const error = (await selectExecutionPods(
      context(executor, onClusterConfig({ waitForPod: { timeoutMs: 5_000 } }))
    ).catch((caught: unknown) => caught)) as ClickHouseSchemaError;

    expect(error).toBeInstanceOf(ClickHouseSchemaError);
    expect(error.message).toContain('clickhouse.altinity.com/chi=orders');
    expect(error.message).toContain('none were Ready');
  });
});

describe('ClickHouseSchema — C-style escape decoding', () => {
  /** Decode one single-quoted literal through the lexer, as redaction does. */
  const decodeLiteral = (source: string): string => {
    const token = tokenizeClickHouseSql(`'${source}'`)[0];
    if (token?.kind !== 'quoted') throw new Error(`not a literal: ${source}`);
    return token.value;
  };

  // https://clickhouse.com/docs/sql-reference/syntax#string
  const table: ReadonlyArray<readonly [source: string, decoded: string]> = [
    ['\\a', '\u0007'],
    ['\\b', '\b'],
    ['\\e', '\u001b'],
    ['\\f', '\f'],
    ['\\n', '\n'],
    ['\\r', '\r'],
    ['\\t', '\t'],
    ['\\v', '\v'],
    ['\\0', '\0'],
    ['\\\\', '\\'],
    ["\\'", "'"],
    ['\\"', '"'],
    ['\\`', '`'],
    ['\\/', '/'],
    ['\\=', '='],
  ];

  it.each(table)('decodes %j to its documented character', (source, decoded) => {
    expect(decodeLiteral(source)).toBe(decoded);
  });

  it('decodes \\n to a NEWLINE, not to the letter n', () => {
    // The bug this replaces turned every `\c` into `c`, so a credential containing a
    // newline was extracted in a spelling the server never emits.
    expect(decodeLiteral('a\\nb')).toBe('a\nb');
    expect(decodeLiteral('a\\nb')).not.toBe('anb');
  });

  it('decodes \\xHH as an 8-bit character', () => {
    expect(decodeLiteral('\\x41')).toBe('A');
    expect(decodeLiteral('\\x0a')).toBe('\n');
    expect(decodeLiteral('a\\x41b')).toBe('aAb');
  });

  it('leaves \\x literal when two hex digits do not follow', () => {
    expect(decodeLiteral('\\xZZ')).toBe('\\xZZ');
    expect(decodeLiteral('\\x4')).toBe('\\x4');
  });

  it('decodes \\N to nothing — it is reserved and does nothing', () => {
    expect(decodeLiteral('a\\Nb')).toBe('ab');
  });

  it('keeps the backslash before an unlisted character, as the docs require', () => {
    // "The backslash loses its special meaning i.e. it is interpreted literally should it
    // precede characters other than the ones listed below." So `\%` survives into a LIKE
    // pattern as two characters.
    expect(decodeLiteral('Hello 100\\%')).toBe('Hello 100\\%');
    expect(decodeLiteral('\\z')).toBe('\\z');
  });

  it('keeps a backslash that ends the statement, with nothing left to escape', () => {
    // An unterminated literal whose last character is the backslash itself.
    const token = tokenizeClickHouseSql("'abc\\")[0];
    expect(token?.kind === 'quoted' ? token.value : undefined).toBe('abc\\');
  });

  it('round-trips: re-escaping a decoded value decodes back to it', () => {
    for (const value of ['a\nb', "pa'ss", 'back\\slash', 'tab\tsep', 'plain-value', '\0\u0007']) {
      expect(decodeLiteral(escapeClickHouseString(value))).toBe(value);
    }
  });

  it('re-escapes with the same table the decoder reads', () => {
    expect(escapeClickHouseString('a\nb')).toBe('a\\nb');
    expect(escapeClickHouseString("pa'ss")).toBe("pa\\'ss");
    expect(escapeClickHouseString('back\\slash')).toBe('back\\\\slash');
    // Inside `'…'` these need no escape, so the source spelling is the character itself.
    expect(escapeClickHouseString('a"b`c/d=e')).toBe('a"b`c/d=e');
  });
});

describe('ClickHouseSchema — a credential containing a newline escape', () => {
  // One secret, two spellings: the source `hunter2\nzx9qv-fake` and the decoded value
  // carrying a real newline. Neither the value nor the surrounding text contains a word
  // the keyword line filter matches, so this exercises the literal replacement alone.
  const RAW_SOURCE = 'hunter2\\nzx9qv-fake';
  const DECODED = 'hunter2\nzx9qv-fake';
  const statement = `CREATE USER reporting IDENTIFIED BY '${RAW_SOURCE}'`;
  const echoOf = (value: string) =>
    `Code: 516. DB::Exception: Authentication failed for user reporting: ${value}`;

  it('collects both the decoded value and the raw source spelling', () => {
    const secrets = extractStatementSecrets(statement);
    expect(secrets).toContain(DECODED);
    expect(secrets).toContain(RAW_SOURCE);
  });

  it('redacts the secret echoed back as a REAL newline', () => {
    const redacted = redactClickHouseOutput(echoOf(DECODED), statement);
    expect(redacted).not.toContain(DECODED);
    expect(redacted).toContain('Code: 516');
  });

  it('redacts the secret echoed back RAW', () => {
    const redacted = redactClickHouseOutput(echoOf(RAW_SOURCE), statement);
    expect(redacted).not.toContain(RAW_SOURCE);
    expect(redacted).not.toContain(DECODED);
  });
});

describe('ClickHouseSchema — redaction', () => {
  const s3Statement =
    'CREATE TABLE IF NOT EXISTS orders.archive (id UUID) ENGINE = S3(' +
    "'https://storage.example.invalid/archive', 'AKIAIOSFODNN7EXAMPLE', " +
    "'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'CSV')";

  // ClickHouse quotes the offending definition back verbatim and says nothing about
  // "password" or "secret" — the exact case keyword matching walks straight past.
  const s3Echo =
    'Code: 36. DB::Exception: Bad arguments: ' +
    "S3('https://storage.example.invalid/archive', 'AKIAIOSFODNN7EXAMPLE', " +
    "'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'CSV')";

  it('redacts positional credentials the server echoed back, which keywords never see', () => {
    const redacted = redactClickHouseOutput(s3Echo, s3Statement);

    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redacted).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(redacted).toContain('<redacted>');
  });

  it('keeps the error code and exception class, which is what a reader needs', () => {
    expect(parseClickHouseErrorCode(s3Echo)).toBe(36);
    expect(parseClickHouseExceptionName(s3Echo)).toBe('DB::Exception');
    expect(redactClickHouseOutput(s3Echo, s3Statement)).toContain('Code: 36');
  });

  it('strips the submitted statement itself when the server echoes it whole', () => {
    const echo = `Code: 62. DB::Exception: Syntax error in: ${s3Statement}`;
    const redacted = redactClickHouseOutput(echo, s3Statement);
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redacted).toContain('Code: 62');
  });

  it('redacts a keyword-introduced credential too', () => {
    const statement = "CREATE USER reporting IDENTIFIED BY 'hunter2-not-a-real-password'";
    expect(extractStatementSecrets(statement)).toContain('hunter2-not-a-real-password');
    const redacted = redactClickHouseOutput(
      'Code: 81. Exception: bad user hunter2-not-a-real-password',
      statement
    );
    expect(redacted).not.toContain('hunter2-not-a-real-password');
  });

  describe('a credential whose value contains a quote', () => {
    // One secret, three spellings. ClickHouse quotes back whichever it feels like — often
    // the source text, since that is what it is complaining about. The value deliberately
    // contains none of the words the line filter matches, so these tests exercise the
    // literal replacement rather than the keyword layer behind it.
    const DECODED = "hunter2'x-zx9qv-fake";
    const BACKSLASH_SOURCE = "hunter2\\'x-zx9qv-fake";
    const DOUBLED_SOURCE = "hunter2''x-zx9qv-fake";
    const echoOf = (value: string) =>
      `Code: 516. DB::Exception: Authentication failed for user reporting: ${value}`;

    const backslashStatement = `CREATE USER reporting IDENTIFIED BY '${BACKSLASH_SOURCE}'`;
    const doubledStatement = `CREATE USER reporting IDENTIFIED BY '${DOUBLED_SOURCE}'`;

    it('collects the decoded value AND both escaped source spellings', () => {
      const secrets = extractStatementSecrets(backslashStatement);
      expect(secrets).toContain(DECODED);
      expect(secrets).toContain(BACKSLASH_SOURCE);
      expect(secrets).toContain(DOUBLED_SOURCE);
    });

    it("redacts a \\' secret echoed back in its RAW source form", () => {
      const redacted = redactClickHouseOutput(echoOf(BACKSLASH_SOURCE), backslashStatement);
      expect(redacted).not.toContain(BACKSLASH_SOURCE);
      expect(redacted).not.toContain(DECODED);
      expect(redacted).toContain('Code: 516');
    });

    it("redacts a \\' secret echoed back DECODED", () => {
      const redacted = redactClickHouseOutput(echoOf(DECODED), backslashStatement);
      expect(redacted).not.toContain(DECODED);
    });

    it("redacts a '' secret in both forms as well", () => {
      for (const echo of [DOUBLED_SOURCE, DECODED, BACKSLASH_SOURCE]) {
        const redacted = redactClickHouseOutput(echoOf(echo), doubledStatement);
        expect(redacted).not.toContain(echo);
        expect(redacted).not.toContain(DECODED);
      }
    });

    it('matches the credential keyword case-insensitively', () => {
      const statement = `CREATE USER reporting Identified By '${BACKSLASH_SOURCE}'`;
      const secrets = extractStatementSecrets(statement);
      expect(secrets).toContain(DECODED);
      expect(secrets).toContain(BACKSLASH_SOURCE);
    });

    it('returns the forms longest first, so no form is stranded inside another', () => {
      const secrets = extractStatementSecrets(backslashStatement);
      const lengths = secrets.map((secret) => secret.length);
      expect([...lengths].sort((left, right) => right - left)).toEqual(lengths);
    });
  });

  it('caps what it retains, so a runaway echo cannot be carried into state', () => {
    const echo = `Code: 47. DB::Exception: ${'x'.repeat(50_000)}`;
    const redacted = redactClickHouseOutput(echo);
    expect(redacted.length).toBeLessThan(MAX_RETAINED_DETAIL_CHARS + 32);
    expect(redacted).toContain('Code: 47');
    expect(redacted).toContain('[truncated]');
  });

  it('carries the redacted detail onto the error, not the raw output', async () => {
    const config = validConfig({ statements: [s3Statement] });
    const { executor } = fakeExecutor({
      results: [{ stdout: '', stderr: s3Echo, exitCode: 36 }],
    });
    const error = (await applyClickHouseSchema(context(executor, config), undefined).catch(
      (caught: unknown) => caught
    )) as ClickHouseSchemaError;

    expect(error.clickHouseCode).toBe(36);
    expect(error.clickHouseException).toBe('DB::Exception');
    expect(error.detail ?? '').not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(error.detail ?? '').not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  });

  it('keeps the keyword line filter as a second layer', () => {
    const text = [
      'Code: 36. DB::Exception: Bad arguments',
      "  S3('https://storage.example.invalid/x', 'AKIAEXAMPLE', aws_secret_access_key)",
      'while processing the request',
    ].join('\n');
    const redacted = redactClickHouseText(text);
    expect(redacted).toContain('Code: 36');
    expect(redacted).toContain('[redacted]');
    expect(redacted).not.toContain('aws_secret_access_key');
  });

  it('parses ClickHouse error codes out of server output', () => {
    expect(parseClickHouseErrorCode('Code: 81. DB::Exception: Database does not exist')).toBe(81);
    expect(parseClickHouseErrorCode('no code here')).toBeUndefined();
  });
});
