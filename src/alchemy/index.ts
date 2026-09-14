/**
 * Alchemy Integration Module
 *
 * This module provides integration with the Alchemy framework for deploying
 * and managing TypeKro resources and Kro ResourceGraphDefinitions.
 *
 * Uses dynamic resource registration to avoid "Resource already exists" errors.
 */

// ClickHouse schema management: converge-time DDL applied through `pods/exec`.
export {
  applyClickHouseSchema,
  CLICKHOUSE_SCHEMA_RESOURCE_TYPE,
  type ClickHouseExecCommand,
  type ClickHouseExecResult,
  type ClickHouseExecutor,
  type ClickHousePodSummary,
  ClickHouseSchema,
  type ClickHouseSchemaClient,
  ClickHouseSchemaClientSchema,
  type ClickHouseSchemaConfig,
  type ClickHouseSchemaConfigInput,
  ClickHouseSchemaConfigSchema,
  ClickHouseSchemaError,
  type ClickHouseSchemaExecution,
  ClickHouseSchemaExecutionSchema,
  type ClickHouseSchemaProps,
  type ClickHouseSchemaR,
  type ClickHouseSchemaResourceProps,
  type ClickHouseSchemaRunContext,
  type ClickHouseSchemaRuntimeDeps,
  type ClickHouseSchemaState,
  type ClickHouseSchemaTarget,
  ClickHouseSchemaTargetSchema,
  type ClickHouseSqlToken,
  clickHouseSchema,
  clickHouseSchemaProvider,
  computeFingerprint,
  DEFAULT_CLICKHOUSE_CONTAINER,
  DEFAULT_CLICKHOUSE_DATABASE,
  DEFAULT_CLICKHOUSE_PASSWORD_ENV,
  DEFAULT_CLICKHOUSE_PORT,
  DEFAULT_CLICKHOUSE_USER,
  DEFAULT_EXECUTION,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  DEFAULT_WAIT_FOR_POD_TIMEOUT_MS,
  deleteClickHouseSchema,
  escapeClickHouseString,
  extractStatementSecrets,
  KubeExecClickHouseExecutor,
  leadingKeyword,
  MAX_RETAINED_DETAIL_CHARS,
  needsApply,
  parseClickHouseErrorCode,
  parseClickHouseExceptionName,
  redactClickHouseOutput,
  redactClickHouseText,
  renderClickHouseCommand,
  runStatements,
  selectExecutionPods,
  statementTargetsCluster,
  tokenizeClickHouseSql,
  validateOnClusterStatement,
} from './clickhouse-schema/index.js';
// Deployer implementations
export { DirectTypeKroDeployer, KroTypeKroDeployer } from './deployers.js';
export type { AlchemyPromise, AlchemyResolutionContext, AlchemyResource } from './resolver.js';

// Reference resolution
export {
  buildResourceGraphWithDeferredResolution,
  containsAlchemyPromises,
  createAlchemyReferenceResolver,
  createAlchemyResourceConfig,
  createAlchemyResourceConfigs,
  extractAlchemyPromises,
  hasMixedDependencies,
  isAlchemyPromise,
  isAlchemyResource,
  resolveAlchemyPromise,
  resolveAllReferences,
  resolveAllReferencesInAlchemyContext,
  resolveReferencesWithAlchemy,
  resolveTypeKroReferencesOnly,
} from './resolver.js';
export type { KroResourceR } from './resource-registration.js';
// Alchemy v2 KRO resource (declarative): instantiate `KroResource` in a Stack and merge
// `kroProvider` into the runtime's providers. Replaces the v1 imperative registration.
export {
  buildAlchemyDeploymentOptions,
  KRO_RESOURCE_TYPE,
  KroResource,
  kroProvider,
  materializeAlchemyResources,
} from './resource-registration.js';
// Type inference
export { inferAlchemyTypeFromTypeKroResource } from './type-inference.js';
// Types
export type {
  AlchemyArtifactBinding,
  AlchemyResourceDeclaration,
  AlchemyResourceState,
  MaterializeAlchemyResourcesOptions,
  SerializableKubeConfigOptions,
  TypeKroDeployer,
  TypeKroResource,
  TypeKroResourceProps,
} from './types.js';

// Utility functions
export { createAlchemyResourceId } from './utilities.js';

// Wrapper utilities
export { generateDeterministicResourceId } from './wrapper.js';
