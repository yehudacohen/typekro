import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { setMetadataField } from '../../../core/metadata/index.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  clickhouseOperatorHelmRelease,
  DEFAULT_CLICKHOUSE_OPERATOR_VERSION,
  DEFAULT_CLICKHOUSE_REPO_NAME,
  DEFAULT_CLICKHOUSE_REPO_URL,
} from '../resources/helm.js';
import {
  type ClickHouseOperatorBootstrapConfig,
  ClickHouseOperatorBootstrapConfigSchema,
  ClickHouseOperatorBootstrapStatusSchema,
} from '../types.js';
import { mapClickHouseOperatorConfigToHelmValues } from '../utils/helm-values-mapper.js';
import { clickhouseHelmRepositoryBootstrap } from './clickhouse-helm-repository.js';

/**
 * Altinity clickhouse-operator Bootstrap Composition
 *
 * Deploys the OFFICIAL Altinity clickhouse-operator via HelmRepository and
 * HelmRelease resources (chart `altinity-clickhouse-operator` 0.27.x from
 * https://helm.altinity.com, Apache-2.0). Build-around: we wrap the official
 * chart — never hand-rolled operator manifests.
 *
 * IMPORTANT — ONE OPERATOR PER CLUSTER: the operator is cluster-scoped and
 * owns the ClickHouse CRDs (`clickhouseinstallations`,
 * `clickhouseinstallationtemplates`, `clickhouseoperatorconfigurations` under
 * `clickhouse.altinity.com/v1`; `clickhousekeeperinstallations` under
 * `clickhouse-keeper.altinity.com/v1`). Install it exactly once; every
 * `clickHouseInstallation()`/`clickHouseKeeperInstallation()` in the cluster
 * is reconciled by that single install. The default `shared: true` tags the
 * operator resources with `scopes: ['cluster']` so instance deletion leaves
 * the shared operator intact.
 *
 * This composition:
 * 1. Creates the target namespace
 * 2. References the shared Altinity HelmRepository singleton
 * 3. Creates a HelmRelease that installs the operator
 *
 * After the operator is running, use `clickHouseInstallation()` and
 * `clickHouseKeeperInstallation()` to create ClickHouse resources.
 *
 * @example
 * ```typescript
 * const operatorFactory = clickhouseOperatorBootstrap.factory('kro', {
 *   namespace: 'typekro-system',
 *   waitForReady: true,
 * });
 *
 * await operatorFactory.deploy({
 *   name: 'clickhouse-operator',
 *   namespace: 'clickhouse-system',
 *   version: '0.27.1',
 * });
 * ```
 */
export const clickhouseOperatorBootstrap = kubernetesComposition(
  {
    name: 'clickhouse-operator-bootstrap',
    kind: 'ClickHouseOperatorBootstrap',
    spec: ClickHouseOperatorBootstrapConfigSchema,
    status: ClickHouseOperatorBootstrapStatusSchema,
  },
  (spec: ClickHouseOperatorBootstrapConfig) => {
    const resolvedNamespace = spec.namespace || 'clickhouse-system';
    const resolvedVersion = spec.version || DEFAULT_CLICKHOUSE_OPERATOR_VERSION;
    // Default to shared-lifecycle: the operator is one-per-cluster
    // infrastructure (it owns the CRDs) and must survive individual consumer
    // instance deletions. `shared: false` exists only for throwaway
    // environments such as kind-cluster integration tests.
    const isShared = spec.shared !== false;

    // Map config to Helm values (metrics.enabled / crdHook.enabled /
    // operator resources + customValues merged LAST). Fields are passed
    // EXPLICITLY — spreading the schema proxy (`...spec`) enumerates proxy
    // keys and leaks `__typekroSchemaKey` markers into the rendered values.
    // In kro mode `spec.customValues` is a schema ref, so the mapper routes
    // it through the graph-aware runtime values merge and the override map
    // lands in the serialized HelmRelease values.
    const helmValues = mapClickHouseOperatorConfigToHelmValues({
      metrics: spec.metrics,
      crdHook: spec.crdHook,
      resources: spec.resources,
      customValues: spec.customValues,
    });

    // Resources are _-prefixed because they're registered via side effects in
    // the kubernetesComposition callback — the composition captures them
    // automatically. They're referenced in the status return via their `id`.
    const _clickhouseNamespace = namespace({
      metadata: {
        name: resolvedNamespace,
        labels: {
          'app.kubernetes.io/name': 'altinity-clickhouse-operator',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/version': resolvedVersion,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'clickhouseNamespace',
    });

    // The Altinity chart repository is one cluster-level Flux source shared
    // by every consumer, so deploy it once via singleton(...) with a fixed
    // identity (same rationale as the Dagster bootstrap: inlining it would
    // make each instance's KRO ApplySet try to own the HelmRepository
    // exclusively, breaking a second instance with an ApplySet reassignment
    // error). The HelmRelease references the shared repository by the
    // official `sourceRef` defaults.
    const _clickhouseHelmRepository = singleton(clickhouseHelmRepositoryBootstrap, {
      id: 'clickhouse-helm-repository',
      spec: {
        name: DEFAULT_CLICKHOUSE_REPO_NAME,
        namespace: DEFAULT_FLUX_NAMESPACE,
        url: DEFAULT_CLICKHOUSE_REPO_URL,
      },
    });

    // Create HelmRelease for the operator itself.
    const _helmRelease = clickhouseOperatorHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      values: helmValues,
      id: 'clickhouseOperatorHelmRelease',
    });

    // Tag resources with 'cluster' scope so factory-level deleteInstance
    // leaves the shared operator install intact for other consumers. Callers
    // can explicitly tear down shared infra with
    // `deleteInstance(name, { scopes: ['cluster'] })`.
    if (isShared) {
      setMetadataField(_clickhouseNamespace, 'scopes', ['cluster']);
      setMetadataField(_helmRelease, 'scopes', ['cluster']);
    }

    // Status derived from HelmRelease conditions.
    // Flux HelmRelease v2 uses conditions with type='Ready' for readiness;
    // the release does not set `disableWait`, so helm-controller waits for
    // the chart's workloads before reporting Ready (readiness is
    // workload-aware, mirroring the cnpg/dagster bootstraps).
    return {
      ready: Cel.expr<boolean>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      // Two-state phase: nested ternaries with .exists() require repeating the
      // full resource path in CEL, which Cel.expr(ref, operator) cannot
      // express (same constraint as the cnpg bootstrap).
      phase: Cel.expr<'Ready' | 'Installing'>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
      ),
      version: resolvedVersion,
    };
  }
);
