/**
 * Web Application Composition Types
 *
 * Higher-level compositions that wire together CNPG, Valkey, Inngest,
 * and application deployments with automatic environment variable injection.
 *
 * These compositions represent common full-stack patterns:
 * - App + PostgreSQL (via CNPG)
 * - App + Cache (via Valkey)
 * - Full-stack with background processing (App + CNPG + Valkey + Inngest)
 *
 * @module
 */

import { type Type, type } from 'arktype';

// ============================================================================
// Shared Sub-Config Types
// ============================================================================

/** Database configuration for compositions using CNPG. */
export interface DatabaseConfig {
  /** Number of PostgreSQL instances (default: 1). */
  instances?: number;
  /** Storage size (e.g., '10Gi', '50Gi'). */
  storageSize: string;
  /** Storage class name. */
  storageClass?: string;
  /** Database name to create (default: derived from app name). */
  database?: string;
  /** Database owner (default: 'app'). */
  owner?: string;
}

/** Cache configuration for compositions using Valkey. */
export interface CacheConfig {
  /** Number of Valkey shards (default: 3). */
  shards?: number;
  /** Replicas per shard (default: 0). */
  replicas?: number;
  /** Enable volume permissions init container. */
  volumePermissions?: boolean;
}

/** Background processing configuration for compositions using Inngest. */
export interface ProcessingConfig {
  /** Inngest event authentication key (hex string, required). */
  eventKey: string;
  /** Inngest request signing key (hex string, required). */
  signingKey: string;
  /** SDK URLs to auto-sync functions from. */
  sdkUrl?: string[];
  /** Number of Inngest server replicas (default: 1). */
  replicas?: number;
}

/** Application deployment configuration. */
export interface AppConfig {
  /** Container image (e.g., 'myapp:latest'). */
  image: string;
  /** Container port (default: 3000). */
  port?: number;
  /** Number of replicas (default: 1). */
  replicas?: number;
  /** Additional environment variables. */
  env?: Record<string, string>;
}

// ============================================================================
// WebAppWithProcessing (Full-Stack)
// ============================================================================

/**
 * Configuration for a full-stack web application with background processing.
 *
 * Deploys: App + CNPG PostgreSQL + Valkey cache + Inngest workflow engine.
 * All connection strings are automatically wired into the app's environment.
 */
export interface WebAppWithProcessingConfig {
  /** Application name (used as prefix for all resources). */
  name: string;
  /** Target namespace. */
  namespace?: string;
  /** Application deployment settings. */
  app: AppConfig;
  /** PostgreSQL database settings. */
  database: DatabaseConfig;
  /** Valkey cache settings. */
  cache?: CacheConfig;
  /** Inngest background processing settings. */
  processing: ProcessingConfig;
}

/**
 * Status of a full-stack web application deployment.
 *
 * Exposes connection URLs and readiness for each component, enabling
 * users to wire additional services or debug connectivity.
 */
export interface WebAppWithProcessingStatus {
  /** All components are ready. */
  ready: boolean;
  /** PostgreSQL connection URL (via PgBouncer pooler). */
  databaseUrl: string;
  /** Valkey/Redis connection URL. */
  cacheUrl: string;
  /** Inngest server URL. */
  inngestUrl: string;
  /** Application URL (ClusterIP service). */
  appUrl: string;
  /** Per-component readiness. */
  components: {
    app: boolean;
    database: boolean;
    cache: boolean;
    inngest: boolean;
  };
}

/** ArkType schema for WebAppWithProcessingConfig. */
export const WebAppWithProcessingConfigSchema: Type<WebAppWithProcessingConfig> = type({
  name: 'string',
  'namespace?': 'string',
  app: {
    image: 'string',
    'port?': 'number',
    'replicas?': 'number',
    'env?': 'Record<string, string>',
  },
  database: {
    'instances?': 'number',
    storageSize: 'string',
    'storageClass?': 'string',
    'database?': 'string',
    'owner?': 'string',
  },
  'cache?': {
    'shards?': 'number',
    'replicas?': 'number',
    'volumePermissions?': 'boolean',
  },
  processing: {
    eventKey: 'string',
    signingKey: 'string',
    'sdkUrl?': 'string[]',
    'replicas?': 'number',
  },
});

/** ArkType schema for WebAppWithProcessingStatus. */
export const WebAppWithProcessingStatusSchema: Type<WebAppWithProcessingStatus> = type({
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
