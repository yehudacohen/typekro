/** Shared official Rook chart repository singleton. */

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { rookCephHelmRepository } from '../resources/helm.js';
import {
  RookCephHelmRepositorySingletonSpecSchema,
  RookCephHelmRepositorySingletonStatusSchema,
} from '../types.js';

/**
 * Own the cluster-wide Rook HelmRepository outside any consumer ApplySet.
 */
export const rookCephHelmRepositoryBootstrap = kubernetesComposition(
  {
    name: 'rook-ceph-helm-repository',
    kind: 'RookCephHelmRepository',
    spec: RookCephHelmRepositorySingletonSpecSchema,
    status: RookCephHelmRepositorySingletonStatusSchema,
  },
  (spec) => {
    const repository = rookCephHelmRepository({
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
