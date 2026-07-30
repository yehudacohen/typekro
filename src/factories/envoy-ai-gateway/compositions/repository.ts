import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { envoyProxyHelmRepository } from '../resources/helm.js';
import {
  EnvoyProxyHelmRepositorySingletonSpecSchema,
  EnvoyProxyHelmRepositorySingletonStatusSchema,
} from '../types.js';

/**
 * Single owner for the shared docker.io/envoyproxy OCI source. Consumer
 * installations reference this resource without competing for ApplySet
 * ownership.
 */
export const envoyProxyHelmRepositoryBootstrap = kubernetesComposition(
  {
    name: 'envoyproxy-helm-repository',
    kind: 'EnvoyProxyHelmRepository',
    spec: EnvoyProxyHelmRepositorySingletonSpecSchema,
    status: EnvoyProxyHelmRepositorySingletonStatusSchema,
  },
  (spec) => {
    const repository = envoyProxyHelmRepository({
      name: spec.name,
      namespace: spec.namespace,
      url: spec.url,
      id: 'repository',
    });
    return {
      // Flux OCI HelmRepository resources are static references and do not
      // publish Ready conditions. Their accepted live generation is the
      // portable readiness boundary used by the direct evaluator as well.
      ready: Cel.expr<boolean>(repository.metadata.generation, ' > 0'),
    };
  },
);
