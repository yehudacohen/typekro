import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { vpaHelmRepository } from '../resources/helm.js';
import {
  type VpaHelmRepositorySingletonSpec,
  VpaHelmRepositorySingletonSpecSchema,
  VpaHelmRepositorySingletonStatusSchema,
} from '../types.js';

/**
 * Shared owner of the Fairwinds `HelmRepository`, kept outside every install
 * so one teardown cannot remove the source another release uses.
 */
export const vpaHelmRepositoryBootstrap: CallableComposition<
  VpaHelmRepositorySingletonSpec,
  { ready: boolean }
> = kubernetesComposition(
  {
    name: 'vpa-helm-repository',
    kind: 'VpaHelmRepository',
    spec: VpaHelmRepositorySingletonSpecSchema,
    status: VpaHelmRepositorySingletonStatusSchema,
  },
  (spec) => {
    const repository = vpaHelmRepository({
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
