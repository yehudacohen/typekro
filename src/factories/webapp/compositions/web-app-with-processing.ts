import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { cnpgBootstrap } from '../../cnpg/compositions/cnpg-bootstrap.js';
import { cluster } from '../../cnpg/resources/cluster.js';
import { pooler } from '../../cnpg/resources/pooler.js';
import { inngestBootstrap } from '../../inngest/compositions/inngest-bootstrap.js';
import { simple } from '../../simple/index.js';
import { valkeyBootstrap } from '../../valkey/compositions/valkey-bootstrap.js';
import { valkey } from '../../valkey/resources/valkey.js';
import {
  type WebAppWithProcessingConfig,
  WebAppWithProcessingConfigSchema,
  WebAppWithProcessingStatusSchema,
} from '../types.js';

/**
 * Full-Stack Web Application with Background Processing
 *
 * Deploys a complete, self-contained application stack. The composition
 * installs its own operators AND the application resources managed by
 * those operators — callers don't need to pre-install anything other
 * than the TypeKro runtime (Flux + KRO) on the target cluster.
 *
 * **Operators** (installed by nested bootstraps):
 * 1. **CloudNativePG operator** (via `cnpgBootstrap`) — manages the
 *    PostgreSQL cluster. Installs into `cnpg-system` by default.
 * 2. **Hyperspike Valkey operator** (via `valkeyBootstrap`) — manages
 *    the Valkey cache cluster. Installs into `valkey-operator-system`
 *    by default.
 * 3. **Inngest** (via `inngestBootstrap`) — the workflow engine itself
 *    is installed via a Helm release alongside the app. Bundled
 *    Postgres/Redis are disabled; Inngest uses the CNPG and Valkey
 *    instances from this composition.
 *
 * **Application resources** (created in the app namespace, managed by
 * the operators above):
 * 1. **PostgreSQL cluster** (CNPG `Cluster`) + PgBouncer `Pooler`
 * 2. **Valkey cache cluster** (Hyperspike `Valkey` CR) + explicit
 *    ClusterIP Service (KRO prunes unowned Services otherwise)
 * 3. **Application** `Deployment` + `Service`
 *
 * All connection strings are automatically wired into the app's environment:
 * - `DATABASE_URL` — points to the PgBouncer pooler
 * - `VALKEY_URL` / `REDIS_URL` — points to the Valkey service
 * - `INNGEST_BASE_URL` — points to the Inngest server
 * - `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` — from config
 *
 * Resource dependencies are expressed through proxy references:
 * - Inngest references `cache.metadata.name` for the redis URI → deploys after Valkey
 * - Inngest references `database.status.writeService` for the postgres URI → deploys after CNPG
 * - App references service names derived from resource names → deploys after all infra
 *
 * Operator install settings can be overridden per-deployment via
 * `spec.cnpgOperator` and `spec.valkeyOperator` — e.g., to pin chart
 * versions or change the install namespace. Both fields are optional;
 * defaults install the latest pinned version into each operator's
 * system namespace.
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
 *   name: 'my-app',
 *   namespace: 'production',
 *   app: {
 *     image: 'my-app:latest',
 *     port: 3000,
 *     replicas: 2,
 *     env: {
 *       NODE_ENV: 'production',
 *     },
 *   },
 *   database: {
 *     instances: 3,
 *     storageSize: '50Gi',
 *     storageClass: 'gp3',
 *     database: 'myapp',
 *   },
 *   cache: { shards: 3, replicas: 1 },
 *   processing: {
 *     eventKey: 'deadbeef0123456789abcdef01234567',
 *     signingKey: 'deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
 *     sdkUrl: ['http://my-app:3000/api/inngest'],
 *   },
 *   // Operators install with sensible defaults; override only if
 *   // you need a specific chart version or custom install namespace.
 *   cnpgOperator: { version: '0.23.0' },
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
    const ns = spec.namespace ?? 'default';
    const appPort = spec.app.port ?? 3000;
    const appReplicas = spec.app.replicas ?? 1;
    const inngestReplicas = spec.processing.replicas ?? 1;
    const dbName = spec.database.database ?? spec.name;
    const dbOwner = spec.database.owner ?? 'app';

    // ── Operator bootstraps ────────────────────────────────────────────
    //
    // Install the CNPG and Valkey operators as part of the composition
    // so consumers get a fully self-contained stack. The bootstraps run
    // in their own system namespaces (not the app namespace) and install
    // cluster-scoped operators; the later `cluster()`/`valkey()` calls
    // create instances in the app namespace managed by those operators.
    //
    // **Shared-singleton default.** Operators are cluster-scoped
    // infrastructure — one install per cluster serves every consumer.
    // The nested bootstraps use fixed names (`cnpg-operator`,
    // `valkey-operator`) in fixed system namespaces and are marked
    // `scopes: ['cluster']`, so multiple `webAppWithProcessing`
    // deployments on the same cluster converge on the same operator
    // install and `factory.deleteInstance()` on any one consumer
    // leaves the operator intact for the others.
    //
    // Users who need a dedicated per-instance operator (multi-tenancy,
    // version testing, isolated failure domains) can override any
    // combination of fields via `spec.cnpgOperator` / `spec.valkeyOperator` —
    // e.g., `{ name: 'testapp-cnpg', namespace: 'testapp-cnpg-system', shared: false }`.
    // The spread puts user overrides AFTER the defaults so they win.
    const _cnpg = cnpgBootstrap({
      name: 'cnpg-operator',
      namespace: 'cnpg-system',
      installCRDs: true,
      ...spec.cnpgOperator,
    });

    const _valkeyOp = valkeyBootstrap({
      name: 'valkey-operator',
      namespace: 'valkey-operator-system',
      ...spec.valkeyOperator,
    });

    // ── PostgreSQL (CNPG) ──────────────────────────────────────────────

    const database = cluster({
      name: `${spec.name}-db`,
      namespace: ns,
      spec: {
        instances: spec.database.instances,
        storage: {
          size: spec.database.storageSize,
          ...(spec.database.storageClass ? { storageClass: spec.database.storageClass } : {}),
        },
        bootstrap: {
          initdb: { database: dbName, owner: dbOwner },
        },
      },
      id: 'database',
    });

    const dbPooler = pooler({
      name: `${spec.name}-db-pooler`,
      namespace: ns,
      spec: {
        cluster: { name: `${spec.name}-db` },
        type: 'rw',
        pgbouncer: { poolMode: 'transaction' },
      },
      id: 'dbPooler',
    });

    // ── Valkey Cache ────────────────────────────────────────────────────

    const cache = valkey({
      name: `${spec.name}-cache`,
      namespace: ns,
      spec: {
        volumePermissions: spec.cache?.volumePermissions ?? true,
        anonymousAuth: true,
        ...(spec.cache?.shards != null ? { shards: spec.cache.shards } : {}),
        ...(spec.cache?.replicas != null ? { replicas: spec.cache.replicas } : {}),
        storage: {
          spec: {
            accessModes: ['ReadWriteOnce'],
            resources: { requests: { storage: spec.cache?.storageSize ?? '1Gi' } },
          },
        },
      },
      id: 'cache',
    });

    // The Valkey operator creates a client Service for each Valkey CR, but KRO's
    // applyset pruning deletes Services it doesn't manage. Declare the cache
    // Service explicitly so KRO includes it in its applyset and doesn't prune it.
    simple.Service({
      name: `${spec.name}-cache`,
      namespace: ns,
      selector: {
        'app.kubernetes.io/name': 'valkey',
        'app.kubernetes.io/instance': `${spec.name}-cache`,
      },
      ports: [{ port: 6379, targetPort: 6379 }],
      id: 'cacheService',
    });

    // ── Database credentials ──────────────────────────────────────────────

    // CNPG auto-generates a Secret named {cluster}-{owner} during bootstrap.
    // Validated against CNPG v1.25 (cloudnative-pg chart 0.23.0).
    // The name is deterministic — no need for an externalRef which would block
    // KRO reconciliation (KRO waits for external refs to exist before creating
    // dependent resources, but the Secret only exists after CNPG bootstraps).
    const dbSecretName = `${spec.name}-db-${dbOwner}`;

    // ── Inngest (with external DB + cache) ──────────────────────────────

    // database.status.writeService creates an implicit deployment dependency:
    // the dependency resolver detects the reference and adds a DAG edge,
    // ensuring the database is ready BEFORE Inngest deploys. The actual
    // postgres credentials are injected via the CNPG Secret (secretKeyRef below).
    const inngest = inngestBootstrap({
      name: `${spec.name}-inngest`,
      namespace: ns,
      inngest: {
        eventKey: spec.processing.eventKey,
        signingKey: spec.processing.signingKey,
        postgres: { uri: `postgresql://${dbOwner}@${database.status.writeService}:5432/${dbName}` },
        redis: { uri: `redis://${cache.metadata.name}:6379` },
        sdkUrl: spec.processing.sdkUrl,
      },
      postgresql: { enabled: false },
      redis: { enabled: false },
      replicaCount: inngestReplicas,
      // Deploy Inngest pods in the same namespace as CNPG (for Secret access)
      // and inject the real postgres URI from the CNPG Secret via secretKeyRef.
      customValues: {
        namespace: { create: false, name: ns },
        inngest: {
          extraEnv: [
            {
              name: 'INNGEST_POSTGRES_URI',
              valueFrom: {
                secretKeyRef: {
                  name: dbSecretName,
                  key: 'uri',
                },
              },
            },
          ],
        },
      },
    });

    // ── Application ─────────────────────────────────────────────────────

    const appEnv: Record<string, string> = {
      DATABASE_URL: `postgresql://${dbOwner}@${dbPooler.metadata.name}:5432/${dbName}`,
      VALKEY_URL: `redis://${cache.metadata.name}:6379`,
      REDIS_URL: `redis://${cache.metadata.name}:6379`,
      INNGEST_BASE_URL: `http://${spec.name}-inngest:8288`,
      INNGEST_EVENT_KEY: spec.processing.eventKey,
      INNGEST_SIGNING_KEY: spec.processing.signingKey,
      ...spec.app.env,
    };

    const app = simple.Deployment({
      name: spec.name,
      namespace: ns,
      image: spec.app.image,
      replicas: appReplicas,
      ports: [{ containerPort: appPort }],
      env: appEnv,
      id: 'app',
    });

    simple.Service({
      name: spec.name,
      namespace: ns,
      selector: { app: spec.name },
      ports: [{ port: appPort, targetPort: appPort }],
      id: 'appService',
    });

    // ── Status ──────────────────────────────────────────────────────────

    return {
      ready:
        app.status.readyReplicas >= appReplicas &&
        database.status.readyInstances >= (spec.database.instances ?? 1) &&
        cache.status.ready &&
        inngest.status.ready,
      databaseUrl: `postgresql://${dbOwner}@${dbPooler.metadata.name}:5432/${dbName}`,
      cacheUrl: `redis://${cache.metadata.name}:6379`,
      inngestUrl: `http://${spec.name}-inngest:8288`,
      appUrl: `http://${spec.name}:${appPort}`,
      components: {
        app: app.status.readyReplicas >= appReplicas,
        database: database.status.readyInstances >= (spec.database.instances ?? 1),
        cache: cache.status.ready,
        inngest: inngest.status.ready,
      },
    };
  }
);
