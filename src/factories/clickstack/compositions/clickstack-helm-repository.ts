import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { clickstackHelmRepository } from '../resources/helm.js';
import {
  ClickStackHelmRepositorySingletonSpecSchema,
  ClickStackHelmRepositorySingletonStatusSchema,
} from '../types.js';

/**
 * Shared ClickStack HelmRepository singleton.
 *
 * The official ClickStack chart repository
 * (https://clickhouse.github.io/ClickStack-helm-charts) is a single
 * cluster-level Flux source — the same URL serves every consumer. Deploying it
 * inline in the `clickstackBootstrap` RGD would make each instance's KRO
 * ApplySet try to *own* the HelmRepository exclusively, so a second instance
 * of the RGD fails to reconcile ("resource belongs to a different ApplySet
 * ... cannot reassign"). Modelling the repository as its own composition lets
 * the bootstrap consume it via `singleton(...)`, so one shared HelmRepository
 * is owned outside any single instance's ApplySet and every instance's
 * HelmRelease references it by the same `sourceRef`. (Same pattern as the
 * dagster/clickhouse bootstraps' shared repositories.)
 */
export const clickstackHelmRepositoryBootstrap = kubernetesComposition(
  {
    name: 'clickstack-helm-repository',
    kind: 'ClickStackHelmRepository',
    spec: ClickStackHelmRepositorySingletonSpecSchema,
    status: ClickStackHelmRepositorySingletonStatusSchema,
  },
  (spec) => {
    const repository = clickstackHelmRepository({
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
