/**
 * Web Application Compositions for TypeKro
 *
 * Higher-level compositions that wire together databases, caches,
 * workflow engines, and application deployments with automatic
 * environment variable injection.
 *
 * ## Compositions
 * - `webAppWithProcessing` — Full-stack: App + CNPG PostgreSQL + Valkey + Inngest
 *
 * All connection URLs (DATABASE_URL, VALKEY_URL, INNGEST_BASE_URL) are
 * automatically injected into the application's environment. The status
 * exposes these URLs for debugging or wiring additional services.
 *
 * ## Prerequisites
 * Install the TypeKro runtime (Flux + KRO). The composition bootstraps the
 * CloudNativePG and Hyperspike Valkey operators itself as shared singleton
 * dependencies.
 *
 * @example
 * ```typescript
 * import { webAppWithProcessing } from 'typekro/webapp';
 *
 * const factory = webAppWithProcessing.factory('kro', {
 *   namespace: 'production',
 * });
 *
 * const instance = await factory.deploy({
 *   name: 'my-app',
 *   namespace: 'production',
 *   app: { image: 'my-app:latest', port: 3000 },
 *   database: { storageSize: '50Gi', database: 'mydb' },
 *   processing: {
 *     eventKey: 'deadbeef...',
 *     signingKey: 'deadbeef...',
 *   },
 * });
 *
 * // Connection details available on status
 * console.log(instance.status.databaseUrl);
 * console.log(instance.status.cacheUrl);
 * console.log(instance.status.inngestUrl);
 * ```
 *
 * @see https://typekro.run/api/cnpg/ — PostgreSQL integration
 * @see https://typekro.run/api/valkey/ — Valkey integration
 * @see https://typekro.run/api/inngest/ — Inngest integration
 * @module
 */
export * from './compositions/index.js';
export * from './types.js';
