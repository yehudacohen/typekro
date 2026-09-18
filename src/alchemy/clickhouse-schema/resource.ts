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
import { clusterIdentity } from '../../core/kubernetes/api-capability.js';
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

/** The transport plus the identity of the cluster it reaches. */
interface ClickHouseSchemaTransport {
  readonly executor: ClickHouseExecutor;
  readonly clusterId: string | undefined;
}

/**
 * Build the transport: the injected executor if present, else exec over the kube API.
 *
 * The cluster identity travels WITH the transport rather than being derived later,
 * because they answer the same question — which API server this converge is talking to —
 * and deriving it twice is how the two drift apart. `clusterIdentity` is the helper the
 * per-cluster capability cache already keys on, reused rather than re-derived, so the two
 * caches cannot disagree about what "the same cluster" means.
 *
 * An injected executor is still identified when a kubeConfig accompanies it: the caller
 * supplying its own transport does not make the target cluster unknowable. Only an
 * injected executor with no kubeConfig at all has no identity to record.
 *
 * @internal — exported for tests
 */
export function resolveTransport(props: ClickHouseSchemaResourceProps): ClickHouseSchemaTransport {
  // The provider must ALWAYS be handed a config object here: `createKubernetesClientProvider`
  // only calls `initialize` when its argument is truthy, so `undefined` for the ambient case
  // returned an uninitialized provider whose `getKubeConfig()` threw on the first exec (#219).
  // `{}` runs `initialize`, which reaches `loadFromDefault()` — `KUBECONFIG`, then
  // `~/.kube/config` — which is what "omit kubeConfig for the ambient kubeconfig" promises.
  const kubeConfig: KubeConfig | undefined =
    props.executor && !props.kubeConfig
      ? undefined
      : createKubernetesClientProvider(
          props.kubeConfig ? materializeSerializableKubeConfigOptions(props.kubeConfig) : {}
        ).getKubeConfig();

  return {
    executor: props.executor ?? new KubeExecClickHouseExecutor(kubeConfig as KubeConfig),
    clusterId: kubeConfig ? clusterIdentity(kubeConfig) : undefined,
  };
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
    // `id` is the author's own name for THIS schema — the thing that distinguishes
    // `orders-schema` from `billing-schema` in an error. The provider TYPE is the same
    // constant for every instance and says nothing, which is why it is not used here.
    reconcile: Effect.fn(function* ({ id, news, output }) {
      return yield* Effect.tryPromise({
        try: async (abortSignal) => {
          const logger = getComponentLogger('alchemy-clickhouse-schema');
          const { executor, clusterId } = resolveTransport(news);
          if (!needsApply(news, output, clusterId)) {
            logger.debug('ClickHouse schema unchanged; verifying the server set', {
              resourceId: id,
              fingerprint: output?.fingerprint,
              statementCount: news.statements.length,
              clusterId,
            });
          } else {
            logger.info('Applying ClickHouse schema', {
              resourceId: id,
              namespace: news.target.namespace,
              statementCount: news.statements.length,
              fingerprint: computeFingerprint(news),
              executionMode: news.execution.mode,
              clusterId,
            });
          }
          return await applyClickHouseSchema(
            { executor, config: news, resourceId: id, clusterId, abortSignal },
            output
          );
        },
        catch: ensureError,
      });
    }),
    delete: Effect.fn(function* ({ id, olds }) {
      // `retain` (the default) must not even reach the cluster, so the missing-spec case
      // below is a no-op rather than a guess: reconstructing an unknown `onDelete` from
      // persisted output could only ever guess `retain`, which is what happens anyway.
      if (!olds || olds.onDelete !== 'run') return;
      yield* Effect.tryPromise({
        try: (abortSignal) => {
          const { executor, clusterId } = resolveTransport(olds);
          return deleteClickHouseSchema({
            executor,
            config: olds,
            resourceId: id,
            clusterId,
            abortSignal,
          });
        },
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
