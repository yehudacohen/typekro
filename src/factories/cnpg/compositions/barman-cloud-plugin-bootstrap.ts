import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { setMetadataField } from '../../../core/metadata/index.js';
import { Cel } from '../../../core/references/cel.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import {
  BARMAN_CLOUD_PLUGIN_CHART_VERSION,
  DEFAULT_CNPG_NAMESPACE,
  DEFAULT_CNPG_REPOSITORY_NAME,
} from '../constants.js';
import { barmanCloudPluginHelmRelease } from '../resources/barman-cloud-plugin-helm.js';
import { cnpgHelmRepository } from '../resources/helm.js';
import {
  type BarmanCloudPluginBootstrapConfig,
  BarmanCloudPluginBootstrapConfigSchema,
  type BarmanCloudPluginBootstrapStatus,
  BarmanCloudPluginBootstrapStatusSchema,
} from '../types.js';
import { BARMAN_CLOUD_PLUGIN_VERSION_CONSTRAINT } from '../utils/barman-cloud-constraints.js';

// The plugin needs CloudNativePG 1.30 or later, must run in the operator's namespace (the
// operator only discovers plugins there), and its chart issues TLS certificates with
// cert-manager. `version` may only be the pinned chart version: the instance schema's enum
// refuses another one at KRO admission, and the body refuses it in direct mode.

/**
 * Installs the CloudNativePG Barman Cloud plugin from the official chart, pinned at 0.9.0
 * (plugin v0.16.0), in the operator's namespace.
 *
 * @see docs/api/cnpg/index.md#barman-cloud-plugin
 */
export const barmanCloudPluginBootstrap: CallableComposition<
  BarmanCloudPluginBootstrapConfig,
  BarmanCloudPluginBootstrapStatus
> = kubernetesComposition(
  {
    name: 'barman-cloud-plugin-bootstrap',
    kind: 'BarmanCloudPluginBootstrap',
    spec: BarmanCloudPluginBootstrapConfigSchema,
    status: BarmanCloudPluginBootstrapStatusSchema,
  },
  (spec: BarmanCloudPluginBootstrapConfig) => {
    BARMAN_CLOUD_PLUGIN_VERSION_CONSTRAINT.check(spec.version);

    const repository = cnpgHelmRepository({
      name: DEFAULT_CNPG_REPOSITORY_NAME,
      namespace: DEFAULT_FLUX_NAMESPACE,
      id: 'cnpgHelmRepository',
    });

    const release = barmanCloudPluginHelmRelease({
      name: spec.name,
      namespace: Cel.default(spec.namespace, DEFAULT_CNPG_NAMESPACE),
      version: Cel.default(spec.version, BARMAN_CLOUD_PLUGIN_CHART_VERSION),
      repositoryName: DEFAULT_CNPG_REPOSITORY_NAME,
      ...(spec.values !== undefined && { values: spec.values }),
      id: 'barmanCloudPluginHelmRelease',
    });
    release.dependsOn(repository);
    // The repository also serves the operator chart (`cnpgBootstrap`), so deleting this
    // instance must leave it in place.
    setMetadataField(repository, 'scopes', ['cluster']);

    return {
      ...helmReleaseConditionSummary(release),
      // Projected from the release, so KRO sets it on the instance (a literal would be dropped).
      version: Cel.expr<string>(release.spec.chart.spec.version),
    };
  }
);
