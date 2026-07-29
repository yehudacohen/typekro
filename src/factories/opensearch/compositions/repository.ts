import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { openSearchOperatorHelmRepository } from '../resources/helm.js';
import {
  OpenSearchHelmRepositorySingletonSpecSchema,
  OpenSearchHelmRepositorySingletonStatusSchema,
} from '../types.js';

export const openSearchHelmRepositoryBootstrap = kubernetesComposition(
  {
    name: 'opensearch-helm-repository',
    kind: 'OpenSearchHelmRepository',
    spec: OpenSearchHelmRepositorySingletonSpecSchema,
    status: OpenSearchHelmRepositorySingletonStatusSchema,
  },
  (spec) => {
    const repository = openSearchOperatorHelmRepository({
      name: spec.name,
      namespace: spec.namespace,
      url: spec.url,
      id: 'repository',
    });
    return {
      ready: Cel.expr<boolean>(
        repository.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
    };
  }
);
