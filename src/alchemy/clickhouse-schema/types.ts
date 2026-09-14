/**
 * Types, validation schema and errors for the `ClickHouseSchema` alchemy resource.
 *
 * The configurable surface is ArkType-first: {@link ClickHouseSchemaConfigSchema} is the
 * single source of truth and the config types are INFERRED from it, so a field cannot
 * exist in the type without existing in the schema that validates it. Only the two
 * fields ArkType cannot express usefully are declared separately on
 * {@link ClickHouseSchemaProps}: `kubeConfig` (a structural TypeScript type owned by the
 * client provider) and `executor` (a runtime-only injection point, deliberately not
 * serializable — mirroring `TypeKroResourceProps.deployer`).
 */

import { type } from 'arktype';
import { TypeKroError } from '../../core/errors.js';
import type { SerializableKubeConfigOptions } from '../types.js';

/**
 * Accepted shape for a ClickHouse user or database name.
 *
 * Every value that reaches the container is embedded in a single-quoted `sh -c`
 * word, so a value containing a quote could close that word. It cannot: names are
 * restricted here to characters that are inert in both the shell and
 * `clickhouse-client`'s own argument parsing, and the renderer single-quotes them
 * anyway (defence in depth, the same pairing the S3 backup CronJob uses).
 */
const CLICKHOUSE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** POSIX environment variable name — what `--password "$VAR"` can expand. */
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `--<setting>=<value>` setting name, matching ClickHouse's own setting identifiers. */
const SETTING_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

/** Setting value: scalars only. Anything needing quoting belongs in a statement. */
const SETTING_VALUE_PATTERN = /^[A-Za-z0-9_.,:+-]+$/;

/** Kubernetes label key: optional DNS-subdomain prefix plus a name segment. */
const LABEL_KEY_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\/)?[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;

/** Kubernetes label value: empty, or up to 63 alphanumeric-delimited characters. */
const LABEL_VALUE_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?)?$/;

/**
 * A plaintext credential must never be representable in props: it would be persisted
 * verbatim into the alchemy state store. `client` therefore REJECTS undeclared keys, so
 * `password` (and any near-miss spelling of it) fails validation instead of being
 * silently dropped and leaving the author believing they configured authentication.
 */
export const ClickHouseSchemaClientSchema = type({
  'user?': 'string > 0',
  /**
   * Name of the environment variable holding the password INSIDE the target container.
   * The value is never read by TypeKro, never echoed, and never enters props or state.
   */
  'passwordEnv?': 'string > 0',
  'database?': 'string > 0',
  'port?': 'number.integer > 0',
})
  .onUndeclaredKey('reject')
  .narrow((client, ctx) => {
    if (client.user !== undefined && !CLICKHOUSE_NAME_PATTERN.test(client.user)) {
      return ctx.mustBe('a ClickHouse user name matching [A-Za-z0-9_][A-Za-z0-9_.-]*');
    }
    if (client.database !== undefined && !CLICKHOUSE_NAME_PATTERN.test(client.database)) {
      return ctx.mustBe('a ClickHouse database name matching [A-Za-z0-9_][A-Za-z0-9_.-]*');
    }
    if (client.passwordEnv !== undefined && !ENV_VAR_NAME_PATTERN.test(client.passwordEnv)) {
      return ctx.mustBe('an environment variable name matching [A-Za-z_][A-Za-z0-9_]*');
    }
    if (client.port !== undefined && client.port > 65535) {
      return ctx.mustBe('a TCP port <= 65535');
    }
    return true;
  });

/** How to reach the ClickHouse server: a namespace, a label selector, and a container. */
export const ClickHouseSchemaTargetSchema = type({
  namespace: 'string > 0',
  /**
   * Label selector for the server pods — e.g. the Altinity CHI label
   * `{ 'clickhouse.altinity.com/chi': 'orders' }`. The first READY pod matching it is
   * used; ClickHouse replicas share the schema, so any healthy replica will do.
   */
  podSelector: 'Record<string, string>',
  /** Container to exec into. Defaults to the CHI server container, `clickhouse`. */
  'container?': 'string > 0',
}).narrow((target, ctx) => {
  const entries = Object.entries(target.podSelector);
  if (entries.length === 0) {
    return ctx.mustBe('a non-empty pod label selector');
  }
  for (const [key, value] of entries) {
    if (!LABEL_KEY_PATTERN.test(key)) {
      return ctx.mustBe(`a valid Kubernetes label key (got '${key}')`);
    }
    if (!LABEL_VALUE_PATTERN.test(value)) {
      return ctx.mustBe(`a valid Kubernetes label value for '${key}'`);
    }
  }
  return true;
});

/** Bounded wait for a Ready server pod before the first exec. */
export const ClickHouseSchemaWaitForPodSchema = type({
  timeoutMs: 'number.integer > 0',
});

/** Bounded retry of TRANSIENT exec failures. A SQL error is never retried. */
export const ClickHouseSchemaRetrySchema = type({
  'maxAttempts?': 'number.integer > 0',
  'backoffMs?': 'number.integer >= 0',
});

/**
 * The configurable (serializable) surface of a `ClickHouseSchema` resource.
 *
 * IDEMPOTENCE IS THE AUTHOR'S CONTRACT. Every statement is re-run whenever the
 * fingerprint changes, so each one must be safe to execute against a database where
 * it has already been executed: `CREATE DATABASE IF NOT EXISTS`, `CREATE TABLE IF NOT
 * EXISTS`, `CREATE OR REPLACE VIEW`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`,
 * `DROP ... IF EXISTS`. TypeKro cannot verify that property — it does not parse SQL —
 * so a non-idempotent statement surfaces as a converge that fails the second time.
 */
export const ClickHouseSchemaConfigSchema = type({
  target: ClickHouseSchemaTargetSchema,
  'client?': ClickHouseSchemaClientSchema,
  /** Ordered DDL. Executed in array order; each must be individually idempotent. */
  statements: 'string[] > 0',
  /** Passed to `clickhouse-client` as `--<setting>=<value>`. Identifiers validated. */
  'settings?': 'Record<string, string | number>',
  /**
   * `retain` (the default) leaves every object in place on delete: a schema resource
   * must never drop data because a stack was torn down. `run` executes
   * {@link deleteStatements} instead, which is the only way to express a destructive
   * teardown and requires spelling out exactly what gets dropped.
   */
  onDelete: "'retain' | 'run' = 'retain'",
  'deleteStatements?': 'string[]',
  'waitForPod?': ClickHouseSchemaWaitForPodSchema,
  /** Per-statement exec timeout. A long `CREATE MATERIALIZED VIEW ... POPULATE` may need more. */
  'statementTimeoutMs?': 'number.integer > 0',
  'retry?': ClickHouseSchemaRetrySchema,
}).narrow((config, ctx) => {
  const blank = config.statements.findIndex((statement) => statement.trim().length === 0);
  if (blank !== -1) {
    return ctx.mustBe(`non-empty statements (statement ${blank} is blank)`);
  }
  if (config.onDelete === 'run') {
    if (config.deleteStatements === undefined || config.deleteStatements.length === 0) {
      return ctx.mustBe("accompanied by a non-empty 'deleteStatements' when onDelete is 'run'");
    }
    const blankDelete = config.deleteStatements.findIndex((s) => s.trim().length === 0);
    if (blankDelete !== -1) {
      return ctx.mustBe(`non-empty deleteStatements (statement ${blankDelete} is blank)`);
    }
  } else if (config.deleteStatements !== undefined) {
    // Rejected rather than ignored: statements that can never run are a silent footgun,
    // and the author who wrote them believes teardown is covered.
    return ctx.mustBe("declared without 'deleteStatements' when onDelete is 'retain'");
  }
  for (const [name, value] of Object.entries(config.settings ?? {})) {
    if (!SETTING_NAME_PATTERN.test(name)) {
      return ctx.mustBe(`a ClickHouse setting name matching [a-z_][a-z0-9_]* (got '${name}')`);
    }
    if (!SETTING_VALUE_PATTERN.test(String(value))) {
      return ctx.mustBe(`a scalar setting value for '${name}'`);
    }
  }
  return true;
});

/** Author-facing (pre-validation) config: schema defaults are still optional here. */
export type ClickHouseSchemaConfigInput = typeof ClickHouseSchemaConfigSchema.inferIn;

/** Validated config: schema defaults have been applied. */
export type ClickHouseSchemaConfig = typeof ClickHouseSchemaConfigSchema.infer;

export type ClickHouseSchemaTarget = typeof ClickHouseSchemaTargetSchema.infer;
export type ClickHouseSchemaClient = typeof ClickHouseSchemaClientSchema.infer;

/** Non-serializable additions ArkType does not describe. */
interface ClickHouseSchemaNonSchemaProps {
  /**
   * Durable cluster connection state, exactly as `KroResource` accepts it. Omit to use
   * the ambient kubeconfig.
   */
  readonly kubeConfig?: SerializableKubeConfigOptions;
  /**
   * Injected transport. Runtime-only — like `TypeKroResourceProps.deployer`, this does
   * not survive alchemy state rehydration, so a resource that relies on it must be
   * reconstructed by the same process. Its purpose is testing and embedding.
   */
  readonly executor?: ClickHouseExecutor;
  /**
   * Alchemy ordering-only input: the channel that makes "run after the ClickHouse
   * instance is Ready" a real dependency edge rather than a coincidence of statement
   * order in the Stack body. Pass an alchemy `Output` derived from the instance's
   * `KroResource` handle and alchemy deploys that resource first:
   *
   * ```ts
   * readyBarrier: Output.map(Output.all(Output.of(instance)), () => true)
   * ```
   *
   * Only the resolved scalar is persisted — the same shape as
   * `TypeKroResourceProps.schedulingBarrier` — so the barrier orders the converge
   * without copying an unrelated resource's outputs into this one's state.
   */
  readonly readyBarrier?: boolean;
}

/** What an author passes to `clickHouseSchema(id, props)`. */
export type ClickHouseSchemaProps = ClickHouseSchemaConfigInput & ClickHouseSchemaNonSchemaProps;

/** What the provider receives: validated config plus the non-schema additions. */
export type ClickHouseSchemaResourceProps = ClickHouseSchemaConfig & ClickHouseSchemaNonSchemaProps;

/**
 * Persisted state / resource outputs.
 *
 * `fingerprint` is what makes the resource diffable: an unchanged fingerprint against an
 * unchanged target is a no-op converge, so a stack that redeploys hourly issues no DDL.
 */
export interface ClickHouseSchemaState {
  /** sha256 over the ordered statements, the settings and the client configuration. */
  readonly fingerprint: string;
  /** ISO-8601 instant the statements were last applied. */
  readonly appliedAt: string;
  readonly statementCount: number;
  /** Database the statements ran against (`default` unless `client.database` is set). */
  readonly database: string;
  /** Where the statements ran, so a target change is visible in state and forces a re-apply. */
  readonly target: ClickHouseSchemaTarget;
  /** The pod the last apply used. Informational — a later apply may pick another replica. */
  readonly podName: string;
}

/** One `clickhouse-client` invocation inside a server container. */
export interface ClickHouseExecCommand {
  readonly namespace: string;
  readonly podName: string;
  readonly container: string;
  readonly command: readonly string[];
  /** Statement text. Passed on stdin so SQL never appears in the container's argv. */
  readonly stdin: string;
  readonly timeoutMs: number;
}

export interface ClickHouseExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** 0 on success. A non-zero code is a SQL/command failure and is NEVER retried. */
  readonly exitCode: number;
}

/** A candidate server pod, reduced to what pod selection needs. */
export interface ClickHousePodSummary {
  readonly name: string;
  readonly ready: boolean;
  readonly containers: readonly string[];
}

/**
 * The exec transport.
 *
 * The contract that makes retries safe is the split between the two failure modes:
 *
 * - a REJECTED promise is a transport failure (websocket error, connection reset,
 *   API-server hiccup, timeout) and is retried;
 * - a RESOLVED result with a non-zero `exitCode` is a SQL failure and is not.
 *
 * Retrying a failed statement would be wrong in general — a partially applied
 * non-idempotent statement must surface, not be re-issued.
 */
export interface ClickHouseExecutor {
  listPods(
    namespace: string,
    podSelector: Readonly<Record<string, string>>,
    abortSignal?: AbortSignal
  ): Promise<readonly ClickHousePodSummary[]>;

  exec(command: ClickHouseExecCommand, abortSignal?: AbortSignal): Promise<ClickHouseExecResult>;
}

/**
 * A statement failed, a pod never became Ready, or the transport gave up.
 *
 * SECURITY: the failing statement's TEXT is never carried on the error — only its
 * INDEX. Statements should not contain credentials (bind them through the server's own
 * configuration, as the S3 storage compiler does), but a `CREATE TABLE ... S3(...,
 * aws_secret_access_key)` would, and ClickHouse echoes the offending fragment back in
 * its own message. Every message that reaches this error is passed through
 * {@link redactClickHouseText} first.
 */
export class ClickHouseSchemaError extends TypeKroError {
  constructor(
    message: string,
    public readonly resourceId: string,
    /** Index into `statements` (or `deleteStatements`), or `undefined` outside statement execution. */
    public readonly statementIndex?: number,
    /** ClickHouse's own error code, parsed from `Code: <n>.`, when the server produced one. */
    public readonly clickHouseCode?: number,
    /** Redacted server output. */
    public readonly detail?: string,
    options?: ErrorOptions
  ) {
    super(
      message,
      'CLICKHOUSE_SCHEMA_ERROR',
      { resourceId, statementIndex, clickHouseCode, detail },
      options
    );
    this.name = 'ClickHouseSchemaError';
  }
}

/**
 * Patterns whose surroundings are redacted out of any text that leaves the container.
 *
 * Matched case-insensitively against a whole line, because ClickHouse reports a bad
 * table definition by quoting the definition — which is precisely where a secret would
 * be if one were ever written into a statement.
 */
const SECRET_LINE_PATTERN = /password|secret|aws_secret|access_key|credential/i;

/** Replace every line that could carry a credential with a marker. */
export function redactClickHouseText(text: string): string {
  return text
    .split('\n')
    .map((line) => (SECRET_LINE_PATTERN.test(line) ? '[redacted]' : line))
    .join('\n');
}

/** Parse ClickHouse's `Code: 62. DB::Exception: …` prefix out of server output. */
export function parseClickHouseErrorCode(text: string): number | undefined {
  const match = /Code:\s*(\d+)/.exec(text);
  if (!match?.[1]) return undefined;
  const code = Number.parseInt(match[1], 10);
  return Number.isNaN(code) ? undefined : code;
}
