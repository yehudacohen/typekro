/**
 * Inngest Helm Chart Type Definitions
 *
 * ArkType schemas are the SINGLE source of truth for validated config types.
 * TypeScript types are INFERRED from schemas using `typeof Schema.infer`.
 * Status interfaces remain hand-written since they represent k8s API responses.
 *
 * Inngest is a workflow orchestration platform — it has no CRDs.
 * All configuration is via Helm values.
 *
 * @see https://github.com/inngest/inngest-helm
 * @see https://www.inngest.com/docs/self-hosting
 */

import { type } from 'arktype';

// ============================================================================
// Shared Schema Shapes
// ============================================================================

/** Shared ArkType schema shape for Kubernetes tolerations. */
const tolerationSchemaShape = {
  'key?': 'string',
  'operator?': '"Exists" | "Equal"',
  'value?': 'string',
  'effect?': '"NoSchedule" | "PreferNoSchedule" | "NoExecute"',
  'tolerationSeconds?': 'number',
} as const;

/** Shared ArkType schema shape for pod resource requirements. */
const resourceRequirementsSchemaShape = {
  'requests?': { 'cpu?': 'string', 'memory?': 'string' },
  'limits?': { 'cpu?': 'string', 'memory?': 'string' },
} as const;

// ============================================================================
// Bootstrap Config (Helm Install)
// ============================================================================

/**
 * ArkType schema for Inngest bootstrap configuration.
 *
 * Deploying Inngest via Helm. Requires PostgreSQL and Redis — either
 * bundled (default) or external (via CNPG + Valkey).
 *
 * @see https://github.com/inngest/inngest-helm
 */
export const InngestBootstrapConfigSchema = type({
  /** Release name for the Helm installation. */
  name: 'string',
  /** Namespace for Inngest (default: 'inngest'). */
  'namespace?': 'string',
  /** Chart version (default: '0.3.1'). */
  'version?': 'string',
  /** Number of Inngest replicas (default: 1). */
  'replicaCount?': 'number',

  /** Core Inngest application configuration. */
  inngest: {
    /** Event authentication key (hex string, required). */
    eventKey: 'string',
    /** Request signing key (hex string, required). */
    signingKey: 'string',
    /** External PostgreSQL connection. */
    'postgres?': { 'uri?': 'string' },
    /** External Redis/Valkey connection. */
    'redis?': { 'uri?': 'string' },
    /** Server hostname for external access. */
    'host?': 'string',
    /** SDK URLs to auto-sync functions from. */
    'sdkUrl?': 'string[]',
    /** Disable the web UI. */
    'noUI?': 'boolean',
    /** App polling interval in seconds (default: 60). */
    'pollInterval?': 'number',
    /** Number of executor queue workers (default: 100). */
    'queueWorkers?': 'number',
    /** Log level (default: 'info'). */
    'logLevel?': 'string',
    /** Enable JSON log output. */
    'json?': 'boolean',
    /** Extra environment variables for the Inngest container. */
    'extraEnv?': type({ name: 'string', value: 'string' }).array(),
  },

  /** Pod resource requirements for the Inngest server. */
  'resources?': resourceRequirementsSchemaShape,

  /** Bundled PostgreSQL configuration. Disable when using external CNPG. */
  'postgresql?': {
    /** Deploy bundled PostgreSQL (default: true). */
    'enabled?': 'boolean',
    /** Authentication settings. */
    'auth?': {
      'database?': 'string',
      'username?': 'string',
      'password?': 'string',
    },
    /** Persistence settings. */
    'persistence?': {
      'enabled?': 'boolean',
      'size?': 'string',
      'storageClass?': 'string',
    },
    /** Pod resources. */
    'resources?': resourceRequirementsSchemaShape,
  },

  /** Bundled Redis configuration. Disable when using external Valkey. */
  'redis?': {
    /** Deploy bundled Redis (default: true). */
    'enabled?': 'boolean',
    /** Persistence settings. */
    'persistence?': {
      'enabled?': 'boolean',
      'size?': 'string',
      'storageClass?': 'string',
    },
    /** Pod resources. */
    'resources?': resourceRequirementsSchemaShape,
  },

  /** Ingress for external access. */
  'ingress?': {
    /** Enable ingress (default: false). */
    'enabled?': 'boolean',
    /** Ingress class name (default: 'nginx'). */
    'className?': 'string',
    /** Ingress annotations. */
    'annotations?': 'Record<string, string>',
    /** Ingress host rules. */
    'hosts?': type({
      host: 'string',
      'paths?': type({ 'path?': 'string', 'pathType?': 'string' }).array(),
    }).array(),
    /** TLS configuration. */
    'tls?': type({
      'secretName?': 'string',
      'hosts?': 'string[]',
    }).array(),
  },

  /** KEDA autoscaling. */
  'keda?': {
    /** Enable KEDA-based autoscaling (default: false). */
    'enabled?': 'boolean',
    /** Minimum replicas (default: 1). */
    'minReplicas?': 'number',
    /** Maximum replicas (default: 10). */
    'maxReplicas?': 'number',
    /** Metric polling interval in seconds (default: 30). */
    'pollingInterval?': 'number',
    /** Cooldown period after scaling in seconds (default: 300). */
    'cooldownPeriod?': 'number',
  },

  /** Node selector for pod scheduling. */
  'nodeSelector?': 'Record<string, string>',
  /** Taint tolerations. */
  'tolerations?': type(tolerationSchemaShape).array(),
  /** Additional Helm values for user overrides. */
  'customValues?': 'Record<string, unknown>',
});

/** Configuration for deploying Inngest via Helm. */
export type InngestBootstrapConfig = typeof InngestBootstrapConfigSchema.infer;

// ============================================================================
// Status Types (interfaces — not schema-validated)
// ============================================================================

/** Observed status of an Inngest deployment. */
export interface InngestBootstrapStatus {
  /**
   * Overall deployment phase (derived from HelmRelease Ready condition).
   * Note: cannot distinguish Failed from Installing due to CEL limitation (#48).
   * Use the `failed` field for failure detection.
   */
  phase: 'Ready' | 'Installing';
  /** Whether Inngest is ready to process events. */
  ready: boolean;
  /** Whether the HelmRelease Ready condition is explicitly False. */
  failed: boolean;
  /** Deployed chart version. */
  version?: string;
}

/** ArkType schema for InngestBootstrapStatus. */
export const InngestBootstrapStatusSchema = type({
  phase: '"Ready" | "Installing"',
  ready: 'boolean',
  failed: 'boolean',
  'version?': 'string',
});

// ============================================================================
// Helm Integration
// ============================================================================

/** ArkType schema for the Inngest Helm chart repository configuration. */
export const InngestHelmRepositoryConfigSchema = type({
  /** Repository name (default: 'inngest-repo'). */
  'name?': 'string',
  /** Namespace for the HelmRepository (default: flux-system). */
  'namespace?': 'string',
  /** OCI registry URL (default: 'oci://ghcr.io/inngest/inngest-helm'). */
  'url?': 'string',
  /** Sync interval (default: '5m'). */
  'interval?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
});

/** Configuration for the Inngest Helm chart repository. */
export type InngestHelmRepositoryConfig = typeof InngestHelmRepositoryConfigSchema.infer;

/** ArkType schema for the Inngest Helm release configuration. */
export const InngestHelmReleaseConfigSchema = type({
  /** Release name. */
  name: 'string',
  /** Target namespace. */
  'namespace?': 'string',
  /** Chart version (default: '0.3.1'). */
  'version?': 'string',
  /** Helm values. */
  'values?': 'Record<string, unknown>',
  /** HelmRepository name to reference (default: 'inngest-repo'). */
  'repositoryName?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
});

/** Configuration for the Inngest Helm release. */
export type InngestHelmReleaseConfig = typeof InngestHelmReleaseConfigSchema.infer;
