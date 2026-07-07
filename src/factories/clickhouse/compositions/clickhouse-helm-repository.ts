import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { clickhouseHelmRepository } from '../resources/helm.js';
import {
  ClickHouseHelmRepositorySingletonSpecSchema,
  ClickHouseHelmRepositorySingletonStatusSchema,
} from '../types.js';

/**
 * Shared Altinity HelmRepository singleton.
 *
 * The official Altinity chart repository (https://helm.altinity.com) is a
 * single cluster-level Flux source — the same URL serves every consumer.
 * Deploying it inline in the `clickhouseOperatorBootstrap` RGD would make
 * each instance's KRO ApplySet try to *own* the HelmRepository exclusively,
 * so a second instance of the RGD fails to reconcile ("resource belongs to a
 * different ApplySet ... cannot reassign"). Modelling the repository as its
 * own composition lets the bootstrap consume it via `singleton(...)`, so one
 * shared HelmRepository is owned outside any single instance's ApplySet and
 * the operator HelmRelease references it by the same `sourceRef`.
 * (Same pattern as the Dagster bootstrap's shared repository.)
 */
export const clickhouseHelmRepositoryBootstrap = kubernetesComposition(
  {
    name: 'clickhouse-helm-repository',
    kind: 'ClickHouseHelmRepository',
    spec: ClickHouseHelmRepositorySingletonSpecSchema,
    status: ClickHouseHelmRepositorySingletonStatusSchema,
  },
  (spec) => {
    const repository = clickhouseHelmRepository({
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
