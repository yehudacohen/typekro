/**
 * ClickHouse schema management as an alchemy v2 resource.
 *
 * @see docs/api/alchemy/clickhouse-schema.md
 */

export { KubeExecClickHouseExecutor } from './executor.js';
export {
  CLICKHOUSE_SCHEMA_RESOURCE_TYPE,
  ClickHouseSchema,
  type ClickHouseSchemaR,
  clickHouseSchema,
  clickHouseSchemaProvider,
} from './resource.js';
export {
  applyClickHouseSchema,
  computeFingerprint,
  DEFAULT_BACKOFF_MS,
  DEFAULT_CLICKHOUSE_CONTAINER,
  DEFAULT_CLICKHOUSE_DATABASE,
  DEFAULT_CLICKHOUSE_PASSWORD_ENV,
  DEFAULT_CLICKHOUSE_PORT,
  DEFAULT_CLICKHOUSE_USER,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  DEFAULT_WAIT_FOR_POD_TIMEOUT_MS,
  deleteClickHouseSchema,
  needsApply,
  renderClickHouseCommand,
  runStatements,
  selectExecutionPods,
} from './runner.js';
export type { ClickHouseSchemaRunContext, ClickHouseSchemaRuntimeDeps } from './runner.js';
export {
  type ClickHouseSqlToken,
  extractStatementSecrets,
  leadingKeyword,
  referencedDatabases,
  statementTargetsCluster,
  tokenizeClickHouseSql,
  validateOnClusterStatement,
} from './sql.js';
export {
  type ClickHouseExecCommand,
  type ClickHouseExecResult,
  type ClickHouseExecutor,
  type ClickHousePodSummary,
  type ClickHouseSchemaClient,
  ClickHouseSchemaClientSchema,
  type ClickHouseSchemaConfig,
  type ClickHouseSchemaConfigInput,
  ClickHouseSchemaConfigSchema,
  ClickHouseSchemaError,
  type ClickHouseSchemaExecution,
  ClickHouseSchemaExecutionSchema,
  type ClickHouseSchemaProps,
  type ClickHouseSchemaResourceProps,
  type ClickHouseSchemaState,
  type ClickHouseSchemaTarget,
  ClickHouseSchemaTargetSchema,
  DEFAULT_EXECUTION,
  MAX_RETAINED_DETAIL_CHARS,
  parseClickHouseErrorCode,
  parseClickHouseExceptionName,
  redactClickHouseOutput,
  redactClickHouseText,
} from './types.js';
