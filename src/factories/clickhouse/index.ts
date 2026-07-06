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
 * ## Resources
 * - `clickHouseInstallation()` — typed CHI (zone-pinned replica layout,
 *   SigNoz-compatible `cluster` name default)
 * - `clickHouseKeeperInstallation()` — typed CHK (coordination service)
 * - `clickhouseHelmRepository()` — Altinity Helm chart repository
 * - `clickhouseOperatorHelmRelease()` — operator installation via Helm
 *
 * ## Compositions
 * - `clickhouseOperatorBootstrap` — complete operator deployment
 *   (namespace + shared Helm repo singleton + release)
 * - `clickhouseHelmRepositoryBootstrap` — shared HelmRepository singleton owner
 *
 * @example
 * ```typescript
 * import {
 *   clickhouseOperatorBootstrap,
 *   clickHouseInstallation,
 * } from 'typekro/clickhouse';
 *
 * // Install the operator (once per cluster)
 * const operatorFactory = clickhouseOperatorBootstrap.factory('kro', {
 *   namespace: 'clickhouse-system',
 * });
 * await operatorFactory.deploy({ name: 'clickhouse-operator' });
 *
 * // Create a zone-pinned ClickHouse cluster
 * const chi = clickHouseInstallation({
 *   name: 'signoz-clickhouse',
 *   namespace: 'observability',
 *   version: '25.12.5',
 *   replicas: 2,
 *   zones: ['us-east-2a', 'us-east-2b'],
 *   storage: { size: '100Gi', storageClassName: 'gp3-expandable' },
 *   id: 'signozClickhouse',
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
