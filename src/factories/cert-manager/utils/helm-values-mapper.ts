import { Cel } from '../../../core/references/cel.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import type {
  CertManagerBootstrapConfig,
  CertManagerComponentScheduling,
  CertManagerHelmValues,
  ResourceRequirements,
} from '../types.js';

/** Chart version installed when the bootstrap spec does not set one. */
export const DEFAULT_CERT_MANAGER_VERSION = '1.19.3';

/** Namespace cert-manager is installed into when the spec does not set one. */
export const DEFAULT_CERT_MANAGER_NAMESPACE = 'cert-manager';

// TypeKro's own resource defaults for every cert-manager pod. The chart sets
// none, which leaves the pods BestEffort.
const DEFAULT_REQUESTS = { cpu: '10m', memory: '32Mi' } as const;
const DEFAULT_LIMITS = { cpu: '100m', memory: '128Mi' } as const;

// In KRO mode every optional spec field is a schema proxy, and a proxy is
// truthy, never `undefined`. So this mapper never branches on spec values,
// never spreads them (a proxy enumerates no keys) and never applies a default
// with `||` or `??`. It places each field into the values tree as-is; the
// serializer renders an unset optional field as `omit()`, so the chart's own
// default applies. Where TypeKro's default differs from the chart's, it uses
// `Cel.default`, which is plain `??` for concrete direct-mode values.

// Drop `undefined` leaves and empty objects from a concrete values tree. Graph
// values (schema references and CEL expressions) are kept whole.
function prune(value: unknown): unknown {
  if (
    value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    isKubernetesRef(value) ||
    isCelExpression(value)
  ) {
    return value;
  }
  const pruned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const next = prune(child);
    if (next !== undefined) pruned[key] = next;
  }
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}

function resourcesWithDefaults(resources: ResourceRequirements | undefined): ResourceRequirements {
  return {
    requests: {
      cpu: Cel.default(resources?.requests?.cpu, DEFAULT_REQUESTS.cpu),
      memory: Cel.default(resources?.requests?.memory, DEFAULT_REQUESTS.memory),
    },
    limits: {
      cpu: Cel.default(resources?.limits?.cpu, DEFAULT_LIMITS.cpu),
      memory: Cel.default(resources?.limits?.memory, DEFAULT_LIMITS.memory),
    },
  };
}

function scheduling(component: CertManagerComponentScheduling | undefined) {
  return {
    podDisruptionBudget: component?.podDisruptionBudget,
    topologySpreadConstraints: component?.topologySpreadConstraints,
  };
}

/**
 * Map the cert-manager bootstrap spec to cert-manager chart values.
 *
 * Works on a concrete spec (direct mode) and on the schema proxy (KRO mode)
 * alike; both render the same values for the same instance spec.
 */
export function mapCertManagerConfigToHelmValues(
  config: CertManagerBootstrapConfig
): CertManagerHelmValues {
  const installNamespace = Cel.default(config.namespace, DEFAULT_CERT_MANAGER_NAMESPACE);
  const controller = config.controller;
  const webhook = config.webhook;
  const cainjector = config.cainjector;
  const startupapicheck = config.startupapicheck;

  const values = {
    // Chart v1.17+ refuses `installCRDs` together with `crds.enabled`, so only
    // the replacement is rendered. The deprecated spec field still decides
    // `crds.enabled` when `crds.enabled` itself is unset.
    crds: {
      enabled: Cel.default(config.crds?.enabled, Cel.default(config.installCRDs, true)),
      keep: Cel.default(config.crds?.keep, true),
    },

    global: {
      // The chart defaults the lease to kube-system. Keep it next to the
      // controller unless the spec says otherwise.
      leaderElection: {
        namespace: Cel.default(config.global?.leaderElection?.namespace, installNamespace),
      },
      logLevel: config.global?.logLevel,
      podSecurityPolicy: config.global?.podSecurityPolicy,
    },

    // Controller settings live at the chart's root level.
    replicaCount: config.replicaCount,
    // Whole objects, not field by field: an empty `rollingUpdate: {}` left
    // behind next to `type: Recreate` is rejected by the API server.
    strategy: config.strategy,
    image: controller?.image,
    extraArgs: controller?.extraArgs,
    resources: resourcesWithDefaults(controller?.resources),
    nodeSelector: controller?.nodeSelector,
    serviceAccount: controller?.serviceAccount,
    ...scheduling(controller),

    webhook: {
      replicaCount: webhook?.replicaCount,
      image: webhook?.image,
      resources: resourcesWithDefaults(webhook?.resources),
      nodeSelector: webhook?.nodeSelector,
      serviceAccount: webhook?.serviceAccount,
      ...scheduling(webhook),
    },

    cainjector: {
      enabled: cainjector?.enabled,
      replicaCount: cainjector?.replicaCount,
      image: cainjector?.image,
      resources: resourcesWithDefaults(cainjector?.resources),
      nodeSelector: cainjector?.nodeSelector,
      serviceAccount: cainjector?.serviceAccount,
      ...scheduling(cainjector),
    },

    // cert-manager 1.19+ only supports `image` in the acmesolver section.
    acmesolver: { image: config.acmesolver?.image },

    // The startup API check gates the release's readiness on the webhook
    // answering, which prevents "webhook not found" errors for Certificates
    // and Issuers applied right after the install. TypeKro gives it 5m (the
    // chart's default is 1m) to cover slow environments.
    startupapicheck: {
      enabled: Cel.default(startupapicheck?.enabled, true),
      image: startupapicheck?.image,
      resources: resourcesWithDefaults(startupapicheck?.resources),
      nodeSelector: startupapicheck?.nodeSelector,
      timeout: Cel.default(startupapicheck?.timeout, '5m'),
      backoffLimit: startupapicheck?.backoffLimit,
    },

    // The chart enables the metrics endpoint by default; TypeKro leaves it
    // off unless asked.
    prometheus: {
      enabled: Cel.default(config.prometheus?.enabled, false),
      servicemonitor: config.prometheus?.servicemonitor,
    },
  };

  const mapped = (prune(values) ?? {}) as Record<string, unknown>;

  // Fields the bootstrap schema does not declare can only be honoured when
  // concrete: in KRO mode a reference to an undeclared schema path would make
  // the ResourceGraphDefinition invalid.
  const concrete = (value: unknown): unknown =>
    isKubernetesRef(value) || isCelExpression(value) ? undefined : value;
  const directOnly = {
    extraEnv: concrete(controller?.env),
    tolerations: concrete(controller?.tolerations),
    affinity: concrete(controller?.affinity),
    securityContext: concrete(controller?.securityContext),
    containerSecurityContext: concrete(controller?.containerSecurityContext),
    volumes: concrete(controller?.volumes),
    volumeMounts: concrete(controller?.volumeMounts),
  };
  for (const [key, value] of Object.entries(directOnly)) {
    if (value !== undefined) mapped[key] = value;
  }

  const customValues = concrete(config.customValues);
  if (customValues && typeof customValues === 'object') {
    Object.assign(mapped, customValues);
  }

  return mapped as CertManagerHelmValues;
}

/**
 * Checks cert-manager Helm values for best-practice warnings (e.g., HA, monitoring).
 *
 * Unlike {@link validateCertManagerHelmValues} (in `resources/helm.ts`) which performs
 * hard validation (invalid replica counts, wrong resource types), this function
 * returns advisory warnings about sub-optimal but technically valid configurations.
 *
 * @param values - The Helm values to check
 * @returns Array of warning messages (empty if no issues found)
 */
export function getCertManagerHelmValueWarnings(values: CertManagerHelmValues): string[] {
  const warnings: string[] = [];

  // Check CRD installation
  if (values.crds?.enabled === false || values.installCRDs === false) {
    warnings.push(
      'crds.enabled is false. Ensure CRDs are installed separately before deploying cert-manager.'
    );
  }

  if (values.installCRDs === true && values.crds?.enabled === true) {
    warnings.push(
      'installCRDs and crds.enabled are both true. The cert-manager chart (v1.17+) refuses this; remove installCRDs.'
    );
  }

  // Note: webhook.enabled was removed in cert-manager 1.19+ (webhook is always enabled)

  // Check CA injector configuration
  if (values.cainjector?.enabled === false) {
    warnings.push('CA injector is disabled. This may cause issues with CA bundle injection.');
  }

  // Check resource requirements
  if (!values.resources?.requests) {
    warnings.push(
      'No resource requests specified. Consider setting CPU and memory requests for better scheduling.'
    );
  }

  // Check replica count for webhook
  if (values.webhook?.replicaCount === 1) {
    warnings.push(
      'Webhook is running with only 1 replica. Consider increasing for high availability.'
    );
  }

  if ((values.replicaCount ?? 1) > 1 && values.podDisruptionBudget?.enabled !== true) {
    warnings.push(
      'The controller runs more than 1 replica without a PodDisruptionBudget. Consider enabling controller.podDisruptionBudget.'
    );
  }

  // Check monitoring configuration
  if (values.prometheus?.enabled && !values.prometheus?.servicemonitor?.enabled) {
    warnings.push(
      'Prometheus is enabled but ServiceMonitor is disabled. Metrics may not be scraped.'
    );
  }

  return warnings;
}
