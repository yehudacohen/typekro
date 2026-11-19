// External Secrets Operator constants: chart, repository and API identity.

/** API version of `ExternalSecret`, `SecretStore` and `ClusterSecretStore` served by v2.x. */
export const EXTERNAL_SECRETS_API_VERSION = 'external-secrets.io/v1';

/** Pinned chart version: External Secrets Operator v2.15.0, released 2026-11-10. */
export const DEFAULT_EXTERNAL_SECRETS_CHART_VERSION = '2.15.0';
export const EXTERNAL_SECRETS_CHART_NAME = 'external-secrets';
export const DEFAULT_EXTERNAL_SECRETS_REPOSITORY_URL = 'https://charts.external-secrets.io';
export const DEFAULT_EXTERNAL_SECRETS_REPOSITORY_NAME = 'external-secrets-repo';
export const DEFAULT_EXTERNAL_SECRETS_NAMESPACE = 'external-secrets';

/** The controller's service account; an EKS Pod Identity association targets this name. */
export const DEFAULT_EXTERNAL_SECRETS_SERVICE_ACCOUNT = 'external-secrets';
