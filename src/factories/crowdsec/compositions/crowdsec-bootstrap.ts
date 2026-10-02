import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { networkPolicy } from '../../kubernetes/networking/network-policy.js';
import { podDisruptionBudget } from '../../kubernetes/policy/pod-disruption-budget.js';
import {
  CROWDSEC_APPSEC_PORT,
  CROWDSEC_LAPI_PORT,
  CROWDSEC_METRICS_PORT,
  DEFAULT_CROWDSEC_CHART_VERSION,
  DEFAULT_CROWDSEC_NAMESPACE,
  DEFAULT_CROWDSEC_REPOSITORY_NAME,
  DEFAULT_CROWDSEC_REPOSITORY_URL,
} from '../constants.js';
import { crowdsecHelmRelease } from '../resources/helm.js';
import {
  type CrowdsecBootstrapConfig,
  CrowdsecBootstrapConfigSchema,
  type CrowdsecBootstrapOptions,
  type CrowdsecBootstrapStatus,
  CrowdsecBootstrapStatusSchema,
} from '../types.js';
import {
  assertCrowdsecBootstrapOptions,
  mapCrowdsecConfigToHelmValues,
} from '../utils/helm-values-mapper.js';
import { crowdsecHelmRepositoryBootstrap } from './crowdsec-helm-repository.js';

const RELEASE_ID = 'crowdsecHelmRelease';

// Service hosts are read off the owned release (a resource projection), not
// echoed from the spec: KRO drops literal status fields (#188).
function serviceHost(suffix: string, port: number): string {
  return (
    `${RELEASE_ID}.spec.releaseName + "${suffix}." + ` +
    `${RELEASE_ID}.spec.targetNamespace + ".svc.cluster.local:${port}"`
  );
}

// Lazy ternaries over `status.history`, for the reasons given on the Traefik
// bootstrap's `chartVersionExpression`: cel-js propagates errors through `&&`.
const CHART_VERSION_EXPRESSION =
  `has(${RELEASE_ID}.status.history) ? ` +
  `(size(${RELEASE_ID}.status.history.filter(e, has(e.chartVersion))) > 0 ? ` +
  `${RELEASE_ID}.status.history.filter(e, has(e.chartVersion))[0].chartVersion : "") : ""`;

/**
 * Build a CrowdSec bootstrap composition.
 *
 * Options decide what CrowdSec runs and are concrete at build time; the
 * runtime spec carries the release name, namespace, chart version and sizing.
 *
 * @throws {TypeKroError} `CROWDSEC_INVALID_OPTIONS` for an option combination CrowdSec cannot run.
 * @see docs/api/crowdsec/index.md
 *
 * @example
 * ```typescript
 * const crowdsec = makeCrowdsecBootstrap({
 *   bouncers: [{ name: 'traefik', keySecretRef: { name: 'crowdsec-bouncer', key: 'api-key' } }],
 *   simulation: { global: true },
 * });
 * await crowdsec.factory('direct', { kubeConfig, waitForReady: true }).deploy({ name: 'crowdsec' });
 * ```
 */
export function makeCrowdsecBootstrap(
  options: CrowdsecBootstrapOptions = {}
): CallableComposition<CrowdsecBootstrapConfig, CrowdsecBootstrapStatus> {
  assertCrowdsecBootstrapOptions(options);
  const ownsNamespace = (options.namespaceOwnership ?? 'owned') === 'owned';
  return kubernetesComposition(
    {
      name: options.name ?? 'crowdsec-bootstrap',
      kind: options.kind ?? 'CrowdsecBootstrap',
      spec: CrowdsecBootstrapConfigSchema,
      status: CrowdsecBootstrapStatusSchema,
    },
    (spec) => {
      const installNamespace = Cel.default(spec.namespace, DEFAULT_CROWDSEC_NAMESPACE);
      const labels = {
        'app.kubernetes.io/name': 'crowdsec',
        'app.kubernetes.io/instance': spec.name,
        'app.kubernetes.io/managed-by': 'typekro',
      };

      if (ownsNamespace) {
        namespace({ metadata: { name: installNamespace, labels }, id: 'crowdsecNamespace' });
      }

      singleton(crowdsecHelmRepositoryBootstrap, {
        id: 'crowdsecHelmRepository',
        spec: {
          name: DEFAULT_CROWDSEC_REPOSITORY_NAME,
          namespace: DEFAULT_FLUX_NAMESPACE,
          url: DEFAULT_CROWDSEC_REPOSITORY_URL,
        },
      });

      const release = crowdsecHelmRelease({
        name: spec.name,
        namespace: DEFAULT_FLUX_NAMESPACE,
        targetNamespace: installNamespace,
        version: Cel.default(spec.chartVersion, DEFAULT_CROWDSEC_CHART_VERSION),
        repositoryName: DEFAULT_CROWDSEC_REPOSITORY_NAME,
        repositoryNamespace: DEFAULT_FLUX_NAMESPACE,
        createNamespace: !ownsNamespace,
        values: mapCrowdsecConfigToHelmValues(spec, options),
        id: RELEASE_ID,
      });

      // The chart ships no PodDisruptionBudget. maxUnavailable 1 never blocks
      // a drain, even with a single replica.
      const disruptionBudget = (component: 'lapi' | 'appsec', id: string) =>
        podDisruptionBudget({
          metadata: { name: `${spec.name}-${component}`, namespace: installNamespace, labels },
          spec: {
            maxUnavailable: 1,
            selector: { matchLabels: { 'k8s-app': spec.name, type: component } },
          },
          id,
        });
      if (options.lapi?.pdb ?? true) disruptionBudget('lapi', 'crowdsecLapiPdb');
      if (options.appsec && (options.appsec.pdb ?? true)) {
        disruptionBudget('appsec', 'crowdsecAppsecPdb');
      }

      const policy = options.networkPolicy;
      if (policy) {
        const inNamespace = (name: string) => ({
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': name } },
        });
        const metricsRule = {
          _from: [
            policy.metricsNamespace
              ? inNamespace(policy.metricsNamespace)
              : { namespaceSelector: {} },
          ],
          ports: [{ port: CROWDSEC_METRICS_PORT, protocol: 'TCP' }],
        };
        const component = (type: string) => ({ matchLabels: { 'k8s-app': spec.name, type } });
        networkPolicy({
          metadata: { name: `${spec.name}-lapi`, namespace: installNamespace, labels },
          spec: {
            podSelector: component('lapi'),
            policyTypes: ['Ingress'],
            ingress: [
              {
                // Agents and AppSec push alerts; the bouncer pulls decisions.
                _from: [
                  { podSelector: component('agent') },
                  { podSelector: component('appsec') },
                  inNamespace(policy.traefikNamespace),
                ],
                ports: [{ port: CROWDSEC_LAPI_PORT, protocol: 'TCP' }],
              },
              metricsRule,
            ],
          },
          id: 'crowdsecLapiNetworkPolicy',
        });
        if (options.appsec) {
          networkPolicy({
            metadata: { name: `${spec.name}-appsec`, namespace: installNamespace, labels },
            spec: {
              podSelector: component('appsec'),
              policyTypes: ['Ingress'],
              ingress: [
                {
                  _from: [inNamespace(policy.traefikNamespace)],
                  ports: [{ port: CROWDSEC_APPSEC_PORT, protocol: 'TCP' }],
                },
                metricsRule,
              ],
            },
            id: 'crowdsecAppsecNetworkPolicy',
          });
        }
      }

      const summary = helmReleaseConditionSummary(release);
      return {
        ready: summary.ready,
        failed: summary.failed,
        phase: summary.phase,
        lapiHost: Cel.expr<string>(serviceHost('-service', CROWDSEC_LAPI_PORT)),
        appsecHost: Cel.expr<string>(
          `${RELEASE_ID}.spec.values.appsec.enabled ? ` +
            `${serviceHost('-appsec-service', CROWDSEC_APPSEC_PORT)} : ""`
        ),
        version: Cel.expr<string>(CHART_VERSION_EXPRESSION),
      };
    }
  );
}

/**
 * The default CrowdSec bootstrap: SQLite LAPI, a DaemonSet agent reading the
 * `traefik` namespace, the Traefik collections, CAPI off and AppSec off.
 *
 * @example
 * ```typescript
 * await crowdsecBootstrap.factory('direct', { kubeConfig, waitForReady: true })
 *   .deploy({ name: 'crowdsec', namespace: 'crowdsec' });
 * ```
 */
export const crowdsecBootstrap: CallableComposition<
  CrowdsecBootstrapConfig,
  CrowdsecBootstrapStatus
> = makeCrowdsecBootstrap();
