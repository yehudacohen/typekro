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
    /** Container image (default: 'searxng/searxng:2026.3.29-7ac4ff39f'). */
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
    /**
     * Server configuration. `secret_key` is NEVER written into the ConfigMap.
     * The preferred delivery channel is `secretKeyRef` (below) which mounts
     * an existing Secret via `valueFrom.secretKeyRef` — that keeps the key
     * out of Deployment spec and pod descriptions. Passing a plaintext
     * `secret_key` directly is supported for direct-mode callers who manage
     * their own secrets, but it results in the value appearing in
     * `Deployment.spec.template.spec.containers[].env[].value` which is
     * visible to anyone with `kubectl get deployment -o yaml`. Prefer
     * `secretKeyRef` in production.
     */
    'server?': serverConfigShape,
    /**
     * Reference to an existing K8s Secret containing the SearXNG secret key.
     * When set, the Deployment mounts `SEARXNG_SECRET` via
     * `valueFrom.secretKeyRef` and any plaintext `server.secret_key` is
     * ignored. This is the recommended production pattern — pair it with
     * an external-secrets operator (Vault, AWS SM, etc.) or create the
     * Secret separately.
     */
    'secretKeyRef?': {
      name: 'string',
      key: 'string',
    },
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
  /** Whether to create SearXNG resources (default: true). */
  'enabled?': 'boolean',
  /** Container image (default: 'searxng/searxng:2026.3.29-7ac4ff39f'). */
  'image?': 'string',
  /** Number of replicas (default: 1). */
  'replicas?': 'number',
  /** SearXNG instance name shown in the UI. */
  'instanceName?': 'string',
  /** Base URL for the instance. */
  'baseUrl?': 'string',
  /**
   * Server configuration. When `secretKeyRef` is NOT provided, the bootstrap
   * composition automatically creates a dedicated K8s Secret (`{name}-secret`)
   * and mounts it via `valueFrom.secretKeyRef` on the Deployment. The Secret
   * uses `server.secret_key` when supplied, otherwise the explicit placeholder
   * default `change-me-in-production`; production deployments should provide
   * `server.secret_key` or an external `secretKeyRef`.
   */
  'server?': serverConfigShape,
  /**
   * Reference to a pre-existing K8s Secret containing the SearXNG secret
   * key. Use this with external-secrets-operator, Vault, or any workflow
   * where the Secret's lifecycle is managed outside TypeKro. When set,
   * the bootstrap SKIPS creating its own Secret and wires the existing
   * one through to the Deployment via `valueFrom.secretKeyRef`. In KRO
   * mode this is resolved via `has(schema.spec.secretKeyRef)` so the
   * user can decide per-instance whether to provide an external ref or
   * fall back to the auto-created Secret.
   */
  'secretKeyRef?': {
    name: 'string',
    key: 'string',
  },
  /** Search configuration. */
  'search?': searchConfigShape,
  /** Redis/Valkey URL for the built-in rate limiter (e.g., 'redis://valkey:6379/0'). */
  'redisUrl?': 'string',
  /**
   * Complete settings.yml content as a string. When provided in direct mode,
   * this overrides the auto-generated settings. Use buildSearxngSettings()
   * or read from a file.
   */
  'settingsYaml?': 'string',
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
  phase: '"Ready" | "Installing" | "Disabled"',
  failed: 'boolean',
  /** The internal service URL. */
  url: 'string',
});

export type SearxngBootstrapStatus = typeof SearxngBootstrapStatusSchema.infer;

/** Default SearXNG image. Pinned to a specific version to avoid breaking config changes. */
export const DEFAULT_SEARXNG_IMAGE = 'searxng/searxng:2026.3.29-7ac4ff39f';

/** Default SearXNG port. */
export const DEFAULT_SEARXNG_PORT = 8080;
