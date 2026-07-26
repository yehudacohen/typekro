/**
 * Web Application Composition Types
 *
 * Higher-level compositions that wire together CNPG, Valkey, Inngest,
 * and application deployments with automatic environment variable injection.
 *
 * All config types are inferred from ArkType schemas — the schema is the
 * single source of truth. Status types remain as interfaces since they
 * represent k8s API responses, not validated input.
 *
 * @module
 */

import { type } from 'arktype';
import { CnpgBootstrapConfigSchema } from '../cnpg/types.js';
import type { ValkeyBootstrapConfig } from '../valkey/types.js';

const resourceRequirementsSchemaShape = {
  'requests?': { 'cpu?': 'string', 'memory?': 'string' },
  'limits?': { 'cpu?': 'string', 'memory?': 'string' },
} as const;

const envFromSourceSchema = type({
  'prefix?': 'string',
  secretRef: { name: 'string', 'optional?': 'boolean' },
  'configMapRef?': 'never',
}).or({
  'prefix?': 'string',
  configMapRef: { name: 'string', 'optional?': 'boolean' },
  'secretRef?': 'never',
});

// ============================================================================
// Config Schemas (source of truth) + Inferred Types
// ============================================================================

/**
 * Full-stack web application with background processing.
 *
 * Deploys: App + CNPG PostgreSQL + Valkey cache + Inngest workflow engine.
 * All connection strings are automatically wired into the app's environment.
 */
export const WebAppWithProcessingConfigSchema = type({
  /** Application name (used as prefix for all resources). */
  name: 'string',
  /** Target namespace. */
  'namespace?': 'string',
  /** Application deployment settings. */
  app: {
    /** Container image (e.g., 'myapp:latest'). */
    image: 'string',
    /** Container port (default: 3000). */
    'port?': 'number.integer',
    /** Number of replicas (default: 1). */
    'replicas?': 'number.integer',
    /** Additional environment variables. */
    'env?': 'Record<string, string>',
    /**
     * Inject all keys from Secrets or ConfigMaps as env vars via
     * the container's `envFrom` field.
     *
     * **Each entry must have exactly one of** `secretRef` or `configMapRef`
     * (not both, not neither). `prefix` and source `optional` are supported
     * to match Kubernetes `V1EnvFromSource` / `V1SecretEnvSource` /
     * `V1ConfigMapEnvSource` behavior.
     *
     * Note: in direct deployments, the composition prepends an inngest
     * credentials Secret to this array. If you provide your own Secret
     * containing `INNGEST_EVENT_KEY` or `INNGEST_SIGNING_KEY`, it will take
     * precedence (last-write-wins in K8s envFrom ordering). KRO deployments
     * mount only the generated credentials Secret because typed list fields
     * cannot be safely concatenated in ResourceGraphDefinition YAML.
     */
    'envFrom?': envFromSourceSchema.array(),
  },
  /** PostgreSQL database settings. */
  database: {
    /** Number of PostgreSQL instances (default: 1). */
    'instances?': 'number.integer',
    /** Storage size (e.g., '10Gi', '50Gi'). */
    storageSize: 'string',
    /** Storage class name (e.g. 'gp3', 'local-path'). */
    'storageClass?': 'string',
    /** Database name to create (default: 'app'). */
    'database?': 'string',
    /** Database owner (default: 'app'). */
    'owner?': 'string',
  },
  /** Valkey cache settings. Always deployed (omitting uses defaults, does not skip cache). */
  'cache?': {
    /** Number of Valkey shards (default: 3). */
    'shards?': 'number.integer',
    /** Replicas per shard (default: 0). */
    'replicas?': 'number.integer',
    /** Enable volume permissions init container. */
    'volumePermissions?': 'boolean',
    /** Storage size per shard (default: '1Gi'). */
    'storageSize?': 'string',
    /** Storage class name for Valkey PVCs (e.g. 'gp3', 'local-path'). */
    'storageClass?': 'string',
  },
  /** Inngest background processing settings. */
  processing: {
    /**
     * Inngest event authentication key (hex string, required).
     * In KRO mode this value is part of the custom resource spec before being
     * copied into a generated Secret; restrict read access to webapp CRs.
     */
    eventKey: 'string',
    /**
     * Inngest request signing key (hex string, required).
     * In KRO mode this value is part of the custom resource spec before being
     * copied into a generated Secret; restrict read access to webapp CRs.
     */
    signingKey: 'string',
    /** SDK URLs to auto-sync functions from. */
    'sdkUrl?': 'string[]',
    /** Number of Inngest server replicas (default: 1). */
    'replicas?': 'number.integer',
    /** Pod resource requirements for the Inngest server. */
    'resources?': resourceRequirementsSchemaShape,
  },
  /**
   * CloudNativePG operator install settings. The composition uses
   * `singleton(cnpgBootstrap, ...)` so app stacks consume a shared
   * operator boundary instead of inlining operator bootstrap resources
   * into every KRO graph.
   *
   * The schema embeds the full `CnpgBootstrapConfigSchema` made
   * partial (every field optional) so every field the underlying
   * bootstrap supports is available here without duplication:
   * `name`, `namespace`, `version`, `installCRDs`, `replicaCount`,
   * `monitoring`, `resources`, `customValues`, `shared`.
   *
   * Defaults applied by the composition when omitted:
   *   name: 'cnpg-operator'
   *   namespace: 'cnpg-system'
   *   shared: true (singleton — survives instance deletion)
   *
   * The defaults make the operator a shared cluster-level singleton:
   * multiple `webAppWithProcessing` instances converge on the same install.
   * `name`/`namespace` customize the install target, but the singleton identity
   * is fixed by this composition's `cnpg-operator` singleton id.
   */
  'cnpgOperator?': CnpgBootstrapConfigSchema.partial(),
});

/** Inferred config type — no separate interface needed. */
export type WebAppWithProcessingConfig = typeof WebAppWithProcessingConfigSchema.infer;

/** Build-time Valkey settings, including the v0.24 lifecycle compatibility flag. */
export type WebAppValkeyOperatorBuildOptions = Partial<ValkeyBootstrapConfig> & {
  /**
   * @deprecated Webapp operators are always consumed as shared singletons.
   * `true` is accepted during migration; `false` is rejected explicitly.
   */
  readonly shared?: boolean;
};

/**
 * Graph-authoring-time choices for {@link makeWebAppWithProcessing}.
 *
 * Operator installation settings are deliberately build-time: singleton
 * identity and ownership must be concrete in a generated KRO graph and may
 * not vary with each WebAppWithProcessing custom-resource instance.
 */
export interface WebAppWithProcessingBuildOptions {
  /**
   * Concrete Hyperspike operator installation settings. Omitted fields use
   * `name: 'valkey-operator'` and `namespace: 'valkey-operator-system'`.
   *
   * Migration from v0.24 and earlier: move the former runtime
   * `spec.valkeyOperator` object here.
   */
  readonly valkeyOperator?: WebAppValkeyOperatorBuildOptions;
}

/**
 * Status schema for the full-stack web application deployment.
 * Exposes connection URLs and readiness for each component.
 */
export const WebAppWithProcessingStatusSchema = type({
  ready: 'boolean',
  databaseUrl: 'string',
  databaseHost: 'string',
  databasePort: 'number.integer',
  cacheUrl: 'string',
  cacheHost: 'string',
  cachePort: 'number.integer',
  inngestUrl: 'string',
  appUrl: 'string',
  components: {
    app: 'boolean',
    database: 'boolean',
    cache: 'boolean',
    inngest: 'boolean',
  },
});

/** Inferred status type. */
export type WebAppWithProcessingStatus = typeof WebAppWithProcessingStatusSchema.infer;
