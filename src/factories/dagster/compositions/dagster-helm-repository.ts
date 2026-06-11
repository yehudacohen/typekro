import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { dagsterHelmRepository } from '../resources/helm.js';
import {
  DagsterHelmRepositorySingletonSpecSchema,
  DagsterHelmRepositorySingletonStatusSchema,
} from '../types.js';

/**
 * Shared Dagster HelmRepository singleton.
 *
 * The official Dagster chart repository is a single cluster-level Flux source —
 * the same URL serves every Dagster instance. Deploying it inline in the
 * `dagsterBootstrap` RGD makes each instance's KRO ApplySet try to *own* the
 * `flux-system/dagster` HelmRepository exclusively, so a second instance of the
 * RGD (e.g. a dev + prod pair) fails to reconcile: "resource belongs to a
 * different ApplySet ... cannot reassign". Modelling the repository as its own
 * composition lets `dagsterBootstrap` consume it via `singleton(...)`, so one
 * shared HelmRepository is owned outside any single instance's ApplySet and
 * every instance's HelmRelease references it by the same `sourceRef`.
 */
export const dagsterHelmRepositoryBootstrap = kubernetesComposition(
  {
    name: 'dagster-helm-repository',
    kind: 'DagsterHelmRepository',
    spec: DagsterHelmRepositorySingletonSpecSchema,
    status: DagsterHelmRepositorySingletonStatusSchema,
  },
  (spec) => {
    const repository = dagsterHelmRepository({
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
