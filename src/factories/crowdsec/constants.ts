/**
 * CrowdSec factory constants.
 *
 * Verified against the official `crowdsec` chart 0.24.2 (CrowdSec v1.8.1) from
 * https://crowdsecurity.github.io/helm-charts and the Traefik bouncer plugin
 * `github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin` v1.7.1 (Apache-2.0).
 */

/** Pinned official chart version. */
export const DEFAULT_CROWDSEC_CHART_VERSION = '0.24.2';
/** CrowdSec version bundled with {@link DEFAULT_CROWDSEC_CHART_VERSION}. */
export const DEFAULT_CROWDSEC_APP_VERSION = 'v1.8.1';
/** Chart name inside the official repository. */
export const DEFAULT_CROWDSEC_CHART_NAME = 'crowdsec';
/** Official classic (non-OCI) Helm repository. */
export const DEFAULT_CROWDSEC_REPOSITORY_URL = 'https://crowdsecurity.github.io/helm-charts';
/** `HelmRepository` name the bootstrap owns through a singleton. */
export const DEFAULT_CROWDSEC_REPOSITORY_NAME = 'crowdsec-repo';
/** Namespace CrowdSec is installed into by default. */
export const DEFAULT_CROWDSEC_NAMESPACE = 'crowdsec';

/** `alpine/kubectl` tag for the chart's register Jobs, pinned instead of `latest`. */
export const CROWDSEC_KUBECTL_IMAGE_TAG = '1.36.4';

/** Port of the Local API (LAPI) Service. */
export const CROWDSEC_LAPI_PORT = 8080;
/** Port of the AppSec (WAF) Service. */
export const CROWDSEC_APPSEC_PORT = 7422;
/** Prometheus port on every CrowdSec pod. */
export const CROWDSEC_METRICS_PORT = 6060;

/** Hub collections every bootstrap installs on the agents. */
export const DEFAULT_CROWDSEC_COLLECTIONS: readonly string[] = [
  'crowdsecurity/traefik',
  'crowdsecurity/base-http-scenarios',
  'crowdsecurity/http-cve',
];

/** Go module of the Traefik bouncer plugin. */
export const CROWDSEC_BOUNCER_PLUGIN_MODULE =
  'github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin';
/** Pinned bouncer plugin release. */
export const DEFAULT_CROWDSEC_BOUNCER_PLUGIN_VERSION = 'v1.7.1';
/** SHA-256 of the v1.7.1 archive served by plugins.traefik.io, as Traefik checks it. */
export const DEFAULT_CROWDSEC_BOUNCER_PLUGIN_HASH =
  '500739fc1600c12a651433b13a81693470cd336dbc7864cb85ee42098c93d884';
/** Default key of the plugin under Traefik's `experimental.plugins`. */
export const DEFAULT_CROWDSEC_PLUGIN_NAME = 'crowdsec';
