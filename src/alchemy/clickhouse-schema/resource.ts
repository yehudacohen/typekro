/**
 * The `ClickHouseSchema` alchemy v2 resource.
 *
 * WHY AN ALCHEMY RESOURCE RATHER THAN A CronJob. TypeKro can already run ClickHouse DDL
 * from inside the cluster — `clickStackStorage`'s retention CronJob does exactly that —
 * and that is the right shape when the statements must wait for objects TypeKro does not
 * own (the OTel tables appear only after the collector migrates). Schema ownership is the
 * other case: the statements are the deployment's own DDL, they should run once per
 * converge rather than on a timer, a failure should fail the deploy instead of showing up
 * in a Job log, and the applied state should be diffable so an unchanged schema costs
 * nothing. That is a converge-time, stateful, ordered operation — an alchemy resource.
 *
 * ORDERING. A `ClickHouseSchema` depends on the ClickHouse instance the same way any
 * alchemy resource depends on another: pass the instance's `KroResource` output through
 * its props. Alchemy then deploys the instance (and waits for TypeKro's readiness
 * evaluation) before this resource's first exec. See `docs/api/alchemy/clickhouse-schema.md`.
 */

import type { KubeConfig } from '@kubernetes/client-node';
import * as ProviderMod from 'alchemy/Provider';
import type { Resource as ResourceT } from 'alchemy/Resource';
import * as ResourceMod from 'alchemy/Resource';
import { type } from 'arktype';
import { Effect } from 'effect';
import { materializeSerializableKubeConfigOptions } from '../../core/deployment/shared-utilities.js';
import { ValidationError } from '../../core/errors.js';
import { createKubernetesClientProvider } from '../../core/kubernetes/client-provider.js';
import { getComponentLogger } from '../../core/logging/index.js';
import { ensureError } from '../../core/errors.js';
import { KubeExecClickHouseExecutor } from './executor.js';
import {
  applyClickHouseSchema,
  computeFingerprint,
  deleteClickHouseSchema,
  needsApply,
} from './runner.js';
import {
  type ClickHouseExecutor,
  ClickHouseSchemaConfigSchema,
  type ClickHouseSchemaProps,
  type ClickHouseSchemaResourceProps,
  type ClickHouseSchemaState,
} from './types.js';

/** The alchemy resource type, following `KRO_RESOURCE_TYPE`'s `TypeKro.<Name>` convention. */
export const CLICKHOUSE_SCHEMA_RESOURCE_TYPE = 'TypeKro.ClickHouseSchema' as const;

export type ClickHouseSchemaR = ResourceT<
  typeof CLICKHOUSE_SCHEMA_RESOURCE_TYPE,
  ClickHouseSchemaResourceProps,
  ClickHouseSchemaState
>;

/**
 * The declarative resource. Prefer the {@link clickHouseSchema} factory, which validates
 * props against the ArkType schema before they reach alchemy state.
 */
export const ClickHouseSchema = ResourceMod.Resource<ClickHouseSchemaR>(
  CLICKHOUSE_SCHEMA_RESOURCE_TYPE
);

/** Build the transport: the injected executor if present, else exec over the kube API. */
function resolveExecutor(props: ClickHouseSchemaResourceProps): ClickHouseExecutor {
  if (props.executor) return props.executor;
  const kubeConfig: KubeConfig = createKubernetesClientProvider(
    props.kubeConfig ? materializeSerializableKubeConfigOptions(props.kubeConfig) : undefined
  ).getKubeConfig();
  return new KubeExecClickHouseExecutor(kubeConfig);
}

/**
 * The provider `Layer` backing {@link ClickHouseSchema}. Merge it into the alchemy
 * runtime's providers alongside `kroProvider`.
 */
export const clickHouseSchemaProvider = ProviderMod.effect(
  ClickHouseSchema,
  Effect.succeed<ProviderMod.ProviderService<ClickHouseSchemaR>>({
    // A schema is applied IN PLACE. Nothing about it is identity-stable: re-pointing the
    // resource at another server must re-apply the DDL there, never delete it here.
    stables: [],
    // Not discoverable cluster-wide: a schema leaves no object carrying this resource's
    // identity, so there is nothing for `alchemy nuke` to enumerate. Same stance as
    // `kroProvider`.
    list: () => Effect.succeed([]),
    reconcile: Effect.fn(function* ({ news, output }) {
      return yield* Effect.tryPromise({
        try: async (abortSignal) => {
          const logger = getComponentLogger('alchemy-clickhouse-schema');
          if (!needsApply(news, output)) {
            logger.debug('ClickHouse schema unchanged; skipping DDL', {
              fingerprint: output?.fingerprint,
              statementCount: news.statements.length,
            });
            // `needsApply` returning false guarantees a persisted output exists.
            return output as ClickHouseSchemaState;
          }
          logger.info('Applying ClickHouse schema', {
            namespace: news.target.namespace,
            statementCount: news.statements.length,
            fingerprint: computeFingerprint(news),
          });
          return await applyClickHouseSchema(
            resolveExecutor(news),
            news,
            CLICKHOUSE_SCHEMA_RESOURCE_TYPE,
            output,
            undefined,
            abortSignal
          );
        },
        catch: ensureError,
      });
    }),
    delete: Effect.fn(function* ({ olds }) {
      // `retain` (the default) must not even reach the cluster, so the missing-spec case
      // below is a no-op rather than a guess: reconstructing an unknown `onDelete` from
      // persisted output could only ever guess `retain`, which is what happens anyway.
      if (!olds || olds.onDelete !== 'run') return;
      yield* Effect.tryPromise({
        try: (abortSignal) =>
          deleteClickHouseSchema(
            resolveExecutor(olds),
            olds,
            CLICKHOUSE_SCHEMA_RESOURCE_TYPE,
            undefined,
            abortSignal
          ),
        catch: ensureError,
      });
    }),
  })
);

/**
 * Declare a ClickHouse schema, validating its configuration first.
 *
 * ```ts
 * const schema = yield* clickHouseSchema('orders-schema', {
 *   target: { namespace: 'telemetry', podSelector: { 'clickhouse.altinity.com/chi': 'orders' } },
 *   statements: [
 *     'CREATE DATABASE IF NOT EXISTS orders',
 *     'CREATE TABLE IF NOT EXISTS orders.events (id UUID, at DateTime) ENGINE = MergeTree ORDER BY at',
 *   ],
 * });
 * ```
 *
 * @param id - Stable alchemy resource id
 * @param props - Validated against {@link ClickHouseSchemaConfigSchema}
 * @throws ValidationError when the configuration is invalid
 */
export function clickHouseSchema(id: string, props: ClickHouseSchemaProps) {
  // `kubeConfig`/`executor` are not part of the ArkType schema (see `types.ts`), so they
  // are split off before validation and re-attached to the validated config afterwards.
  const { kubeConfig, executor, readyBarrier, ...configurable } = props;
  const validated = ClickHouseSchemaConfigSchema(configurable);
  if (validated instanceof type.errors) {
    throw new ValidationError(
      `Invalid ClickHouseSchema configuration for '${id}': ${validated.summary}`,
      'ClickHouseSchema',
      id
    );
  }
  return ClickHouseSchema(id, {
    ...validated,
    ...(kubeConfig ? { kubeConfig } : {}),
    ...(executor ? { executor } : {}),
    // Passed through unvalidated and unresolved: this is an alchemy `Output` at
    // declaration time, and alchemy resolves it before reconcile.
    ...(readyBarrier !== undefined ? { readyBarrier } : {}),
  });
}
