import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import type { Enhanced } from '../../../core/types/index.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import {
  DEFAULT_EXTERNAL_SECRETS_CHART_VERSION,
  DEFAULT_EXTERNAL_SECRETS_NAMESPACE,
  DEFAULT_EXTERNAL_SECRETS_REPOSITORY_NAME,
} from '../constants.js';
import { externalSecretsHelmRelease, externalSecretsHelmRepository } from '../resources/helm.js';
import { clusterSecretStore, secretStore } from '../resources/secret-store.js';
import { CLUSTER_SECRET_STORE_NAMESPACES } from '../resources/store-conditions.js';
import {
  type ExternalSecretsAwsClusterStoreConfig,
  ExternalSecretsAwsClusterStoreConfigSchema,
  type ExternalSecretsAwsConfig,
  ExternalSecretsAwsConfigSchema,
  type ExternalSecretsAwsStatus,
  ExternalSecretsAwsStatusSchema,
  type SecretStoreSpec,
  type SecretStoreStatus,
} from '../types.js';
import { mapExternalSecretsConfigToHelmValues } from '../utils/helm-values-mapper.js';

type ControllerInputs = Omit<ExternalSecretsAwsConfig, 'storeNamespace'>;

/** The chart repository and the controller release both compositions install. */
function externalSecretsController(spec: ControllerInputs) {
  const repository = externalSecretsHelmRepository({
    name: DEFAULT_EXTERNAL_SECRETS_REPOSITORY_NAME,
    namespace: DEFAULT_FLUX_NAMESPACE,
    id: 'externalSecretsHelmRepository',
  });

  const release = externalSecretsHelmRelease({
    name: spec.name,
    namespace: DEFAULT_FLUX_NAMESPACE,
    targetNamespace: Cel.default(spec.namespace, DEFAULT_EXTERNAL_SECRETS_NAMESPACE),
    version: Cel.default(spec.version, DEFAULT_EXTERNAL_SECRETS_CHART_VERSION),
    repositoryName: DEFAULT_EXTERNAL_SECRETS_REPOSITORY_NAME,
    repositoryNamespace: DEFAULT_FLUX_NAMESPACE,
    values: mapExternalSecretsConfigToHelmValues({
      serviceAccountName: spec.serviceAccountName,
      ...(spec.values !== undefined && { values: spec.values }),
    }),
    id: 'externalSecretsHelmRelease',
  });
  release.dependsOn(repository);
  return release;
}

/** Composition status from the controller release and the store. */
function externalSecretsStatus(
  release: ReturnType<typeof externalSecretsController>,
  store: Enhanced<SecretStoreSpec, SecretStoreStatus>
) {
  const controller = helmReleaseConditionSummary(release);
  const storeReady = Cel.expr<boolean>(
    'has(',
    store.status.conditions,
    ') && ',
    store.status.conditions,
    '.exists(c, c.type == "Ready" && c.status == "True")'
  );
  return {
    ready: Cel.expr<boolean>(controller.ready, ' && ', storeReady),
    controllerReady: controller.ready,
    storeReady,
  };
}

/**
 * External Secrets Operator for AWS Composition
 *
 * Installs the controller from the official chart and creates one namespaced `SecretStore` for
 * AWS Secrets Manager in `region`, in `storeNamespace`. Only ExternalSecrets in that namespace
 * can use it; give other namespaces their own `secretStore`. For one store shared by several
 * namespaces, use `externalSecretsAwsClusterStore`, which names the namespaces allowed.
 *
 * The store authenticates through EKS Pod Identity: it has no `auth` section, and the
 * controller uses the credentials EKS injects for `serviceAccountName`. The IAM role and the
 * Pod Identity association are created outside TypeKro.
 *
 * Deploy it in direct mode, which applies the HelmRelease (and so the CRDs) before the store.
 * KRO mode needs the ESO CRDs installed before the RGD.
 *
 * @example
 * ```typescript
 * const factory = externalSecretsAws.factory('direct', { namespace: 'external-secrets' });
 * await factory.deploy({
 *   name: 'external-secrets',
 *   region: 'us-east-1',
 *   serviceAccountName: 'external-secrets',
 *   storeNamespace: 'payments',
 * });
 * ```
 */
export const externalSecretsAws: CallableComposition<
  ExternalSecretsAwsConfig,
  ExternalSecretsAwsStatus
> = kubernetesComposition(
  {
    name: 'external-secrets-aws',
    kind: 'ExternalSecretsAws',
    spec: ExternalSecretsAwsConfigSchema,
    status: ExternalSecretsAwsStatusSchema,
  },
  (spec: ExternalSecretsAwsConfig) => {
    const release = externalSecretsController(spec);
    const store = secretStore({
      name: Cel.default(spec.storeName, spec.name),
      namespace: spec.storeNamespace,
      spec: { provider: { aws: { service: 'SecretsManager', region: spec.region } } },
      id: 'secretStore',
    });
    store.dependsOn(release);
    return externalSecretsStatus(release, store);
  }
);

/**
 * External Secrets Operator for AWS with a cluster-wide store
 *
 * The explicit opt-in to a `ClusterSecretStore`. It installs the same controller as
 * `externalSecretsAws` and creates one `ClusterSecretStore` whose `conditions` allow only the
 * namespaces in `allowedNamespaces`. The list must name at least one namespace: the instance
 * schema requires the field and refuses an empty list in KRO mode, and the composition refuses
 * it in direct mode.
 *
 * @example
 * ```typescript
 * const factory = externalSecretsAwsClusterStore.factory('direct', {
 *   namespace: 'external-secrets',
 * });
 * await factory.deploy({
 *   name: 'external-secrets',
 *   region: 'us-east-1',
 *   serviceAccountName: 'external-secrets',
 *   allowedNamespaces: ['payments', 'orders'],
 * });
 * ```
 */
export const externalSecretsAwsClusterStore: CallableComposition<
  ExternalSecretsAwsClusterStoreConfig,
  ExternalSecretsAwsStatus
> = kubernetesComposition(
  {
    name: 'external-secrets-aws-cluster-store',
    kind: 'ExternalSecretsAwsClusterStore',
    spec: ExternalSecretsAwsClusterStoreConfigSchema,
    status: ExternalSecretsAwsStatusSchema,
  },
  (spec: ExternalSecretsAwsClusterStoreConfig) => {
    CLUSTER_SECRET_STORE_NAMESPACES.check(spec.allowedNamespaces);
    const release = externalSecretsController(spec);
    const store = clusterSecretStore({
      name: Cel.default(spec.storeName, spec.name),
      spec: {
        provider: { aws: { service: 'SecretsManager', region: spec.region } },
        conditions: [{ namespaces: spec.allowedNamespaces }],
      },
      id: 'clusterSecretStore',
    });
    store.dependsOn(release);
    return externalSecretsStatus(release, store);
  }
);
