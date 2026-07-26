import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { apisixHelmRepository } from '../resources/helm.js';
import {
  APISixHelmRepositorySingletonSpecSchema,
  APISixHelmRepositorySingletonStatusSchema,
} from '../types.js';

/**
 * Shared APISIX HelmRepository singleton.
 *
 * Every APISIX release consumes the same official chart source. Keeping that
 * source outside consumer ownership prevents one instance from deleting or
 * relabeling the repository used by another installation.
 */
export const apisixHelmRepositoryBootstrap = kubernetesComposition(
  {
    name: 'apisix-helm-repository',
    kind: 'APISixHelmRepository',
    spec: APISixHelmRepositorySingletonSpecSchema,
    status: APISixHelmRepositorySingletonStatusSchema,
  },
  (spec) => {
    const repository = apisixHelmRepository({
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
