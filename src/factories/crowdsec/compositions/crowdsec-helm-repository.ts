import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { crowdsecHelmRepository } from '../resources/helm.js';
import {
  type CrowdsecHelmRepositorySpec,
  CrowdsecHelmRepositorySpecSchema,
  CrowdsecHelmRepositoryStatusSchema,
} from '../types.js';

/**
 * Shared CrowdSec `HelmRepository` singleton, so one installation's teardown
 * cannot delete the chart source another release resolves against.
 */
export const crowdsecHelmRepositoryBootstrap: CallableComposition<
  CrowdsecHelmRepositorySpec,
  { ready: boolean }
> = kubernetesComposition(
  {
    name: 'crowdsec-helm-repository',
    kind: 'CrowdsecHelmRepository',
    spec: CrowdsecHelmRepositorySpecSchema,
    status: CrowdsecHelmRepositoryStatusSchema,
  },
  (spec) => {
    const repository = crowdsecHelmRepository({
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
