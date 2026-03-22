/**
 * Inngest Helm Chart Type Definitions
 *
 * TypeScript interfaces and ArkType schemas for deploying Inngest
 * on Kubernetes via the official Helm chart.
 *
 * Inngest is a workflow orchestration platform — it has no CRDs.
 * All configuration is via Helm values.
 *
 * @see https://github.com/inngest/inngest-helm
 * @see https://www.inngest.com/docs/self-hosting
 */

import { type Type, type } from 'arktype';

// ============================================================================
// Common Kubernetes Types
// ============================================================================

/** Pod resource requests and limits. */
export interface ResourceRequirements {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string };
}

/** Kubernetes toleration for pod scheduling. */
export interface Toleration {
  key?: string;
  operator?: 'Exists' | 'Equal';
  value?: string;
  effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
  tolerationSeconds?: number;
}

// ============================================================================
// Inngest Application Configuration
// ============================================================================

/** PostgreSQL connection configuration for Inngest. */
export interface InngestPostgresConfig {
  /** External PostgreSQL connection URI. */
  uri?: string;
}

/** Redis/Valkey connection configuration for Inngest. */
export interface InngestRedisConfig {
  /** External Redis/Valkey connection URI. */
  uri?: string;
}

/** Core Inngest application settings. */
export interface InngestAppConfig {
  /** Event authentication key (required). Generate with: openssl rand -hex 16 */
  eventKey: string;
  /** Request signing key (required). Generate with: openssl rand -hex 32 */
  signingKey: string;
  /** External PostgreSQL connection. If not set, uses bundled PostgreSQL. */
  postgres?: InngestPostgresConfig;
  /** External Redis/Valkey connection. If not set, uses bundled Redis. */
  redis?: InngestRedisConfig;
  /** Server hostname for external access. */
  host?: string;
  /** SDK URLs to auto-sync functions from. */
  sdkUrl?: string[];
  /** Disable the web UI. */
  noUI?: boolean;
  /** App polling interval in seconds (default: 60). */
  pollInterval?: number;
  /** Number of executor queue workers (default: 100). */
  queueWorkers?: number;
  /** Log level: 'trace' | 'debug' | 'info' | 'warn' | 'error' (default: 'info'). */
  logLevel?: string;
  /** Enable JSON log output. */
  json?: boolean;
  /** Extra environment variables for the Inngest container. */
  extraEnv?: Array<{ name: string; value: string }>;
}

/** Bundled PostgreSQL subchart configuration. */
export interface InngestBundledPostgresConfig {
  /** Deploy bundled PostgreSQL (default: true). Set false when using external DB. */
  enabled?: boolean;
  /** Authentication settings. */
  auth?: {
    database?: string;
    username?: string;
    password?: string;
  };
  /** Persistence settings. */
  persistence?: {
    enabled?: boolean;
    size?: string;
    storageClass?: string;
  };
  /** Pod resources. */
  resources?: ResourceRequirements;
}

/** Bundled Redis subchart configuration. */
export interface InngestBundledRedisConfig {
  /** Deploy bundled Redis (default: true). Set false when using external Valkey/Redis. */
  enabled?: boolean;
  /** Persistence settings. */
  persistence?: {
    enabled?: boolean;
    size?: string;
    storageClass?: string;
  };
  /** Pod resources. */
  resources?: ResourceRequirements;
}

/** Ingress configuration for external access. */
export interface InngestIngressConfig {
  /** Enable ingress (default: false). */
  enabled?: boolean;
  /** Ingress class name (default: 'nginx'). */
  className?: string;
  /** Ingress annotations. */
  annotations?: Record<string, string>;
  /** Ingress host rules. */
  hosts?: Array<{
    host: string;
    paths?: Array<{ path?: string; pathType?: string }>;
  }>;
  /** TLS configuration. */
  tls?: Array<{
    secretName?: string;
    hosts?: string[];
  }>;
}

/** KEDA autoscaling configuration. */
export interface InngestKedaConfig {
  /** Enable KEDA-based autoscaling (default: false). */
  enabled?: boolean;
  /** Minimum replicas (default: 1). */
  minReplicas?: number;
  /** Maximum replicas (default: 10). */
  maxReplicas?: number;
  /** Metric polling interval in seconds (default: 30). */
  pollingInterval?: number;
  /** Cooldown period after scaling in seconds (default: 300). */
  cooldownPeriod?: number;
}

// ============================================================================
// Bootstrap Config (Helm Install)
// ============================================================================

/**
 * Configuration for deploying Inngest via Helm.
 *
 * Used by the `inngestBootstrap` composition. Inngest requires
 * PostgreSQL and Redis — either bundled (default) or external.
 *
 * @see https://github.com/inngest/inngest-helm
 */
export interface InngestBootstrapConfig {
  /** Release name for the Helm installation. */
  name: string;
  /** Namespace for Inngest (default: 'inngest'). */
  namespace?: string;
  /** Chart version (default: '0.3.1'). */
  version?: string;
  /** Number of Inngest replicas (default: 1). */
  replicaCount?: number;

  /** Core Inngest application configuration. */
  inngest: InngestAppConfig;

  /** Pod resource requirements for the Inngest server. */
  resources?: ResourceRequirements;
  /** Bundled PostgreSQL configuration. Disable when using external CNPG. */
  postgresql?: InngestBundledPostgresConfig;
  /** Bundled Redis configuration. Disable when using external Valkey. */
  redis?: InngestBundledRedisConfig;
  /** Ingress for external access. */
  ingress?: InngestIngressConfig;
  /** KEDA autoscaling. */
  keda?: InngestKedaConfig;

  /** Node selector for pod scheduling. */
  nodeSelector?: Record<string, string>;
  /** Taint tolerations. */
  tolerations?: Toleration[];

  /** Additional Helm values for user overrides. */
  customValues?: Record<string, unknown>;
}

/**
 * Observed status of an Inngest deployment.
 */
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

// ============================================================================
// ArkType Schemas
// ============================================================================

/** Shared ArkType schema shape for Toleration. */
const tolerationSchemaShape = {
  'key?': 'string',
  'operator?': '"Exists" | "Equal"',
  'value?': 'string',
  'effect?': '"NoSchedule" | "PreferNoSchedule" | "NoExecute"',
  'tolerationSeconds?': 'number',
} as const;

/** ArkType schema for InngestBootstrapConfig. */
export const InngestBootstrapConfigSchema: Type<InngestBootstrapConfig> = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'replicaCount?': 'number',
  inngest: {
    eventKey: 'string',
    signingKey: 'string',
    'postgres?': { 'uri?': 'string' },
    'redis?': { 'uri?': 'string' },
    'host?': 'string',
    'sdkUrl?': 'string[]',
    'noUI?': 'boolean',
    'pollInterval?': 'number',
    'queueWorkers?': 'number',
    'logLevel?': 'string',
    'json?': 'boolean',
    'extraEnv?': type({ name: 'string', value: 'string' }).array(),
  },
  'resources?': {
    'requests?': { 'cpu?': 'string', 'memory?': 'string' },
    'limits?': { 'cpu?': 'string', 'memory?': 'string' },
  },
  'postgresql?': {
    'enabled?': 'boolean',
    'auth?': {
      'database?': 'string',
      'username?': 'string',
      'password?': 'string',
    },
    'persistence?': {
      'enabled?': 'boolean',
      'size?': 'string',
      'storageClass?': 'string',
    },
    'resources?': {
      'requests?': { 'cpu?': 'string', 'memory?': 'string' },
      'limits?': { 'cpu?': 'string', 'memory?': 'string' },
    },
  },
  'redis?': {
    'enabled?': 'boolean',
    'persistence?': {
      'enabled?': 'boolean',
      'size?': 'string',
      'storageClass?': 'string',
    },
    'resources?': {
      'requests?': { 'cpu?': 'string', 'memory?': 'string' },
      'limits?': { 'cpu?': 'string', 'memory?': 'string' },
    },
  },
  'ingress?': {
    'enabled?': 'boolean',
    'className?': 'string',
    'annotations?': 'Record<string, string>',
    'hosts?': type({
      host: 'string',
      'paths?': type({ 'path?': 'string', 'pathType?': 'string' }).array(),
    }).array(),
    'tls?': type({
      'secretName?': 'string',
      'hosts?': 'string[]',
    }).array(),
  },
  'keda?': {
    'enabled?': 'boolean',
    'minReplicas?': 'number',
    'maxReplicas?': 'number',
    'pollingInterval?': 'number',
    'cooldownPeriod?': 'number',
  },
  'nodeSelector?': 'Record<string, string>',
  'tolerations?': type(tolerationSchemaShape).array(),
  'customValues?': 'Record<string, unknown>',
});

/** ArkType schema for InngestBootstrapStatus. */
export const InngestBootstrapStatusSchema: Type<InngestBootstrapStatus> = type({
  phase: '"Ready" | "Installing"',
  ready: 'boolean',
  failed: 'boolean',
  'version?': 'string',
});

// ============================================================================
// Helm Integration Types
// ============================================================================

/** Configuration for the Inngest Helm chart repository. */
export interface InngestHelmRepositoryConfig {
  /** Repository name (default: 'inngest-repo'). */
  name?: string;
  /** Namespace for the HelmRepository (default: flux-system). */
  namespace?: string;
  /** OCI registry URL (default: 'oci://ghcr.io/inngest/inngest-helm'). */
  url?: string;
  /** Sync interval (default: '5m'). */
  interval?: string;
  /** Resource ID for composition references. */
  id?: string;
}

/** Configuration for the Inngest Helm release. */
export interface InngestHelmReleaseConfig {
  /** Release name. */
  name: string;
  /** Target namespace. */
  namespace?: string;
  /** Chart version (default: '0.3.1'). */
  version?: string;
  /** Helm values. */
  values?: Record<string, unknown>;
  /** HelmRepository name to reference (default: 'inngest-repo'). */
  repositoryName?: string;
  /** Resource ID for composition references. */
  id?: string;
}
