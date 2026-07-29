import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { setMetadataField } from '../../../core/metadata/index.js';
import { singleton } from '../../../core/singleton/singleton.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_OPENSEARCH_OPERATOR_REPOSITORY_NAME,
  DEFAULT_OPENSEARCH_OPERATOR_REPOSITORY_URL,
  DEFAULT_OPENSEARCH_OPERATOR_VERSION,
  openSearchOperatorHelmRelease,
} from '../resources/helm.js';
import {
  type OpenSearchOperatorBootstrapConfig,
  OpenSearchOperatorBootstrapConfigSchema,
  OpenSearchOperatorBootstrapStatusSchema,
} from '../types.js';
import { openSearchHelmRepositoryBootstrap } from './repository.js';
import { DEFAULT_OPENSEARCH_OPERATOR_NAMESPACE } from '../constants.js';

export const openSearchOperatorBootstrap = kubernetesComposition(
  {
    name: 'opensearch-operator-bootstrap',
    kind: 'OpenSearchOperatorBootstrap',
    spec: OpenSearchOperatorBootstrapConfigSchema,
    status: OpenSearchOperatorBootstrapStatusSchema,
  },
  (spec: OpenSearchOperatorBootstrapConfig) => {
    const operatorNamespace =
      spec.namespace || DEFAULT_OPENSEARCH_OPERATOR_NAMESPACE;
    const version = spec.version || DEFAULT_OPENSEARCH_OPERATOR_VERSION;
    const repositoryName =
      spec.repositoryName || DEFAULT_OPENSEARCH_OPERATOR_REPOSITORY_NAME;
    const repositoryNamespace = spec.repositoryNamespace || DEFAULT_FLUX_NAMESPACE;
    const shared = spec.shared !== false;
    const operatorNamespaceResource = namespace({
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
    if (shared) {
      setMetadataField(operatorNamespaceResource, 'scopes', ['cluster']);
      setMetadataField(release, 'scopes', ['cluster']);
    }
    return {
      ...helmReleaseConditionSummary(release),
      version: release.spec.chart.spec.version,
    };
  }
);
