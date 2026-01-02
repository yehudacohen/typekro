// External-DNS Type Definitions
// Following external-dns Helm chart and CRD specifications

import { type, type Type } from 'arktype';

// Re-export common types from cert-manager for consistency
export type {
  ResourceRequirements,
  Toleration,
  Affinity,
  SecurityContext,
  EnvVar,
  Volume,
  VolumeMount,
  LabelSelector,
} from '../cert-manager/types';

// =============================================================================
// ARKTYPE SCHEMAS FOR BOOTSTRAP COMPOSITIONS
// =============================================================================

/**
 * ArkType schema for External-DNS Bootstrap Configuration
 * Simplified schema focusing on core bootstrap functionality
 */
// Type definitions for bootstrap configuration
export interface ExternalDnsBootstrapConfig {
  name: string;
  namespace?: string;
  provider: 'aws' | 'azure' | 'cloudflare' | 'google' | 'digitalocean';
  domainFilters?: string[];
  policy?: 'sync' | 'upsert-only' | 'create-only';
  dryRun?: boolean;
  txtOwnerId?: string;
  interval?: string;
  logLevel?: 'panic' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
}

export interface ExternalDnsBootstrapStatus {
  phase: 'Pending' | 'Installing' | 'Ready' | 'Failed' | 'Upgrading';
  ready: boolean;
  dnsProvider: string;
  domainFilters?: string[];
  policy: string;
  dryRun: boolean;
  endpoints: {
    metrics: string;
    healthz: string;
  };
  records: {
    managed: number;
    total: number;
    errors: number;
  };
}

export const ExternalDnsBootstrapConfigSchema: Type<ExternalDnsBootstrapConfig> = type({
  // Basic configuration
  name: 'string',
  'namespace?': 'string',

  // DNS Provider configuration (simplified for bootstrap)
  provider: '"aws" | "azure" | "cloudflare" | "google" | "digitalocean"',
  'domainFilters?': 'string[]',
  'policy?': '"sync" | "upsert-only" | "create-only"',
  'dryRun?': 'boolean',

  // Optional advanced configuration
  'txtOwnerId?': 'string',
  'interval?': 'string',
  'logLevel?': '"panic" | "fatal" | "error" | "warn" | "info" | "debug" | "trace"',
});

export const ExternalDnsBootstrapStatusSchema: Type<ExternalDnsBootstrapStatus> = type({
  // Overall status
  phase: '"Pending" | "Installing" | "Ready" | "Failed" | "Upgrading"',
  ready: 'boolean',

  // DNS Provider status
  dnsProvider: 'string',
  'domainFilters?': 'string[]',
  policy: 'string',
  dryRun: 'boolean',

  // Integration endpoints
  endpoints: {
    metrics: 'string',
    healthz: 'string',
  },

  // DNS record management status
  records: {
    managed: 'number',
    total: 'number',
    errors: 'number',
  },
});

// =============================================================================
// HELM INTEGRATION TYPES
// =============================================================================

/**
 * Configuration interface for External-DNS HelmRepository
 */
export interface ExternalDnsHelmRepositoryConfig {
  name: string;
  namespace?: string;
  url?: string; // Defaults to https://kubernetes-sigs.github.io/external-dns/
  interval?: string; // Defaults to 5m
  id?: string;
}

/**
 * Configuration interface for External-DNS HelmRelease
 */
export interface ExternalDnsHelmReleaseConfig {
  name: string;
  namespace?: string;
  repositoryName: string;
  version?: string; // Chart version
  values?: ExternalDnsHelmValues;
  id?: string;
}

/**
 * External-DNS Helm chart values interface
 * Based on the official external-dns Helm chart values
 */
export interface ExternalDnsHelmValues {
  // Provider configuration
  provider?: string; // 'aws', 'azure', 'cloudflare', 'google', etc.

  // DNS configuration
  domainFilters?: string[];
  excludeDomains?: string[];
  regexDomainFilter?: string;
  regexDomainExclusion?: string;
  zoneNameFilter?: string[];
  zoneIdFilter?: string[];
  aliasZoneIdFilter?: string[];
  targetNetFilter?: string[];
  excludeTargetNet?: string[];

  // Policy configuration
  policy?: 'sync' | 'upsert-only' | 'create-only';
  registry?: 'txt' | 'aws-sd' | 'dynamodb' | 'noop';
  txtOwnerId?: string;
  txtPrefix?: string;
  txtSuffix?: string;
  txtWildcardReplacement?: string;
  managedDNSRecordTypes?: string[];

  // Kubernetes configuration
  sources?: string[];
  namespace?: string;
  annotationFilter?: string;
  labelFilter?: string;
  ingressClass?: string;
  fqdnTemplate?: string;
  combineFQDNAnnotation?: boolean;
  ignoreHostnameAnnotation?: boolean;
  ignoreIngressTLSSpec?: boolean;
  ignoreIngressRulesSpec?: boolean;

  // Deployment configuration
  image?: {
    repository?: string;
    tag?: string;
    pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  };
  imagePullSecrets?: string[];
  nameOverride?: string;
  fullnameOverride?: string;
  commonLabels?: Record<string, string>;
  replicaCount?: number;
  revisionHistoryLimit?: number;

  // Resource configuration
  resources?: {
    limits?: {
      cpu?: string;
      memory?: string;
    };
    requests?: {
      cpu?: string;
      memory?: string;
    };
  };
  nodeSelector?: Record<string, string>;
  tolerations?: Array<{
    key?: string;
    operator?: 'Exists' | 'Equal';
    value?: string;
    effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
    tolerationSeconds?: number;
  }>;
  affinity?: any;
  priorityClassName?: string;
  terminationGracePeriodSeconds?: number;

  // Service Account configuration
  serviceAccount?: {
    create?: boolean;
    annotations?: Record<string, string>;
    name?: string;
    automountServiceAccountToken?: boolean;
  };

  // RBAC configuration
  rbac?: {
    create?: boolean;
    additionalPermissions?: Array<{
      apiGroups: string[];
      resources: string[];
      verbs: string[];
    }>;
  };

  // Service configuration
  service?: {
    enabled?: boolean;
    type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'ExternalName';
    port?: number;
    nodePort?: number;
    externalIPs?: string[];
    loadBalancerIP?: string;
    loadBalancerSourceRanges?: string[];
    annotations?: Record<string, string>;
  };

  // Monitoring configuration
  metrics?: {
    enabled?: boolean;
    port?: number;
    path?: string;
  };
  prometheus?: {
    monitor?: {
      enabled?: boolean;
      additionalLabels?: Record<string, string>;
      interval?: string;
      scrapeTimeout?: string;
    };
  };

  // Logging configuration
  logLevel?: 'panic' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  logFormat?: 'text' | 'json';

  // Advanced configuration
  dryRun?: boolean;
  interval?: string;
  triggerLoopOnEvent?: boolean;

  // Environment variables configuration (for credentials, etc.)
  env?: Array<{
    name: string;
    value?: string;
    valueFrom?: {
      secretKeyRef?: {
        name: string;
        key: string;
      };
      configMapKeyRef?: {
        name: string;
        key: string;
      };
    };
  }>;

  // Additional custom values
  [key: string]: any;
}
