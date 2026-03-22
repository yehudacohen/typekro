/**
 * CloudNativePG (CNPG) Integration for TypeKro
 *
 * Provides type-safe factories for managing PostgreSQL clusters on Kubernetes
 * using the CloudNativePG operator.
 *
 * ## Resources
 * - `cluster()` — PostgreSQL cluster (primary + replicas)
 * - `backup()` — On-demand backup
 * - `scheduledBackup()` — Cron-based automated backups
 * - `pooler()` — PgBouncer connection pooling
 * - `cnpgHelmRepository()` — Helm chart repository
 * - `cnpgHelmRelease()` — Operator installation via Helm
 *
 * ## Compositions
 * - `cnpgBootstrap` — Complete operator deployment (namespace + Helm repo + release)
 *
 * @example
 * ```typescript
 * import { cnpgBootstrap, cluster, scheduledBackup } from 'typekro/cnpg';
 *
 * // Install the operator
 * const operatorFactory = cnpgBootstrap.factory('kro', { namespace: 'cnpg-system' });
 * await operatorFactory.deploy({ name: 'cnpg', namespace: 'cnpg-system' });
 *
 * // Create a PostgreSQL cluster
 * const db = cluster({
 *   name: 'my-db',
 *   namespace: 'default',
 *   spec: { instances: 3, storage: { size: '50Gi' } },
 *   id: 'myDatabase',
 * });
 * ```
 *
 * @see https://cloudnative-pg.io/documentation/
 * @module
 */
export * from './compositions/index.js';
export * from './resources/index.js';
export * from './types.js';
export * from './utils/index.js';
