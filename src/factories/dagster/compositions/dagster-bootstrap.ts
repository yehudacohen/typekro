import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_DAGSTER_REPO_NAME,
  DEFAULT_DAGSTER_VERSION,
  dagsterHelmRelease,
  dagsterHelmRepository,
} from '../resources/helm.js';
import {
  type DagsterBootstrapConfig,
  DagsterBootstrapConfigSchema,
  DagsterBootstrapStatusSchema,
} from '../types.js';
import { mapDagsterConfigToHelmValues } from '../utils/helm-values-mapper.js';

type DagsterBootstrapSchemaConfig = typeof DagsterBootstrapConfigSchema.infer;

/**
 * High-level Dagster bootstrap composition.
 *
 * Creates the target Namespace, official Dagster HelmRepository, and Dagster
 * HelmRelease. Status is derived only from owned Flux Helm resources.
 */
export const dagsterBootstrap = kubernetesComposition(
  {
    name: 'dagster-bootstrap',
    kind: 'DagsterBootstrap',
    spec: DagsterBootstrapConfigSchema,
    status: DagsterBootstrapStatusSchema,
  },
  (spec) => {
    const resolvedNamespace = spec.namespace || 'dagster';
    const resolvedVersion = spec.version || DEFAULT_DAGSTER_VERSION;
    const repositoryName = spec.repositoryName || DEFAULT_DAGSTER_REPO_NAME;
    const repositoryNamespace = spec.repositoryNamespace || DEFAULT_FLUX_NAMESPACE;
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

    const _dagsterHelmRepository = dagsterHelmRepository({
      name: repositoryName,
      namespace: repositoryNamespace,
      id: 'dagsterHelmRepository',
    });

    const _dagsterHelmRelease = dagsterHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      repositoryName,
      repositoryNamespace,
      values: helmValues,
      id: 'dagsterHelmRelease',
    });

    const helmRepositoryReady = Cel.expr<boolean>(
      _dagsterHelmRepository.status.conditions,
      '.exists(c, c.type == "Ready" && c.status == "True")'
    );
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
);

function buildHelmValues(spec: DagsterBootstrapSchemaConfig) {
  return mapDagsterConfigToHelmValues(buildMapperConfig(spec));
}

function buildMapperConfig(spec: DagsterBootstrapSchemaConfig): DagsterBootstrapConfig {
  return Object.assign(
    { name: spec.name },
    spec.namespace !== undefined && { namespace: spec.namespace },
    spec.version !== undefined && { version: spec.version },
    spec.repositoryName !== undefined && { repositoryName: spec.repositoryName },
    spec.repositoryNamespace !== undefined && { repositoryNamespace: spec.repositoryNamespace },
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
