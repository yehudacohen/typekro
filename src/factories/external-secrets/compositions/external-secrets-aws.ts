import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import {
  DEFAULT_EXTERNAL_SECRETS_CHART_VERSION,
  DEFAULT_EXTERNAL_SECRETS_NAMESPACE,
  DEFAULT_EXTERNAL_SECRETS_REPOSITORY_NAME,
} from '../constants.js';
import { externalSecretsHelmRelease, externalSecretsHelmRepository } from '../resources/helm.js';
import { clusterSecretStore } from '../resources/secret-store.js';
import {
  type ExternalSecretsAwsConfig,
  ExternalSecretsAwsConfigSchema,
  ExternalSecretsAwsStatusSchema,
} from '../types.js';
import { mapExternalSecretsConfigToHelmValues } from '../utils/helm-values-mapper.js';

/**
 * External Secrets Operator for AWS Composition
 *
 * Installs the controller from the official chart and creates one `ClusterSecretStore` for AWS
 * Secrets Manager in `region`. The store authenticates through EKS Pod Identity: it has no
 * `auth` section, and the controller uses the credentials EKS injects for `serviceAccountName`.
 * The IAM role and the Pod Identity association are created outside TypeKro.
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
 * });
 * ```
 */
export const externalSecretsAws = kubernetesComposition(
  {
    name: 'external-secrets-aws',
    kind: 'ExternalSecretsAws',
    spec: ExternalSecretsAwsConfigSchema,
    status: ExternalSecretsAwsStatusSchema,
  },
  (spec: ExternalSecretsAwsConfig) => {
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

    const store = clusterSecretStore({
      name: Cel.default(spec.storeName, spec.name),
      spec: { provider: { aws: { service: 'SecretsManager', region: spec.region } } },
      id: 'clusterSecretStore',
    });
    store.dependsOn(release);

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
);
