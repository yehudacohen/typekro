/**
 * `traefikBootstrap` — the composition that stands Traefik up as a cluster edge.
 *
 * It owns the whole install: the (optional) namespace, the Flux `HelmRelease`,
 * and optionally the cluster-default `TLSOption`/`TLSStore`. The shared chart
 * `HelmRepository` is delegated to a singleton composition so one instance's
 * teardown cannot break another's chart source.
 *
 * **Build-time vs runtime.** Options that decide WHICH resources exist — the
 * namespace lifecycle, the default TLS resources, the `web` → `websecure`
 * redirect, raw chart values — are arguments to {@link makeTraefikBootstrap}
 * and are always concrete, so plain JavaScript branches on them are safe. The
 * runtime spec carries only values, which may arrive as schema references in
 * KRO mode and are therefore only ever placed into the values tree, never
 * branched on. This is the ClickStack convention.
 *
 * @security The dashboard and the insecure API are not reachable through this
 * contract: the spec's `dashboard` field is typed as the literal `false`, and
 * `mapTraefikConfigToHelmValues` pins `api.dashboard`, `api.insecure`,
 * `api.debug` and the dashboard `IngressRoute` off after every other values
 * source has been merged.
 */

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { observedResource } from '../../../core/references/external-refs.js';
import { singleton } from '../../../core/singleton/singleton.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_TRAEFIK_CHART_VERSION,
  DEFAULT_TRAEFIK_NAMESPACE,
  DEFAULT_TRAEFIK_REPOSITORY_NAME,
  DEFAULT_TRAEFIK_REPOSITORY_URL,
  TRAEFIK_DEFAULT_TLS_OPTION_NAME,
  TRAEFIK_DEFAULT_TLS_STORE_NAME,
  TRAEFIK_WEB_ENTRYPOINT,
  TRAEFIK_WEBSECURE_ENTRYPOINT,
} from '../constants.js';
import { traefikHelmRelease } from '../resources/helm.js';
import { traefikTLSOption, traefikTLSStore } from '../resources/tls.js';
import {
  type TraefikBootstrapBuildOptions,
  TraefikBootstrapConfigSchema,
  TraefikBootstrapStatusSchema,
} from '../types.js';
import { mapTraefikConfigToHelmValues } from '../utils/helm-values-mapper.js';
import { traefikHelmRepositoryBootstrap } from './traefik-helm-repository.js';

/** Minimal observed shape of the entrypoint Service the chart creates. */
interface ObservedServiceSpec {
  readonly type?: string;
}

/** Minimal observed status of the entrypoint Service the chart creates. */
interface ObservedServiceStatus {
  readonly loadBalancer?: {
    readonly ingress?: readonly {
      readonly ip?: string;
      readonly hostname?: string;
    }[];
  };
}

/**
 * CEL reading one field of the entrypoint Service's first load-balancer
 * address, falling back to `''`.
 *
 * Written as an explicit expression rather than a JavaScript optional chain
 * because every hop is genuinely absent for a `ClusterIP`/`NodePort` Service
 * and while a cloud controller is still provisioning: `status.loadBalancer` may
 * be missing, `ingress` may be missing, it may be empty, and an entry carries
 * either `ip` or `hostname` but rarely both.
 */
function loadBalancerAddressExpression(resourceId: string, field: 'ip' | 'hostname'): string {
  const base = `${resourceId}.status.loadBalancer`;
  return (
    `has(${base}) && has(${base}.ingress) && size(${base}.ingress) > 0 ` +
    `&& has(${base}.ingress[0].${field}) ? ${base}.ingress[0].${field} : ""`
  );
}

/**
 * Build a Traefik bootstrap composition.
 *
 * Use this when the defaults of {@link traefikBootstrap} are not enough — to
 * adopt an externally managed namespace, to own the cluster-default TLS
 * resources, to disable the HTTP→HTTPS redirect, or to pass chart values this
 * factory does not model.
 *
 * @param options - Build-time options. Must be concrete values.
 *
 * @example An edge that owns its default TLS store, fed by cert-manager
 * ```typescript
 * const edge = makeTraefikBootstrap({
 *   name: 'traefik-edge',
 *   kind: 'TraefikEdge',
 *   defaultTlsStore: { defaultCertificateSecretName: 'edge-wildcard-tls' },
 *   defaultTlsOption: { minVersion: 'VersionTLS13' },
 * });
 *
 * await edge.factory('direct', { kubeConfig, waitForReady: true }).deploy({
 *   name: 'traefik',
 *   namespace: 'traefik',
 *   service: { type: 'LoadBalancer' },
 * });
 * ```
 */
export function makeTraefikBootstrap(options: TraefikBootstrapBuildOptions = {}) {
  const ownsNamespace = (options.namespaceOwnership ?? 'owned') === 'owned';
  const redirectWebToWebsecure = options.redirectWebToWebsecure ?? true;
  const defaultTlsOption = options.defaultTlsOption;
  const defaultTlsStore = options.defaultTlsStore;

  return kubernetesComposition(
    {
      name: options.name ?? 'traefik-bootstrap',
      kind: options.kind ?? 'TraefikBootstrap',
      spec: TraefikBootstrapConfigSchema,
      status: TraefikBootstrapStatusSchema,
    },
    (spec) => {
      const installNamespace = Cel.default(spec.namespace, DEFAULT_TRAEFIK_NAMESPACE);
      const chartVersion = Cel.default(spec.chartVersion, DEFAULT_TRAEFIK_CHART_VERSION);

      if (ownsNamespace) {
        namespace({
          metadata: {
            name: installNamespace,
            labels: {
              'app.kubernetes.io/name': 'traefik',
              'app.kubernetes.io/instance': spec.name,
              'app.kubernetes.io/managed-by': 'typekro',
            },
          },
          id: 'traefikNamespace',
        });
      }

      // The official chart source is shared by every Traefik installation, so
      // its ownership stays outside any consumer instance.
      singleton(traefikHelmRepositoryBootstrap, {
        id: 'traefikHelmRepository',
        spec: {
          name: DEFAULT_TRAEFIK_REPOSITORY_NAME,
          namespace: DEFAULT_FLUX_NAMESPACE,
          url: DEFAULT_TRAEFIK_REPOSITORY_URL,
        },
      });

      const values = mapTraefikConfigToHelmValues(spec, {
        redirectWebToWebsecure,
        ...(options.values ? { baseValues: options.values } : {}),
      });

      // Chart 41.5.0 ships the traefik.io CRDs in its own crds/ directory, so
      // this single release installs the CRDs and the proxy together.
      const release = traefikHelmRelease({
        name: spec.name,
        namespace: DEFAULT_FLUX_NAMESPACE,
        targetNamespace: installNamespace,
        version: chartVersion,
        repositoryName: DEFAULT_TRAEFIK_REPOSITORY_NAME,
        repositoryNamespace: DEFAULT_FLUX_NAMESPACE,
        // Flux creates the namespace only when this composition does not.
        createNamespace: !ownsNamespace,
        values,
        id: 'traefikHelmRelease',
      });

      if (defaultTlsOption) {
        const tlsOption = traefikTLSOption({
          name: defaultTlsOption.name ?? TRAEFIK_DEFAULT_TLS_OPTION_NAME,
          namespace: installNamespace,
          spec: {
            ...(defaultTlsOption.minVersion ? { minVersion: defaultTlsOption.minVersion } : {}),
            ...(defaultTlsOption.sniStrict === undefined
              ? {}
              : { sniStrict: defaultTlsOption.sniStrict }),
            ...(defaultTlsOption.cipherSuites
              ? { cipherSuites: [...defaultTlsOption.cipherSuites] }
              : {}),
            ...(defaultTlsOption.curvePreferences
              ? { curvePreferences: [...defaultTlsOption.curvePreferences] }
              : {}),
            ...(defaultTlsOption.clientAuth ? { clientAuth: defaultTlsOption.clientAuth } : {}),
          },
          id: 'traefikDefaultTlsOption',
        });
        // The TLSOption CRD arrives with the release.
        tlsOption.dependsOn(release);
      }

      if (defaultTlsStore) {
        const tlsStore = traefikTLSStore({
          name: defaultTlsStore.name ?? TRAEFIK_DEFAULT_TLS_STORE_NAME,
          namespace: installNamespace,
          spec: {
            defaultCertificate: { secretName: defaultTlsStore.defaultCertificateSecretName },
          },
          id: 'traefikDefaultTlsStore',
        });
        tlsStore.dependsOn(release);
      }

      // The entrypoint Service is created by the chart, so it is observed
      // rather than owned. `fullnameOverride` is pinned to `spec.name` by the
      // values mapper, which is what makes this name predictable.
      const entrypointService = observedResource<ObservedServiceSpec, ObservedServiceStatus>({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: spec.name, namespace: installNamespace },
        id: 'traefikService',
      });
      entrypointService.dependsOn(release);

      const releaseStatus = helmReleaseConditionSummary(release);

      return {
        ready: releaseStatus.ready,
        failed: releaseStatus.failed,
        phase: releaseStatus.phase,
        loadBalancer: {
          hostname: Cel.expr<string>(loadBalancerAddressExpression('traefikService', 'hostname')),
          ip: Cel.expr<string>(loadBalancerAddressExpression('traefikService', 'ip')),
        },
        // The entrypoint set is fixed by this composition's values mapping, so
        // it is a literal rather than a projection of the spec.
        entrypoints: [TRAEFIK_WEB_ENTRYPOINT, TRAEFIK_WEBSECURE_ENTRYPOINT],
        // Read back from the observed Service rather than echoing the spec.
        // The resource-scoped CEL form is deliberate: a `schema.spec` reference
        // in a status field is not a resource projection and KRO drops it.
        serviceName: Cel.expr<string>('traefikService.metadata.name'),
      };
    }
  );
}

/**
 * The default Traefik bootstrap composition.
 *
 * Owns its install namespace, redirects `web` to `websecure`, and creates no
 * default TLS resources. Use {@link makeTraefikBootstrap} for anything else.
 *
 * @example
 * ```typescript
 * const factory = traefikBootstrap.factory('direct', {
 *   namespace: 'flux-system',
 *   waitForReady: true,
 *   timeout: 600_000,
 *   kubeConfig,
 * });
 *
 * const instance = await factory.deploy({
 *   name: 'traefik',
 *   namespace: 'traefik',
 *   replicas: 2,
 *   service: {
 *     type: 'LoadBalancer',
 *     annotations: {
 *       'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
 *       'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'ip',
 *       'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing',
 *     },
 *   },
 *   providers: { crd: true },
 *   accessLogs: true,
 * });
 * ```
 */
export const traefikBootstrap = makeTraefikBootstrap();
