/** Hydra Maester chart and OAuth2Client CRD contracts for Ory k8s chart version 0.62.0. */

import type {
  OryGlobalValues,
  OryImageValues,
  OryObjectMap,
  OryPdbValues,
  OryPodRuntimeValues,
  OryResourceRequirementsValues,
  OryServiceEndpointValues,
  OryServiceMonitorValues,
  OryStringMap,
} from './chart-values.js';

/** Kubernetes condition status values used by Ory Maester CRDs. */
export type OryConditionStatus = 'True' | 'False' | 'Unknown';

/** OAuth 2.0 access token strategies accepted by Hydra Maester. */
export type OAuth2AccessTokenStrategy = 'jwt' | 'opaque';

/** OAuth 2.0 grant types accepted by the pinned Hydra Maester CRD. */
export type OAuth2GrantType =
  | 'client_credentials'
  | 'authorization_code'
  | 'implicit'
  | 'refresh_token';

/** OAuth 2.0 response types accepted by the pinned Hydra Maester CRD. */
export type OAuth2ResponseType =
  | 'id_token'
  | 'code'
  | 'token'
  | 'code token'
  | 'code id_token'
  | 'id_token token'
  | 'code id_token token';

/** OAuth 2.0 token endpoint authentication methods accepted by Hydra Maester. */
export type OAuth2TokenEndpointAuthMethod =
  | 'client_secret_basic'
  | 'client_secret_post'
  | 'private_key_jwt'
  | 'none';

/** OAuth 2.0 subject types accepted by Hydra Maester. */
export type OAuth2SubjectType = 'public' | 'pairwise';

/** Deletion behavior for Hydra Maester-managed clients. */
export type OAuth2ClientDeletionPolicy = 'delete' | 'orphan';

/** Optional per-resource Hydra Admin override in the OAuth2Client CRD. */
export interface OAuth2ClientHydraAdmin {
  /** Hydra client endpoint override, e.g. `/admin/clients`. */
  endpoint?: string;
  /** Forwarded proto override. `off` disables forwarded proto behavior. */
  forwardedProto?: string;
  /** Hydra admin port override. */
  port?: number;
  /** Hydra admin URL override. */
  url?: string;
}

/** Token lifespan overrides accepted by the pinned Hydra Maester CRD. */
export interface OAuth2ClientTokenLifespans {
  authorization_code_grant_access_token_lifespan?: string;
  authorization_code_grant_id_token_lifespan?: string;
  authorization_code_grant_refresh_token_lifespan?: string;
  client_credentials_grant_access_token_lifespan?: string;
  implicit_grant_access_token_lifespan?: string;
  implicit_grant_id_token_lifespan?: string;
  jwt_bearer_grant_access_token_lifespan?: string;
  refresh_token_grant_access_token_lifespan?: string;
  refresh_token_grant_id_token_lifespan?: string;
  refresh_token_grant_refresh_token_lifespan?: string;
}

/** Spec for `hydra.ory.sh/v1alpha1`, kind `OAuth2Client`. */
export interface OAuth2ClientSpec {
  [key: string]: unknown;
  accessTokenStrategy?: OAuth2AccessTokenStrategy;
  allowedCorsOrigins?: string[];
  audience?: string[];
  backChannelLogoutSessionRequired?: boolean;
  backChannelLogoutURI?: string;
  clientName?: string;
  clientSecretExpiresAt?: number;
  clientUri?: string;
  contacts?: string[];
  deletionPolicy?: OAuth2ClientDeletionPolicy;
  frontChannelLogoutSessionRequired?: boolean;
  frontChannelLogoutURI?: string;
  grantTypes: OAuth2GrantType[];
  hydraAdmin?: OAuth2ClientHydraAdmin;
  jwksUri?: string;
  logoUri?: string;
  metadata?: Record<string, unknown>;
  policyUri?: string;
  postLogoutRedirectUris?: string[];
  redirectUris?: string[];
  requestObjectSigningAlg?: string;
  requestUris?: string[];
  responseTypes?: OAuth2ResponseType[];
  scope?: string;
  scopeArray?: string[];
  secretName: string;
  sectorIdentifierUri?: string;
  skipConsent?: boolean;
  skipLogoutConsent?: boolean;
  subjectType?: OAuth2SubjectType;
  tokenEndpointAuthMethod?: OAuth2TokenEndpointAuthMethod;
  tokenEndpointAuthSigningAlg?: string;
  tokenLifespans?: OAuth2ClientTokenLifespans;
  tosUri?: string;
  userinfoSignedResponseAlg?: string;
}

/** Status condition for Hydra Maester-managed OAuth2Client resources. */
export interface OAuth2ClientCondition {
  status: OryConditionStatus;
  type: string;
}

/** Structured reconciliation error reported by Hydra Maester. */
export interface OAuth2ClientReconciliationError {
  description?: string;
  statusCode?: string;
}

/** Status for `hydra.ory.sh/v1alpha1`, kind `OAuth2Client`. */
export interface OAuth2ClientStatus {
  [key: string]: unknown;
  conditions?: OAuth2ClientCondition[];
  observedGeneration?: number;
  reconciliationError?: OAuth2ClientReconciliationError;
}

/** Resource config accepted by the TypeKro `oauth2Client` factory. */
export interface OAuth2ClientConfig {
  /** TypeKro composition resource id. */
  id?: string;
  /** Kubernetes resource name. */
  name: string;
  /** Kubernetes namespace. */
  namespace?: string;
  /** Complete pinned upstream CRD spec. */
  spec: OAuth2ClientSpec;
}

/** Hydra Maester chart admin service values. */
export interface OryHydraMaesterAdminServiceValues {
  name?: string;
  port?: number;
  endpoint?: string;
  scheme?: 'http' | 'https';
  tlsTrustStorePath?: string;
  insecureSkipVerify?: boolean;
}

/** Hydra Maester deployment values. */
export interface OryHydraMaesterDeploymentValues extends OryPodRuntimeValues {
  resources?: OryResourceRequirementsValues;
  extraEnv?: OryObjectMap[];
  extraVolumes?: OryObjectMap[];
  extraVolumeMounts?: OryObjectMap[];
  extraAnnotations?: OryStringMap;
  extraLabels?: OryStringMap;
  args?: { syncPeriod?: string };
  serviceAccount?: { annotations?: OryStringMap };
}

/** Values for the Ory Hydra Maester chart. */
export interface OryHydraMaesterChartValues {
  global?: OryGlobalValues;
  replicaCount?: number;
  revisionHistoryLimit?: number;
  enabledNamespaces?: string[];
  singleNamespaceMode?: boolean;
  image?: OryImageValues;
  imagePullSecrets?: OryObjectMap[];
  priorityClassName?: string;
  adminService?: OryHydraMaesterAdminServiceValues;
  forwardedProto?: string;
  deployment?: OryHydraMaesterDeploymentValues;
  affinity?: OryObjectMap;
  pdb?: OryPdbValues;
  service?: { metrics?: OryServiceEndpointValues };
  serviceMonitor?: OryServiceMonitorValues;
}
