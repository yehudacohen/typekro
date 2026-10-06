import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { kedaHelmRepository } from '../resources/helm.js';
import {
  type KedaHelmRepositorySingletonSpec,
  KedaHelmRepositorySingletonSpecSchema,
  KedaHelmRepositorySingletonStatusSchema,
} from '../types.js';

/**
 * Shared owner of the kedacore `HelmRepository`, kept outside every install
 * so one teardown cannot remove the source another release uses.
 */
export const kedaHelmRepositoryBootstrap: CallableComposition<
  KedaHelmRepositorySingletonSpec,
  { ready: boolean }
> = kubernetesComposition(
  {
    name: 'keda-helm-repository',
    kind: 'KedaHelmRepository',
    spec: KedaHelmRepositorySingletonSpecSchema,
    status: KedaHelmRepositorySingletonStatusSchema,
  },
  (spec) => {
    const repository = kedaHelmRepository({
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
