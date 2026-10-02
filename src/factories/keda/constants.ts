// KEDA factory constants.
//
// Verified against the official kedacore `keda` chart 2.21.0 (appVersion
// `2.21.0`) from https://kedacore.github.io/charts.
//
// @see https://keda.sh/docs/2.21/deploy/#helm

/** API group/version of `ScaledObject`, `ScaledJob` and the trigger authentications. */
export const KEDA_API_VERSION = 'keda.sh/v1alpha1';

/** Pinned chart version. */
export const DEFAULT_KEDA_CHART_VERSION = '2.21.0';
/** Chart name in the kedacore repository. */
export const KEDA_CHART_NAME = 'keda';
/** Official kedacore chart repository. */
export const DEFAULT_KEDA_REPOSITORY_URL = 'https://kedacore.github.io/charts';
/** `HelmRepository` name owned by the shared singleton composition. */
export const DEFAULT_KEDA_REPOSITORY_NAME = 'kedacore';
/** Install namespace, as in the upstream install guide. */
export const DEFAULT_KEDA_NAMESPACE = 'keda';

/**
 * Default component resources: the chart's own, restated so the rendered
 * values show them. Helm merges a partial override with these.
 */
export const KEDA_DEFAULT_RESOURCES = {
  requests: { cpu: '100m', memory: '100Mi' },
  limits: { cpu: '1', memory: '1000Mi' },
} as const;
