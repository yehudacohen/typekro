// `vpaBootstrap`: installs the Vertical Pod Autoscaler with Flux from the
// Fairwinds `vpa` chart. The shared `HelmRepository` is owned by a singleton.
//
// The three components are switched on the runtime spec, since a switch only
// changes chart values. A recommend-only install disables the updater and the
// admission controller.

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_VPA_CHART_VERSION,
  DEFAULT_VPA_NAMESPACE,
  DEFAULT_VPA_REPOSITORY_NAME,
  DEFAULT_VPA_REPOSITORY_URL,
} from '../constants.js';
import { vpaHelmRelease } from '../resources/helm.js';
import {
  type VpaBootstrapBuildOptions,
  type VpaBootstrapConfig,
  VpaBootstrapConfigSchema,
  type VpaBootstrapStatus,
  VpaBootstrapStatusSchema,
} from '../types.js';
import { mapVpaConfigToHelmValues } from '../utils/helm-values-mapper.js';
import { validateVpaBootstrapConfig, warnVpaIssues } from '../utils/validation.js';
import { vpaHelmRepositoryBootstrap } from './vpa-helm-repository.js';

// The chart version Flux installed, newest history entry first. A lazy ternary
// and `filter` rather than `has(history[0].x)`, so both KRO's cel-go and the
// direct-mode cel-js accept it; '' until Flux records a release.
function chartVersionExpression(resourceId: string): string {
  const history = `${resourceId}.status.history`;
  const matching = `${history}.filter(entry, has(entry.chartVersion))`;
  return `has(${history}) ? (size(${matching}) > 0 ? ${matching}[0].chartVersion : "") : ""`;
}

/**
 * Build a VPA bootstrap composition.
 *
 * @param options - Build-time options. Must be concrete values.
 *
 * @example
 * ```typescript
 * const vpa = makeVpaBootstrap({ namespaceOwnership: 'owned' });
 * await vpa.factory('direct', { namespace: 'flux-system', waitForReady: true }).deploy({ name: 'vpa' });
 * ```
 */
export function makeVpaBootstrap(
  options: VpaBootstrapBuildOptions = {}
): CallableComposition<VpaBootstrapConfig, VpaBootstrapStatus> {
  const ownsNamespace = options.namespaceOwnership === 'owned';

  return kubernetesComposition(
    {
      name: options.name ?? 'vpa-bootstrap',
      kind: options.kind ?? 'VpaBootstrap',
      spec: VpaBootstrapConfigSchema,
      status: VpaBootstrapStatusSchema,
    },
    (spec) => {
      warnVpaIssues('vpaBootstrap', validateVpaBootstrapConfig(spec));
      const installNamespace = Cel.default(spec.namespace, DEFAULT_VPA_NAMESPACE);

      if (ownsNamespace) {
        namespace({
          metadata: {
            name: installNamespace,
            labels: {
              'app.kubernetes.io/name': 'vpa',
              'app.kubernetes.io/instance': spec.name,
              'app.kubernetes.io/managed-by': 'typekro',
            },
          },
          id: 'vpaNamespace',
        });
      }

      singleton(vpaHelmRepositoryBootstrap, {
        id: 'vpaHelmRepository',
        spec: {
          name: DEFAULT_VPA_REPOSITORY_NAME,
          namespace: DEFAULT_FLUX_NAMESPACE,
          url: DEFAULT_VPA_REPOSITORY_URL,
        },
      });

      const release = vpaHelmRelease({
        name: spec.name,
        namespace: DEFAULT_FLUX_NAMESPACE,
        targetNamespace: installNamespace,
        version: Cel.default(spec.version, DEFAULT_VPA_CHART_VERSION),
        repositoryName: DEFAULT_VPA_REPOSITORY_NAME,
        repositoryNamespace: DEFAULT_FLUX_NAMESPACE,
        createNamespace: !ownsNamespace,
        values: mapVpaConfigToHelmValues(spec, options.values),
        id: 'vpaHelmRelease',
      });

      return {
        ...helmReleaseConditionSummary(release),
        version: Cel.expr<string>(chartVersionExpression('vpaHelmRelease')),
      };
    }
  );
}

/**
 * The default VPA bootstrap: all three components in the `vpa` namespace,
 * which Flux creates.
 *
 * @example
 * ```typescript
 * // Recommend only: no evictions, no webhook.
 * await vpaBootstrap.factory('kro', { namespace: 'flux-system' }).deploy({
 *   name: 'vpa',
 *   updater: { enabled: false },
 *   admissionController: { enabled: false },
 * });
 * ```
 */
export const vpaBootstrap: CallableComposition<VpaBootstrapConfig, VpaBootstrapStatus> =
  makeVpaBootstrap();
