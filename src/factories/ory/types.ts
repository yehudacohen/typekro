/**
 * Public Ory identity stack contracts.
 *
 * This module defines the TypeKro-facing configuration, status, error, and factory
 * signatures for the graph-native Ory ecosystem. Implementation files must conform to
 * these contracts while the exhaustive pinned upstream chart and CRD surfaces live in
 * `schemas/`.
 *
 * Interface decision: model current pinned chart/CRD fields as explicit TypeScript
 * contracts and reserve `customValues` only for future chart keys and upstream
 * free-form extension points. The rejected alternative was a thin wrapper around
 * `Record<string, unknown>` values, which would not preserve the dependency-source safety
 * and field-coverage guarantees required by the approved plan.
 *
 * Interface organization decision: keep source-of-truth chart and CRD contracts
 * physically split by Ory subproduct while this module owns the cross-product stack
 * config, status, factory, lifecycle, and error contracts for the combined stack API.
 */

import { type } from 'arktype';
import type { TypeKroError } from '../../core/errors.js';
import type {
  Composable,
  DirectResourceFactory,
  Enhanced,
  KroResourceFactory,
  PublicFactoryOptions,
} from '../../core/types/index.js';
import type { HelmRepositorySpec, HelmRepositoryStatus } from '../helm/helm-repository.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../helm/types.js';
import type { ResourceRequirements } from '../cert-manager/types.js';
import type {
  OAuth2ClientConfig,
  OAuth2ClientSpec,
  OAuth2ClientStatus,
  OryHydraMaesterChartValues,
} from './schemas/hydra-maester.js';
import type { OryHydraChartValues } from './schemas/hydra.js';
import type { OryKetoChartValues } from './schemas/keto.js';
import type { OryKratosChartValues } from './schemas/kratos.js';
import type { OryOathkeeperChartValues } from './schemas/oathkeeper.js';
import type {
  OryOathkeeperMaesterChartValues,
  OathkeeperRuleConfig,
  OathkeeperRuleSpec,
  OathkeeperRuleStatus,
} from './schemas/oathkeeper-maester.js';

export type * from './schemas/index.js';

/** Default official Ory Helm repository URL used by all Ory chart wrappers. */
export type OryDefaultHelmRepositoryUrl = 'https://k8s.ory.sh/helm/charts';

/** Default pinned chart version covered by the Ory chart value contracts. */
export type OryDefaultChartVersion = '0.62.0';

/** Stack phase exposed through `OryIdentityStackStatus`. */
export type OryIdentityStackPhase = 'Ready' | 'Installing';

/** Platform phase exposed through `OryPlatformStackStatus`. */
export type OryPlatformStackPhase = 'Ready' | 'Installing';

/** Supported Ory service chart names. */
export type OryServiceName = 'hydra' | 'kratos' | 'keto' | 'oathkeeper';

/** Physical subproduct contract modules required by the approved interface split. */
export type OrySubproductSchemaModule =
  | 'hydra'
  | 'kratos'
  | 'keto'
  | 'oathkeeper'
  | 'hydra-maester'
  | 'oathkeeper-maester';

/** Public source file map for the required physical Ory subproduct schema split. */
export interface OrySubproductSchemaFiles {
  hydra: 'schemas/hydra.ts';
  kratos: 'schemas/kratos.ts';
  keto: 'schemas/keto.ts';
  oathkeeper: 'schemas/oathkeeper.ts';
  hydraMaester: 'schemas/hydra-maester.ts';
  oathkeeperMaester: 'schemas/oathkeeper-maester.ts';
}

/** Supported Ory Maester controller names. */
export type OryMaesterName = 'hydra' | 'oathkeeper';

/** Error codes thrown by Ory validation and values-mapping implementation. */
export type OryConfigurationErrorCode =
  | 'ORY_MISSING_DSN'
  | 'ORY_MISSING_SECRET'
  | 'ORY_UNRESOLVED_DEPENDENCY_SOURCE'
  | 'ORY_UNSAFE_PRODUCTION_VALUE'
  | 'ORY_INVALID_HELM_VALUES'
  | 'ORY_MAESTER_CONFIG_INVALID';

/** Error codes for Ory resource factory and lifecycle operations. */
export type OryOperationErrorCode =
  | OryConfigurationErrorCode
  | 'ORY_RESOURCE_NOT_FOUND'
  | 'ORY_RESOURCE_APPLY_FAILED'
  | 'ORY_RESOURCE_DELETE_FAILED'
  | 'ORY_RESOURCE_READ_FAILED'
  | 'ORY_RESOURCE_RECONCILE_FAILED';

/** Kubernetes Secret key reference used for DSNs and sensitive Ory config. */
export interface OrySecretKeyRef {
  /** Name of the Kubernetes Secret in the Ory stack namespace. */
  name: string;
  /** Key inside the Kubernetes Secret. */
  key: string;
}

/** Kubernetes Secret-backed source for sensitive values. */
export interface OrySecretKeyRefSource {
  /** Existing or graph-created Kubernetes Secret key reference. */
  secretRef: OrySecretKeyRef;
}

/** Explicit literal source for intentional non-secret or deterministic local config. */
export interface OryLiteralValueSource {
  /** Literal value supplied by the user. Treat as sensitive when used for secrets. */
  value: string;
}

/** Explicit source for Ory DSNs, secret material, URLs, and JWK payloads. */
export type OryValueSource = OrySecretKeyRefSource | OryLiteralValueSource;

/** Source mode for graph-managed or externally supplied Ory dependencies. */
export type OryDependencySourceMode = 'external' | 'managed';

/** External dependency source supplied by the user or platform. */
export interface OryExternalDependencySource {
  /** Marks this dependency as externally supplied. */
  mode: 'external';
  /** Optional externally supplied value or Secret reference. */
  value?: OryValueSource;
  /** Optional externally supplied URL. */
  url?: string;
  /** Optional externally supplied Kubernetes resource name. */
  resourceName?: string;
}

/** Graph-managed local/internal dependency created by `oryPlatformStack`. */
export interface OryManagedDependencySource {
  /** Marks this dependency as created by the TypeKro graph. */
  mode: 'managed';
  /** Stable Kubernetes resource name override for the managed dependency. */
  resourceName?: string;
  /** Runtime URL produced by the managed dependency, when it differs from the resource name. */
  url?: string;
  /** Namespace override when the managed dependency must live outside the Ory namespace. */
  namespace?: string;
  /** Stable Secret name override when the dependency produces Secret data. */
  secretName?: string;
  /** Secret key used when the dependency produces one selected value. */
  secretKey?: string;
}

/** External or graph-managed dependency source. */
export type OryDependencySource = OryExternalDependencySource | OryManagedDependencySource;

/** Database dependency source for Hydra, Kratos, or Keto. */
export interface OryDatabaseDependencySource {
  /** External DSN source or graph-managed database source. */
  dsn: OryDependencySource;
  /** Optional database name used by managed CNPG resources. */
  databaseName?: string;
}

/** URL dependency source used for routes, UIs, and upstream services. */
export interface OryUrlDependencySource {
  /** External URL or graph-managed route/upstream source. */
  url: OryDependencySource;
}

/** Service-level Ory dependency source configuration. */
export interface OryDependencySourceConfig {
  /** Hydra database, service secret, and UI URL sources. */
  hydra?: {
    database?: OryDatabaseDependencySource;
    systemSecret?: OryDependencySource;
    issuerUrl?: OryUrlDependencySource;
    loginUrl?: OryUrlDependencySource;
    consentUrl?: OryUrlDependencySource;
    logoutUrl?: OryUrlDependencySource;
  };
  /** Kratos database, secrets, browser URLs, identity schema, and courier sources. */
  kratos?: {
    database?: OryDatabaseDependencySource;
    publicBaseUrl?: OryUrlDependencySource;
    browserBaseUrl?: OryUrlDependencySource;
    identitySchemas?: OryDependencySource;
    secrets?: Record<string, OryDependencySource>;
    courier?: OryDependencySource;
  };
  /** Keto database source. */
  keto?: {
    database?: OryDatabaseDependencySource;
  };
  /** Oathkeeper route, upstream, and mutator secret sources. */
  oathkeeper?: {
    proxyRoute?: OryUrlDependencySource;
    apiRoute?: OryUrlDependencySource;
    upstream?: OryUrlDependencySource;
    mutatorIdTokenJwks?: OryDependencySource;
  };
  /** Optional ACK/SES courier source used when Kratos email flows are enabled. */
  courier?: OryDependencySource;
}

/** Shared global chart convenience config applied before service-specific values. */
export interface OryGlobalConfig {
  /** Optional global image registry override. */
  imageRegistry?: string;
  /** Optional image pull secret names. */
  imagePullSecrets?: string[];
}

/** Shared ServiceMonitor convenience config. */
export interface OryServiceMonitorConfig {
  /** Enables chart ServiceMonitor resources when supported by the service chart. */
  enabled?: boolean;
}

/** Shared high-level fields common to Ory service configs. */
export interface OryServiceConfigBase<TValues extends object> {
  /** Number of service replicas. */
  replicaCount?: number;
  /** Pod resource requests and limits. */
  resources?: ResourceRequirements;
  /** Prometheus ServiceMonitor convenience toggle. */
  serviceMonitor?: OryServiceMonitorConfig;
  /** Exhaustive pinned upstream chart values for this service. */
  values?: TValues;
  /** Forward-compatibility escape hatch for future chart fields. */
  customValues?: Record<string, unknown>;
}

/** Hydra high-level config plus exhaustive pinned chart values. */
export interface OryHydraConfig extends OryServiceConfigBase<OryHydraChartValues> {
  /** Explicit Hydra SQL DSN source. */
  dsn?: OryValueSource;
  /** Public issuer URL advertised by Hydra. */
  issuerUrl?: string;
  /** Login UI URL configured in Hydra. */
  loginUrl?: string;
  /** Consent UI URL configured in Hydra. */
  consentUrl?: string;
  /** Logout UI URL configured in Hydra. */
  logoutUrl?: string;
  /** Hydra system secret source. */
  systemSecret?: OryValueSource;
}

/** Kratos high-level config plus exhaustive pinned chart values. */
export interface OryKratosConfig extends OryServiceConfigBase<OryKratosChartValues> {
  /** Explicit Kratos SQL DSN source. */
  dsn?: OryValueSource;
  /** Public base URL for Kratos self-service flows. */
  publicBaseUrl?: string;
  /** Browser base URL for Kratos self-service flows. */
  browserBaseUrl?: string;
  /** Named identity schema documents mounted through Kratos chart values. */
  identitySchemas?: Record<string, string>;
  /** Courier config passthrough; upstream chart accepts provider-specific objects. */
  courier?: Record<string, unknown>;
  /** Explicit Kratos secret sources keyed by chart/config secret name. */
  secrets?: Record<string, OryValueSource>;
}

/** Keto namespace declaration used by high-level authorization config. */
export interface OryKetoNamespaceConfig {
  /** Numeric namespace id used by Keto relation tuples. */
  id: number;
  /** Human-readable Keto namespace name. */
  name: string;
}

/** Keto high-level config plus exhaustive pinned chart values. */
export interface OryKetoConfig extends OryServiceConfigBase<OryKetoChartValues> {
  /** Explicit Keto SQL DSN source. */
  dsn?: OryValueSource;
  /** Keto namespace declarations written to chart config. */
  namespaces?: OryKetoNamespaceConfig[];
}

/** Oathkeeper high-level config plus exhaustive pinned chart values. */
export interface OryOathkeeperConfig extends OryServiceConfigBase<OryOathkeeperChartValues> {
  /** Whether Oathkeeper managed access rules are enabled in chart values. */
  managedAccessRules?: boolean;
  /** JWK source used by the Oathkeeper ID token mutator. */
  mutatorIdTokenJwks?: OryValueSource;
}

/** Hydra Maester high-level controller settings. */
export interface OryHydraMaesterConfig {
  /** Enables Hydra Maester and its OAuth2Client CRD support. Defaults to true. */
  enabled?: boolean;
  /** Limits watches to the stack namespace. Defaults to true in the high-level stack. */
  singleNamespaceMode?: boolean;
  /** Explicit namespaces watched when not using single-namespace mode. */
  enabledNamespaces?: string[];
  /** Hydra Maester ServiceMonitor convenience toggle. */
  serviceMonitor?: OryServiceMonitorConfig;
}

/** Oathkeeper Maester high-level controller settings. */
export interface OryOathkeeperMaesterConfig {
  /** Enables Oathkeeper Maester and its Rule CRD support. Defaults to true. */
  enabled?: boolean;
  /** Limits watches to the stack namespace. Defaults to true in the high-level stack. */
  singleNamespaceMode?: boolean;
  /** Namespace containing the generated Oathkeeper rules ConfigMap. */
  rulesConfigmapNamespace?: string;
  /** Rules filename written by Oathkeeper Maester. */
  rulesFileName?: string;
}

/** Combined Maester config for high-level stack wiring. */
export interface OryMaesterConfig {
  /** Hydra Maester high-level settings. */
  hydra?: OryHydraMaesterConfig;
  /** Oathkeeper Maester high-level settings. */
  oathkeeper?: OryOathkeeperMaesterConfig;
  /** Exhaustive pinned Hydra Maester chart values. */
  hydraValues?: OryHydraMaesterChartValues;
  /** Exhaustive pinned Oathkeeper Maester chart values. */
  oathkeeperValues?: OryOathkeeperMaesterChartValues;
}

/** Service-specific custom value escape hatch grouped at stack level. */
export interface OryIdentityStackCustomValues {
  hydra?: Record<string, unknown>;
  kratos?: Record<string, unknown>;
  keto?: Record<string, unknown>;
  oathkeeper?: Record<string, unknown>;
}

/** Optional starter Maester resources created with the identity stack. */
export interface OryIdentityStackStarterResources {
  /** OAuth2 clients reconciled by Hydra Maester. */
  oauth2Clients?: OAuth2ClientConfig[];
  /** Oathkeeper rules reconciled by Oathkeeper Maester. */
  oathkeeperRules?: OathkeeperRuleConfig[];
}

/** High-level Ory identity stack config. */
export interface OryIdentityStackConfig {
  /** Stable stack name used for release names, labels, and instance identity. */
  name: string;
  /** Target namespace for Ory services and Maester resources. */
  namespace?: string;
  /** Ory chart version. Defaults to the pinned `0.62.0` contract. */
  version?: string;
  /** Explicit external or graph-managed dependency sources. */
  dependencySources?: OryDependencySourceConfig;
  /** Whether Ory resources are shared infrastructure during deletion. */
  shared?: boolean;
  /** Global image/chart convenience config. */
  global?: OryGlobalConfig;
  /** Hydra service config. */
  hydra?: OryHydraConfig;
  /** Kratos service config. */
  kratos?: OryKratosConfig;
  /** Keto service config. */
  keto?: OryKetoConfig;
  /** Oathkeeper service config. */
  oathkeeper?: OryOathkeeperConfig;
  /** Maester controller config. */
  maester?: OryMaesterConfig;
  /** Stack-level future chart field escape hatch. */
  customValues?: OryIdentityStackCustomValues;
  /** Optional representative Maester resources to create with the stack. */
  resources?: OryIdentityStackStarterResources;
}

/** Managed local infrastructure toggles for `oryPlatformStack`. */
export interface OryManagedPlatformConfig {
  /** Enables CNPG-backed managed PostgreSQL resources when database sources are omitted. */
  databases?: boolean;
  /** Enables graph-created Kubernetes Secrets when secret sources are omitted. */
  secrets?: boolean;
  /** Enables local APISIX routing when route sources are omitted. */
  routes?: boolean;
  /** Enables a sample upstream webapp for Oathkeeper proxy validation. */
  sampleUpstream?: boolean;
  /** Enables optional ACK/SES courier resources when explicitly configured. */
  courierSes?: boolean;
}

/** Locally runnable identity platform config that composes infrastructure plus Ory. */
export interface OryPlatformStackConfig extends OryIdentityStackConfig {
  /** Managed local defaults used when explicit dependency sources are omitted. */
  managed?: OryManagedPlatformConfig;
}

/** Component readiness booleans exposed by stack status. */
export interface OryIdentityStackComponentStatus {
  hydra: boolean;
  kratos: boolean;
  keto: boolean;
  oathkeeper: boolean;
}

/** Maester readiness booleans exposed by stack status. */
export interface OryIdentityStackMaesterStatus {
  hydra: boolean;
  oathkeeper: boolean;
}

/** Structured service endpoint exposed by Ory stack statuses. */
export interface OryEndpointStatus {
  /** URL clients should use for this endpoint. */
  url: string;
  /** URL scheme used by the endpoint. */
  scheme: string;
  /** DNS hostname or route host for the endpoint. */
  host: string;
  /** Cluster-assigned Service IP when this endpoint is backed by a Service. */
  clusterIP?: string;
  /** TCP port exposed by the endpoint when observed from the backing Service. */
  port?: number;
  /** Kubernetes Service name when this endpoint resolves to an in-cluster service. */
  serviceName?: string;
  /** Kubernetes namespace for the service endpoint when applicable. */
  namespace?: string;
}

/** Service endpoints exposed by stack status. */
export interface OryIdentityStackEndpointStatus {
  hydraPublic: OryEndpointStatus;
  hydraAdmin: OryEndpointStatus;
  kratosPublic: OryEndpointStatus;
  kratosAdmin: OryEndpointStatus;
  ketoRead: OryEndpointStatus;
  ketoWrite: OryEndpointStatus;
  oathkeeperProxy: OryEndpointStatus;
  oathkeeperApi: OryEndpointStatus;
}

/** Observed status returned by the `oryIdentityStack` composition. */
export interface OryIdentityStackStatus {
  /** Overall readiness derived from all Ory HelmRelease Ready conditions. */
  ready: boolean;
  /** Stack installation phase. */
  phase: OryIdentityStackPhase;
  /** Per-service readiness derived from HelmRelease status. */
  components: OryIdentityStackComponentStatus;
  /** Per-Maester readiness derived from relevant HelmRelease status. */
  maester: OryIdentityStackMaesterStatus;
  /** Stable in-cluster endpoint hostnames for installed Ory services. */
  endpoints: OryIdentityStackEndpointStatus;
  /** Deployed chart version when known. */
  version?: string;
}

/** Infrastructure readiness surfaced by `oryPlatformStack`. */
export interface OryPlatformInfrastructureStatus {
  databases: boolean;
  secrets: boolean;
  routes: boolean;
  upstream: boolean;
  courier: boolean;
}

/** Resolved source mode for each platform dependency group. */
export interface OryPlatformDependencyResolutionStatus {
  hydraDatabase: OryDependencySourceMode;
  kratosDatabase: OryDependencySourceMode;
  ketoDatabase: OryDependencySourceMode;
  secrets: OryDependencySourceMode;
  routes: OryDependencySourceMode;
  upstream: OryDependencySourceMode;
  courier: OryDependencySourceMode;
}

/** Observed status returned by the `oryPlatformStack` composition. */
export interface OryPlatformStackStatus {
  /** Overall readiness derived from infrastructure, Ory, Maester, and route readiness. */
  ready: boolean;
  /** Platform installation phase. */
  phase: OryPlatformStackPhase;
  /** Managed/external dependency readiness. */
  infrastructure: OryPlatformInfrastructureStatus;
  /** Resolved external-or-managed source mode for each dependency group. */
  dependencies: OryPlatformDependencyResolutionStatus;
  /** Nested Ory identity stack readiness. */
  ory: OryIdentityStackStatus;
  /** Resolved endpoints for graph-managed or external routes. */
  endpoints: OryIdentityStackEndpointStatus;
}

/** Chart values produced by the Ory values mapper. */
export interface OryMappedHelmValues {
  hydra: OryHydraChartValues;
  kratos: OryKratosChartValues;
  keto: OryKetoChartValues;
  oathkeeper: OryOathkeeperChartValues;
  hydraMaester: OryHydraMaesterChartValues;
  oathkeeperMaester: OryOathkeeperMaesterChartValues;
}

/** Structured validation issue produced before throwing an Ory configuration error. */
export interface OryConfigurationIssue {
  /** Stable machine-readable issue code. */
  code: OryConfigurationErrorCode;
  /** Config path where the issue was found. */
  path: string;
  /** Human-readable safe message that does not include secret values. */
  message: string;
  /** Affected service or Maester component, when applicable. */
  component?: OryServiceName | OryMaesterName;
}

/** Structured context carried by Ory TypeKro errors. */
export interface OryConfigurationErrorContext extends Record<string, unknown> {
  /** Selected dependency sources at the time of validation. */
  dependencySources?: OryDependencySourceConfig;
  /** All validation issues that caused the failure. */
  issues: OryConfigurationIssue[];
}

/** Typed thrown error contract for Ory validation failures. */
export interface OryConfigurationError extends TypeKroError {
  readonly name: 'OryConfigurationError';
  readonly code: OryConfigurationErrorCode;
  readonly context: OryConfigurationErrorContext;
}

/** Structured safe error returned by explicit Ory lifecycle operation contracts. */
export interface OryOperationError {
  /** Stable machine-readable operation error code. */
  code: OryOperationErrorCode;
  /** Safe diagnostic message that excludes DSNs, secrets, and tokens. */
  message: string;
  /** Affected service or Maester component, when applicable. */
  component?: OryServiceName | OryMaesterName;
  /** Kubernetes resource name, when applicable. */
  resourceName?: string;
  /** Kubernetes namespace, when applicable. */
  namespace?: string;
  /** Config or status path that produced the error, when known. */
  path?: string;
}

/** Successful explicit Ory operation result. */
export interface OryOperationSuccess<T> {
  ok: true;
  value: T;
}

/** Failed explicit Ory operation result with structured safe error details. */
export interface OryOperationFailure {
  ok: false;
  error: OryOperationError;
}

/** Result type used by explicit Ory lifecycle operation contracts. */
export type OryOperationResult<T> = OryOperationSuccess<T> | OryOperationFailure;

/** Public resource factory signature with an explicit typed error boundary. */
export type OryResourceFactorySignature<TConfig, TSpec, TStatus> = {
  (config: Composable<TConfig>): Enhanced<TSpec, TStatus>;
  /** Structured errors thrown or surfaced by this factory use this shape. */
  readonly errorType?: OryOperationError;
};

/** Public utility signature with an explicit typed error boundary. */
export type OryUtilitySignature<
  TInput,
  TOutput,
  TError extends TypeKroError | OryOperationError,
> = {
  (input: TInput): TOutput;
  /** Structured errors thrown or surfaced by this utility use this shape. */
  readonly errorType?: TError;
};

/** Direct resource factory with explicit Ory operation error shape. */
export type OryDirectFactoryWithErrors<TSpec extends object, TStatus extends object> = DirectResourceFactory<TSpec, TStatus> & {
  readonly errorType?: OryOperationError;
};

/** KRO resource factory with explicit Ory operation error shape. */
export type OryKroFactoryWithErrors<TSpec extends object, TStatus extends object> = KroResourceFactory<TSpec, TStatus> & {
  readonly errorType?: OryOperationError;
};

/** Public Ory factory and composition error boundary map. */
export interface OryFactoryErrorBoundary {
  oryHelmRepository: OryOperationError;
  hydraHelmRelease: OryOperationError;
  kratosHelmRelease: OryOperationError;
  ketoHelmRelease: OryOperationError;
  oathkeeperHelmRelease: OryOperationError;
  oauth2Client: OryOperationError;
  oathkeeperRule: OryOperationError;
  oryIdentityStack: OryOperationError;
  oryPlatformStack: OryOperationError;
  helmValuesMapper: OryOperationError;
  configValidator: OryOperationError;
}

/** Non-throwing validation result used by tests and mapper internals. */
export interface OryConfigValidationResult {
  valid: boolean;
  issues: OryConfigurationIssue[];
}

/** Operational warning from Ory Helm values generation. */
export interface OryHelmValueWarning {
  /** Config path that produced the warning. */
  path: string;
  /** Human-readable safe message that does not include secret values. */
  message: string;
  /** Affected service or Maester component, when applicable. */
  component?: OryServiceName | OryMaesterName;
}

/** Operational event categories emitted by Ory implementation diagnostics. */
export type OryOperationalEventType =
  | 'helmRepositoryNotReady'
  | 'helmReleaseNotReady'
  | 'dependencySourceValidationFailed'
  | 'maesterCrdMissing'
  | 'oauth2ClientReconciliationFailed'
  | 'oathkeeperRuleValidationFailed';

/** Health check names exposed by Ory operational status and tests. */
export type OryHealthCheckName =
  | 'helmRepositoryReady'
  | 'hydraReady'
  | 'kratosReady'
  | 'ketoReady'
  | 'oathkeeperReady'
  | 'hydraMaesterReady'
  | 'oathkeeperMaesterReady'
  | 'oauth2ClientReconciled'
  | 'oathkeeperRuleValidated';

/** Metrics signal names exposed by Ory chart and Maester monitoring config. */
export type OryMetricSignalName =
  | 'serviceMonitorEnabled'
  | 'serviceMonitorDisabled'
  | 'metricsServiceConfigured'
  | 'maesterMetricsConfigured';

/** Health check contract used by tests and operational diagnostics. */
export interface OryHealthCheckStatus {
  name: OryHealthCheckName;
  component: OryServiceName | OryMaesterName;
  healthy: boolean;
  message?: string;
  resourceName?: string;
  namespace?: string;
}

/** Metrics configuration signal emitted by values mapping and operational diagnostics. */
export interface OryMetricSignal {
  name: OryMetricSignalName;
  component: OryServiceName | OryMaesterName;
  enabled: boolean;
  endpoint?: string;
  labels?: Record<string, string>;
}

/** Safe structured log event contract; secret values and DSNs must never be included. */
export interface OryOperationalLogEvent {
  /** Machine-readable operational event type. */
  type: OryOperationalEventType;
  /** Affected Ory service or Maester component. */
  component: OryServiceName | OryMaesterName;
  /** Kubernetes resource name, when applicable. */
  resourceName?: string;
  /** Kubernetes namespace, when applicable. */
  namespace?: string;
  /** Safe diagnostic message that excludes DSNs, secrets, and tokens. */
  message: string;
}

/** Config for creating the official Ory HelmRepository. */
export interface OryHelmRepositoryConfig {
  /** HelmRepository name. */
  name?: string;
  /** HelmRepository namespace. Defaults to Flux namespace. */
  namespace?: string;
  /** Repository URL. Defaults to the official Ory Helm repository. */
  url?: string;
  /** Flux reconcile interval. */
  interval?: string;
  /** TypeKro composition resource id. */
  id?: string;
}

/** Shared config for Ory service HelmRelease wrappers. */
export interface OryHelmReleaseConfigBase<TValues extends object> {
  /** HelmRelease name. */
  name: string;
  /** HelmRelease namespace and chart target namespace. */
  namespace?: string;
  /** Name of the Ory HelmRepository sourceRef. */
  repositoryName?: string;
  /** Namespace of the Ory HelmRepository sourceRef. */
  repositoryNamespace?: string;
  /** Chart version. Defaults to pinned `0.62.0`. */
  version?: string;
  /** Flux reconcile interval. */
  interval?: string;
  /** Fully typed pinned chart values. */
  values?: TValues;
  /** TypeKro composition resource id. */
  id?: string;
}

/** Hydra HelmRelease wrapper config. */
export interface OryHydraHelmReleaseConfig extends OryHelmReleaseConfigBase<OryHydraChartValues> {}

/** Kratos HelmRelease wrapper config. */
export interface OryKratosHelmReleaseConfig
  extends OryHelmReleaseConfigBase<OryKratosChartValues> {}

/** Keto HelmRelease wrapper config. */
export interface OryKetoHelmReleaseConfig extends OryHelmReleaseConfigBase<OryKetoChartValues> {}

/** Oathkeeper HelmRelease wrapper config. */
export interface OryOathkeeperHelmReleaseConfig
  extends OryHelmReleaseConfigBase<OryOathkeeperChartValues> {}

/** Public factory signature for creating the Ory HelmRepository. */
export type OryHelmRepositoryFactory = OryResourceFactorySignature<
  OryHelmRepositoryConfig,
  HelmRepositorySpec,
  HelmRepositoryStatus
>;

/** Public factory signature for creating the Hydra HelmRelease. */
export type OryHydraHelmReleaseFactory = OryResourceFactorySignature<
  OryHydraHelmReleaseConfig,
  HelmReleaseSpec,
  HelmReleaseStatus
>;

/** Public factory signature for creating the Kratos HelmRelease. */
export type OryKratosHelmReleaseFactory = OryResourceFactorySignature<
  OryKratosHelmReleaseConfig,
  HelmReleaseSpec,
  HelmReleaseStatus
>;

/** Public factory signature for creating the Keto HelmRelease. */
export type OryKetoHelmReleaseFactory = OryResourceFactorySignature<
  OryKetoHelmReleaseConfig,
  HelmReleaseSpec,
  HelmReleaseStatus
>;

/** Public factory signature for creating the Oathkeeper HelmRelease. */
export type OryOathkeeperHelmReleaseFactory = OryResourceFactorySignature<
  OryOathkeeperHelmReleaseConfig,
  HelmReleaseSpec,
  HelmReleaseStatus
>;

/** Public factory signature for Hydra Maester `OAuth2Client` resources. */
export type OryOAuth2ClientFactory = OryResourceFactorySignature<
  OAuth2ClientConfig,
  OAuth2ClientSpec,
  OAuth2ClientStatus
>;

/** Public factory signature for Oathkeeper Maester `Rule` resources. */
export type OryOathkeeperRuleFactory = OryResourceFactorySignature<
  OathkeeperRuleConfig,
  OathkeeperRuleSpec,
  OathkeeperRuleStatus
>;

/** Public mapper signature for deriving chart values from stack config. */
export type OryHelmValuesMapper = OryUtilitySignature<
  OryIdentityStackConfig,
  OryMappedHelmValues,
  OryConfigurationError
>;

/** Public validation signature used before Ory values are emitted. */
export type OryConfigValidator = OryUtilitySignature<
  OryIdentityStackConfig,
  OryConfigValidationResult,
  OryConfigurationError
>;

/** Direct-mode stack factory. Deploy/read/delete operations come from TypeKro ResourceFactory. */
export type OryIdentityStackDirectFactory = OryDirectFactoryWithErrors<
  OryIdentityStackConfig,
  OryIdentityStackStatus
>;

/** KRO-mode stack factory. Deploy/read/delete operations come from TypeKro ResourceFactory. */
export type OryIdentityStackKroFactory = OryKroFactoryWithErrors<
  OryIdentityStackConfig,
  OryIdentityStackStatus
>;

/** Public composition surface for `oryIdentityStack`. */
export interface OryIdentityStackComposition {
  factory(mode: 'direct', options?: PublicFactoryOptions): OryIdentityStackDirectFactory;
  factory(mode: 'kro', options?: PublicFactoryOptions): OryIdentityStackKroFactory;
}

/** Direct-mode platform factory. Deploy/read/delete operations come from TypeKro ResourceFactory. */
export type OryPlatformStackDirectFactory = OryDirectFactoryWithErrors<
  OryPlatformStackConfig,
  OryPlatformStackStatus
>;

/** KRO-mode platform factory. Deploy/read/delete operations come from TypeKro ResourceFactory. */
export type OryPlatformStackKroFactory = OryKroFactoryWithErrors<
  OryPlatformStackConfig,
  OryPlatformStackStatus
>;

/** Public composition surface for `oryPlatformStack`. */
export interface OryPlatformStackComposition {
  factory(mode: 'direct', options?: PublicFactoryOptions): OryPlatformStackDirectFactory;
  factory(mode: 'kro', options?: PublicFactoryOptions): OryPlatformStackKroFactory;
}

/** Product-local contract bundle for Hydra service and Hydra Maester surfaces. */
export interface OryHydraContracts {
  serviceConfig: OryHydraConfig;
  chartValues: OryHydraChartValues;
  helmReleaseConfig: OryHydraHelmReleaseConfig;
  helmReleaseFactory: OryHydraHelmReleaseFactory;
  maesterConfig: OryHydraMaesterConfig;
  maesterChartValues: OryHydraMaesterChartValues;
  oauth2ClientConfig: OAuth2ClientConfig;
  oauth2ClientSpec: OAuth2ClientSpec;
  oauth2ClientStatus: OAuth2ClientStatus;
  oauth2ClientFactory: OryOAuth2ClientFactory;
}

/** Product-local contract bundle for Kratos service surfaces. */
export interface OryKratosContracts {
  serviceConfig: OryKratosConfig;
  chartValues: OryKratosChartValues;
  helmReleaseConfig: OryKratosHelmReleaseConfig;
  helmReleaseFactory: OryKratosHelmReleaseFactory;
}

/** Product-local contract bundle for Keto service surfaces. */
export interface OryKetoContracts {
  serviceConfig: OryKetoConfig;
  namespaceConfig: OryKetoNamespaceConfig;
  chartValues: OryKetoChartValues;
  helmReleaseConfig: OryKetoHelmReleaseConfig;
  helmReleaseFactory: OryKetoHelmReleaseFactory;
}

/** Product-local contract bundle for Oathkeeper service and Oathkeeper Maester surfaces. */
export interface OryOathkeeperContracts {
  serviceConfig: OryOathkeeperConfig;
  chartValues: OryOathkeeperChartValues;
  helmReleaseConfig: OryOathkeeperHelmReleaseConfig;
  helmReleaseFactory: OryOathkeeperHelmReleaseFactory;
  maesterConfig: OryOathkeeperMaesterConfig;
  maesterChartValues: OryOathkeeperMaesterChartValues;
  ruleConfig: OathkeeperRuleConfig;
  ruleSpec: OathkeeperRuleSpec;
  ruleStatus: OathkeeperRuleStatus;
  ruleFactory: OryOathkeeperRuleFactory;
}

/** Top-level contract index grouped by Ory subproduct. */
export interface OrySubproductContracts {
  hydra: OryHydraContracts;
  kratos: OryKratosContracts;
  keto: OryKetoContracts;
  oathkeeper: OryOathkeeperContracts;
}

/** Create/update operation for stack instances, inherited from TypeKro ResourceFactory. */
export type OryIdentityStackCreateOrUpdateOperation = OryIdentityStackDirectFactory['deploy'];

/** Read/list operation for stack instances, inherited from TypeKro ResourceFactory. */
export type OryIdentityStackReadOperation = OryIdentityStackDirectFactory['getInstances'];

/** Delete operation for stack instances, inherited from TypeKro ResourceFactory. */
export type OryIdentityStackDeleteOperation = OryIdentityStackDirectFactory['deleteInstance'];

/** Declarative create/update operation for a Hydra Maester OAuth2Client resource. */
export type OryOAuth2ClientCreateOrUpdateOperation = OryOAuth2ClientFactory;

/** Read operation contract for Hydra Maester OAuth2Client resources. */
export type OryOAuth2ClientReadOperation = (
  name: string,
  namespace?: string
) => OryOperationResult<OAuth2ClientSpec>;

/** Delete operation contract for Hydra Maester OAuth2Client resources. */
export type OryOAuth2ClientDeleteOperation = (
  name: string,
  namespace?: string
) => OryOperationResult<void>;

/** Declarative create/update operation for an Oathkeeper Maester Rule resource. */
export type OryOathkeeperRuleCreateOrUpdateOperation = OryOathkeeperRuleFactory;

/** Read operation contract for Oathkeeper Maester Rule resources. */
export type OryOathkeeperRuleReadOperation = (
  name: string,
  namespace?: string
) => OryOperationResult<OathkeeperRuleSpec>;

/** Delete operation contract for Oathkeeper Maester Rule resources. */
export type OryOathkeeperRuleDeleteOperation = (
  name: string,
  namespace?: string
) => OryOperationResult<void>;

/** ArkType schema for literal and Secret-backed value sources. */
const oryValueSourceSchema = type({ value: 'string' }).or({
  secretRef: { name: 'string', key: 'string' },
});

/** ArkType schema for high-level Ory service monitor config. */
const oryServiceMonitorSchema = type({ 'enabled?': 'boolean' });

/** ArkType schema for Kubernetes resource requirements used by high-level config. */
const oryResourceRequirementsSchema = type({
  'requests?': { 'cpu?': 'string', 'memory?': 'string' },
  'limits?': { 'cpu?': 'string', 'memory?': 'string' },
});

/** ArkType schema for maps whose values are `OryValueSource` contracts. */
const oryValueSourceMapSchema = type('Record<string, unknown>');

/** ArkType schema for dependency source configuration. */
const oryDependencySourceSchema = type({
  mode: '"external"',
  'value?': oryValueSourceSchema,
  'url?': 'string',
  'resourceName?': 'string',
}).or({
  mode: '"managed"',
  'resourceName?': 'string',
  'url?': 'string',
  'namespace?': 'string',
  'secretName?': 'string',
  'secretKey?': 'string',
});

const oryDatabaseDependencySourceSchema = type({
  dsn: oryDependencySourceSchema,
  'databaseName?': 'string',
});

const oryUrlDependencySourceSchema = type({ url: oryDependencySourceSchema });

const oryDependencySourceMapSchema = type('Record<string, unknown>');

const oryDependencySourceConfigSchema = type({
  'hydra?': {
    'database?': oryDatabaseDependencySourceSchema,
    'systemSecret?': oryDependencySourceSchema,
    'issuerUrl?': oryUrlDependencySourceSchema,
    'loginUrl?': oryUrlDependencySourceSchema,
    'consentUrl?': oryUrlDependencySourceSchema,
    'logoutUrl?': oryUrlDependencySourceSchema,
  },
  'kratos?': {
    'database?': oryDatabaseDependencySourceSchema,
    'publicBaseUrl?': oryUrlDependencySourceSchema,
    'browserBaseUrl?': oryUrlDependencySourceSchema,
    'identitySchemas?': oryDependencySourceSchema,
    'secrets?': oryDependencySourceMapSchema,
    'courier?': oryDependencySourceSchema,
  },
  'keto?': { 'database?': oryDatabaseDependencySourceSchema },
  'oathkeeper?': {
    'proxyRoute?': oryUrlDependencySourceSchema,
    'apiRoute?': oryUrlDependencySourceSchema,
    'upstream?': oryUrlDependencySourceSchema,
    'mutatorIdTokenJwks?': oryDependencySourceSchema,
  },
  'courier?': oryDependencySourceSchema,
});

/** ArkType schema for managed platform infrastructure toggles. */
const oryManagedPlatformConfigSchema = type({
  'databases?': 'boolean',
  'secrets?': 'boolean',
  'routes?': 'boolean',
  'sampleUpstream?': 'boolean',
  'courierSes?': 'boolean',
});

const stringMapSchema = type('Record<string, string>');
const yamlObjectSchema = type('object');
const yamlObjectArraySchema = type('object[]');
const imageSchema = type({
  'registry?': 'string',
  'repository?': 'string',
  'tag?': 'string',
  'pullPolicy?': '"Always" | "IfNotPresent" | "Never"',
});
const oathkeeperImageSchema = type({
  'registry?': 'string',
  'repository?': 'string',
  'tag?': 'string',
  'pullPolicy?': '"Always" | "IfNotPresent" | "Never"',
  'initContainer?': { 'repository?': 'string', 'tag?': 'string' },
});
const serviceEndpointSchema = type({
  'enabled?': 'boolean',
  'type?': '"ClusterIP" | "NodePort" | "LoadBalancer" | "ExternalName"',
  'clusterIP?': 'string',
  'loadBalancerIP?': 'string',
  'nodePort?': 'string | number',
  'port?': 'number',
  'containerPort?': 'number',
  'name?': 'string',
  'annotations?': stringMapSchema,
  'labels?': stringMapSchema,
  'metricsPath?': 'string',
  'appProtocol?': 'string',
  'externalTrafficPolicy?': 'string',
  'internalTrafficPolicy?': 'string',
  'headless?': { 'enabled?': 'boolean' },
});
const ingressEndpointSchema = type({
  'enabled?': 'boolean',
  'className?': 'string',
  'annotations?': stringMapSchema,
  'hosts?': type({ 'host?': 'string', 'paths?': type({ 'path?': 'string', 'pathType?': '"Exact" | "Prefix" | "ImplementationSpecific"' }).array() }).array(),
  'tls?': type({ 'secretName?': 'string', 'hosts?': 'string[]' }).array(),
  'defaultBackend?': yamlObjectSchema,
});
const secretValuesSchema = type({
  'enabled?': 'boolean',
  'nameOverride?': 'string',
  'enableDefaultAnnotations?': 'boolean',
  'secretAnnotations?': stringMapSchema,
  'extraAnnotations?': stringMapSchema,
  'hashSumEnabled?': 'boolean',
  'mountPath?': 'string',
  'filename?': 'string',
});
const podMetadataSchema = type({ 'labels?': stringMapSchema, 'annotations?': stringMapSchema });
const serviceAccountSchema = type({
  'create?': 'boolean',
  'annotations?': stringMapSchema,
  'name?': 'string',
  'automountServiceAccountToken?': 'boolean',
});
const resourceRequirementsValuesSchema = type({ 'limits?': yamlObjectSchema, 'requests?': yamlObjectSchema });
const probeTimingSchema = type({
  'initialDelaySeconds?': 'number',
  'periodSeconds?': 'number',
  'failureThreshold?': 'number',
  'successThreshold?': 'number',
  'timeoutSeconds?': 'number',
});
const autoscalingSchema = type({
  'enabled?': 'boolean',
  'minReplicas?': 'number',
  'maxReplicas?': 'number',
  'targetCPU?': yamlObjectSchema,
  'targetMemory?': yamlObjectSchema,
  'behavior?': yamlObjectSchema,
  'extraMetrics?': yamlObjectArraySchema,
});
const podRuntimeShape = {
  'resources?': resourceRequirementsValuesSchema,
  'podSecurityContext?': yamlObjectSchema,
  'securityContext?': yamlObjectSchema,
  'nodeSelector?': stringMapSchema,
  'tolerations?': yamlObjectArraySchema,
  'affinity?': yamlObjectSchema,
  'topologySpreadConstraints?': yamlObjectArraySchema,
  'dnsConfig?': yamlObjectSchema,
  'podMetadata?': podMetadataSchema,
  'automountServiceAccountToken?': 'boolean',
  'terminationGracePeriodSeconds?': 'number',
} as const;
const deploymentStrategySchema = type({
  'type?': 'string',
  'rollingUpdate?': { 'maxSurge?': 'string | number', 'maxUnavailable?': 'string | number' },
});
const automigrationSchema = type({
  'enabled?': 'boolean',
  'type?': '"job" | "initContainer"',
  'customCommand?': 'string[]',
  'customArgs?': 'string[]',
  'resources?': resourceRequirementsValuesSchema,
  'extraEnv?': yamlObjectArraySchema,
});
const customMigrationsSchema = type({ 'jobs?': 'object' });
const pdbSchema = type({ 'enabled?': 'boolean', 'spec?': { 'minAvailable?': 'string | number', 'maxUnavailable?': 'string | number' } });
const serviceMonitorValuesSchema = type({
  'enabled?': 'boolean',
  'scheme?': 'string',
  'scrapeInterval?': 'string',
  'scrapeTimeout?': 'string',
  'relabelings?': yamlObjectArraySchema,
  'metricRelabelings?': yamlObjectArraySchema,
  'labels?': stringMapSchema,
  'tlsConfig?': yamlObjectSchema,
  'targetLabels?': 'string[]',
});
const configMapValuesSchema = type({ 'hashSumEnabled?': 'boolean', 'annotations?': stringMapSchema });
const testValuesSchema = type({
  'labels?': stringMapSchema,
  'busybox?': { 'registry?': 'string', 'repository?': 'string', 'tag?': 'string' },
});
const jobValuesSchema = type({
  'annotations?': stringMapSchema,
  'labels?': stringMapSchema,
  'extraContainers?': 'string | object[]',
  'extraEnv?': yamlObjectArraySchema,
  'podMetadata?': podMetadataSchema,
  'extraInitContainers?': 'string',
  'nodeSelector?': stringMapSchema,
  'resources?': resourceRequirementsValuesSchema,
  'tolerations?': yamlObjectArraySchema,
  'lifecycle?': 'string | object',
  'automountServiceAccountToken?': 'boolean',
  'shareProcessNamespace?': 'boolean',
  'serviceAccount?': serviceAccountSchema,
  'spec?': { 'backoffLimit?': 'number' },
});
const watcherValuesSchema = type({
  'enabled?': 'boolean',
  'image?': 'string',
  'mountFile?': 'string',
  'podMetadata?': podMetadataSchema,
  'watchLabelKey?': 'string',
  'revisionHistoryLimit?': 'number',
  'automountServiceAccountToken?': 'boolean',
  'podSecurityContext?': yamlObjectSchema,
  'securityContext?': yamlObjectSchema,
  'resources?': resourceRequirementsValuesSchema,
});

/** Top-level ArkType schemas for pinned chart values. */
const oryHydraChartValuesSchema = type({
  'global?': { 'imageRegistry?': 'string', 'podMetadata?': podMetadataSchema },
  'replicaCount?': 'number',
  'image?': imageSchema,
  'imagePullSecrets?': yamlObjectArraySchema,
  'nameOverride?': 'string',
  'fullnameOverride?': 'string',
  'priorityClassName?': 'string',
  'service?': { 'public?': serviceEndpointSchema, 'admin?': serviceEndpointSchema },
  'secret?': secretValuesSchema,
  'ingress?': { 'public?': ingressEndpointSchema, 'admin?': ingressEndpointSchema },
  'hydra?': {
    'command?': 'string[]',
    'customArgs?': 'string[]',
    'config?': yamlObjectSchema,
    'automigration?': automigrationSchema,
    'customMigrations?': customMigrationsSchema,
    'dev?': 'boolean',
  },
  'deployment?': type({ ...podRuntimeShape, 'strategy?': deploymentStrategySchema, 'initContainerSecurityContext?': yamlObjectSchema, 'lifecycle?': yamlObjectSchema, 'labels?': stringMapSchema, 'annotations?': stringMapSchema, 'extraEnv?': yamlObjectArraySchema, 'automigration?': { 'extraEnv?': yamlObjectArraySchema }, 'serviceAccount?': serviceAccountSchema, 'extraVolumes?': yamlObjectArraySchema, 'extraVolumeMounts?': yamlObjectArraySchema, 'autoscaling?': autoscalingSchema, 'readinessProbe?': probeTimingSchema, 'startupProbe?': probeTimingSchema, 'extraInitContainers?': 'string', 'extraContainers?': 'string', 'customLivenessProbe?': yamlObjectSchema, 'customReadinessProbe?': yamlObjectSchema, 'customStartupProbe?': yamlObjectSchema, 'revisionHistoryLimit?': 'number' }),
  'job?': jobValuesSchema,
  'affinity?': yamlObjectSchema,
  'maester?': { 'enabled?': 'boolean' },
  'hydra-maester?': { 'adminService?': { 'name?': 'string', 'port?': 'number' } },
  'watcher?': watcherValuesSchema,
  'janitor?': { 'enabled?': 'boolean', 'cleanupGrants?': 'boolean', 'cleanupRequests?': 'boolean', 'cleanupTokens?': 'boolean', 'batchSize?': 'number', 'limit?': 'number' },
  'cronjob?': { 'janitor?': jobValuesSchema },
  'pdb?': pdbSchema,
  'serviceMonitor?': serviceMonitorValuesSchema,
  'configmap?': configMapValuesSchema,
  'test?': testValuesSchema,
});
const oryKratosChartValuesSchema = type({
  'global?': { 'imageRegistry?': 'string', 'podMetadata?': podMetadataSchema },
  'replicaCount?': 'number',
  'strategy?': deploymentStrategySchema,
  'image?': imageSchema,
  'imagePullSecrets?': yamlObjectArraySchema,
  'nameOverride?': 'string',
  'fullnameOverride?': 'string',
  'service?': { 'admin?': serviceEndpointSchema, 'public?': serviceEndpointSchema, 'courier?': serviceEndpointSchema },
  'secret?': secretValuesSchema,
  'ingress?': { 'admin?': ingressEndpointSchema, 'public?': ingressEndpointSchema },
  'kratos?': { 'development?': 'boolean', 'automigration?': automigrationSchema, 'identitySchemas?': 'Record<string, string>', 'emailTemplates?': yamlObjectSchema, 'config?': yamlObjectSchema, 'customMigrations?': customMigrationsSchema },
  'deployment?': type({ ...podRuntimeShape, 'lifecycle?': yamlObjectSchema, 'readinessProbe?': probeTimingSchema, 'startupProbe?': probeTimingSchema, 'customLivenessProbe?': yamlObjectSchema, 'customReadinessProbe?': yamlObjectSchema, 'customStartupProbe?': yamlObjectSchema, 'extraArgs?': 'string[]', 'extraEnv?': yamlObjectArraySchema, 'extraVolumes?': yamlObjectArraySchema, 'extraVolumeMounts?': yamlObjectArraySchema, 'extraInitContainers?': 'string', 'extraContainers?': 'string', 'priorityClassName?': 'string', 'labels?': stringMapSchema, 'annotations?': stringMapSchema, 'environmentSecretsName?': 'string', 'serviceAccount?': serviceAccountSchema, 'automigration?': { 'extraEnv?': yamlObjectArraySchema }, 'revisionHistoryLimit?': 'number' }),
  'statefulSet?': type({ ...podRuntimeShape, 'resources?': resourceRequirementsValuesSchema, 'extraArgs?': 'string[]', 'extraEnv?': yamlObjectArraySchema, 'extraVolumes?': yamlObjectArraySchema, 'extraVolumeMounts?': yamlObjectArraySchema, 'extraInitContainers?': 'string', 'extraContainers?': 'string', 'annotations?': stringMapSchema, 'environmentSecretsName?': 'string', 'labels?': stringMapSchema, 'priorityClassName?': 'string', 'log?': { 'format?': 'string', 'level?': 'string' }, 'revisionHistoryLimit?': 'number' }),
  'securityContext?': yamlObjectSchema,
  'autoscaling?': autoscalingSchema,
  'job?': jobValuesSchema,
  'courier?': { 'enabled?': 'boolean' },
  'watcher?': watcherValuesSchema,
  'cleanup?': { 'enabled?': 'boolean', 'batchSize?': 'number', 'sleepTables?': 'string', 'keepLast?': 'string' },
  'cronjob?': { 'cleanup?': jobValuesSchema },
  'pdb?': pdbSchema,
  'serviceMonitor?': serviceMonitorValuesSchema,
  'configmap?': configMapValuesSchema,
  'test?': testValuesSchema,
});
const oryKetoChartValuesSchema = type({
  'global?': { 'imageRegistry?': 'string', 'podMetadata?': podMetadataSchema },
  'replicaCount?': 'number',
  'image?': imageSchema,
  'imagePullSecrets?': yamlObjectArraySchema,
  'nameOverride?': 'string',
  'fullnameOverride?': 'string',
  'priorityClassName?': 'string',
  'serviceAccount?': serviceAccountSchema,
  'podSecurityContext?': yamlObjectSchema,
  'securityContext?': yamlObjectSchema,
  'job?': jobValuesSchema,
  'ingress?': { 'read?': ingressEndpointSchema, 'write?': ingressEndpointSchema },
  'service?': { 'read?': serviceEndpointSchema, 'write?': serviceEndpointSchema, 'metrics?': serviceEndpointSchema },
  'extraServices?': yamlObjectSchema,
  'secret?': secretValuesSchema,
  'keto?': { 'command?': 'string[]', 'customArgs?': 'string[]', 'automigration?': automigrationSchema, 'config?': yamlObjectSchema, 'customMigrations?': customMigrationsSchema },
  'deployment?': type({ ...podRuntimeShape, 'strategy?': deploymentStrategySchema, 'minReadySeconds?': 'number', 'podAnnotations?': stringMapSchema, 'lifecycle?': yamlObjectSchema, 'readinessProbe?': probeTimingSchema, 'startupProbe?': probeTimingSchema, 'customLivenessProbe?': yamlObjectSchema, 'customReadinessProbe?': yamlObjectSchema, 'customStartupProbe?': yamlObjectSchema, 'annotations?': stringMapSchema, 'autoscaling?': autoscalingSchema, 'extraContainers?': 'string', 'extraEnv?': yamlObjectArraySchema, 'extraVolumes?': yamlObjectArraySchema, 'extraVolumeMounts?': yamlObjectArraySchema, 'extraInitContainers?': 'string | object', 'extraLabels?': stringMapSchema, 'extraPorts?': yamlObjectArraySchema, 'automigration?': { 'extraEnv?': yamlObjectArraySchema }, 'revisionHistoryLimit?': 'number' }),
  'watcher?': watcherValuesSchema,
  'pdb?': pdbSchema,
  'serviceMonitor?': serviceMonitorValuesSchema,
  'configmap?': configMapValuesSchema,
  'test?': testValuesSchema,
});
const oryOathkeeperChartValuesSchema = type({
  'global?': { 'imageRegistry?': 'string', 'ory?': yamlObjectSchema, 'podMetadata?': podMetadataSchema },
  'replicaCount?': 'number',
  'revisionHistoryLimit?': 'number',
  'image?': oathkeeperImageSchema,
  'sidecar?': { 'image?': { 'repository?': 'string', 'tag?': 'string' }, 'envs?': yamlObjectSchema },
  'priorityClassName?': 'string',
  'imagePullSecrets?': yamlObjectArraySchema,
  'nameOverride?': 'string',
  'fullnameOverride?': 'string',
  'securityContext?': yamlObjectSchema,
  'podSecurityContext?': yamlObjectSchema,
  'demo?': 'boolean',
  'service?': { 'proxy?': serviceEndpointSchema, 'api?': serviceEndpointSchema, 'metrics?': serviceEndpointSchema },
  'ingress?': { 'proxy?': ingressEndpointSchema, 'api?': ingressEndpointSchema },
  'oathkeeper?': { 'helmTemplatedConfigEnabled?': 'boolean', 'configFileOverride?': { 'enabled?': 'boolean', 'nameOverride?': 'string' }, 'config?': yamlObjectSchema, 'mutatorIdTokenJWKs?': 'string', 'accessRulesOverride?': { 'nameOverride?': 'string' }, 'accessRules?': 'string', 'managedAccessRules?': 'boolean' },
  'secret?': secretValuesSchema,
  'deployment?': type({ ...podRuntimeShape, 'strategy?': deploymentStrategySchema, 'lifecycle?': yamlObjectSchema, 'readinessProbe?': probeTimingSchema, 'startupProbe?': probeTimingSchema, 'customLivenessProbe?': yamlObjectSchema, 'customReadinessProbe?': yamlObjectSchema, 'customStartupProbe?': yamlObjectSchema, 'serviceAccount?': serviceAccountSchema, 'extraEnv?': yamlObjectArraySchema, 'extraArgs?': 'string[]', 'extraVolumes?': yamlObjectArraySchema, 'extraVolumeMounts?': yamlObjectArraySchema, 'extraContainers?': 'string', 'extraInitContainers?': 'string', 'labels?': stringMapSchema, 'annotations?': stringMapSchema, 'autoscaling?': autoscalingSchema }),
  'affinity?': yamlObjectSchema,
  'maester?': { 'enabled?': 'boolean' },
  'pdb?': pdbSchema,
  'serviceMonitor?': serviceMonitorValuesSchema,
  'configmap?': configMapValuesSchema,
  'test?': testValuesSchema,
});
const oryHydraMaesterChartValuesSchema = type({
  'global?': { 'imageRegistry?': 'string', 'podMetadata?': podMetadataSchema },
  'replicaCount?': 'number',
  'revisionHistoryLimit?': 'number',
  'enabledNamespaces?': 'string[]',
  'singleNamespaceMode?': 'boolean',
  'image?': imageSchema,
  'imagePullSecrets?': yamlObjectArraySchema,
  'priorityClassName?': 'string',
  'adminService?': { 'name?': 'string', 'port?': 'number', 'endpoint?': 'string', 'scheme?': 'string', 'tlsTrustStorePath?': 'string', 'insecureSkipVerify?': 'boolean' },
  'forwardedProto?': 'string',
  'deployment?': type({ ...podRuntimeShape, 'args?': { 'syncPeriod?': 'string' }, 'extraEnv?': yamlObjectArraySchema, 'extraVolumes?': yamlObjectArraySchema, 'extraVolumeMounts?': yamlObjectArraySchema, 'serviceAccount?': serviceAccountSchema }),
  'affinity?': yamlObjectSchema,
  'pdb?': pdbSchema,
  'service?': { 'metrics?': serviceEndpointSchema },
  'serviceMonitor?': serviceMonitorValuesSchema,
});
const oryOathkeeperMaesterChartValuesSchema = type({
  'global?': { 'imageRegistry?': 'string', 'ory?': yamlObjectSchema, 'podMetadata?': podMetadataSchema },
  'replicaCount?': 'number',
  'revisionHistoryLimit?': 'number',
  'singleNamespaceMode?': 'boolean',
  'rulesConfigmapNamespace?': 'string',
  'rulesFileName?': 'string',
  'image?': imageSchema,
  'imagePullSecrets?': yamlObjectArraySchema,
  'securityContext?': yamlObjectSchema,
  'podSecurityContext?': yamlObjectSchema,
  'deployment?': { 'envs?': yamlObjectSchema, 'extraLabels?': stringMapSchema, 'annotations?': stringMapSchema },
  'affinity?': yamlObjectSchema,
  'pdb?': pdbSchema,
});

/** ArkType schema for the pinned Hydra Maester OAuth2Client factory config. */
const oauth2ClientConfigSchema = type({
  'id?': 'string',
  name: 'string',
  'namespace?': 'string',
  spec: {
    'accessTokenStrategy?': '"jwt" | "opaque"',
    'allowedCorsOrigins?': 'string[]',
    'audience?': 'string[]',
    'backChannelLogoutSessionRequired?': 'boolean',
    'backChannelLogoutURI?': 'string',
    'clientName?': 'string',
    'clientSecretExpiresAt?': 'number',
    'clientUri?': 'string',
    'contacts?': 'string[]',
    'deletionPolicy?': '"delete" | "orphan"',
    'frontChannelLogoutSessionRequired?': 'boolean',
    'frontChannelLogoutURI?': 'string',
    grantTypes: '("client_credentials" | "authorization_code" | "implicit" | "refresh_token")[]',
    'hydraAdmin?': {
      'endpoint?': 'string',
      'forwardedProto?': 'string',
      'port?': 'number',
      'url?': 'string',
    },
    'jwksUri?': 'string',
    'logoUri?': 'string',
    'metadata?': 'object',
    'policyUri?': 'string',
    'postLogoutRedirectUris?': 'string[]',
    'redirectUris?': 'string[]',
    'requestObjectSigningAlg?': 'string',
    'requestUris?': 'string[]',
    'responseTypes?':
      '("id_token" | "code" | "token" | "code token" | "code id_token" | "id_token token" | "code id_token token")[]',
    'scope?': 'string',
    'scopeArray?': 'string[]',
    secretName: 'string',
    'sectorIdentifierUri?': 'string',
    'skipConsent?': 'boolean',
    'skipLogoutConsent?': 'boolean',
    'subjectType?': '"public" | "pairwise"',
    'tokenEndpointAuthMethod?':
      '"client_secret_basic" | "client_secret_post" | "private_key_jwt" | "none"',
    'tokenEndpointAuthSigningAlg?': 'string',
    'tokenLifespans?': {
      'authorization_code_grant_access_token_lifespan?': 'string',
      'authorization_code_grant_id_token_lifespan?': 'string',
      'authorization_code_grant_refresh_token_lifespan?': 'string',
      'client_credentials_grant_access_token_lifespan?': 'string',
      'implicit_grant_access_token_lifespan?': 'string',
      'implicit_grant_id_token_lifespan?': 'string',
      'jwt_bearer_grant_access_token_lifespan?': 'string',
      'refresh_token_grant_access_token_lifespan?': 'string',
      'refresh_token_grant_id_token_lifespan?': 'string',
      'refresh_token_grant_refresh_token_lifespan?': 'string',
    },
    'tosUri?': 'string',
    'userinfoSignedResponseAlg?': 'string',
  },
});

/** ArkType schema for the pinned Oathkeeper Maester Rule factory config. */
const oathkeeperRuleConfigSchema = type({
  'id?': 'string',
  name: 'string',
  'namespace?': 'string',
  spec: {
    'authenticators?': type({ handler: 'string', 'config?': 'object' }).array(),
    'authorizer?': { handler: 'string', 'config?': 'object' },
    'configMapName?': 'string',
    'errors?': type({ handler: 'string', 'config?': 'object' }).array(),
    match: { methods: 'string[]', url: 'string' },
    'mutators?': type({ handler: 'string', 'config?': 'object' }).array(),
    'upstream?': { 'preserveHost?': 'boolean', 'stripPath?': 'string', url: 'string' },
  },
});

/** ArkType schema for `OryIdentityStackConfig`. */
export const OryIdentityStackConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'dependencySources?': oryDependencySourceConfigSchema,
  'shared?': 'boolean',
  'global?': {
    'imageRegistry?': 'string',
    'imagePullSecrets?': 'string[]',
  },
  'hydra?': {
    'dsn?': oryValueSourceSchema,
    'issuerUrl?': 'string',
    'loginUrl?': 'string',
    'consentUrl?': 'string',
    'logoutUrl?': 'string',
    'systemSecret?': oryValueSourceSchema,
    'replicaCount?': 'number',
    'resources?': oryResourceRequirementsSchema,
    'serviceMonitor?': oryServiceMonitorSchema,
    'values?': oryHydraChartValuesSchema,
    'customValues?': 'object',
  },
  'kratos?': {
    'dsn?': oryValueSourceSchema,
    'publicBaseUrl?': 'string',
    'browserBaseUrl?': 'string',
    'identitySchemas?': 'object',
    'courier?': 'object',
    'secrets?': oryValueSourceMapSchema,
    'replicaCount?': 'number',
    'resources?': oryResourceRequirementsSchema,
    'serviceMonitor?': oryServiceMonitorSchema,
    'values?': oryKratosChartValuesSchema,
    'customValues?': 'object',
  },
  'keto?': {
    'dsn?': oryValueSourceSchema,
    'namespaces?': type({ id: 'number', name: 'string' }).array(),
    'replicaCount?': 'number',
    'resources?': oryResourceRequirementsSchema,
    'serviceMonitor?': oryServiceMonitorSchema,
    'values?': oryKetoChartValuesSchema,
    'customValues?': 'object',
  },
  'oathkeeper?': {
    'managedAccessRules?': 'boolean',
    'mutatorIdTokenJwks?': oryValueSourceSchema,
    'replicaCount?': 'number',
    'resources?': oryResourceRequirementsSchema,
    'serviceMonitor?': oryServiceMonitorSchema,
    'values?': oryOathkeeperChartValuesSchema,
    'customValues?': 'object',
  },
  'maester?': {
    'hydra?': {
      'enabled?': 'boolean',
      'singleNamespaceMode?': 'boolean',
      'enabledNamespaces?': 'string[]',
      'serviceMonitor?': oryServiceMonitorSchema,
    },
    'oathkeeper?': {
      'enabled?': 'boolean',
      'singleNamespaceMode?': 'boolean',
      'rulesConfigmapNamespace?': 'string',
      'rulesFileName?': 'string',
    },
    'hydraValues?': oryHydraMaesterChartValuesSchema,
    'oathkeeperValues?': oryOathkeeperMaesterChartValuesSchema,
  },
  'customValues?': {
    'hydra?': 'object',
    'kratos?': 'object',
    'keto?': 'object',
    'oathkeeper?': 'object',
  },
  'resources?': {
    'oauth2Clients?': oauth2ClientConfigSchema.array(),
    'oathkeeperRules?': oathkeeperRuleConfigSchema.array(),
  },
});

/** ArkType schema for `OryPlatformStackConfig`. */
export const OryPlatformStackConfigSchema = OryIdentityStackConfigSchema.and({
  'managed?': oryManagedPlatformConfigSchema,
});

/** ArkType schema for `OryIdentityStackStatus`. */
const oryEndpointStatusSchema = type({
  url: 'string',
  scheme: 'string',
  host: 'string',
  'clusterIP?': 'string',
  'port?': 'number',
  'serviceName?': 'string',
  'namespace?': 'string',
});

const oryEndpointSetStatusSchema = type({
  hydraPublic: oryEndpointStatusSchema,
  hydraAdmin: oryEndpointStatusSchema,
  kratosPublic: oryEndpointStatusSchema,
  kratosAdmin: oryEndpointStatusSchema,
  ketoRead: oryEndpointStatusSchema,
  ketoWrite: oryEndpointStatusSchema,
  oathkeeperProxy: oryEndpointStatusSchema,
  oathkeeperApi: oryEndpointStatusSchema,
});

export const OryIdentityStackStatusSchema = type({
  ready: 'boolean',
  phase: '"Ready" | "Installing"',
  components: {
    hydra: 'boolean',
    kratos: 'boolean',
    keto: 'boolean',
    oathkeeper: 'boolean',
  },
  maester: {
    hydra: 'boolean',
    oathkeeper: 'boolean',
  },
  endpoints: oryEndpointSetStatusSchema,
  'version?': 'string',
});

/** ArkType schema for `OryPlatformStackStatus`. */
export const OryPlatformStackStatusSchema = type({
  ready: 'boolean',
  phase: '"Ready" | "Installing"',
  infrastructure: {
    databases: 'boolean',
    secrets: 'boolean',
    routes: 'boolean',
    upstream: 'boolean',
    courier: 'boolean',
  },
  dependencies: {
    hydraDatabase: '"external" | "managed"',
    kratosDatabase: '"external" | "managed"',
    ketoDatabase: '"external" | "managed"',
    secrets: '"external" | "managed"',
    routes: '"external" | "managed"',
    upstream: '"external" | "managed"',
    courier: '"external" | "managed"',
  },
  ory: OryIdentityStackStatusSchema,
  endpoints: oryEndpointSetStatusSchema,
});
