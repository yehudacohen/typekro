import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { karpenterHelmRepository } from '../resources/helm.js';
import {
  type KarpenterHelmRepositorySingletonSpec,
  KarpenterHelmRepositorySingletonSpecSchema,
  KarpenterHelmRepositorySingletonStatusSchema,
} from '../types.js';

/**
 * Shared owner of the Karpenter OCI `HelmRepository`, kept outside every
 * install so one teardown cannot remove the source another release uses.
 */
export const karpenterHelmRepositoryBootstrap: CallableComposition<
  KarpenterHelmRepositorySingletonSpec,
  { ready: boolean }
> = kubernetesComposition(
  {
    name: 'karpenter-helm-repository',
    kind: 'KarpenterHelmRepository',
    spec: KarpenterHelmRepositorySingletonSpecSchema,
    status: KarpenterHelmRepositorySingletonStatusSchema,
  },
  (spec) => {
    const repository = karpenterHelmRepository({
      name: spec.name,
      namespace: spec.namespace,
      url: spec.url,
      id: 'repository',
    });
    // OCI HelmRepositories publish no Ready condition; a positive generation
    // means the API server accepted the object.
    return { ready: Cel.expr<boolean>(repository.metadata.generation, ' > 0') };
  }
);
