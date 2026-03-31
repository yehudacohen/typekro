/**
 * SearXNG Types
 *
 * Schema-first type definitions for the SearXNG metasearch engine integration.
 * Config types are inferred from ArkType schemas. Status types are interfaces
 * representing K8s API responses.
 *
 * SearXNG is a privacy-respecting metasearch engine that aggregates results
 * from multiple search providers. It runs as a single container with a
 * YAML configuration file.
 *
 * @module
 */

import { type } from 'arktype';

// ============================================================================
// Shared schema shapes
// ============================================================================

/** SearXNG server configuration shape. */
const serverConfigShape = {
  /** Secret key for session encryption. */
  'secret_key?': 'string',
  /** Enable/disable the built-in rate limiter. */
  'limiter?': 'boolean',
  /** Bind address (default: '0.0.0.0:8080'). */
  'bind_address?': 'string',
  /** HTTP method (default: 'GET'). */
  'method?': 'string',
} as const;

/** SearXNG search configuration shape. */
const searchConfigShape = {
  /** Enabled response formats. */
  'formats?': 'string[]',
  /** Default language. */
  'default_lang?': 'string',
  /** Autocomplete provider (e.g., 'google', 'duckduckgo', false to disable). */
  'autocomplete?': 'string',
  /** Safe search level (0=off, 1=moderate, 2=strict). */
  'safe_search?': '0 | 1 | 2',
} as const;

// ============================================================================
// SearXNG Deployment Config
// ============================================================================

export const SearxngConfigSchema = type({
  /** Resource name. */
  name: 'string',
  /** Target namespace. */
  'namespace?': 'string',
  /** Composition resource ID. */
  'id?': 'string',
  spec: {
    /** Container image (default: 'searxng/searxng:latest'). */
    'image?': 'string',
    /** Image pull policy. */
    'imagePullPolicy?': '"Always" | "Never" | "IfNotPresent"',
    /** Number of replicas (default: 1). */
    'replicas?': 'number',
    /** SearXNG instance name shown in the UI. */
    'instanceName?': 'string',
    /** Base URL for the instance (used for redirects/links). */
    'baseUrl?': 'string',
    /** ConfigMap name for settings (default: '{name}-config'). */
    'configMapName?': 'string',
    /** Server configuration. secret_key is injected via SEARXNG_SECRET env var, not ConfigMap. */
    'server?': serverConfigShape,
    /** Search configuration. */
    'search?': searchConfigShape,
    /** Redis/Valkey URL for the built-in rate limiter (e.g., 'redis://valkey:6379/0'). */
    'redisUrl?': 'string',
    /** Additional environment variables. */
    'env?': 'Record<string, string>',
    /** Resource requests and limits. */
    'resources?': {
      'requests?': { 'cpu?': 'string', 'memory?': 'string' },
      'limits?': { 'cpu?': 'string', 'memory?': 'string' },
    },
    /** Node selector for scheduling. */
    'nodeSelector?': 'Record<string, string>',
    /** Tolerations for scheduling. */
    'tolerations?': type({
      'key?': 'string',
      'operator?': '"Exists" | "Equal"',
      'value?': 'string',
      'effect?': '"NoSchedule" | "PreferNoSchedule" | "NoExecute"',
    }).array(),
  },
});

export type SearxngConfig = typeof SearxngConfigSchema.infer;

// ============================================================================
// SearXNG Status
// ============================================================================

export interface SearxngStatus {
  /** Whether the deployment is ready. */
  ready?: boolean;
  /** Number of ready replicas. */
  readyReplicas?: number;
  /** Number of desired replicas. */
  replicas?: number;
  /** Standard K8s conditions. */
  conditions?: Array<{ type: string; status: string; message?: string }>;
}

// ============================================================================
// Bootstrap Composition Config
// ============================================================================

export const SearxngBootstrapConfigSchema = type({
  /** Instance name. */
  name: 'string',
  /** Target namespace (default: 'searxng'). */
  'namespace?': 'string',
  /** Container image (default: 'searxng/searxng:latest'). */
  'image?': 'string',
  /** Number of replicas (default: 1). */
  'replicas?': 'number',
  /** SearXNG instance name shown in the UI. */
  'instanceName?': 'string',
  /** Base URL for the instance. */
  'baseUrl?': 'string',
  /** Server configuration. */
  'server?': serverConfigShape,
  /** Search configuration. */
  'search?': searchConfigShape,
  /** Redis/Valkey URL for the built-in rate limiter. */
  'redisUrl?': 'string',
  /** Additional environment variables. */
  'env?': 'Record<string, string>',
  /** Resource requests and limits. */
  'resources?': {
    'requests?': { 'cpu?': 'string', 'memory?': 'string' },
    'limits?': { 'cpu?': 'string', 'memory?': 'string' },
  },
});

export type SearxngBootstrapConfig = typeof SearxngBootstrapConfigSchema.infer;

export const SearxngBootstrapStatusSchema = type({
  ready: 'boolean',
  phase: '"Ready" | "Installing"',
  failed: 'boolean',
  /** The internal service URL. */
  url: 'string',
});

export type SearxngBootstrapStatus = typeof SearxngBootstrapStatusSchema.infer;

/** Default SearXNG image. */
export const DEFAULT_SEARXNG_IMAGE = 'searxng/searxng:latest';

/** Default SearXNG port. */
export const DEFAULT_SEARXNG_PORT = 8080;
