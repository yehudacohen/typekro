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
    'port?': 'number',
    /** Number of replicas (default: 1). */
    'replicas?': 'number',
    /** Additional environment variables. */
    'env?': 'Record<string, string>',
  },
  /** PostgreSQL database settings. */
  database: {
    /** Number of PostgreSQL instances (default: 1). */
    'instances?': 'number',
    /** Storage size (e.g., '10Gi', '50Gi'). */
    storageSize: 'string',
    /** Storage class name (e.g. 'gp3', 'local-path'). */
    'storageClass?': 'string',
    /** Database name to create (default: derived from app name). */
    'database?': 'string',
    /** Database owner (default: 'app'). */
    'owner?': 'string',
  },
  /** Valkey cache settings. */
  'cache?': {
    /** Number of Valkey shards (default: 3). */
    'shards?': 'number',
    /** Replicas per shard (default: 0). */
    'replicas?': 'number',
    /** Enable volume permissions init container. */
    'volumePermissions?': 'boolean',
    /** Storage size per shard (default: '1Gi'). */
    'storageSize?': 'string',
  },
  /** Inngest background processing settings. */
  processing: {
    /** Inngest event authentication key (hex string, required). */
    eventKey: 'string',
    /** Inngest request signing key (hex string, required). */
    signingKey: 'string',
    /** SDK URLs to auto-sync functions from. */
    'sdkUrl?': 'string[]',
    /** Number of Inngest server replicas (default: 1). */
    'replicas?': 'number',
  },
});

/** Inferred config type — no separate interface needed. */
export type WebAppWithProcessingConfig = typeof WebAppWithProcessingConfigSchema.infer;

/**
 * Status schema for the full-stack web application deployment.
 * Exposes connection URLs and readiness for each component.
 */
export const WebAppWithProcessingStatusSchema = type({
  ready: 'boolean',
  databaseUrl: 'string',
  cacheUrl: 'string',
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
