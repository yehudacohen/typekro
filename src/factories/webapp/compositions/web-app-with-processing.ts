import type { V1EnvFromSource } from '@kubernetes/client-node';
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { singleton } from '../../../core/singleton/singleton.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { cnpgBootstrap } from '../../cnpg/compositions/cnpg-bootstrap.js';
import { cluster } from '../../cnpg/resources/cluster.js';
import { secret } from '../../kubernetes/config/secret.js';
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
 * - `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` — injected from a generated Secret via envFrom
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
    // Defaults for optional DB fields. These literals are picked up by
    // `extractNullishDefaults` and propagated to the outer KRO schema as
    // `| default="..."` annotations (see schema.ts). Using schema-ref
    // fallbacks (e.g., `spec.name`) does NOT work in KRO mode because
    // the schema proxy is truthy and `??` never fires — KRO also has
    // no way to express a cross-field schema default statically.
    const dbName = spec.database.database ?? 'app';
    const dbOwner = spec.database.owner ?? 'app';

    // ── Operator bootstraps ────────────────────────────────────────────
    //
    // Install the CNPG and Valkey operators as part of the composition
    // so consumers get a fully self-contained stack. The bootstraps run
    // in their own system namespaces (not the app namespace) and install
    // cluster-scoped operators; the later `cluster()`/`valkey()` calls
    // create instances in the app namespace managed by those operators.
    //
    // Operators are cluster-scoped infrastructure — one install per
    // cluster serves every consumer. Use singleton(...) so KRO-mode
    // consumers reference the shared operator boundary instead of
    // inlining the operator bootstrap resources into every app graph.
    //
    // Users who need a dedicated per-instance operator (multi-tenancy,
    // version testing, isolated failure domains) can override any
    // combination of fields via `spec.cnpgOperator` / `spec.valkeyOperator` —
    // e.g., `{ name: 'testapp-cnpg', namespace: 'testapp-cnpg-system', shared: false }`.
    // The spread puts user overrides AFTER the defaults so they win.
    // Operator bootstrap config: merge user overrides AFTER defaults.
    // Use explicit ?? fallbacks for name/namespace instead of relying on
    // object-literal-before-spread ordering — the spread of an optional
    // spec field produces schema refs that get wrapped with omit(), but
    // metadata.name is required and cannot be omitted. The ?? ensures
    // the default is expressed as a KRO orValue/default, not omit().
    const _cnpg = singleton(cnpgBootstrap, {
      id: 'cnpg-operator',
      spec: {
        ...spec.cnpgOperator,
        name: spec.cnpgOperator?.name ?? 'cnpg-operator',
        namespace: spec.cnpgOperator?.namespace ?? 'cnpg-system',
        installCRDs: spec.cnpgOperator?.installCRDs ?? true,
      },
    });

    const _valkeyOp = singleton(valkeyBootstrap, {
      id: 'valkey-operator',
      spec: {
        ...spec.valkeyOperator,
        name: spec.valkeyOperator?.name ?? 'valkey-operator',
        namespace: spec.valkeyOperator?.namespace ?? 'valkey-operator-system',
      },
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

    // KRO applyset pruning workaround (upstream: kubernetes-sigs/kro#1153).
    //
    // The Hyperspike Valkey operator copies ALL parent labels to child
    // resources. KRO stamps applyset labels on the Valkey CR, so the
    // operator propagates them to children (ConfigMap, headless Service,
    // etc.). KRO's pruner then treats those children as applyset members
    // and deletes any whose GK is already in `contains-group-kinds` but
    // whose UID isn't in `keepUIDs` — creating an infinite create/delete
    // loop. KRO closed this as "expected behavior"; the fix belongs on
    // the operator side, but Hyperspike has no label-propagation opt-out.
    //
    // Workaround: pre-declare the operator-created resources as typekro
    // graph nodes so KRO claims them with their own `kro.run/node-id`
    // label. The operator's upsert then patches the existing resource
    // instead of creating a new one with inherited applyset labels.
    //
    // TODO: remove when migrating to valkey-io/valkey-operator, which
    // is unlikely to have this label-copying behavior.
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
    simple.ConfigMap({
      name: `${spec.name}-cache`,
      namespace: ns,
      data: {},
      id: 'cacheConfigMap',
    });

    // ── Database credentials ──────────────────────────────────────────────

    // CNPG auto-generates a Secret named {cluster}-{owner} during bootstrap.
    // Validated against CNPG v1.25 (cloudnative-pg chart 0.23.0).
    // The name is deterministic — no need for an externalRef which would block
    // KRO reconciliation (KRO waits for external refs to exist before creating
    // dependent resources, but the Secret only exists after CNPG bootstraps).
    const dbSecretName = `${spec.name}-db-${dbOwner}`;
    const inngestRepositoryName = `${spec.name}-${ns}-inngest-repo`;

    // ── Inngest (with external DB + cache) ──────────────────────────────

    // The actual postgres credentials are injected via the CNPG Secret
    // (secretKeyRef below). Use the deterministic pooler host here instead of
    // database.status.writeService so nested compositions do not leak an inner
    // resource status marker into the parent deployment graph.
    const inngestBootstrapApp = inngestBootstrap({
      name: `${spec.name}-inngest`,
      namespace: ns,
      repositoryName: inngestRepositoryName,
      inngest: {
        eventKey: spec.processing.eventKey,
        signingKey: spec.processing.signingKey,
        postgres: { uri: `postgresql://${dbOwner}@${dbPooler.metadata.name}:5432/${dbName}` },
        redis: { uri: `redis://${cache.metadata.name}:6379` },
        sdkUrl: spec.processing.sdkUrl,
      },
      postgresql: { enabled: false },
      redis: { enabled: false },
      replicaCount: inngestReplicas,
      ...(spec.processing.resources ? { resources: spec.processing.resources } : {}),
      // Deploy Inngest pods in the same namespace as CNPG (for Secret access)
      // and inject the real postgres URI from the CNPG Secret via secretKeyRef.
      customValues: {
        namespace: { create: false, name: ns },
        inngest: {
          eventKey: undefined,
          signingKey: undefined,
          extraEnv: [
            {
              name: 'INNGEST_EVENT_KEY',
              valueFrom: {
                secretKeyRef: {
                  name: `${spec.name}-inngest-credentials`,
                  key: 'INNGEST_EVENT_KEY',
                },
              },
            },
            {
              name: 'INNGEST_SIGNING_KEY',
              valueFrom: {
                secretKeyRef: {
                  name: `${spec.name}-inngest-credentials`,
                  key: 'INNGEST_SIGNING_KEY',
                },
              },
            },
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

    // Inngest needs cache to be ready before it can connect to Redis.
    // cache.metadata.name is deterministic and gets inlined to a schema
    // ref, so KRO sees no implicit dependency. dependsOn creates an
    // explicit readyWhen on inngest's leaf resource.
    inngestBootstrapApp.dependsOn?.(cache);
    inngestBootstrapApp.dependsOn?.(database);
    inngestBootstrapApp.dependsOn?.(dbPooler);

    // ── Inngest credentials Secret ──────────────────────────────────────
    //
    // The Inngest event key and signing key are sensitive — store them
    // in a K8s Secret rather than plaintext in the Deployment env.
    // Both the app and the Inngest server need these: the app sends
    // events with the event key and validates webhooks with the signing
    // key; the Inngest server uses them to authenticate SDK connections.
    const inngestSecretName = `${spec.name}-inngest-credentials`;
    secret({
      metadata: {
        name: inngestSecretName,
        namespace: ns,
      },
      stringData: {
        INNGEST_EVENT_KEY: spec.processing.eventKey,
        INNGEST_SIGNING_KEY: spec.processing.signingKey,
      },
      id: 'inngestCredentials',
    });

    // ── Application ─────────────────────────────────────────────────────

    const appEnv: Record<string, string> = {
      DATABASE_URL: `postgresql://${dbOwner}@${dbPooler.metadata.name}:5432/${dbName}`,
      VALKEY_URL: `redis://${cache.metadata.name}:6379`,
      REDIS_URL: `redis://${cache.metadata.name}:6379`,
      INNGEST_BASE_URL: `http://${spec.name}-inngest:8288`,
      // INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY injected via the
      // inngest credentials Secret (envFrom below) — not plaintext.
      ...spec.app.env,
    };

    // The inngest Secret is listed FIRST so user-provided envFrom sources can
    // override INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY if they provide their
    // own Secret containing those keys (last-write-wins in K8s envFrom ordering).
    const userAppEnvFrom = spec.app.envFrom;
    const appEnvFrom: V1EnvFromSource[] = isKubernetesRef(userAppEnvFrom)
      ? [{ secretRef: { name: inngestSecretName } }]
      : [{ secretRef: { name: inngestSecretName } }, ...(userAppEnvFrom ?? [])];

    const app = simple.Deployment({
      name: spec.name,
      namespace: ns,
      image: spec.app.image,
      replicas: appReplicas,
      ports: [{ containerPort: appPort }],
      env: appEnv,
      envFrom: appEnvFrom,
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
        inngestBootstrapApp.status.ready,
      databaseUrl: `postgresql://${dbOwner}@${dbPooler.metadata.name}:5432/${dbName}`,
      databaseHost: `${dbPooler.metadata.name}`,
      databasePort: 5432,
      cacheUrl: `redis://${cache.metadata.name}:6379`,
      cacheHost: `${cache.metadata.name}`,
      cachePort: 6379,
      inngestUrl: `http://${spec.name}-inngest:8288`,
      appUrl: `http://${spec.name}:${appPort}`,
      components: {
        app: app.status.readyReplicas >= appReplicas,
        database: database.status.readyInstances >= (spec.database.instances ?? 1),
        cache: cache.status.ready,
        inngest: inngestBootstrapApp.status.ready,
      },
    };
  }
);
