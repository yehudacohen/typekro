// `kedaBootstrap`: installs KEDA (operator, metrics API server, admission
// webhooks) with Flux from the official kedacore `keda` chart, CRDs included.
// The shared `HelmRepository` is owned by a singleton.

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_KEDA_CHART_VERSION,
  DEFAULT_KEDA_NAMESPACE,
  DEFAULT_KEDA_REPOSITORY_NAME,
  DEFAULT_KEDA_REPOSITORY_URL,
} from '../constants.js';
import { kedaHelmRelease } from '../resources/helm.js';
import {
  type KedaBootstrapBuildOptions,
  type KedaBootstrapConfig,
  KedaBootstrapConfigSchema,
  type KedaBootstrapStatus,
  KedaBootstrapStatusSchema,
} from '../types.js';
import { mapKedaConfigToHelmValues } from '../utils/helm-values-mapper.js';
import { validateKedaBootstrapConfig, warnKedaIssues } from '../utils/validation.js';
import { kedaHelmRepositoryBootstrap } from './keda-helm-repository.js';

// The chart version Flux installed, newest history entry first. A lazy ternary
// and `filter` rather than `has(history[0].x)`, so both KRO's cel-go and the
// direct-mode cel-js accept it; '' until Flux records a release.
function chartVersionExpression(resourceId: string): string {
  const history = `${resourceId}.status.history`;
  const matching = `${history}.filter(entry, has(entry.chartVersion))`;
  return `has(${history}) ? (size(${matching}) > 0 ? ${matching}[0].chartVersion : "") : ""`;
}

/**
 * Build a KEDA bootstrap composition.
 *
 * @param options - Build-time options. Must be concrete values.
 *
 * @example
 * ```typescript
 * const keda = makeKedaBootstrap({ namespaceOwnership: 'owned' });
 * await keda.factory('direct', { namespace: 'flux-system', waitForReady: true }).deploy({ name: 'keda' });
 * ```
 */
export function makeKedaBootstrap(
  options: KedaBootstrapBuildOptions = {}
): CallableComposition<KedaBootstrapConfig, KedaBootstrapStatus> {
  const ownsNamespace = options.namespaceOwnership === 'owned';
  const keepCrds = options.keepCrdsOnUninstall ?? true;

  return kubernetesComposition(
    {
      name: options.name ?? 'keda-bootstrap',
      kind: options.kind ?? 'KedaBootstrap',
      spec: KedaBootstrapConfigSchema,
      status: KedaBootstrapStatusSchema,
    },
    (spec) => {
      warnKedaIssues('kedaBootstrap', validateKedaBootstrapConfig(spec));
      const installNamespace = Cel.default(spec.namespace, DEFAULT_KEDA_NAMESPACE);

      if (ownsNamespace) {
        namespace({
          metadata: {
            name: installNamespace,
            labels: {
              'app.kubernetes.io/name': 'keda',
              'app.kubernetes.io/instance': spec.name,
              'app.kubernetes.io/managed-by': 'typekro',
            },
          },
          id: 'kedaNamespace',
        });
      }

      singleton(kedaHelmRepositoryBootstrap, {
        id: 'kedaHelmRepository',
        spec: {
          name: DEFAULT_KEDA_REPOSITORY_NAME,
          namespace: DEFAULT_FLUX_NAMESPACE,
          url: DEFAULT_KEDA_REPOSITORY_URL,
        },
      });

      const release = kedaHelmRelease({
        name: spec.name,
        namespace: DEFAULT_FLUX_NAMESPACE,
        targetNamespace: installNamespace,
        version: Cel.default(spec.version, DEFAULT_KEDA_CHART_VERSION),
        repositoryName: DEFAULT_KEDA_REPOSITORY_NAME,
        repositoryNamespace: DEFAULT_FLUX_NAMESPACE,
        createNamespace: !ownsNamespace,
        values: mapKedaConfigToHelmValues(spec, options.values, { keepCrds }),
        id: 'kedaHelmRelease',
      });

      return {
        ...helmReleaseConditionSummary(release),
        version: Cel.expr<string>(chartVersionExpression('kedaHelmRelease')),
      };
    }
  );
}

/**
 * The default KEDA bootstrap: every component in the `keda` namespace, which
 * Flux creates.
 *
 * @example
 * ```typescript
 * await kedaBootstrap.factory('kro', { namespace: 'flux-system' }).deploy({
 *   name: 'keda',
 *   // IRSA for the AWS scalers. With EKS Pod Identity, associate the role with
 *   // the keda-operator ServiceAccount instead.
 *   podIdentity: { awsIrsa: { enabled: true, roleArn: 'arn:aws:iam::111122223333:role/keda-operator' } },
 * });
 * ```
 */
export const kedaBootstrap: CallableComposition<KedaBootstrapConfig, KedaBootstrapStatus> =
  makeKedaBootstrap();
