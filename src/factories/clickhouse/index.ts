/**
 * ClickHouse (Altinity clickhouse-operator) Integration for TypeKro
 *
 * Provides type-safe factories for managing ClickHouse clusters on Kubernetes
 * using the OFFICIAL Altinity clickhouse-operator (build-around: the official
 * `altinity-clickhouse-operator` chart from https://helm.altinity.com,
 * Apache-2.0 — never hand-rolled manifests).
 *
 * ONE OPERATOR PER CLUSTER: the operator is cluster-scoped and owns the
 * ClickHouse CRDs; install exactly one `clickhouseOperatorBootstrap` per
 * cluster and point every CHI/CHK at it.
 *
 * BUILD-TIME vs RUNTIME: topology (`zones`/`replicas`/`shards`/keeper
 * presence/user names) is fixed at CONSTRUCTION time via
 * `makeClickHouseCluster(topology)`; everything else (name, namespace,
 * version, storage, credentials, keeper host) is proxy-safe RUNTIME spec.
 *
 * ## Compositions
 * - `makeClickHouseCluster(topology)` — build-time topology constructor;
 *   returns a composition whose runtime spec is fully schema-ref safe and
 *   whose status exposes the typed connection contract
 * - `clickHouseCluster` — the default single-node topology
 * - `clickhouseOperatorBootstrap` — complete operator deployment
 *   (namespace + shared Helm repo singleton + release)
 * - `clickhouseHelmRepositoryBootstrap` — shared HelmRepository singleton owner
 *
 * ## Resources
 * - `clickHouseInstallation()` — LOW-LEVEL typed CHI (concrete topology only;
 *   zone-pinned replica layout, SigNoz-compatible `cluster` name default)
 * - `clickHouseKeeperInstallation()` — typed CHK (coordination service)
 * - `clickhouseHelmRepository()` — Altinity Helm chart repository
 * - `clickhouseOperatorHelmRelease()` — operator installation via Helm
 *
 * @example
 * ```typescript
 * import {
 *   clickhouseOperatorBootstrap,
 *   makeClickHouseCluster,
 * } from 'typekro/clickhouse';
 *
 * // Install the operator (once per cluster)
 * const operatorFactory = clickhouseOperatorBootstrap.factory('kro', {
 *   namespace: 'clickhouse-system',
 * });
 * await operatorFactory.deploy({ name: 'clickhouse-operator' });
 *
 * // Fix the topology at construction, deploy with runtime spec
 * const clickhouse = makeClickHouseCluster({
 *   zones: ['us-east-2a', 'us-east-2b'],
 *   replicas: 2,
 *   users: [{ name: 'signoz' }],
 * });
 * await clickhouse.factory('kro', { namespace: 'observability' }).deploy({
 *   name: 'signoz-clickhouse',
 *   namespace: 'observability',
 *   version: '25.12.5',
 *   storage: { size: '100Gi', storageClassName: 'gp3-expandable' },
 *   keeper: { host: 'keeper-signoz.observability.svc.cluster.local' },
 *   users: { signoz: { passwordSha256Hex: '<sha256-hex>' } },
 * });
 * ```
 *
 * @see https://github.com/Altinity/clickhouse-operator
 * @module
 */
export * from './compositions/index.js';
export * from './resources/index.js';
export * from './types.js';
export * from './utils/index.js';
