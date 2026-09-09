/**
 * Traefik factory constants.
 *
 * Compatibility tuple verified against the official Traefik Helm chart
 * `traefik` 41.5.0 (appVersion `v3.7.13`, `kubeVersion >=1.25.0-0`) published on
 * https://traefik.github.io/charts. That chart ships the `traefik.io/v1alpha1`
 * CRDs in its own `crds/` directory, so one HelmRelease installs both the CRDs
 * and the proxy.
 */

/** API group/version of every Traefik CRD this factory creates. */
export const TRAEFIK_API_VERSION = 'traefik.io/v1alpha1';

/** Pinned official chart version. */
export const DEFAULT_TRAEFIK_CHART_VERSION = '41.5.0';
/** Traefik Proxy version bundled with {@link DEFAULT_TRAEFIK_CHART_VERSION}. */
export const DEFAULT_TRAEFIK_APP_VERSION = 'v3.7.13';
/** Chart name inside the official repository. */
export const DEFAULT_TRAEFIK_CHART_NAME = 'traefik';
/** Official classic (non-OCI) Helm repository. */
export const DEFAULT_TRAEFIK_REPOSITORY_URL = 'https://traefik.github.io/charts';
/** `HelmRepository` name the bootstrap composition owns as a singleton. */
export const DEFAULT_TRAEFIK_REPOSITORY_NAME = 'traefik-repo';

/** Namespace Traefik is installed into by default. */
export const DEFAULT_TRAEFIK_NAMESPACE = 'traefik';
/** `IngressClass` / `providers.kubernetesCRD.ingressClass` value. */
export const DEFAULT_TRAEFIK_INGRESS_CLASS = 'traefik';

/**
 * Controller name Traefik v3 claims for Gateway API `GatewayClass` resources.
 *
 * Passed to the shared `src/factories/gateway-api` factories so a Traefik edge
 * and an Envoy AI Gateway can coexist in one cluster.
 */
export const TRAEFIK_GATEWAY_CONTROLLER_NAME = 'traefik.io/gateway-controller';

/** Plain-HTTP entrypoint name. */
export const TRAEFIK_WEB_ENTRYPOINT = 'web';
/** TLS entrypoint name. */
export const TRAEFIK_WEBSECURE_ENTRYPOINT = 'websecure';
/** Internal entrypoint serving `/ping`, metrics and (when enabled) the dashboard. */
export const TRAEFIK_INTERNAL_ENTRYPOINT = 'traefik';

/**
 * `app.kubernetes.io/name` the chart stamps on the Traefik pods.
 *
 * The chart derives this label from `nameOverride`, defaulting to the chart
 * name. The values mapper pins `nameOverride` to this constant so the
 * entrypoint Service this factory OWNS can select the chart's pods by an
 * exactly known label rather than by whatever the chart's template computed.
 */
export const TRAEFIK_POD_NAME_LABEL_VALUE = 'traefik';

/**
 * Flux CRD policy this factory applies to install AND upgrade.
 *
 * Chart 41.5.0 ships the `traefik.io/v1alpha1` CRDs in its own `crds/`
 * directory, and the helm-controller SKIPS `crds/` on upgrade by default — so a
 * chart bump would otherwise keep serving the CRD schemas the release was
 * first installed with.
 *
 * @see https://fluxcd.io/flux/components/helm/api/v2/
 */
export const DEFAULT_TRAEFIK_CRDS_POLICY = 'CreateReplace';

/** Externally published port of the `web` entrypoint. */
export const DEFAULT_TRAEFIK_WEB_PORT = 80;
/** Externally published port of the `websecure` entrypoint. */
export const DEFAULT_TRAEFIK_WEBSECURE_PORT = 443;
/** Container port backing the `web` entrypoint. */
export const DEFAULT_TRAEFIK_WEB_CONTAINER_PORT = 8000;
/** Container port backing the `websecure` entrypoint. */
export const DEFAULT_TRAEFIK_WEBSECURE_CONTAINER_PORT = 8443;

/** Name of the cluster-wide default `TLSOption`, per Traefik's convention. */
export const TRAEFIK_DEFAULT_TLS_OPTION_NAME = 'default';
/** Name of the cluster-wide default `TLSStore`, per Traefik's convention. */
export const TRAEFIK_DEFAULT_TLS_STORE_NAME = 'default';

/**
 * Every OSS Traefik middleware key, in CRD order.
 *
 * A `Middleware` must set exactly one of these, which the middleware factory
 * enforces at the type level and re-checks before serialization.
 */
export const TRAEFIK_MIDDLEWARE_KINDS = [
  'addPrefix',
  'basicAuth',
  'buffering',
  'chain',
  'circuitBreaker',
  'compress',
  'contentType',
  'digestAuth',
  'encodedCharacters',
  'errors',
  'forwardAuth',
  'grpcWeb',
  'headers',
  'inFlightReq',
  'ipAllowList',
  'passTLSClientCert',
  'plugin',
  'rateLimit',
  'redirectRegex',
  'redirectScheme',
  'replacePath',
  'replacePathRegex',
  'retry',
  'stripPrefix',
  'stripPrefixRegex',
] as const;
