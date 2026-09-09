/**
 * `traefikBootstrap` — the composition that stands Traefik up as a cluster edge.
 *
 * It owns the whole install: the (optional) namespace, the Flux `HelmRelease`,
 * the entrypoint `Service`, and optionally the cluster-default
 * `TLSOption`/`TLSStore`. The shared chart `HelmRepository` is delegated to a
 * singleton composition so one instance's teardown cannot break another's
 * chart source.
 *
 * **Why the entrypoint Service is owned rather than observed.** The status
 * contract publishes the edge's load-balancer address, which means projecting
 * the entrypoint Service's `status.loadBalancer`. A projection requires the
 * resource to be in the graph. Observing the chart-created Service instead
 * (`observedResource`) made every FRESH direct deployment fail: the direct
 * engine resolves external references before it applies anything, so it read a
 * `Service` that the release had not created yet and treated the `404` as
 * fatal — and `dependsOn` cannot reorder that, because the read happens before
 * the dependency graph is walked. So the chart's Service is disabled through
 * values and this composition creates a typed one selecting the chart's pods.
 * The graph therefore has no external reference to any Kubernetes API object.
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
import { singleton } from '../../../core/singleton/singleton.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { service } from '../../kubernetes/networking/service.js';
import {
  DEFAULT_TRAEFIK_CHART_VERSION,
  DEFAULT_TRAEFIK_CRDS_POLICY,
  DEFAULT_TRAEFIK_NAMESPACE,
  DEFAULT_TRAEFIK_REPOSITORY_NAME,
  DEFAULT_TRAEFIK_REPOSITORY_URL,
  DEFAULT_TRAEFIK_WEB_PORT,
  DEFAULT_TRAEFIK_WEBSECURE_PORT,
  TRAEFIK_DEFAULT_TLS_OPTION_NAME,
  TRAEFIK_DEFAULT_TLS_STORE_NAME,
  TRAEFIK_POD_NAME_LABEL_VALUE,
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
import {
  mapTraefikConfigToHelmValues,
  traefikEntrypointServiceType,
} from '../utils/helm-values-mapper.js';
import { traefikHelmRepositoryBootstrap } from './traefik-helm-repository.js';

/**
 * CEL reading one field of the first load-balancer address the entrypoint
 * Service reports that carries it, falling back to `''`.
 *
 * Written as an explicit expression rather than a JavaScript optional chain
 * because every hop is genuinely absent for a `ClusterIP`/`NodePort` Service
 * and while a cloud controller is still provisioning: `status.loadBalancer` may
 * be missing, `ingress` may be missing, it may be empty, and an entry carries
 * either `ip` or `hostname` but rarely both.
 *
 * Two details of the shape are load-bearing, both of them about satisfying the
 * two CEL engines this one string has to run on — KRO's cel-go and the `cel-js`
 * evaluator direct mode uses:
 *
 * 1. **A ternary, not one `&&` chain.** `size()` on an absent `ingress` is an
 *    evaluation error. cel-go absorbs an error in one operand of `&&` when the
 *    other operand is false; cel-js evaluates both operands and propagates the
 *    error. A ternary is lazy in both, so the guard is actually reached before
 *    the access it protects. Without this, a plain `ClusterIP` Service took the
 *    WHOLE status object down to unresolved — `ready` and `phase` included, not
 *    just this field.
 * 2. **`filter(...)` rather than a guard on `ingress[0]`.** The obvious
 *    `has(ingress[0].hostname)` is rejected by cel-js ("has() does not support
 *    atomic expressions" — its operand is an index expression), and the obvious
 *    workaround `"hostname" in ingress[0]` is rejected by KRO, which types an
 *    ingress entry as a message rather than a map ("no matching overload for
 *    '@in'"). Selecting the entries that carry the field is accepted by both —
 *    and says what is actually meant: an entry carries `ip` or `hostname`, and
 *    a load balancer may report more than one.
 */
function loadBalancerAddressExpression(resourceId: string, field: 'ip' | 'hostname'): string {
  const base = `${resourceId}.status.loadBalancer`;
  const matching = `${base}.ingress.filter(entry, has(entry.${field}))`;
  return (
    `has(${base}) && has(${base}.ingress) ` +
    `? (size(${matching}) > 0 ? ${matching}[0].${field} : "") ` +
    `: ""`
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
  const crdsPolicy = options.crds ?? DEFAULT_TRAEFIK_CRDS_POLICY;

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
              'app.kubernetes.io/name': TRAEFIK_POD_NAME_LABEL_VALUE,
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
        targetNamespace: installNamespace,
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
        crds: crdsPolicy,
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

      // The entrypoint Service this composition OWNS. The chart's own Service
      // is pinned off by the values mapper; this one carries the same name
      // (`fullnameOverride` is pinned to `spec.name`) and the same selector, so
      // nothing downstream — `providers.kubernetesIngress.publishedService`
      // included — has to know which of the two created it.
      //
      // `targetPort` is the container port NAME, exactly as the chart's own
      // Service template does it: the chart names every container port after
      // its entrypoint, so the names survive a change of container port.
      service({
        metadata: {
          name: spec.name,
          namespace: installNamespace,
          labels: {
            'app.kubernetes.io/name': TRAEFIK_POD_NAME_LABEL_VALUE,
            'app.kubernetes.io/instance': spec.name,
            'app.kubernetes.io/managed-by': 'typekro',
          },
          // `Cel.default`, never a JavaScript branch: a schema proxy is a truthy
          // object, so `spec.service?.annotations ? ... : {}` would always take
          // the first arm in KRO mode and disagree with direct mode.
          annotations: Cel.default(spec.service?.annotations, {}),
        },
        spec: {
          type: traefikEntrypointServiceType(spec),
          // The chart stamps these two labels on the Traefik pods, and the
          // values mapper pins both of their sources (`nameOverride`,
          // `instanceLabelOverride`) so this selector is exact.
          selector: {
            'app.kubernetes.io/name': TRAEFIK_POD_NAME_LABEL_VALUE,
            'app.kubernetes.io/instance': spec.name,
          },
          // @security The internal `traefik` entrypoint serves /ping, metrics
          // and the (pinned off) dashboard. Owning the Service is what makes
          // its absence here a structural guarantee rather than a chart value.
          ports: [
            {
              name: TRAEFIK_WEB_ENTRYPOINT,
              port: Cel.default(spec.entrypoints?.web?.exposedPort, DEFAULT_TRAEFIK_WEB_PORT),
              targetPort: TRAEFIK_WEB_ENTRYPOINT,
              protocol: 'TCP',
            },
            {
              name: TRAEFIK_WEBSECURE_ENTRYPOINT,
              port: Cel.default(
                spec.entrypoints?.websecure?.exposedPort,
                DEFAULT_TRAEFIK_WEBSECURE_PORT
              ),
              targetPort: TRAEFIK_WEBSECURE_ENTRYPOINT,
              protocol: 'TCP',
            },
          ],
        },
        id: 'traefikService',
      });
      // Deliberately no `dependsOn`. Ordering against the owned namespace is
      // already implicit — the dependency resolver adds an edge from any
      // resource whose `metadata.namespace` matches a `Namespace` in the same
      // graph — and the Service must NOT wait for the release: a Service with
      // no endpoints is valid, and creating it first lets a cloud
      // load-balancer controller provision while Helm is still installing.
      // An explicit `dependsOn` would also force TypeKro to inject ordering
      // annotations into `metadata.annotations`, which cannot be merged into an
      // annotation map that arrives as one schema reference.

      const releaseStatus = helmReleaseConditionSummary(release);

      return {
        ready: releaseStatus.ready,
        failed: releaseStatus.failed,
        phase: releaseStatus.phase,
        loadBalancer: {
          hostname: Cel.expr<string>(loadBalancerAddressExpression('traefikService', 'hostname')),
          ip: Cel.expr<string>(loadBalancerAddressExpression('traefikService', 'ip')),
        },
        // Read back from the owned Service rather than echoing the spec. The
        // resource-scoped CEL form is deliberate: a `schema.spec` reference in
        // a status field is not a resource projection and KRO drops it.
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
