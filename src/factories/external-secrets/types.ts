/**
 * External Secrets Operator Types
 *
 * Typed shapes for the `external-secrets.io/v1` `SecretStore`, `ClusterSecretStore` and
 * `ExternalSecret` resources, narrowed to AWS Secrets Manager authenticated through EKS Pod
 * Identity. With Pod Identity the store carries no `auth` section: the controller uses the
 * credentials EKS injects for its own service account. ESO documents that `serviceAccountRef`
 * (JWT auth) cannot be combined with Pod Identity, and static keys are deliberately not offered.
 *
 * The IAM role and its Pod Identity association are created outside TypeKro.
 */

import { type } from 'arktype';
import type { TypeKroChartValue } from '../../core/types/common.js';
import { specConstraint } from '../../core/validation/spec-constraint.js';
import type { HelmReleaseLifecycleOptions } from '../helm/types.js';

/** A status condition as ESO reports it. */
export interface ExternalSecretsCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

// =============================================================================
// SECRET STORES
// =============================================================================

/** The AWS provider, Pod Identity only: there is no `auth` field. */
export interface AwsPodIdentityProvider {
  service: 'SecretsManager' | 'ParameterStore';
  region: string;
  /** Optional role to assume (`sts:AssumeRole`) after the Pod Identity credentials. */
  role?: string;
  /** Prefix added to every remote key. */
  prefix?: string;
}

export interface SecretStoreSpec {
  provider: { aws: AwsPodIdentityProvider };
  /** How often the store re-validates, in seconds. */
  refreshInterval?: number;
  /**
   * ClusterSecretStore only: which namespaces may use the store. `clusterSecretStore` requires at
   * least one condition, each naming namespaces, a non-empty selector or name patterns.
   */
  conditions?: Array<{
    namespaces?: string[];
    namespaceSelector?: {
      matchLabels?: Record<string, string>;
      matchExpressions?: Array<{ key: string; operator: string; values?: string[] }>;
    };
    namespaceRegexes?: string[];
  }>;
}

export interface SecretStoreStatus {
  conditions?: ExternalSecretsCondition[];
  capabilities?: 'ReadOnly' | 'WriteOnly' | 'ReadWrite';
}

export interface SecretStoreConfig {
  name: string;
  /** Namespaced `SecretStore` only. */
  namespace?: string;
  spec: SecretStoreSpec;
  id?: string;
}

// =============================================================================
// EXTERNAL SECRET
// =============================================================================

export interface ExternalSecretSpec {
  secretStoreRef: { name: string; kind?: 'SecretStore' | 'ClusterSecretStore' };
  /** For example `'1h'`; `'0'` disables periodic refresh. */
  refreshInterval?: string;
  target?: {
    name?: string;
    creationPolicy?: 'Owner' | 'Orphan' | 'Merge' | 'None';
    deletionPolicy?: 'Delete' | 'Merge' | 'Retain';
    immutable?: boolean;
    template?: {
      type?: string;
      metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
      data?: Record<string, string>;
    };
  };
  data?: Array<{
    secretKey: string;
    remoteRef: { key: string; property?: string; version?: string };
  }>;
  dataFrom?: Array<{ extract?: { key: string; property?: string; version?: string } }>;
}

export interface ExternalSecretStatus {
  conditions?: ExternalSecretsCondition[];
  refreshTime?: string;
  syncedResourceVersion?: string;
  binding?: { name?: string };
}

export interface ExternalSecretConfig {
  name: string;
  namespace?: string;
  spec: ExternalSecretSpec;
  id?: string;
}

// =============================================================================
// HELM
// =============================================================================

export interface ExternalSecretsHelmRepositoryConfig {
  name?: string;
  namespace?: string;
  url?: string;
  interval?: string;
  id?: string;
}

export interface ExternalSecretsHelmReleaseConfig extends HelmReleaseLifecycleOptions {
  name: string;
  namespace?: string;
  targetNamespace?: string;
  version?: string;
  repositoryName?: string;
  repositoryNamespace?: string;
  createNamespace?: boolean;
  values?: TypeKroChartValue<Record<string, unknown>>;
  id?: string;
}

// =============================================================================
// COMPOSITIONS
// =============================================================================

/** A DNS-1123 label: a namespace name. */
const namespaceName = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 63');

/** Inputs both AWS compositions share: the controller release and the store's provider. */
const externalSecretsAwsControllerFields = {
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  region: 'string',
  serviceAccountName: 'string',
  /** Name of the store. Defaults to `name`. */
  'storeName?': 'string',
  /**
   * Extra chart values. They can't override `installCRDs`, `serviceAccount.create` or
   * `serviceAccount.name`: a conflicting value is refused, and the composition's own values are
   * applied last.
   */
  'values?': 'Record<string, unknown>',
} as const;

/**
 * Inputs of `externalSecretsAws`: the controller plus one namespaced `SecretStore` for AWS
 * Secrets Manager in `storeNamespace`. Only ExternalSecrets in that namespace can use the store.
 * `serviceAccountName` is the controller's service account, which an EKS Pod Identity
 * association (created outside TypeKro) binds to an IAM role.
 */
export const ExternalSecretsAwsConfigSchema = type({
  ...externalSecretsAwsControllerFields,
  storeNamespace: namespaceName,
});

export type ExternalSecretsAwsConfig = typeof ExternalSecretsAwsConfigSchema.infer;

/**
 * Namespaces allowed to use a cluster store, by name. At least one is required, so a cluster
 * store is never open to every namespace. The pattern and item count are on the instance
 * schema, so admission refuses an empty list in KRO mode.
 */
export const CLUSTER_STORE_ALLOWED_NAMESPACES = specConstraint({
  path: 'allowedNamespaces',
  type: namespaceName.array().atLeastLength(1),
  code: 'EXTERNAL_SECRETS_CLUSTER_STORE_UNCONDITIONED',
  message: (value) =>
    `allowedNamespaces must list at least one namespace name; got ${JSON.stringify(value)}.`,
});

/**
 * Inputs of `externalSecretsAwsClusterStore`, the explicit opt-in to cluster-wide access: the
 * controller plus one `ClusterSecretStore` that only the namespaces in `allowedNamespaces` can use.
 */
export const ExternalSecretsAwsClusterStoreConfigSchema = type({
  ...externalSecretsAwsControllerFields,
  allowedNamespaces: CLUSTER_STORE_ALLOWED_NAMESPACES.type,
});

export type ExternalSecretsAwsClusterStoreConfig =
  typeof ExternalSecretsAwsClusterStoreConfigSchema.infer;

export const ExternalSecretsAwsStatusSchema = type({
  ready: 'boolean',
  controllerReady: 'boolean',
  storeReady: 'boolean',
});

export type ExternalSecretsAwsStatus = typeof ExternalSecretsAwsStatusSchema.infer;
