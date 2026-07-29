import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { singleton } from '../../../core/singleton/singleton.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { DEFAULT_OPENSEARCH_OPERATOR_NAMESPACE } from '../constants.js';
import {
  DEFAULT_OPENSEARCH_OPERATOR_REPOSITORY_NAME,
  DEFAULT_OPENSEARCH_OPERATOR_REPOSITORY_URL,
  DEFAULT_OPENSEARCH_OPERATOR_VERSION,
  openSearchOperatorHelmRelease,
} from '../resources/helm.js';
import {
  type OpenSearchOperatorBootstrapBuildOptions,
  type OpenSearchOperatorBootstrapConfig,
  OpenSearchOperatorBootstrapConfigSchema,
  OpenSearchOperatorBootstrapStatusSchema,
  type OpenSearchOperatorReferenceConfig,
  OpenSearchOperatorReferenceConfigSchema,
} from '../types.js';
import { openSearchHelmRepositoryBootstrap } from './repository.js';

/**
 * Explicitly owned operator installation. Deleting its KRO instance uninstalls
 * the operator; shared consumers should use openSearchOperatorBootstrap.
 */
export const openSearchOperatorInstallation = kubernetesComposition(
  {
    name: 'opensearch-operator-installation',
    kind: 'OpenSearchOperatorInstallation',
    spec: OpenSearchOperatorBootstrapConfigSchema,
    status: OpenSearchOperatorBootstrapStatusSchema,
  },
  (spec: OpenSearchOperatorBootstrapConfig) => {
    const operatorNamespace = spec.namespace || DEFAULT_OPENSEARCH_OPERATOR_NAMESPACE;
    const version = spec.version || DEFAULT_OPENSEARCH_OPERATOR_VERSION;
    const repositoryName = spec.repositoryName || DEFAULT_OPENSEARCH_OPERATOR_REPOSITORY_NAME;
    const repositoryNamespace = spec.repositoryNamespace || DEFAULT_FLUX_NAMESPACE;
    namespace({
      metadata: {
        name: operatorNamespace,
        labels: {
          'app.kubernetes.io/name': 'opensearch-operator',
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'operatorNamespace',
    });
    const _repository = singleton(openSearchHelmRepositoryBootstrap, {
      id: 'opensearch-helm-repository',
      spec: {
        name: repositoryName,
        namespace: repositoryNamespace,
        url: DEFAULT_OPENSEARCH_OPERATOR_REPOSITORY_URL,
      },
    });
    const release = openSearchOperatorHelmRelease({
      name: spec.name,
      namespace: operatorNamespace,
      version,
      repositoryName,
      repositoryNamespace,
      values: spec.customValues,
      id: 'operatorRelease',
    });
    return {
      ...helmReleaseConditionSummary(release),
      version: release.spec.chart.spec.version,
    };
  }
);

/**
 * Create a shared operator reference whose complete installation is owned by
 * one singleton instance in typekro-singletons. Ownership is build-time so a
 * KRO schema proxy can never silently change lifecycle semantics.
 */
export function makeOpenSearchOperatorBootstrap(
  options: OpenSearchOperatorBootstrapBuildOptions = {}
) {
  const installation: OpenSearchOperatorBootstrapConfig = {
    name: options.name ?? 'opensearch-operator',
    namespace: options.namespace ?? DEFAULT_OPENSEARCH_OPERATOR_NAMESPACE,
    version: options.version ?? DEFAULT_OPENSEARCH_OPERATOR_VERSION,
    repositoryName: options.repositoryName ?? DEFAULT_OPENSEARCH_OPERATOR_REPOSITORY_NAME,
    repositoryNamespace: options.repositoryNamespace ?? DEFAULT_FLUX_NAMESPACE,
    ...(options.customValues ? { customValues: options.customValues } : {}),
  };
  return kubernetesComposition(
    {
      name: 'opensearch-operator-bootstrap',
      kind: 'OpenSearchOperatorBootstrap',
      spec: OpenSearchOperatorReferenceConfigSchema,
      status: OpenSearchOperatorBootstrapStatusSchema,
    },
    (_spec: OpenSearchOperatorReferenceConfig) => {
      const owner = singleton(openSearchOperatorInstallation, {
        id: 'opensearch-operator',
        spec: installation,
      });
      return {
        ready: owner.status.ready,
        failed: owner.status.failed,
        phase: owner.status.phase,
        version: owner.status.version,
      };
    }
  );
}

export const openSearchOperatorBootstrap = makeOpenSearchOperatorBootstrap();
