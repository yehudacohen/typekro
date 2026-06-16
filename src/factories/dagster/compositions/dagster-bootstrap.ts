import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { lazyComposition } from '../../../core/composition/lazy-composition.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_DAGSTER_REPO_NAME,
  DEFAULT_DAGSTER_REPO_URL,
  DEFAULT_DAGSTER_VERSION,
  dagsterHelmRelease,
} from '../resources/helm.js';
import {
  type DagsterBootstrapConfig,
  DagsterBootstrapConfigSchema,
  DagsterBootstrapStatusSchema,
} from '../types.js';
import { mapDagsterConfigToHelmValues } from '../utils/helm-values-mapper.js';
import { dagsterHelmRepositoryBootstrap } from './dagster-helm-repository.js';

type DagsterBootstrapSchemaConfig = typeof DagsterBootstrapConfigSchema.infer;

/**
 * High-level Dagster bootstrap composition.
 *
 * Creates the target Namespace, official Dagster HelmRepository, and Dagster
 * HelmRelease. Status is derived only from owned Flux Helm resources.
 */
export const dagsterBootstrap = lazyComposition(() => kubernetesComposition(
  {
    name: 'dagster-bootstrap',
    kind: 'DagsterBootstrap',
    spec: DagsterBootstrapConfigSchema,
    status: DagsterBootstrapStatusSchema,
  },
  (spec) => {
    const resolvedNamespace = spec.namespace || 'dagster';
    const resolvedVersion = spec.version || DEFAULT_DAGSTER_VERSION;
    const helmValues = buildHelmValues(spec);

    const _dagsterNamespace = namespace({
      metadata: {
        name: resolvedNamespace,
        labels: {
          'app.kubernetes.io/name': 'dagster',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/version': resolvedVersion,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'dagsterNamespace',
    });

    // The official Dagster chart repository is one cluster-level Flux source shared
    // by every Dagster instance, so deploy it once via singleton(...) with a fixed
    // identity. Inlining it would make each instance's KRO ApplySet try to own the
    // HelmRepository exclusively, breaking a second instance (dev + prod) with an
    // ApplySet reassignment error. Every instance's HelmRelease references the same
    // shared repository by the official `sourceRef` defaults.
    const _dagsterHelmRepository = singleton(dagsterHelmRepositoryBootstrap, {
      id: 'dagster-helm-repository',
      spec: {
        name: DEFAULT_DAGSTER_REPO_NAME,
        namespace: DEFAULT_FLUX_NAMESPACE,
        url: DEFAULT_DAGSTER_REPO_URL,
      },
    });

    const _dagsterHelmRelease = dagsterHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      values: helmValues,
      id: 'dagsterHelmRelease',
    });

    const helmRepositoryReady = _dagsterHelmRepository.status.ready;
    const helmReleaseReady = Cel.expr<boolean>(
      _dagsterHelmRelease.status.conditions,
      '.exists(c, c.type == "Ready" && c.status == "True")'
    );

    return {
      ready: helmReleaseReady,
      phase: Cel.expr<'Ready' | 'Installing' | 'Failed'>(
        'dagsterHelmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "False") ' +
          '? "Failed" : dagsterHelmRelease.status.conditions.exists(c, c.type == "Ready" && ' +
          'c.status == "True") ? "Ready" : "Installing"'
      ),
      failed: Cel.expr<boolean>(
        _dagsterHelmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "False")'
      ),
      version: resolvedVersion,
      components: {
        helmRepository: helmRepositoryReady,
        helmRelease: helmReleaseReady,
        webserver: helmReleaseReady,
        daemon: helmReleaseReady,
        userDeployments: helmReleaseReady,
      },
    };
  }
));

function buildHelmValues(spec: DagsterBootstrapSchemaConfig) {
  return mapDagsterConfigToHelmValues(buildMapperConfig(spec));
}

function buildMapperConfig(spec: DagsterBootstrapSchemaConfig): DagsterBootstrapConfig {
  return Object.assign(
    { name: spec.name },
    spec.namespace !== undefined && { namespace: spec.namespace },
    spec.version !== undefined && { version: spec.version },
    spec.serviceAccountName !== undefined && { serviceAccountName: spec.serviceAccountName },
    spec.nameOverride !== undefined && { nameOverride: spec.nameOverride },
    spec.fullnameOverride !== undefined && { fullnameOverride: spec.fullnameOverride },
    spec.rbacEnabled !== undefined && { rbacEnabled: spec.rbacEnabled },
    spec.imagePullSecrets !== undefined && { imagePullSecrets: spec.imagePullSecrets },
    spec.webserver !== undefined && { webserver: spec.webserver },
    spec.daemon !== undefined && { daemon: spec.daemon },
    spec.userDeployments !== undefined && { userDeployments: spec.userDeployments },
    spec.postgresql !== undefined && { postgresql: spec.postgresql },
    spec.runLauncher !== undefined && { runLauncher: spec.runLauncher },
    spec.scheduler !== undefined && { scheduler: spec.scheduler },
    spec.computeLogManager !== undefined && { computeLogManager: spec.computeLogManager },
    spec.ingress !== undefined && { ingress: spec.ingress },
    spec.flower !== undefined && { flower: spec.flower },
    spec.rabbitmq !== undefined && { rabbitmq: spec.rabbitmq },
    spec.redis !== undefined && { redis: spec.redis },
    spec.global !== undefined && { global: spec.global },
    spec.values !== undefined && { values: spec.values }
  ) as DagsterBootstrapConfig;
}
