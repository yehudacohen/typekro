// `karpenterBootstrap`: installs the Karpenter controller with Flux.
//
// Following upstream's GitOps guidance, the CRDs come from the `karpenter-crd`
// chart (whose templates Helm upgrades) and the controller chart's own `crds/`
// are skipped. The shared OCI `HelmRepository` is owned by a singleton.
//
// TypeKro creates no AWS resources. See docs/api/karpenter for the IAM roles,
// SQS queue, EventBridge rules and discovery tags the caller provides.

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_KARPENTER_CHART_VERSION,
  DEFAULT_KARPENTER_NAMESPACE,
  DEFAULT_KARPENTER_REPOSITORY_NAME,
  DEFAULT_KARPENTER_REPOSITORY_URL,
} from '../constants.js';
import { karpenterCrdHelmRelease, karpenterHelmRelease } from '../resources/helm.js';
import {
  type KarpenterBootstrapBuildOptions,
  type KarpenterBootstrapConfig,
  KarpenterBootstrapConfigSchema,
  type KarpenterBootstrapStatus,
  KarpenterBootstrapStatusSchema,
} from '../types.js';
import { mapKarpenterConfigToHelmValues } from '../utils/helm-values-mapper.js';
import { karpenterHelmRepositoryBootstrap } from './karpenter-helm-repository.js';

// The chart version Flux installed, newest history entry first. A lazy ternary
// and `filter` rather than `has(history[0].x)`, so both KRO's cel-go and the
// direct-mode cel-js accept it; '' until Flux records a release.
function chartVersionExpression(resourceId: string): string {
  const history = `${resourceId}.status.history`;
  const matching = `${history}.filter(entry, has(entry.chartVersion))`;
  return `has(${history}) ? (size(${matching}) > 0 ? ${matching}[0].chartVersion : "") : ""`;
}

/**
 * Build a Karpenter bootstrap composition.
 *
 * @param options - Build-time options. Must be concrete values.
 *
 * @example
 * ```typescript
 * const karpenter = makeKarpenterBootstrap({ crds: 'external' });
 * await karpenter.factory('direct', { namespace: 'flux-system', waitForReady: true }).deploy({
 *   name: 'karpenter',
 *   clusterName: 'my-cluster',
 * });
 * ```
 */
export function makeKarpenterBootstrap(
  options: KarpenterBootstrapBuildOptions = {}
): CallableComposition<KarpenterBootstrapConfig, KarpenterBootstrapStatus> {
  const manageCrds = (options.crds ?? 'karpenter-crd') === 'karpenter-crd';
  const ownsNamespace = options.namespaceOwnership === 'owned';
  const keepCrds = options.keepCrdsOnUninstall ?? true;

  return kubernetesComposition(
    {
      name: options.name ?? 'karpenter-bootstrap',
      kind: options.kind ?? 'KarpenterBootstrap',
      spec: KarpenterBootstrapConfigSchema,
      status: KarpenterBootstrapStatusSchema,
    },
    (spec) => {
      const installNamespace = Cel.default(spec.namespace, DEFAULT_KARPENTER_NAMESPACE);
      const version = Cel.default(spec.version, DEFAULT_KARPENTER_CHART_VERSION);

      if (ownsNamespace) {
        namespace({
          metadata: {
            name: installNamespace,
            labels: {
              'app.kubernetes.io/name': 'karpenter',
              'app.kubernetes.io/instance': spec.name,
              'app.kubernetes.io/managed-by': 'typekro',
            },
          },
          id: 'karpenterNamespace',
        });
      }

      singleton(karpenterHelmRepositoryBootstrap, {
        id: 'karpenterHelmRepository',
        spec: {
          name: DEFAULT_KARPENTER_REPOSITORY_NAME,
          namespace: DEFAULT_FLUX_NAMESPACE,
          url: DEFAULT_KARPENTER_REPOSITORY_URL,
        },
      });

      const releaseCommon = {
        namespace: DEFAULT_FLUX_NAMESPACE,
        targetNamespace: installNamespace,
        version,
        repositoryName: DEFAULT_KARPENTER_REPOSITORY_NAME,
        repositoryNamespace: DEFAULT_FLUX_NAMESPACE,
        createNamespace: !ownsNamespace,
      };

      const controller = karpenterHelmRelease({
        ...releaseCommon,
        name: spec.name,
        values: mapKarpenterConfigToHelmValues(spec, options.values),
        id: 'karpenterHelmRelease',
      });

      if (!manageCrds) {
        return {
          ...helmReleaseConditionSummary(controller),
          version: Cel.expr<string>(chartVersionExpression('karpenterHelmRelease')),
        };
      }

      const crds = karpenterCrdHelmRelease({
        ...releaseCommon,
        name: Cel.template('%s-crd', spec.name),
        // `helm.sh/resource-policy: keep` stops an uninstall from deleting the
        // CRDs and, with them, every NodePool and NodeClaim in the cluster.
        values: keepCrds ? { additionalAnnotations: { 'helm.sh/resource-policy': 'keep' } } : {},
        id: 'karpenterCrdHelmRelease',
      });
      controller.dependsOn(crds);

      return {
        ...helmReleaseConditionSummary(crds, controller),
        version: Cel.expr<string>(chartVersionExpression('karpenterHelmRelease')),
      };
    }
  );
}

/**
 * The default Karpenter bootstrap: CRDs from `karpenter-crd`, the controller
 * in `kube-system`, no namespace ownership.
 *
 * @example
 * ```typescript
 * const factory = karpenterBootstrap.factory('kro', { namespace: 'flux-system' });
 * await factory.deploy({
 *   name: 'karpenter',
 *   clusterName: 'my-cluster',
 *   interruptionQueue: 'my-cluster',
 *   resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { memory: '1Gi' } },
 * });
 * ```
 */
export const karpenterBootstrap: CallableComposition<
  KarpenterBootstrapConfig,
  KarpenterBootstrapStatus
> = makeKarpenterBootstrap();
