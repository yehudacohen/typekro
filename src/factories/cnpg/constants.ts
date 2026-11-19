// CloudNativePG constants: the chart repository and the Barman Cloud plugin's identity.
//
// Barman Cloud plugin values were verified against the official chart `plugin-barman-cloud`
// 0.9.0 (appVersion v0.16.0) and the plugin's v0.16.0 release manifest.
//
// @see https://cloudnative-pg.io/plugin-barman-cloud/docs/installation/

/** Helm repository that serves both the operator chart and the Barman Cloud plugin chart. */
export const CNPG_CHART_REPOSITORY_URL = 'https://cloudnative-pg.github.io/charts';
/** Name of the `HelmRepository` for {@link CNPG_CHART_REPOSITORY_URL}. */
export const DEFAULT_CNPG_REPOSITORY_NAME = 'cnpg-repo';
/** Namespace the operator chart installs into by default. */
export const DEFAULT_CNPG_NAMESPACE = 'cnpg-system';

/**
 * Default `cloudnative-pg` chart version: 0.29.2, released 2026-11-17, which installs operator
 * {@link CNPG_OPERATOR_VERSION}. Checked against the chart repository index.
 */
export const CNPG_CHART_VERSION = '0.29.2';
/** Operator version {@link CNPG_CHART_VERSION} installs. */
export const CNPG_OPERATOR_VERSION = '1.30.2';

/** Name a `Cluster` uses to refer to the plugin, in `spec.plugins` and elsewhere. */
export const BARMAN_CLOUD_PLUGIN_NAME = 'barman-cloud.cloudnative-pg.io';
/** API version of the plugin's `ObjectStore`. */
export const BARMAN_CLOUD_API_VERSION = 'barmancloud.cnpg.io/v1';

/** Chart name of the plugin in {@link CNPG_CHART_REPOSITORY_URL}. */
export const BARMAN_CLOUD_PLUGIN_CHART_NAME = 'plugin-barman-cloud';
/** Pinned chart version: `plugin-barman-cloud` 0.9.0, released 2026-11-09. */
export const BARMAN_CLOUD_PLUGIN_CHART_VERSION = '0.9.0';
/** Plugin version that chart installs. */
export const BARMAN_CLOUD_PLUGIN_VERSION = 'v0.16.0';
/**
 * Oldest CloudNativePG operator the plugin v0.16.0 documents as supported. The plugin must run
 * in the operator's namespace, and its chart needs cert-manager to issue the plugin's TLS
 * certificates. The plugin factories require the caller to name the operator version
 * (`operatorVersion`), and refuse one older than this; see
 * `BARMAN_CLOUD_OPERATOR_VERSION_CONSTRAINT`.
 */
export const BARMAN_CLOUD_PLUGIN_MINIMUM_CNPG_VERSION = '1.30.0';

/**
 * `service.name` of the plugin chart. The chart says it must not change: the plugin's TLS
 * certificates are issued for it.
 */
export const BARMAN_CLOUD_PLUGIN_SERVICE_NAME = 'barman-cloud';
