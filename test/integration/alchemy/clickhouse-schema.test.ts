/**
 * `ClickHouseSchema` against a live ClickHouse — cluster-gated integration suite.
 *
 * Follows the existing ClickHouse harness (`test/integration/clickhouse/s3-storage.test.ts`):
 * the whole suite SKIPS cleanly when no cluster is reachable.
 *
 * LIVE-PATH PREREQUISITES (a clean skip without a cluster is the hard requirement; a live
 * pass needs all of these):
 * - A kind/OrbStack cluster with the TypeKro runtime installed (the Flux source/helm
 *   controllers the Altinity operator bootstrap needs), i.e. `bun run scripts/e2e-setup.ts`.
 * - Outbound access to pull the Altinity operator chart and the ClickHouse server image.
 * - RBAC for `pods/exec` (`create`) and `pods` (`list`) in the CHI namespace — which is
 *   the resource's only cluster requirement beyond reachability.
 *
 * WHAT IT PROVES
 * 1. A `clickHouseSchema` declared in an alchemy Stack, ordered after a
 *    `makeClickHouseCluster` deployment, applies its DDL over `pods/exec` — no
 *    port-forward, no exposed native port, no credentials in props or state.
 * 2. IDEMPOTENCE: a second converge of the identical Stack issues ZERO statements and
 *    leaves `appliedAt`/`fingerprint` untouched.
 * 3. A changed statement list re-runs the WHOLE list (which is safe precisely because every
 *    statement is `IF NOT EXISTS`) and records a new fingerprint.
 * 4. `onDelete: 'retain'` (the default) tears the resource out of alchemy state while
 *    leaving the database and its rows in place.
 *
 * The transport under test is the real `KubeExecClickHouseExecutor`; it is wrapped in a
 * counting decorator (through the documented `executor` injection point) purely so
 * assertion 2 can observe that no exec happened rather than inferring it.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(1_500_000);

import * as Alchemy from 'alchemy';
import * as StateMod from 'alchemy/State';
import * as Test from 'alchemy/Test/Core';
import { Effect } from 'effect';
import {
  type ClickHouseExecutor,
  type ClickHouseSchemaState,
  clickHouseSchema,
  clickHouseSchemaProvider,
  KubeExecClickHouseExecutor,
} from '../../../src/alchemy/index.js';
import { createBunCompatibleCustomObjectsApi } from '../../../src/core/kubernetes/index.js';
import {
  CLICKHOUSE_SCHEMA_E2E_DATABASE,
  CLICKHOUSE_SCHEMA_E2E_PASSWORD,
  CLICKHOUSE_SCHEMA_E2E_USER,
  clickHouseSchemaE2EClusterSpec,
  makeClickHouseSchemaE2ECluster,
} from './clickhouse-schema-fixture.js';
import {
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  deleteTestResourceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  requireTestStorageClass,
  runTestPodAndReadLogs,
  type TestNamespaceLease,
} from '../shared-kubeconfig';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

describeOrSkip('ClickHouseSchema against a live ClickHouse (e2e)', () => {
  const runId = crypto.randomUUID().slice(0, 8);
  const operatorNs = `tk-chschema-op-${runId}`;
  const chiNs = `tk-chschema-chi-${runId}`;
  const chiName = 'ch-schema';
  const chiUser = CLICKHOUSE_SCHEMA_E2E_USER;
  const database = CLICKHOUSE_SCHEMA_E2E_DATABASE;

  let kubeConfig: ReturnType<typeof getIntegrationTestKubeConfig>;
  let storageClass: string;
  let operatorFactory: unknown;
  let clickhouseFactory: unknown;
  let operatorDeployed = false;
  let clickhouseDeployed = false;
  let helmRepositoryPreexisting = false;
  const namespaceLeases: TestNamespaceLease[] = [];

  /** Real transport, plus a counter so an idempotent converge is observably a no-op. */
  let execCount = 0;
  const countingExecutor = (): ClickHouseExecutor => {
    const real = new KubeExecClickHouseExecutor(kubeConfig);
    return {
      listPods: (namespace, podSelector, abortSignal) =>
        real.listPods(namespace, podSelector, abortSignal),
      exec: (command, abortSignal) => {
        execCount += 1;
        return real.exec(command, abortSignal);
      },
    };
  };

  const target = () => ({
    namespace: chiNs,
    // The label the Altinity operator puts on every server pod of a CHI.
    podSelector: { 'clickhouse.altinity.com/chi': chiName },
  });

  const alchemyOptions = { providers: clickHouseSchemaProvider, state: StateMod.inMemoryState() };
  const runDeploy = (stack: unknown) =>
    Effect.runPromise(
      Test.toEffect(Test.deploy(alchemyOptions, stack as never) as never, alchemyOptions as never)
    );
  const runDestroy = (stack: unknown) =>
    Effect.runPromise(
      Test.toEffect(Test.destroy(alchemyOptions, stack as never) as never, alchemyOptions as never)
    );

  /**
   * Query the live server from a throwaway `clickhouse-client` Pod (independent evidence).
   *
   * Authenticates as the SAME user, with the SAME password, as the schema resource — both
   * come from the fixture, so the CHI's declared credential and the two clients that use
   * it cannot drift apart. The password travels in the Pod's environment rather than in
   * argv, so it never reaches a process listing even in a test.
   */
  async function query(sql: string, name: string): Promise<string> {
    return (
      await runTestPodAndReadLogs(
        {
          namespace: chiNs,
          name: `${chiName}-q-${name}-${crypto.randomUUID().slice(0, 6)}`,
          image: 'clickhouse/clickhouse-server:25.7',
          command: ['sh', '-c'],
          args: [
            'exec clickhouse-client ' +
              `--host clickhouse-${chiName}.${chiNs}.svc.cluster.local ` +
              `--port 9000 --user ${chiUser} --password "\${CLICKHOUSE_PASSWORD:-}" ` +
              '--query "$CLICKHOUSE_QUERY"',
          ],
          env: [
            { name: 'CLICKHOUSE_PASSWORD', value: CLICKHOUSE_SCHEMA_E2E_PASSWORD },
            { name: 'CLICKHOUSE_QUERY', value: sql },
          ],
          timeoutMs: 240_000,
        },
        kubeConfig
      )
    ).trim();
  }

  beforeAll(async () => {
    if (!clusterAvailable) return;
    kubeConfig = getIntegrationTestKubeConfig();
    storageClass = await requireTestStorageClass({ kubeConfig });
    namespaceLeases.push(
      ...(await Promise.all(
        [operatorNs, chiNs].map((namespace) => createTestNamespace(namespace, kubeConfig))
      ))
    );

    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
    try {
      await customApi.getNamespacedCustomObject({
        group: 'source.toolkit.fluxcd.io',
        version: 'v1',
        namespace: 'flux-system',
        plural: 'helmrepositories',
        name: 'altinity',
      });
      helmRepositoryPreexisting = true;
    } catch {
      // The temporary bootstrap creates and later removes the repository.
    }
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    const cleanupErrors: unknown[] = [];

    if (clickhouseFactory && clickhouseDeployed) {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        clickhouseFactory as never,
        chiName,
        [],
        kubeConfig,
        120_000
      ).catch((error) => cleanupErrors.push(error));
    }
    if (operatorFactory && operatorDeployed) {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        operatorFactory as never,
        'clickhouse-operator',
        [],
        kubeConfig,
        120_000,
        { scopes: ['cluster'], includeUnscopedResources: true }
      ).catch((error) => cleanupErrors.push(error));
    }
    if (!helmRepositoryPreexisting) {
      await deleteTestResourceAndWait(
        {
          apiVersion: 'source.toolkit.fluxcd.io/v1',
          kind: 'HelmRepository',
          metadata: { namespace: 'flux-system', name: 'altinity' },
        },
        kubeConfig,
        60_000
      ).catch((error) => cleanupErrors.push(error));
    }

    await Promise.all(
      namespaceLeases.map((lease) =>
        deleteTestNamespaceAndWait(lease, kubeConfig).catch((error) => cleanupErrors.push(error))
      )
    );

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'ClickHouseSchema suite cleanup failed');
    }
  });

  it('deploys the Altinity operator scoped to the CHI namespace', async () => {
    const { clickhouseOperatorBootstrap } = await import(
      '../../../src/factories/clickhouse/index.js'
    );
    const factory = clickhouseOperatorBootstrap.factory('direct', {
      namespace: operatorNs,
      waitForReady: true,
      timeout: 600_000,
      kubeConfig,
    });
    operatorFactory = factory;

    const instance = await factory.deploy({
      name: 'clickhouse-operator',
      namespace: operatorNs,
      version: '0.27.1',
      shared: false,
      customValues: {
        configs: { files: { 'config.yaml': { watch: { namespaces: { include: [chiNs] } } } } },
      },
    });
    operatorDeployed = true;
    expect(instance.status.ready).toBe(true);
  }, 900_000);

  it('reconciles a ClickHouse cluster the schema resource can target', async () => {
    const clickhouse = makeClickHouseSchemaE2ECluster();
    const factory = clickhouse.factory('direct', {
      namespace: chiNs,
      waitForReady: true,
      timeout: 900_000,
      kubeConfig,
    });
    clickhouseFactory = factory;

    // The spec comes from the fixture so the declared user's credential is supplied.
    // Omitting it is not a smaller test: the composition body dereferences
    // `spec.users.<name>` and throws before anything reaches the cluster, which
    // `test/unit/alchemy/clickhouse-schema-composition.test.ts` pins offline.
    const instance = await factory.deploy(
      clickHouseSchemaE2EClusterSpec({
        name: chiName,
        namespace: chiNs,
        version: '25.7',
        storage: { size: '2Gi', storageClassName: storageClass },
      }) as never
    );
    clickhouseDeployed = true;
    expect(instance.status.ready).toBe(true);
  }, 900_000);

  it('applies the schema, no-ops on re-converge, re-applies on change, and retains on destroy', async () => {
    const baseStatements = [
      `CREATE DATABASE IF NOT EXISTS ${database}`,
      `CREATE TABLE IF NOT EXISTS ${database}.events (` +
        'id UUID, at DateTime, payload String' +
        ') ENGINE = MergeTree ORDER BY at',
    ];

    const makeStack = (name: string, statements: string[]) =>
      Alchemy.Stack(
        name,
        alchemyOptions as never,
        Effect.gen(function* () {
          return yield* clickHouseSchema('orders-schema', {
            target: target(),
            // No `passwordEnv`: the default one is unset inside the CHI server container,
            // so `--password "${CLICKHOUSE_PASSWORD:-}"` resolves to the empty password the
            // fixture declared for this user. See `clickhouse-schema-fixture.ts`.
            client: { user: chiUser },
            statements,
            // `execution` left at the `fanout` default: this CHI has one replica, so the
            // fanout is one pod, and the state records that pod set.
            executor: countingExecutor(),
          });
        }) as never
      );

    // ---- create -------------------------------------------------------------
    execCount = 0;
    const stack = makeStack('tk-clickhouse-schema-e2e', baseStatements);
    const created = (await runDeploy(stack)) as unknown as ClickHouseSchemaState | undefined;
    expect(execCount).toBe(baseStatements.length);
    // One Ready server pod, so the fanout is one pod — and it is recorded, which is what a
    // later scale-out would be compared against.
    expect(created?.podNames).toHaveLength(1);

    // Independent evidence from the server itself, not from the resource's own state.
    expect(await query(`EXISTS DATABASE ${database}`, 'db')).toBe('1');
    expect(await query(`EXISTS TABLE ${database}.events`, 'tbl')).toBe('1');
    await query(
      `INSERT INTO ${database}.events VALUES (generateUUIDv4(), now(), 'first')`,
      'insert'
    );
    expect(await query(`SELECT count() FROM ${database}.events`, 'count')).toBe('1');

    const firstFingerprint = created?.fingerprint;
    const firstAppliedAt = created?.appliedAt;

    // ---- update: unchanged fingerprint is a no-op ----------------------------
    execCount = 0;
    const unchanged = (await runDeploy(
      makeStack('tk-clickhouse-schema-e2e', baseStatements)
    )) as unknown as ClickHouseSchemaState | undefined;
    expect(execCount).toBe(0);
    if (firstFingerprint !== undefined) {
      expect(unchanged?.fingerprint).toBe(firstFingerprint);
      expect(unchanged?.appliedAt).toBe(firstAppliedAt as string);
    }

    // ---- update: changed statements re-run the WHOLE list --------------------
    const extendedStatements = [
      ...baseStatements,
      `CREATE TABLE IF NOT EXISTS ${database}.shipments (` +
        'id UUID, at DateTime' +
        ') ENGINE = MergeTree ORDER BY at',
    ];
    execCount = 0;
    const rerun = (await runDeploy(
      makeStack('tk-clickhouse-schema-e2e', extendedStatements)
    )) as unknown as ClickHouseSchemaState | undefined;
    expect(execCount).toBe(extendedStatements.length);
    expect(await query(`EXISTS TABLE ${database}.shipments`, 'ship')).toBe('1');
    // Re-running `CREATE TABLE IF NOT EXISTS` left the existing rows untouched — the
    // idempotence contract, observed rather than asserted from the resource's own state.
    expect(await query(`SELECT count() FROM ${database}.events`, 'count2')).toBe('1');
    if (firstFingerprint !== undefined) {
      expect(rerun?.fingerprint).not.toBe(firstFingerprint);
    }

    // ---- delete: retain leaves the data in place -----------------------------
    execCount = 0;
    await runDestroy(makeStack('tk-clickhouse-schema-e2e', extendedStatements));
    expect(execCount).toBe(0);
    expect(await query(`EXISTS DATABASE ${database}`, 'db-after')).toBe('1');
    expect(await query(`SELECT count() FROM ${database}.events`, 'count3')).toBe('1');
  }, 1_200_000);
});
