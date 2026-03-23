import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { externalRef } from '../../../core/references/external-refs.js';
import { cluster } from '../../cnpg/resources/cluster.js';
import { pooler } from '../../cnpg/resources/pooler.js';
import { inngestBootstrap } from '../../inngest/compositions/inngest-bootstrap.js';
import { simple } from '../../simple/index.js';
import { valkey } from '../../valkey/resources/valkey.js';
import {
  type WebAppWithProcessingConfig,
  WebAppWithProcessingConfigSchema,
  WebAppWithProcessingStatusSchema,
} from '../types.js';

/**
 * Full-Stack Web Application with Background Processing
 *
 * Deploys a complete application stack:
 * 1. **PostgreSQL** (via CNPG) — cluster + PgBouncer pooler
 * 2. **Valkey** cache cluster
 * 3. **Inngest** workflow engine (with external DB/cache, not bundled)
 * 4. **Application** Deployment + Service
 *
 * All connection strings are automatically wired into the app's environment:
 * - `DATABASE_URL` — points to the PgBouncer pooler
 * - `VALKEY_URL` / `REDIS_URL` — points to the Valkey service
 * - `INNGEST_BASE_URL` — points to the Inngest server
 * - `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` — from config
 *
 * The Inngest server is configured to use the CNPG database and Valkey cache
 * instead of bundled PostgreSQL/Redis.
 *
 * @example
 * ```typescript
 * import { webAppWithProcessing } from 'typekro/webapp';
 *
 * const factory = webAppWithProcessing.factory('kro', {
 *   namespace: 'production',
 *   waitForReady: true,
 * });
 *
 * await factory.deploy({
 *   name: 'collectorbills',
 *   namespace: 'production',
 *   app: {
 *     image: 'collectorbills:latest',
 *     port: 5173,
 *     replicas: 2,
 *     env: {
 *       NODE_ENV: 'production',
 *       BETTER_AUTH_SECRET: 'your-secret',
 *     },
 *   },
 *   database: {
 *     instances: 3,
 *     storageSize: '50Gi',
 *     storageClass: 'gp3',
 *     database: 'collector_bills',
 *   },
 *   cache: { shards: 3, replicas: 1 },
 *   processing: {
 *     eventKey: 'deadbeef0123456789abcdef01234567',
 *     signingKey: 'deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
 *     sdkUrl: ['http://collectorbills:5173/api/inngest'],
 *   },
 * });
 * ```
 */
export const webAppWithProcessing = kubernetesComposition(
  {
    name: 'web-app-with-processing',
    kind: 'WebAppWithProcessing',
    spec: WebAppWithProcessingConfigSchema,
    status: WebAppWithProcessingStatusSchema,
  },
  (spec: WebAppWithProcessingConfig) => {
    const ns = spec.namespace || 'default';
    const appPort = spec.app.port || 3000;
    const appReplicas = spec.app.replicas || 1;
    const dbName = spec.database.database || spec.name;
    const dbOwner = spec.database.owner || 'app';

    // Resource name conventions — used for service discovery
    const dbClusterName = `${spec.name}-db`;
    const dbPoolerName = `${spec.name}-db-pooler`;
    const cacheName = `${spec.name}-cache`;
    const inngestName = `${spec.name}-inngest`;
    const appName = spec.name;

    // Connection URLs — derived from resource naming conventions.
    // CNPG creates services: {cluster}-rw (primary), {cluster}-ro (replicas)
    // PgBouncer pooler creates: {pooler} service
    // Valkey creates: {name} service on port 6379
    // Inngest runs on port 8288
    const databaseUrl =
      `postgresql://${dbOwner}@${dbPoolerName}:5432/${dbName}`;
    const cacheUrl = `redis://${cacheName}:6379`;
    const inngestUrl = `http://${inngestName}:8288`;
    const appUrl = `http://${appName}:${appPort}`;

    // ── PostgreSQL (CNPG) ──────────────────────────────────────────────

    // Resources auto-register in the composition context.
    // _-prefixed vars are referenced by id in the status, not by variable.
    const _database = cluster({
      name: dbClusterName,
      namespace: ns,
      spec: {
        instances: spec.database.instances,
        storage: Object.assign(
          { size: spec.database.storageSize },
          spec.database.storageClass && { storageClass: spec.database.storageClass },
        ),
        bootstrap: {
          initdb: {
            database: dbName,
            owner: dbOwner,
          },
        },
        monitoring: { enabled: true },
      },
      id: 'database',
    });

    const _pooler = pooler({
      name: dbPoolerName,
      namespace: ns,
      spec: {
        cluster: { name: dbClusterName },
        type: 'rw',
        pgbouncer: { poolMode: 'transaction' },
      },
      id: 'pooler',
    });

    // ── Valkey Cache ────────────────────────────────────────────────────

    const cacheConfig = spec.cache || {};
    const _cache = valkey({
      name: cacheName,
      namespace: ns,
      spec: Object.assign(
        { volumePermissions: true },
        cacheConfig.shards !== undefined && { shards: cacheConfig.shards },
        cacheConfig.replicas !== undefined && { replicas: cacheConfig.replicas },
        cacheConfig.volumePermissions !== undefined && {
          volumePermissions: cacheConfig.volumePermissions,
        },
      ),
      id: 'cache',
    });

    // ── Database credentials (external ref to CNPG-generated Secret) ────

    // CNPG auto-generates credentials in a Secret named {cluster}-app.
    // We reference it via externalRef so the name is derived from the proxy
    // system rather than duplicated as a string literal.
    const dbSecret = externalRef({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: `${dbClusterName}-${dbOwner}`, namespace: ns },
      id: 'dbCredentials',
    });

    // ── Inngest (with external DB + cache) ──────────────────────────────

    // Inngest uses the CNPG database and Valkey cache — bundled deps disabled.
    // The CNPG-generated Secret contains a full postgres URI with the auto-
    // generated password. We inject it via extraEnv with secretKeyRef so the
    // password never appears in Helm values or ResourceGraphDefinitions.
    //
    // inngestBootstrap is a nested composition — its spec type doesn't use
    // Composable yet (that requires a core API change). Use Object.assign
    // to conditionally include optional fields.
    const _inngest = inngestBootstrap(Object.assign(
      {
        name: inngestName,
        namespace: ns,
        inngest: Object.assign(
          {
            eventKey: spec.processing.eventKey,
            signingKey: spec.processing.signingKey,
            // Placeholder — overridden by extraEnv secretKeyRef below
            postgres: { uri: `postgresql://${dbOwner}@${dbClusterName}-rw:5432/${dbName}` },
            redis: { uri: cacheUrl },
          },
          spec.processing.sdkUrl && { sdkUrl: spec.processing.sdkUrl },
        ),
        postgresql: { enabled: false } as const,
        redis: { enabled: false } as const,
        // Inject the real postgres URI from the CNPG Secret via secretKeyRef.
        // This overrides the placeholder inngest.postgres.uri Helm value.
        customValues: {
          inngest: {
            extraEnv: [
              {
                name: 'INNGEST_POSTGRES_URI',
                valueFrom: {
                  secretKeyRef: {
                    name: dbSecret.metadata.name,
                    key: 'uri',
                  },
                },
              },
            ],
          },
        },
      },
      spec.processing.replicas !== undefined && { replicaCount: spec.processing.replicas },
    ));

    // ── Application ─────────────────────────────────────────────────────

    // The app gets all connection details injected as environment variables.
    const baseEnv: Record<string, string> = {
      DATABASE_URL: databaseUrl,
      VALKEY_URL: cacheUrl,
      REDIS_URL: cacheUrl,
      INNGEST_BASE_URL: inngestUrl,
      INNGEST_EVENT_KEY: spec.processing.eventKey,
      INNGEST_SIGNING_KEY: spec.processing.signingKey,
    };

    // Merge user-provided env vars (user's take precedence)
    const appEnv = spec.app.env
      ? Object.assign({}, baseEnv, spec.app.env)
      : baseEnv;

    const appDeployment = simple.Deployment({
      name: appName,
      image: spec.app.image,
      replicas: appReplicas,
      ports: [{ containerPort: appPort }],
      env: appEnv,
      id: 'app',
    });

    const _appService = simple.Service({
      name: appName,
      selector: { app: appName },
      ports: [{ port: appPort, targetPort: appPort }],
      id: 'appService',
    });

    // ── Status ──────────────────────────────────────────────────────────

    return {
      ready:
        appDeployment.status.readyReplicas >= appReplicas &&
        _database.status.readyInstances >= (spec.database.instances ?? 1) &&
        _cache.status.ready &&
        _inngest.status.ready,
      databaseUrl,
      cacheUrl,
      inngestUrl,
      appUrl,
      components: {
        app: appDeployment.status.readyReplicas >= appReplicas,
        database: _database.status.readyInstances >= (spec.database.instances ?? 1),
        cache: _cache.status.ready,
        inngest: _inngest.status.ready,
      },
    };
  }
);
