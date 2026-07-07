/**
 * ClickStack (HyperDX) Integration for TypeKro — EXTERNAL ClickHouse only.
 *
 * Type-safe deployment primitives for ClickStack observability on Kubernetes
 * via the OFFICIAL `clickstack` Helm chart (MIT) from
 * https://clickhouse.github.io/ClickStack-helm-charts, wired to an EXTERNAL
 * ClickHouse (e.g. an Altinity-operator-managed ClickHouseInstallation).
 * The chart's bundled ClickHouse and MongoDB are hard-disabled — their CRDs
 * belong to the `clickstack-operators` prerequisite chart, whose ClickHouse
 * operator would collide with the Altinity operator.
 *
 * ## Compositions
 * - `clickstackBootstrap` — Namespace + shared HelmRepository singleton +
 *   optional internal Mongo (StatefulSet/Service) + clickstack HelmRelease
 *   (HyperDX UI/API/OpAMP + OTel gateway collector).
 * - `clickstackK8sTelemetry` — the documented k8s ingestion pattern: a
 *   daemonset + a deployment instance of the STOCK `opentelemetry-collector`
 *   chart exporting otlphttp to the ClickStack gateway.
 *
 * ## Resources
 * - `clickstackHelmRepository()` / `otelHelmRepository()` — chart repositories
 * - `clickstackHelmRelease()` / `otelCollectorHelmRelease()` — releases
 * - `clickstackMongoStatefulSet()` / `clickstackMongoService()` — internal Mongo
 *
 * @example
 * ```typescript
 * import { clickstackBootstrap } from 'typekro/clickstack';
 *
 * const factory = clickstackBootstrap.factory('kro', { namespace: 'clickstack' });
 * ```
 *
 * @see https://github.com/ClickHouse/ClickStack-helm-charts
 * @see https://clickhouse.com/docs/use-cases/observability/clickstack
 * @module
 */
export * from './compositions/index.js';
export * from './resources/index.js';
export * from './types.js';
export * from './utils/index.js';
