import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { traefikHelmRepository } from '../resources/helm.js';
import {
  TraefikHelmRepositorySingletonSpecSchema,
  TraefikHelmRepositorySingletonStatusSchema,
} from '../types.js';

/**
 * Shared Traefik `HelmRepository` singleton.
 *
 * Every Traefik release consumes the same official chart source. Keeping that
 * source outside consumer ownership prevents one installation's teardown from
 * deleting or relabeling the repository another `HelmRelease` still resolves
 * against.
 */
export const traefikHelmRepositoryBootstrap = kubernetesComposition(
  {
    name: 'traefik-helm-repository',
    kind: 'TraefikHelmRepository',
    spec: TraefikHelmRepositorySingletonSpecSchema,
    status: TraefikHelmRepositorySingletonStatusSchema,
  },
  (spec) => {
    const repository = traefikHelmRepository({
      name: spec.name,
      namespace: spec.namespace,
      url: spec.url,
      id: 'repository',
    });

    return {
      // The official repository is a classic (non-OCI) Helm repository, so Flux
      // publishes a real Ready condition for it.
      ready: Cel.expr<boolean>(
        repository.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
    };
  }
);
