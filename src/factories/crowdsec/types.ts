/**
 * CrowdSec types: the bootstrap's runtime spec and status (ArkType), its
 * build-time options, and the Traefik bouncer configuration.
 */

import type {
  V1Affinity,
  V1EnvVar,
  V1Toleration,
  V1TopologySpreadConstraint,
} from '@kubernetes/client-node';
import { type Type, type } from 'arktype';

// Runtime spec and status (KRO-safe values only)

/** Container requests (required, so no pod is BestEffort) and optional limits. */
export interface CrowdsecResources {
  requests: { cpu: string; memory: string };
  limits?: { cpu?: string; memory?: string };
}

/** Runtime spec of the CrowdSec bootstrap. Every field may be a schema reference. */
export interface CrowdsecBootstrapConfig {
  /** Helm release name; also prefixes every chart resource. */
  name: string;
  /** @default 'crowdsec' */
  namespace?: string;
  /** @default DEFAULT_CROWDSEC_CHART_VERSION */
  chartVersion?: string;
  lapi?: { resources?: CrowdsecResources };
  agent?: { resources?: CrowdsecResources };
  /** Only used when the build options enable AppSec. */
  appsec?: { replicas?: number; resources?: CrowdsecResources };
}

/** Status of the CrowdSec bootstrap. Every field is a projection of the owned release. */
export interface CrowdsecBootstrapStatus {
  ready: boolean;
  failed: boolean;
  phase: 'Ready' | 'Installing' | 'Failed';
  /** `host:port` of the LAPI Service, for the bouncer middleware. */
  lapiHost: string;
  /** `host:port` of the AppSec Service, or `''` when AppSec is off. */
  appsecHost: string;
  /** Chart version Flux installed, `''` until the first release. */
  version: string;
}

// Release names prefix `<name>-lapi-cscli-register-job`, a 63-character Job name.
const releaseName = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 39');
const dnsLabel = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 63');
const resources = type({
  requests: { cpu: 'string > 0', memory: 'string > 0' },
  'limits?': { 'cpu?': 'string > 0', 'memory?': 'string > 0' },
});

/** ArkType schema of {@link CrowdsecBootstrapConfig}. */
export const CrowdsecBootstrapConfigSchema: Type<CrowdsecBootstrapConfig> = type({
  name: releaseName,
  'namespace?': dnsLabel,
  'chartVersion?': 'string > 0',
  'lapi?': { 'resources?': resources },
  'agent?': { 'resources?': resources },
  'appsec?': { 'replicas?': 'number.integer >= 1', 'resources?': resources },
});

/** ArkType schema of {@link CrowdsecBootstrapStatus}. */
export const CrowdsecBootstrapStatusSchema: Type<CrowdsecBootstrapStatus> = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Ready" | "Installing" | "Failed"',
  lapiHost: 'string',
  appsecHost: 'string',
  version: 'string',
});

/** Spec of the shared `HelmRepository` singleton. */
export interface CrowdsecHelmRepositorySpec {
  name: string;
  namespace: string;
  url: string;
}

/** ArkType schema of {@link CrowdsecHelmRepositorySpec}. */
export const CrowdsecHelmRepositorySpecSchema: Type<CrowdsecHelmRepositorySpec> = type({
  name: dnsLabel,
  namespace: dnsLabel,
  url: 'string > 0',
});

/** ArkType schema of the singleton's status. */
export const CrowdsecHelmRepositoryStatusSchema: Type<{ ready: boolean }> = type({
  ready: 'boolean',
});

// Build-time options (concrete values; they decide what the graph contains)

/** A key of a Secret in the CrowdSec namespace. */
export interface CrowdsecSecretKeyRef {
  readonly name: string;
  readonly key: string;
}

/** Scheduling for one CrowdSec component. */
export interface CrowdsecPlacement {
  readonly nodeSelector?: Readonly<Record<string, string>>;
  readonly tolerations?: readonly V1Toleration[];
  readonly affinity?: V1Affinity;
  /** Defaults to a soft spread across nodes for LAPI and AppSec. */
  readonly topologySpreadConstraints?: readonly V1TopologySpreadConstraint[];
  readonly priorityClassName?: string;
}

/** LAPI storage: SQLite on a PVC (one replica) or an existing Postgres. */
export type CrowdsecStorage =
  | { readonly type: 'sqlite'; readonly size?: string; readonly storageClassName?: string }
  | {
      readonly type: 'postgres';
      readonly host: string;
      /** @default 5432 */
      readonly port?: number;
      readonly database: string;
      readonly user: string;
      readonly passwordSecretRef: CrowdsecSecretKeyRef;
      /** @default 'require' */
      readonly sslMode?: 'disable' | 'require' | 'verify-ca' | 'verify-full';
    };

/**
 * Pods whose logs the agents read: a namespace and a pod-name glob, matched
 * against node-local container log files by every agent in the DaemonSet.
 * @see docs/api/crowdsec/index.md for why label selectors are not offered.
 */
export interface CrowdsecAcquisition {
  readonly namespace: string;
  /** Glob over pod names, e.g. `traefik-*`. */
  readonly podName: string;
  /** Parser program. @default 'traefik' */
  readonly program?: string;
}

/** An AppSec rule to switch off, everywhere or under one path prefix. */
export interface CrowdsecAppsecExclusion {
  readonly ruleId?: number;
  readonly ruleName?: string;
  readonly ruleTag?: string;
  /** @default 'both' */
  readonly phase?: 'inband' | 'outofband' | 'both';
  /** Only exclude for request paths starting with this prefix. */
  readonly pathPrefix?: string;
}

/** The AppSec (WAF) component. Present means enabled. */
export interface CrowdsecAppsecOptions {
  /** In-band virtual patching (`crowdsecurity/appsec-default`). @default true */
  readonly virtualPatching?: boolean;
  /** Out-of-band OWASP CRS (`crowdsecurity/crs`). @default true */
  readonly crs?: boolean;
  /** Largest body AppSec inspects, in bytes. @default 10485760 */
  readonly maxBodySize?: number;
  /** What happens to a larger body. @default 'partial' */
  readonly bodySizeExceededAction?: 'drop' | 'partial' | 'allow';
  /** In-band remediation. Defaults to `'allow'` under global simulation, else `'ban'`. */
  readonly inBandRemediation?: 'ban' | 'allow';
  readonly exclusions?: readonly CrowdsecAppsecExclusion[];
  readonly pdb?: boolean;
  readonly placement?: CrowdsecPlacement;
}

/**
 * Simulation: everything simulated except `enforce`, or nothing simulated
 * except `simulate`. Both render as CrowdSec's `exclusions`.
 */
export type CrowdsecSimulation =
  | { readonly global: true; readonly enforce?: readonly string[] }
  | { readonly global: false; readonly simulate?: readonly string[] };

/** Ingress allowed to LAPI (`:8080`) and AppSec (`:7422`). */
export interface CrowdsecNetworkPolicyOptions {
  /** Namespace of the Traefik pods running the bouncer. */
  readonly traefikNamespace: string;
  /** Namespace allowed to scrape `:6060`. @default any namespace */
  readonly metricsNamespace?: string;
}

/** Build-time options of {@link makeCrowdsecBootstrap}. */
export interface CrowdsecBootstrapOptions {
  /** @default 'crowdsec-bootstrap' */
  readonly name?: string;
  /** @default 'CrowdsecBootstrap' */
  readonly kind?: string;
  /** @default 'owned' */
  readonly namespaceOwnership?: 'owned' | 'external';
  /** @default { type: 'sqlite', size: '1Gi' } */
  readonly storage?: CrowdsecStorage;
  readonly lapi?: {
    /** More than one needs Postgres. @default 1 */
    readonly replicas?: number;
    /** @default true */
    readonly pdb?: boolean;
    readonly placement?: CrowdsecPlacement;
    /** Pod CIDRs allowed to auto-register agents. @default the RFC 1918 ranges */
    readonly autoRegistrationRanges?: readonly string[];
    /** Extra LAPI env, appended after the env this factory sets. */
    readonly env?: readonly V1EnvVar[];
  };
  readonly agent?: {
    /** @default 'containerd' */
    readonly containerRuntime?: 'containerd' | 'docker';
    readonly placement?: CrowdsecPlacement;
    /** Extra agent env, e.g. `DISABLE_PARSERS`, after `COLLECTIONS`. */
    readonly env?: readonly V1EnvVar[];
  };
  /** @default [{ namespace: 'traefik', podName: 'traefik-*' }] */
  readonly acquisitions?: readonly CrowdsecAcquisition[];
  /** Hub collections installed on top of {@link DEFAULT_CROWDSEC_COLLECTIONS}. */
  readonly collections?: readonly string[];
  /** Central API. Absent means LAPI runs offline. */
  readonly centralApi?: {
    /** Register with CAPI and pull the community blocklist. */
    readonly communityBlocklist: boolean;
    readonly enrollment?: {
      readonly keySecretRef: CrowdsecSecretKeyRef;
      readonly instanceName?: string;
      readonly tags?: readonly string[];
    };
  };
  /** Bouncers registered as `BOUNCER_KEY_<name>`. */
  readonly bouncers?: readonly {
    readonly name: string;
    readonly keySecretRef: CrowdsecSecretKeyRef;
  }[];
  /** IPs and CIDRs that never trigger a decision. */
  readonly allowlist?: {
    readonly ips?: readonly string[];
    readonly cidrs?: readonly string[];
    readonly reason?: string;
  };
  /** Simulated scenarios alert but do not remediate. */
  readonly simulation?: CrowdsecSimulation;
  /** NetworkPolicies for LAPI and AppSec ingress. Absent means none. */
  readonly networkPolicy?: CrowdsecNetworkPolicyOptions;
  readonly appsec?: CrowdsecAppsecOptions;
  /** Prometheus Operator objects. Metrics are always served on port 6060. */
  readonly metrics?: { readonly serviceMonitor?: boolean; readonly podMonitor?: boolean };
  /** Raw chart values, merged first; everything this factory sets wins. */
  readonly values?: Readonly<Record<string, unknown>>;
}

// Traefik side

/** One entry of Traefik's `experimental.plugins`. */
export interface CrowdsecTraefikPluginDeclaration {
  moduleName: string;
  version: string;
  /** SHA-256 of the plugin archive, as Traefik verifies it. */
  hash: string;
}

/** Options of {@link crowdsecBouncerMiddleware}. */
export interface CrowdsecBouncerMiddlewareOptions {
  /** LAPI `host:port`, e.g. the bootstrap's `status.lapiHost`. */
  readonly lapiHost: string;
  /** Secret in the Middleware's namespace holding this bouncer's key. */
  readonly apiKeySecret?: CrowdsecSecretKeyRef;
  /** Path of the key in the Traefik pods, instead of `apiKeySecret`. */
  readonly apiKeyFile?: string;
  /** AppSec `host:port`. Omit to skip the WAF. */
  readonly appsecHost?: string;
  /** Let traffic through when LAPI or AppSec is unreachable. @default true */
  readonly failOpen?: boolean;
  /** Failed pulls tolerated before fail-closed blocks traffic. @default 4 */
  readonly failClosedAfter?: number;
  /** Key of the plugin in `experimental.plugins`. @default 'crowdsec' */
  readonly pluginName?: string;
  /** Seconds between decision pulls. @default 15 */
  readonly updateIntervalSeconds?: number;
  /** Proxies in front of Traefik whose `X-Forwarded-For` is trusted. */
  readonly forwardedHeadersTrustedIps?: readonly string[];
  /** Clients that bypass the bouncer and AppSec. */
  readonly clientTrustedIps?: readonly string[];
  /** Bytes of body sent to AppSec; match `appsec.maxBodySize`. @default 10485760 */
  readonly appsecBodyLimit?: number;
  /** @default 'INFO' */
  readonly logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
}

/** A Traefik `Middleware.spec` that runs the bouncer plugin. */
export interface CrowdsecBouncerMiddlewareSpec {
  plugin: Record<string, Record<string, unknown>>;
}
