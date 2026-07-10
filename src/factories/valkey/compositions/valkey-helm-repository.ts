import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { valkeyHelmRepository } from '../resources/helm.js';
import {
  ValkeyHelmRepositorySingletonSpecSchema,
  ValkeyHelmRepositorySingletonStatusSchema,
} from '../types.js';

/**
 * Shared owner for the cluster-wide Hyperspike OCI HelmRepository.
 *
 * Keeping this resource outside each operator instance's ApplySet prevents
 * cross-instance ownership conflicts and preserves its `flux-system` namespace
 * in direct factory YAML. OCI HelmRepositories do not consistently publish a
 * Ready condition, so existence is represented by its positive generation.
 */
export const valkeyHelmRepositoryBootstrap = kubernetesComposition(
  {
    name: 'valkey-helm-repository',
    kind: 'ValkeyHelmRepository',
    spec: ValkeyHelmRepositorySingletonSpecSchema,
    status: ValkeyHelmRepositorySingletonStatusSchema,
  },
  (spec) => {
    const repository = valkeyHelmRepository({
      name: spec.name,
      namespace: spec.namespace,
      url: spec.url,
      id: 'repository',
    });

    return {
      ready: Cel.expr<boolean>(repository.metadata.generation, ' > 0'),
    };
  }
);
